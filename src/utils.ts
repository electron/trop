import fetch from 'node-fetch';
import * as fs from 'fs-extra';
import { execSync } from 'child_process';
import Queue from 'queue';
import simpleGit from 'simple-git';

import queue from './Queue';
import {
  BACKPORT_REQUESTED_LABEL,
  DEFAULT_BACKPORT_REVIEW_TEAM,
  BACKPORT_LABEL,
  CHECK_PREFIX,
} from './constants';
import { PRStatus, BackportPurpose, LogLevel, PRChange } from './enums';

import * as labelUtils from './utils/label-utils';
import { initRepo } from './operations/init-repo';
import { setupRemotes } from './operations/setup-remotes';
import { backportCommitsToBranch } from './operations/backport-commits';
import { getRepoToken } from './utils/token-util';
import { getSupportedBranches, getBackportPattern } from './utils/branch-util';
import { getOrCreateCheckRun } from './utils/checks-util';
import { getEnvVar } from './utils/env-util';
import { log } from './utils/log-util';
import { TryBackportOptions } from './interfaces';
import { client, register } from './utils/prom';
import {
  SimpleWebHookRepoContext,
  WebHookIssueContext,
  WebHookPR,
  WebHookRepoContext,
} from './types';
import { Probot } from 'probot';

const { parse: parseDiff } = require('what-the-diff');

const backportViaAllHisto = new client.Histogram({
  name: 'backport_via_all',
  help: 'Successful backports via tryBackportAllCommits',
  buckets: [0, 100, 500, 1500, 3000, 5000, 10000],
});
const backportViaSquashHisto = new client.Histogram({
  name: 'backport_via_squash',
  help: 'Successful backports via tryBackportSquashCommit',
  buckets: [0, 100, 500, 1500, 3000, 5000, 10000],
});
register.registerMetric(backportViaAllHisto);
register.registerMetric(backportViaSquashHisto);

export const labelClosedPR = async (
  context: WebHookRepoContext,
  pr: WebHookPR,
  targetBranch: String,
  change: PRChange,
) => {
  log(
    'labelClosedPR',
    LogLevel.INFO,
    `Labeling original PRs for PR at #${pr.number}`,
  );

  const targetLabel = PRStatus.TARGET + targetBranch;

  if (change === PRChange.CLOSE) {
    await labelUtils.removeLabel(context, pr.number, targetLabel);
  }

  const backportNumbers = getPRNumbersFromPRBody(pr);
  for (const prNumber of backportNumbers) {
    const inFlightLabel = PRStatus.IN_FLIGHT + targetBranch;
    await labelUtils.removeLabel(context, prNumber, inFlightLabel);

    if (change === PRChange.MERGE) {
      const mergedLabel = PRStatus.MERGED + targetBranch;
      const needsManualLabel = PRStatus.NEEDS_MANUAL + targetBranch;

      // Add merged label to the original PR.
      await labelUtils.addLabels(context, prNumber, [mergedLabel]);

      // Remove the needs-manual-backport label from the original PR.
      await labelUtils.removeLabel(context, prNumber, needsManualLabel);

      // Remove the target label from the intermediate PR.
      await labelUtils.removeLabel(context, pr.number, targetLabel);
    }
  }
};

