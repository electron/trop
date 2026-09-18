import * as fs from 'fs';
import fetch from 'node-fetch';
import { execSync } from 'child_process';
import Queue from 'queue';
import simpleGit from 'simple-git';

import queue from './Queue';
import {
  BACKPORT_REQUESTED_LABEL,
  DEFAULT_BACKPORT_REVIEW_TEAM,
  BACKPORT_LABEL,
  CHECK_PREFIX,
  SEMVER_LABELS,
} from './constants';
import { PRStatus, BackportPurpose, LogLevel, PRChange } from './enums';

import * as labelUtils from './utils/label-utils';
import { initRepo } from './operations/init-repo';
import { setupRemotes } from './operations/setup-remotes';
import { backportCommitsToBranch } from './operations/backport-commits';
import { getRepoToken } from './utils/token-util';
import { getSupportedBranches, getBackportPattern } from './utils/branch-util';
import {
  CHECK_RUN_MAX_ANNOTATIONS,
  getOrCreateCheckRun,
  markBackportCheckFailed,
  truncateAnnotationDetails,
} from './utils/checks-util';
import { getEffectiveBaseRef } from './utils/stack-util';
import { getEnvVar } from './utils/env-util';
import { log } from './utils/log-util';
import { TryBackportOptions } from './interfaces';
import { client, register } from './utils/prom';
import {
  SimpleWebHookRepoContext,
  WebHookPR,
  WebHookRepoContext,
} from './types';
import { Probot } from 'probot';

import { parse as parseDiff } from 'what-the-diff';

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
  targetBranch: string,
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
  const { context } = opts;
  if (!context) return;

  // Gather the commits of every PR bottom to top so a stack applies in the
  // order it landed.
  const commits: string[] = [];
  for (const pr of opts.prs) {
    log(
      'backportImpl',
      LogLevel.INFO,
      `Getting rev list from: ${pr.base.sha}..${pr.head.sha}`,
    );

    const allCommits = await context.octokit.paginate(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits',
      context.repo({ pull_number: pr.number, per_page: 100 }),
    );

    const mergeCommits = allCommits.filter((c) => c.parents.length > 1);
    if (mergeCommits.length > 0) {
      log(
        'backportImpl',
        LogLevel.INFO,
        `Skipping ${mergeCommits.length} merge commit(s) from PR #${pr.number}: ${mergeCommits.map((c) => c.sha).join(', ')}`,
      );
    }

    commits.push(
      ...allCommits
        .filter((commit) => commit.parents.length <= 1)
        .map((commit) => commit.sha),
    );
  }

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
        issue_number: opts.prs[opts.prs.length - 1].number,
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

