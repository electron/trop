import { Application, Context } from 'probot';
import {
  PullsGetResponse,
  ChecksListForRefResponseCheckRunsItem,
  PullsGetResponseBase,
  ChecksUpdateParams,
  PullsListCommitsResponseItem,
} from '@octokit/rest';
import fetch from 'node-fetch';
import * as fs from 'fs-extra';
import { IQueue } from 'queue';
import * as simpleGit from 'simple-git/promise';

import queue from './Queue';
import { CHECK_PREFIX, BACKPORT_REQUESTED_LABEL } from './constants';
import { PRStatus, BackportPurpose, LogLevel } from './enums';

import * as labelUtils from './utils/label-utils';
import { initRepo } from './operations/init-repo';
import { setupRemotes } from './operations/setup-remotes';
import { backportCommitsToBranch } from './operations/backport-commits';
import { getRepoToken } from './utils/token-util';
import { getSupportedBranches, getBackportPattern } from './utils/branch-util';
import { getEnvVar } from './utils/env-util';
import { log } from './utils/log-util';

const makeQueue: IQueue = require('queue');
const { parse: parseDiff } = require('what-the-diff');

export const labelMergedPR = async (
  context: Context,
  pr: PullsGetResponse,
  targetBranch: String,
) => {
  log(
    'labelMergedPR',
    LogLevel.INFO,
    `Labeling original PRs for PR at #${pr.number}`,
  );

  const backportNumbers: number[] = [];
  let match: RegExpExecArray | null;
  const backportPattern = getBackportPattern();
  while ((match = backportPattern.exec(pr.body))) {
    // This might be the first or second capture group depending on if it's a link or not.
    backportNumbers.push(
      match[1] ? parseInt(match[1], 10) : parseInt(match[2], 10),
    );
  }

  for (const prNumber of backportNumbers) {
    const labelToAdd = PRStatus.MERGED + targetBranch;
    const labelToRemove = PRStatus.IN_FLIGHT + targetBranch;

    await labelUtils.removeLabel(context, prNumber, labelToRemove);
    await labelUtils.addLabel(context, prNumber, [labelToAdd]);
  }
};

const isSemverMinorPR = async (context: Context, pr: PullsGetResponse) => {
  log(
    'isSemverMinorPR',
    LogLevel.INFO,
    `Checking if #${pr.number} is semver-minor`,
  );
  const SEMVER_MINOR_LABEL = 'semver-minor';

  const hasPrefix = pr.title.startsWith('feat:');
  const hasLabel = await labelUtils.labelExistsOnPR(
    context,
    pr.number,
    SEMVER_MINOR_LABEL,
  );

  return hasLabel || hasPrefix;
};

const checkUserHasWriteAccess = async (context: Context, user: string) => {
  log(
    'checkUserHasWriteAccess',
    LogLevel.INFO,
    `Checking whether ${user} has write access`,
  );

  const params = context.repo({ username: user });
  const {
    data: userInfo,
  } = await context.github.repos.getCollaboratorPermissionLevel(params);

  // Possible values for the permission key: 'admin', 'write', 'read', 'none'.
  // In order for the user's review to count, they must be at least 'write'.
  return ['write', 'admin'].includes(userInfo.permission);
};

const createBackportComment = (pr: PullsGetResponse) => {
  log(
    'createBackportComment',
    LogLevel.INFO,
    `Creating backport comment for #${pr.number}`,
  );

  let body = `Backport of #${pr.number}\n\nSee that PR for details.`;

  const onelineMatch = pr.body.match(
    /(?:(?:\r?\n)|^)notes: (.+?)(?:(?:\r?\n)|$)/gi,
  );
  const multilineMatch = pr.body.match(
    /(?:(?:\r?\n)Notes:(?:\r?\n)((?:\*.+(?:(?:\r?\n)|$))+))/gi,
  );

  // attach release notes to backport PR body
  if (onelineMatch && onelineMatch[0]) {
    body += `\n\n${onelineMatch[0]}`;
  } else if (multilineMatch && multilineMatch[0]) {
    body += `\n\n${multilineMatch[0]}`;
  } else {
    body += '\n\nNotes: no-notes';
  }

  return body;
};