const tryBackportAllCommits = async (opts: TryBackportOptions) => {
  log(
    'backportImpl',
    LogLevel.INFO,
    `Getting rev list from: ${opts.pr.base.sha}..${opts.pr.head.sha}`,
  );

  const { context } = opts;
  if (!context) return;

  const commits = (
    await context.octokit.paginate(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits',
      context.repo({ pull_number: opts.pr.number, per_page: 100 }),
    )
  ).map((commit) => commit.sha);

  if (commits.length === 0) {
    log(
      'backportImpl',
      LogLevel.INFO,
      'Found no commits to backport - aborting backport process',
    );
    return false;
  }

  // Over 240 commits is probably the limit from GitHub so let's not bother.
  if (commits.length >= 240) {
    log(
      'backportImpl',
      LogLevel.ERROR,
      `Too many commits (${commits.length})...backport will not be performed.`,
    );
    await context.octokit.issues.createComment(
      context.repo({
        issue_number: opts.pr.number,
        body: 'This PR has exceeded the automatic backport commit limit \
and must be performed manually.',
      }),
    );

    return false;
  }

  log(
    'backportImpl',
    LogLevel.INFO,
    `Found ${commits.length} commits to backport - requesting details now.`,
  );

  const patches: string[] = new Array(commits.length).fill('');
  const q = new Queue({ concurrency: 5 });
  q.stop();

  for (const [i, commit] of commits.entries()) {
    q.push(async () => {
      const patchUrl = `https://api.github.com/repos/${opts.slug}/commits/${commit}`;
      const patchBody = await fetch(patchUrl, {
        headers: {
          Accept: 'application/vnd.github.VERSION.patch',
          Authorization: `token ${opts.repoAccessToken}`,
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

  await new Promise<void>((resolve, reject) =>
    q.start((err) => (err ? reject(err) : resolve())),
  );
  log('backportImpl', LogLevel.INFO, 'Got all commit info');

  log(
    'backportImpl',
    LogLevel.INFO,
    `Checking out target: "target_repo/${opts.targetBranch}" to temp: "${opts.tempBranch}"`,
  );

  const success = await backportCommitsToBranch({
    dir: opts.dir,
    slug: opts.slug,
    targetBranch: opts.targetBranch,
    tempBranch: opts.tempBranch,
    patches,
    targetRemote: 'target_repo',
    shouldPush: opts.purpose === BackportPurpose.ExecuteBackport,
    github: context.octokit,
    context,
  });

  if (success) {
    log(
      'backportImpl',
      LogLevel.INFO,
      'Cherry pick success - pushed up to target_repo',
    );
  }

  return success;
};

const tryBackportSquashCommit = async (opts: TryBackportOptions) => {
  // Fetch the merged squash commit.
  log('backportImpl', LogLevel.INFO, `Fetching squash commit details`);

  if (!opts.pr.merged) {
    log('backportImpl', LogLevel.INFO, `PR was not squash merged - aborting`);
    return false;
  }

  const patchUrl = `https://api.github.com/repos/${opts.slug}/commits/${opts.pr.merge_commit_sha}`;
  const patchBody = await fetch(patchUrl, {
    headers: {
      Accept: 'application/vnd.github.VERSION.patch',
      Authorization: `token ${opts.repoAccessToken}`,
    },
  });

  const rawPatch = await patchBody.text();
  let patch: string = '';
  let subjectLineFound = false;
  for (const patchLine of rawPatch.split('\n')) {
    if (patchLine.startsWith('Subject: ') && !subjectLineFound) {
      subjectLineFound = true;
      const branchAwarePatchLine = patchLine
        // Replace branch references in commit message with new branch
        .replaceAll(`(${opts.pr.base.ref})`, `${opts.targetBranch}`)
        // Replace PR references in squashed message with empty string
        .replaceAll(/ \(#[0-9]+\)$/g, '');
      patch += `${branchAwarePatchLine}\n`;
    } else {
      patch += `${patchLine}\n`;
    }
  }

  log('backportImpl', LogLevel.INFO, 'Got squash commit details');

  log(
    'backportImpl',
    LogLevel.INFO,
    `Checking out target: "target_repo/${opts.targetBranch}" to temp: "${opts.tempBranch}"`,
  );

  const success = await backportCommitsToBranch({
    dir: opts.dir,
    slug: opts.slug,
    targetBranch: opts.targetBranch,
    tempBranch: opts.tempBranch,
    patches: [patch],
    targetRemote: 'target_repo',
    shouldPush: opts.purpose === BackportPurpose.ExecuteBackport,
    github: opts.context.octokit,
    context: opts.context,
  });

  if (success) {
    log(
      'backportImpl',
      LogLevel.INFO,
      'Cherry pick success - pushed up to target_repo',
    );
  }

  return success;
};

export const isAuthorizedUser = async (
  context: WebHookIssueContext,
  username: string,
) => {
  const { data } = await context.octokit.repos.getCollaboratorPermissionLevel(
    context.repo({
      username,
    }),
  );

  return ['admin', 'write'].includes(data.permission);
};

export const getPRNumbersFromPRBody = (pr: WebHookPR, checkNotBot = false) => {
  const backportNumbers: number[] = [];

  const isBot = pr.user.login === getEnvVar('BOT_USER_NAME');
  if (checkNotBot && isBot) return backportNumbers;

  let match: RegExpExecArray | null;
  const backportPattern = getBackportPattern();
  while ((match = backportPattern.exec(pr.body || ''))) {
    // This might be the first or second capture group depending on if it's a link or not.
    backportNumbers.push(
      match[1] ? parseInt(match[1], 10) : parseInt(match[2], 10),
    );
  }

  return backportNumbers;
};

/**
 *
 * It can be the case that someone marks a PR for backporting via label or comment
 * which it *itself* a backport.
 *
 * In this case, we should ensure that the PR being passed is the original backport.
 * If it isn't, we should traverse via "Backport of #12345" links in each nested
 * backport until we arrive at the backport which is the original to ensure
 * optimal bookkeeping.
 *
 * TODO(codebytere): support multi-backports.
 *
 * @param context Context
 * @param pr Pull Request
 */
const getOriginalBackportNumber = async (
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
) => {
  let originalPR: Pick<WebHookPR, 'number' | 'body'> = pr;
  let match: RegExpExecArray | null;

  const backportPattern = getBackportPattern();
  while ((match = backportPattern.exec(originalPR.body || ''))) {
    // This might be the first or second capture group depending on if it's a link or not.
    const oldPRNumber = match[1]
      ? parseInt(match[1], 10)
      : parseInt(match[2], 10);

    // Fetch the PR body this PR is marked as backporting.
    const { data: pullRequest } = await context.octokit.pulls.get({
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      pull_number: oldPRNumber,
    });

    originalPR = pullRequest;
  }

  return originalPR.number;
};

export const isSemverMinorPR = async (
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
) => {
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

const checkUserHasWriteAccess = async (
  context: SimpleWebHookRepoContext,
  user: string,
) => {
  log(
    'checkUserHasWriteAccess',
    LogLevel.INFO,
    `Checking whether ${user} has write access`,
  );

  const params = context.repo({ username: user });
  const { data: userInfo } =
    await context.octokit.repos.getCollaboratorPermissionLevel(params);

  // Possible values for the permission key: 'admin', 'write', 'read', 'none'.
  // In order for the user's review to count, they must be at least 'write'.
  return ['write', 'admin'].includes(userInfo.permission);
};

const createBackportComment = async (
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
) => {
  const prNumber = await getOriginalBackportNumber(context, pr);

  log(
    'createBackportComment',
    LogLevel.INFO,
    `Creating backport comment for #${prNumber}`,
  );

  let body = `Backport of #${prNumber}\n\nSee that PR for details.`;

  const onelineMatch = pr.body?.match(
    /(?:(?:\r?\n)|^)notes: (.+?)(?:(?:\r?\n)|$)/gi,
  );
  const multilineMatch = pr.body?.match(
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

export const tagBackportReviewers = async ({
  context,
  targetPrNumber,
  user,
}: {
  context: SimpleWebHookRepoContext;
  targetPrNumber: number;
  user?: string;
}) => {
  const reviewers = [];
  const teamReviewers = [];

  if (DEFAULT_BACKPORT_REVIEW_TEAM) {
    // Optionally request a default review team for backports.
    // Use team slug value. i.e electron/wg-releases => wg-releases
    const slug =
      DEFAULT_BACKPORT_REVIEW_TEAM.split('/')[1] ||
      DEFAULT_BACKPORT_REVIEW_TEAM;
    teamReviewers.push(slug);
  }

  if (user) {
    const hasWrite = await checkUserHasWriteAccess(context, user);
    // If the PR author has write access, also request their review.
    if (hasWrite) reviewers.push(user);
  }

  if (Math.max(reviewers.length, teamReviewers.length) > 0) {
    try {
      await context.octokit.pulls.requestReviewers(
        context.repo({
          pull_number: targetPrNumber,
          reviewers,
          team_reviewers: teamReviewers,
        }),
      );
    } catch (error) {
      log(
        'tagBackportReviewers',
        LogLevel.ERROR,
        `Failed to request reviewers for PR #${targetPrNumber}`,
        error,
      );
    }
  }
};

export const backportImpl = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
  targetBranch: string,
  purpose: BackportPurpose,
  labelToRemove?: string,
  labelToAdd?: string,
) => {
  // Optionally disallow backports to EOL branches
  const noEOLSupport = getEnvVar('NO_EOL_SUPPORT', '');
  if (noEOLSupport) {
    const supported = await getSupportedBranches(context);
    const defaultBranch = context.payload.repository.default_branch;
    if (![defaultBranch, ...supported].includes(targetBranch)) {
      log(
        'backportImpl',
        LogLevel.WARN,
        `${targetBranch} is no longer supported - no backport will be initiated.`,
      );
      await context.octokit.issues.createComment(
        context.repo({
          body: `${targetBranch} is no longer supported - no backport will be initiated.`,
          issue_number: pr.number,
        }),
      );
      return;
    }
  }

  const gitExists = execSync('which git').toString().trim();
  if (/git not found/.test(gitExists)) {
    await context.octokit.issues.createComment(
      context.repo({
        body: `Git not found - unable to proceed with backporting to ${targetBranch}`,
        issue_number: pr.number,
      }),
    );
    return;
  }

  const base = pr.base;
  const slug = `${base.repo.owner.login}/${base.repo.name}`;
  const bp = `backport from PR #${pr.number} to "${targetBranch}"`;
  log('backportImpl', LogLevel.INFO, `Queuing ${bp} for "${slug}"`);

  let createdDir: string | null = null;

  queue.enterQueue(
    `backport-${pr.head.sha}-${targetBranch}-${purpose}`,
    async () => {
      log('backportImpl', LogLevel.INFO, `Executing ${bp} for "${slug}"`);
      const checkRun = await getOrCreateCheckRun(context, pr, targetBranch);
      log(
        'backportImpl',
        LogLevel.INFO,
        `Updating check run '${CHECK_PREFIX}${targetBranch}' (${checkRun.id}) with status 'in_progress'`,
      );
      await context.octokit.checks.update(
        context.repo({
          check_run_id: checkRun.id,
          name: checkRun.name,
          status: 'in_progress' as 'in_progress',
        }),
      );

      const repoAccessToken = await getRepoToken(robot, context);

      // Set up empty repo on main.
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

      // Create temporary branch name.
      const sanitizedTitle = pr.title
        .replace(/\*/g, 'x')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '-');
      const tempBranch = `trop/${targetBranch}-bp-${sanitizedTitle}-${Date.now()}`;

      // First try to backport all commits in the original PR.
      const end = backportViaAllHisto.startTimer();
      let success = await tryBackportAllCommits({
        context,
        repoAccessToken,
        purpose,
        pr,
        dir,
        slug,
        targetBranch,
        tempBranch,
      });
      end();

      // If that fails, try to backport the squash commit.
      if (!success) {
        const end = backportViaSquashHisto.startTimer();
        success = await tryBackportSquashCommit({
          context,
          repoAccessToken,
          purpose,
          pr,
          dir,
          slug,
          targetBranch,
          tempBranch,
        });
        end();
      }

      console.log(
        JSON.stringify({
          msg: 'backport-result',
          pullRequest: pr.number,
          backportPurpose: purpose,
          success,
        }),
      );

      // Throw if neither succeeded - if we don't we
      // never enter the ErrorExecutor and the check hangs.
      if (!success) {
        log(
          'backportImpl',
          LogLevel.ERROR,
          `Cherry picking commits to branch failed`,
        );

        throw new Error(`Cherry picking commit(s) to branch failed`);
      }

      if (purpose === BackportPurpose.ExecuteBackport) {
        log('backportImpl', LogLevel.INFO, 'Creating Pull Request');

        const branchAwarePrTitle = pr.title.replaceAll(
          `(${pr.base.ref})`,
          `(${targetBranch})`,
        );

        const { data: newPr } = await context.octokit.pulls.create(
          context.repo({
            head: `${tempBranch}`,
            base: targetBranch,
            title: branchAwarePrTitle,
            body: await createBackportComment(context, pr),
            maintainer_can_modify: false,
          }),
        );

        await tagBackportReviewers({
          context,
          targetPrNumber: newPr.number,
          user: pr.user.login,
        });

        log(
          'backportImpl',
          LogLevel.INFO,
          `Adding breadcrumb comment to ${pr.number}`,
        );
        await context.octokit.issues.createComment(
          context.repo({
            issue_number: pr.number,
            body: `I have automatically backported this PR to "${targetBranch}", \
    please check out #${newPr.number}`,
          }),
        );

        // TODO(codebytere): getOriginalBackportNumber doesn't support multi-backports yet,
        // so only try if the backport is a single backport.
        const backportNumbers = getPRNumbersFromPRBody(pr);
        const originalPRNumber =
          backportNumbers.length === 1
            ? await getOriginalBackportNumber(context, pr)
            : pr.number;

        if (labelToAdd) {
          await labelUtils.addLabels(context, originalPRNumber, [labelToAdd]);
        }

        if (labelToRemove) {
          await labelUtils.removeLabel(
            context,
            originalPRNumber,
            labelToRemove,
          );
        } else if (labelToAdd?.startsWith(PRStatus.IN_FLIGHT)) {
          await labelUtils.removeLabel(
            context,
            originalPRNumber,
            `${PRStatus.NEEDS_MANUAL}${targetBranch}`,
          );
        }

        const labelsToAdd = [BACKPORT_LABEL, `${targetBranch}`];

        if (await isSemverMinorPR(context, pr)) {
          log(
            'backportImpl',
            LogLevel.INFO,
            `Determined that ${pr.number} is semver-minor`,
          );
          labelsToAdd.push(BACKPORT_REQUESTED_LABEL);
        }

        const semverLabel = labelUtils.getSemverLabel(pr);
        if (semverLabel) {
          // If the new PR for some reason has a semver label already, then
          // we need to compare the two semver labels and ensure the higher one
          // takes precedence.
          const newPRSemverLabel = labelUtils.getSemverLabel(newPr);
          if (newPRSemverLabel && newPRSemverLabel.name !== semverLabel.name) {
            const higherLabel = labelUtils.getHighestSemverLabel(
              semverLabel.name,
              newPRSemverLabel.name,
            );
            // The existing label is lower precedence - remove and replace it.
            if (higherLabel === semverLabel.name) {
              await labelUtils.removeLabel(
                context,
                newPr.number,
                newPRSemverLabel.name,
              );
              labelsToAdd.push(semverLabel.name);
            }
          } else {
            labelsToAdd.push(semverLabel.name);
          }
        }

        await labelUtils.addLabels(context, newPr.number, labelsToAdd);

        log('backportImpl', LogLevel.INFO, 'Backport process complete');
      }

      log(
        'backportImpl',
        LogLevel.INFO,
        `Updating check run '${CHECK_PREFIX}${targetBranch}' (${checkRun.id}) with conclusion 'success'`,
      );

      await context.octokit.checks.update(
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

      if (purpose === BackportPurpose.ExecuteBackport) {
        await context.octokit.issues.createComment(
          context.repo({
            issue_number: pr.number,
            body: `I was unable to backport this PR to "${targetBranch}" cleanly;
   you will need to perform this [backport manually](https://github.com/electron/trop/blob/main/docs/manual-backports.md#manual-backports).`,
          }),
        );

        const labelToRemove = PRStatus.TARGET + targetBranch;
        await labelUtils.removeLabel(context, pr.number, labelToRemove);

        const labelToAdd = PRStatus.NEEDS_MANUAL + targetBranch;
        const originalBackportNumber = await getOriginalBackportNumber(
          context,
          pr,
        );
        await labelUtils.addLabels(context, originalBackportNumber, [
          labelToAdd,
        ]);
      }

      const checkRun = await getOrCreateCheckRun(context, pr, targetBranch);
      const mdSep = '``````````````````````````````';
      const updateOpts = context.repo({
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
      log(
        'backportImpl',
        LogLevel.INFO,
        `Updating check run '${CHECK_PREFIX}${targetBranch}' (${checkRun.id}) with conclusion 'neutral'`,
      );
      try {
        await context.octokit.checks.update(updateOpts);
      } catch (err) {
        // A GitHub error occurred - try to mark it as a failure without annotations.
        updateOpts.output!.annotations = undefined;
        await context.octokit.checks.update(updateOpts);
      }
    },
  );
};