const fetchSquashPatch = async (opts: TryBackportOptions, pr: WebHookPR) => {
  const patchUrl = `https://api.github.com/repos/${opts.slug}/commits/${pr.merge_commit_sha}`;
  const patchBody = await fetch(patchUrl, {
    headers: {
      Accept: 'application/vnd.github.VERSION.patch',
      Authorization: `token ${opts.repoAccessToken}`,
    },
  });

  const rawPatch = await patchBody.text();
  let patch = '';
  let subjectLineFound = false;
  for (const patchLine of rawPatch.split('\n')) {
    if (patchLine.startsWith('Subject: ') && !subjectLineFound) {
      subjectLineFound = true;
      const branchAwarePatchLine = patchLine
        // Replace branch references in commit message with new branch
        .replaceAll(`(${getEffectiveBaseRef(pr)})`, `${opts.targetBranch}`)
        // Replace PR references in squashed message with empty string
        .replaceAll(/ \(#[0-9]+\)$/g, '');
      patch += `${branchAwarePatchLine}\n`;
    } else {
      patch += `${patchLine}\n`;
    }
  }

  return patch;
};

const tryBackportSquashCommit = async (opts: TryBackportOptions) => {
  // Fetch the merged squash commit(s).
  log('backportImpl', LogLevel.INFO, `Fetching squash commit details`);

  if (opts.prs.some((pr) => !pr.merged)) {
    log('backportImpl', LogLevel.INFO, `PR was not squash merged - aborting`);
    return false;
  }

  const patches: string[] = [];
  for (const pr of opts.prs) {
    patches.push(await fetchSquashPatch(opts, pr));
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
    patches,
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

export const shouldRequestBackportApproval = async (
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
) => {
  log(
    'shouldRequestBackportApproval',
    LogLevel.INFO,
    `Checking if #${pr.number} requires backport approval`,
  );

  const hasPrefix =
    pr.title.startsWith('feat:') || pr.title.startsWith('feat!:');
  if (hasPrefix) return true;

  const approvalLabels = [SEMVER_LABELS.MINOR, SEMVER_LABELS.MAJOR];
  for (const label of approvalLabels) {
    if (await labelUtils.labelExistsOnPR(context, pr.number, label)) {
      return true;
    }
  }

  return false;
};

export const checkUserHasWriteAccess = async (
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

const ONELINE_NOTES_PATTERN = /(?:(?:\r?\n)|^)notes: (.+?)(?:(?:\r?\n)|$)/i;
const MULTILINE_NOTES_PATTERN =
  /(?:(?:\r?\n)Notes:(?:\r?\n)((?:\*.+(?:(?:\r?\n)|$))+))/i;

/**
 * Extracts the release notes from a PR body: `raw` is the matched text as it
 * appears in the body, `bullets` the same notes as `* ` list items.
 */
const getReleaseNotes = (body: string | null | undefined) => {
  const onelineMatch = body?.match(ONELINE_NOTES_PATTERN);
  if (onelineMatch) {
    return { raw: onelineMatch[0], bullets: [`* ${onelineMatch[1].trim()}`] };
  }

  const multilineMatch = body?.match(MULTILINE_NOTES_PATTERN);
  if (multilineMatch) {
    return {
      raw: multilineMatch[0],
      bullets: multilineMatch[1]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    };
  }

  return null;
};

const NO_NOTES_PATTERN = /^\* (none|no[- ]notes)\.?$/i;

/**
 * Builds the body of a backport PR for one or more original PRs (a merged
 * stack is backported as one PR, listed bottom to top).
 */
export const createBackportComment = async (
  context: SimpleWebHookRepoContext,
  prs: WebHookPR[],
) => {
  const prNumbers: number[] = [];
  for (const pr of prs) {
    prNumbers.push(await getOriginalBackportNumber(context, pr));
  }

  log(
    'createBackportComment',
    LogLevel.INFO,
    `Creating backport comment for ${prNumbers.map((n) => `#${n}`).join(', ')}`,
  );

  let body = prNumbers.map((n) => `Backport of #${n}`).join('\n');
  body += `\n\nSee ${prs.length > 1 ? 'those PRs' : 'that PR'} for details.`;

  // attach release notes to backport PR body
  let notes = prs
    .map((pr) => getReleaseNotes(pr.body))
    .filter((n): n is NonNullable<typeof n> => n !== null);
  if (notes.length > 1) {
    // Combining notes from several PRs: drop the ones that say "none".
    notes = notes.filter(
      (n) => !n.bullets.every((b) => NO_NOTES_PATTERN.test(b)),
    );
  }

  if (notes.length === 0) {
    body += '\n\nNotes: no-notes';
  } else if (notes.length === 1) {
    body += `\n\n${notes[0].raw}`;
  } else {
    body += `\n\nNotes:\n${notes.flatMap((n) => n.bullets).join('\n')}\n`;
  }

  return body;
};

/**
 * The semver label a backport of `prs` should carry: the highest one among
 * them.
 */
const getStackSemverLabel = (prs: WebHookPR[]) => {
  const labels = prs
    .map((pr) => labelUtils.getSemverLabel(pr))
    .filter((label): label is NonNullable<typeof label> => !!label);
  if (labels.length <= 1) return labels[0];

  const highest = labelUtils.getHighestSemverLabel(
    ...labels.map((label) => label.name),
  );
  return labels.find((label) => label.name === highest);
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

export const updatePRBranch = async (
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
) => {
  log(
    'updatePRBranch',
    LogLevel.INFO,
    `Updating #${pr.number} by merging the latest changes from "${pr.base.ref}"`,
  );

  // Don't use the REBASE update method, as it would create unverified commits
  const mutation = `mutation UpdatePullRequestBranch($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
    updatePullRequestBranch(input: {
      pullRequestId: $pullRequestId,
      expectedHeadOid: $expectedHeadOid,
      updateMethod: MERGE
    }) {
      pullRequest {
        number
      }
    }
  }`;

  try {
    await context.octokit.graphql(mutation, {
      pullRequestId: pr.node_id,
      expectedHeadOid: pr.head.sha,
    });
  } catch (error) {
    log(
      'updatePRBranch',
      LogLevel.ERROR,
      `Failed to update branch for #${pr.number}`,
      error,
    );

    const isConflict = (error as Error)?.message?.includes(
      'merge conflict between base and head',
    );

    await context.octokit.issues.createComment(
      context.repo({
        issue_number: pr.number,
        body: isConflict
          ? `This branch could not be updated because there is a merge conflict with \`${pr.base.ref}\`. Please resolve the conflict manually.`
          : `I was unable to update this branch with the latest changes from \`${pr.base.ref}\`. Please update it manually.`,
      }),
    );

    return;
  }

  await context.octokit.issues.createComment(
    context.repo({
      issue_number: pr.number,
      body: `This branch has been updated with the latest changes from \`${pr.base.ref}\`.`,
    }),
  );
};

export const backportImpl = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
  targetBranch: string,
  purpose: BackportPurpose,
  labelToRemove?: string,
  labelToAdd?: string,
) =>
  backportStackImpl(
    robot,
    context,
    [pr],
    targetBranch,
    purpose,
    labelToRemove,
    labelToAdd,
  );

/**
 * Backports one or more PRs to `targetBranch` as a single pull request.
 *
 * `prs` is ordered bottom to top; the last entry is the PR that drives the
 * backport (check run, title, reviewer, comments) - for a stack that is the
 * top PR, whose merge landed the whole stack.
 */
export const backportStackImpl = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  prs: WebHookPR[],
  targetBranch: string,
  purpose: BackportPurpose,
  labelToRemove?: string,
  labelToAdd?: string,
) => {
  const pr = prs[prs.length - 1];

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

  const gitExists = execSync('which git', { encoding: 'utf-8' }).trim();
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
  const bp = `backport from PR ${prs
    .map((p) => `#${p.number}`)
    .join(', ')} to "${targetBranch}"`;
  log('backportImpl', LogLevel.INFO, `Queuing ${bp} for "${slug}"`);

  let createdDir: string | null = null;

  queue.enterQueue(
    `backport-${pr.head.sha}-${targetBranch}-${purpose}`,
    async () => {
      log('backportImpl', LogLevel.INFO, `Executing ${bp} for "${slug}"`);
      const checkRun = await getOrCreateCheckRun(context, pr, targetBranch, {
        supersedeCompleted: purpose === BackportPurpose.Check,
      });
      log(
        'backportImpl',
        LogLevel.INFO,
        `Updating check run '${CHECK_PREFIX}${targetBranch}' (${checkRun.id}) with status 'in_progress'`,
      );
      await context.octokit.checks.update(
        context.repo({
          check_run_id: checkRun.id,
          name: checkRun.name,
          status: 'in_progress' as const,
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
        prs,
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
          prs,
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
          `(${getEffectiveBaseRef(pr)})`,
          `(${targetBranch})`,
        );

        const { data: newPr } = await context.octokit.pulls.create(
          context.repo({
            head: `${tempBranch}`,
            base: targetBranch,
            title: branchAwarePrTitle,
            body: await createBackportComment(context, prs),
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

        // Every backported PR gets its labels updated, not only the top one.
        for (const member of prs) {
          // TODO(codebytere): getOriginalBackportNumber doesn't support multi-backports yet,
          // so only try if the backport is a single backport.
          const backportNumbers = getPRNumbersFromPRBody(member);
          const originalPRNumber =
            backportNumbers.length === 1
              ? await getOriginalBackportNumber(context, member)
              : member.number;

          if (labelToAdd) {
            await labelUtils.addLabels(context, originalPRNumber, [labelToAdd]);
          }

          if (labelToRemove) {
            await labelUtils.removeLabel(
              context,
              originalPRNumber,
              labelToRemove,
            );
          }

          if (labelToAdd?.startsWith(PRStatus.IN_FLIGHT)) {
            await labelUtils.removeLabel(
              context,
              originalPRNumber,
              `${PRStatus.NEEDS_MANUAL}${targetBranch}`,
            );
          }
        }

        const labelsToAdd = [BACKPORT_LABEL, `${targetBranch}`];

        for (const member of prs) {
          if (await shouldRequestBackportApproval(context, member)) {
            log(
              'backportImpl',
              LogLevel.INFO,
              `Determined that ${member.number} requires backport approval`,
            );
            labelsToAdd.push(BACKPORT_REQUESTED_LABEL);
            break;
          }
        }

        const semverLabel = getStackSemverLabel(prs);
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
          conclusion: 'success' as const,
          completed_at: new Date().toISOString(),
          output: {
            title: 'Clean Backport',
            summary: `This PR was checked and can be backported to "${targetBranch}" cleanly.`,
          },
        }),
      );

      await fs.promises.rm(createdDir, { force: true, recursive: true });
    },
    async () => {
      let annotations: unknown[] | null = null;
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
              raw_details: truncateAnnotationDetails(
                hunk.lines
                  .filter(
                    (_: unknown, i: number) =>
                      i >= startOffset && i <= finalOffset,
                  )
                  .join('\n'),
              ),
            });
          }
        }

        // GitHub accepts at most 50 annotations per check run update; the
        // full conflict is still available in the diff text.
        annotations = annotations.slice(0, CHECK_RUN_MAX_ANNOTATIONS);

        await fs.promises.rm(createdDir, { force: true, recursive: true });
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
        const labelToAdd = PRStatus.NEEDS_MANUAL + targetBranch;
        for (const member of prs) {
          await labelUtils.removeLabel(context, member.number, labelToRemove);

          const originalBackportNumber = await getOriginalBackportNumber(
            context,
            member,
          );
          await labelUtils.addLabels(context, originalBackportNumber, [
            labelToAdd,
          ]);
        }
      }

      const checkRun = await getOrCreateCheckRun(context, pr, targetBranch, {
        supersedeCompleted: purpose === BackportPurpose.Check,
      });
      await markBackportCheckFailed(context, checkRun, targetBranch, {
        rawDiff: diff ? rawDiff : undefined,
        annotations: annotations ? annotations : undefined,
      });
    },
  );
};