export const backportImpl = async (
  robot: Application,
  context: Context,
  targetBranch: string,
  purpose: BackportPurpose,
  labelToRemove?: string,
  labelToAdd?: string,
) => {
  // Optionally disallow backports to EOL branches
  const noEOLSupport = getEnvVar('NO_EOL_SUPPORT', '');
  if (noEOLSupport) {
    const supported = await getSupportedBranches(context);
    if (!['master', ...supported].includes(targetBranch)) {
      log(
        'backportImpl',
        LogLevel.WARN,
        `${targetBranch} is no longer supported - no backport will be initiated.`,
      );
      await context.github.issues.createComment(
        context.repo({
          body: `${targetBranch} is no longer supported - no backport will be initiated.`,
          issue_number: context.payload.issue.number,
        }),
      );
      return;
    }
  }

  const base: PullsGetResponseBase = context.payload.pull_request.base;
  const slug = `${base.repo.owner.login}/${base.repo.name}`;
  const bp = `backport from PR #${context.payload.pull_request.number} to "${targetBranch}"`;
  log('backportImpl', LogLevel.INFO, `Queuing ${bp} for "${slug}"`);

  const getCheckRun = async () => {
    const allChecks = await context.github.checks.listForRef(
      context.repo({
        ref: context.payload.pull_request.head.sha,
        per_page: 100,
      }),
    );

    return allChecks.data.check_runs.find(
      (run: ChecksListForRefResponseCheckRunsItem) => {
        return run.name === `${CHECK_PREFIX}${targetBranch}`;
      },
    );
  };

  let createdDir: string | null = null;

  queue.enterQueue(
    `backport-${context.payload.pull_request.head.sha}-${targetBranch}-${purpose}`,
    async () => {
      log('backportImpl', LogLevel.INFO, `Executing ${bp} for "${slug}"`);
      if (purpose === BackportPurpose.Check) {
        const checkRun = await getCheckRun();
        if (checkRun) {
          await context.github.checks.update(
            context.repo({
              check_run_id: checkRun.id,
              name: checkRun.name,
              status: 'in_progress' as 'in_progress',
            }),
          );
        }
      }

      const repoAccessToken = await getRepoToken(robot, context);

      const pr: PullsGetResponse = context.payload.pull_request;

      // Set up empty repo on master.
      const { dir } = await initRepo({
        slug,
        accessToken: repoAccessToken,
      });
      createdDir = dir;
      log('backportImpl', LogLevel.INFO, `Working directory cleaned: ${dir}`);

      const targetRepoRemote = `https://x-access-token:${repoAccessToken}@github.com/${slug}.git`;
      await setupRemotes({
        dir,
        remotes: [
          {
            name: 'target_repo',
            value: targetRepoRemote,
          },
        ],
      });

      // Get list of commits.
      log(
        'backportImpl',
        LogLevel.INFO,
        `Getting rev list from: ${pr.base.sha}..${pr.head.sha}`,
      );
      const commits = (
        await context.github.pulls.listCommits(
          context.repo({
            pull_number: pr.number,
          }),
        )
      ).data.map((commit: PullsListCommitsResponseItem) => commit.sha!);

      // No commits == WTF
      if (commits.length === 0) {
        log(
          'backportImpl',
          LogLevel.INFO,
          'Found no commits to backport - aborting backport process',
        );
        return;
      }

      // Over 240 commits is probably the limit from GitHub so let's not bother.
      if (commits.length >= 240) {
        log(
          'backportImpl',
          LogLevel.ERROR,
          `Too many commits (${commits.length})...backport will not be performed.`,
        );
        await context.github.issues.createComment(
          context.repo({
            issue_number: pr.number,
            body:
              'This PR has exceeded the automatic backport commit limit \
    and must be performed manually.',
          }),
        );

        return;
      }

      log(
        'backportImpl',
        LogLevel.INFO,
        `Found ${commits.length} commits to backport - requesting details now.`,
      );
      const patches: string[] = new Array(commits.length).fill('');
      const q = makeQueue({
        concurrency: 5,
      });
      q.stop();

      for (const [i, commit] of commits.entries()) {
        q.push(async () => {
          const patchUrl = `https://api.github.com/repos/${slug}/commits/${commit}`;
          const patchBody = await fetch(patchUrl, {
            headers: {
              Accept: 'application/vnd.github.VERSION.patch',
              Authorization: `token ${repoAccessToken}`,
            },
          });
          patches[i] = await patchBody.text();
          log(
            'backportImpl',
            LogLevel.INFO,
            `Got patch (${i + 1}/${commits.length})`,
          );
        });
      }

      await new Promise((r) => q.start(r));
      log('backportImpl', LogLevel.INFO, 'Got all commit info');

      // Create temporary branch name.
      const sanitizedTitle = pr.title
        .replace(/\*/g, 'x')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '-');
      const tempBranch = `trop/${targetBranch}-bp-${sanitizedTitle}-${Date.now()}`;

      log(
        'backportImpl',
        LogLevel.INFO,
        `Checking out target: "target_repo/${targetBranch}" to temp: "${tempBranch}"`,
      );
      log('backportImpl', LogLevel.INFO, 'Will start backporting now');

      await backportCommitsToBranch({
        dir,
        slug,
        targetBranch,
        tempBranch,
        patches,
        targetRemote: 'target_repo',
        shouldPush: purpose === BackportPurpose.ExecuteBackport,
      });

      log(
        'backportImpl',
        LogLevel.INFO,
        'Cherry pick success - pushed up to target_repo',
      );

      if (purpose === BackportPurpose.ExecuteBackport) {
        log('backportImpl', LogLevel.INFO, 'Creating Pull Request');
        const { data: newPr } = await context.github.pulls.create(
          context.repo({
            head: `${tempBranch}`,
            base: targetBranch,
            title: pr.title,
            body: createBackportComment(pr),
            maintainer_can_modify: false,
          }),
        );

        // If user has sufficient permissions (i.e has write access)
        // request their review on the automatically backported pull request
        if (await checkUserHasWriteAccess(context, pr.user.login)) {
          await context.github.pulls.createReviewRequest(
            context.repo({
              pull_number: newPr.number,
              reviewers: [pr.user.login],
            }),
          );
        }

        log('backportImpl', LogLevel.INFO, 'Adding breadcrumb comment');
        await context.github.issues.createComment(
          context.repo({
            issue_number: pr.number,
            body: `I have automatically backported this PR to "${targetBranch}", \
    please check out #${newPr.number}`,
          }),
        );

        if (labelToRemove) {
          await labelUtils.removeLabel(context, pr.number, labelToRemove);
        }

        if (labelToAdd) {
          await labelUtils.addLabel(context, pr.number, [labelToAdd]);
        }

        const labelsToAdd = ['backport', `${targetBranch}`];

        if (await isSemverMinorPR(context, pr)) {
          log(
            'backportImpl',
            LogLevel.INFO,
            `Determined that ${pr.number} is semver-minor`,
          );
          labelsToAdd.push(BACKPORT_REQUESTED_LABEL);
        }

        await labelUtils.addLabel(context, newPr.number!, labelsToAdd);

        log('backportImpl', LogLevel.INFO, 'Backport process complete');
      }

      if (purpose === BackportPurpose.Check) {
        const checkRun = await getCheckRun();
        if (checkRun) {
          context.github.checks.update(
            context.repo({
              check_run_id: checkRun.id,
              name: checkRun.name,
              conclusion: 'success' as 'success',
              completed_at: new Date().toISOString(),
              output: {
                title: 'Clean Backport',
                summary: `This PR was checked and can be backported to "${targetBranch}" cleanly.`,
              },
            }),
          );
        }
      }

      await fs.remove(createdDir);
    },
    async () => {
      let annotations: any[] | null = null;
      let diff;
      let rawDiff;
      if (createdDir) {
        const git = simpleGit(createdDir);
        rawDiff = await git.diff();
        diff = parseDiff(rawDiff);

        annotations = [];
        for (const file of diff) {
          if (file.binary) continue;

          for (const hunk of file.hunks || []) {
            const startOffset = hunk.lines.findIndex((line: string) =>
              line.includes('<<<<<<<'),
            );
            const endOffset =
              hunk.lines.findIndex((line: string) => line.includes('=======')) -
              2;
            const finalOffset = hunk.lines.findIndex((line: string) =>
              line.includes('>>>>>>>'),
            );
            annotations.push({
              path: file.filePath,
              start_line: hunk.theirStartLine + Math.max(0, startOffset),
              end_line: hunk.theirStartLine + Math.max(0, endOffset),
              annotation_level: 'failure',
              message: 'Patch Conflict',
              raw_details: hunk.lines
                .filter(
                  (_: any, i: number) => i >= startOffset && i <= finalOffset,
                )
                .join('\n'),
            });
          }
        }

        await fs.remove(createdDir);
      }

      const pr = context.payload.pull_request;
      if (purpose === BackportPurpose.ExecuteBackport) {
        await context.github.issues.createComment(
          context.repo({
            issue_number: pr.number,
            body: `I was unable to backport this PR to "${targetBranch}" cleanly;
   you will need to perform this backport manually.`,
          }) as any,
        );

        const labelToRemove = PRStatus.TARGET + targetBranch;
        await labelUtils.removeLabel(context, pr.number, labelToRemove);

        const labelToAdd = PRStatus.NEEDS_MANUAL + targetBranch;
        await labelUtils.addLabel(context, pr.number, [labelToAdd]);
      }

      if (purpose === BackportPurpose.Check) {
        const checkRun = await getCheckRun();
        if (checkRun) {
          const mdSep = '``````````````````````````````';
          const updateOpts: ChecksUpdateParams = context.repo({
            check_run_id: checkRun.id,
            name: checkRun.name,
            conclusion: 'neutral' as 'neutral',
            completed_at: new Date().toISOString(),
            output: {
              title: 'Backport Failed',
              summary: `This PR was checked and could not be automatically backported to "${targetBranch}" cleanly`,
              text: diff
                ? `Failed Diff:\n\n${mdSep}diff\n${rawDiff}\n${mdSep}`
                : undefined,
              annotations: annotations ? annotations : undefined,
            },
          });
          try {
            await context.github.checks.update(updateOpts as any);
          } catch (err) {
            // A GitHub error occurred - try to mark it as a failure without annotations.
            updateOpts.output!.annotations = undefined;
            await context.github.checks.update(updateOpts as any);
          }
        }
      }
    },
  );
};
