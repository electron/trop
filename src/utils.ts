import fetch from 'node-fetch';
import { execSync } from 'child_process';
import Queue from 'queue';

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
import { getRepoToken } from './utils/token-util';
import {
  BackportAttempt,
  BackportCommit,
  runSandboxedBackport,
} from './sandbox';
import { OriginalFile } from './sandbox/backstop';
import { createBackportCommits } from './sandbox/commits';
import { commitMessage, PatchError, splitPatch } from './sandbox/patches';
import { SandboxInfraError } from './sandbox/runner';
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

/**
 * The patches of every commit of the PRs (bottom to top), or null if there
 * are none or too many to backport this way.
 */
const getAllCommitsAttempt = async (
  opts: TryBackportOptions,
): Promise<BackportAttempt | null> => {
  const { context } = opts;

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
    return null;
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

    return null;
  }

  log(
    'backportImpl',
    LogLevel.INFO,
    `Found ${commits.length} commits to backport - requesting details now.`,
  );

  const backportCommits: BackportCommit[] = new Array(commits.length);
  let unusable = false;
  const q = new Queue({ concurrency: 5 });
  q.stop();

  for (const [i, commit] of commits.entries()) {
    q.push(async () => {
      try {
        backportCommits[i] = await fetchBackportCommit(opts, commit);
      } catch (error) {
        // A patch `git am` could never apply (as trop used to find out
        // only once it tried): this attempt fails, the squash may not.
        if (!(error instanceof PatchError)) throw error;
        log(
          'backportImpl',
          LogLevel.WARN,
          `Cannot backport all commits: ${error.message}`,
        );
        unusable = true;
        return;
      }
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
  if (unusable) return null;

  return { kind: 'all', commits: backportCommits };
};

const FILES_RETRY_DELAY_MS = process.env.VITEST ? 0 : 2000;

/** GETs a commit from the REST API in one of its text media types. */
const fetchCommitAs = async (
  opts: TryBackportOptions,
  sha: string,
  type: 'patch' | 'diff',
) => {
  const url = `https://api.github.com/repos/${opts.slug}/commits/${sha}`;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      headers: {
        Accept: `application/vnd.github.VERSION.${type}`,
        Authorization: `token ${opts.repoAccessToken}`,
      },
    });
    if (response.ok) return response.text();
    if (response.status < 500 || attempt === 3) {
      // trop used to hand the error body to `git am`, which failed on it,
      // so the attempt failed: same here.
      throw new PatchError(
        `Fetching the ${type} of ${sha} failed: ${response.status}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
};

/**
 * GitHub's list of files for a commit (up to the API's 3000). The backstop
 * needs it, so a backport that can't get it fails as an internal error.
 */
const fetchCommitFiles = async (
  opts: TryBackportOptions,
  sha: string,
): Promise<OriginalFile[]> => {
  for (let attempt = 1; ; attempt++) {
    try {
      const files: OriginalFile[] = [];
      for (let page = 1; page <= 30; page++) {
        const { data } = await opts.context.octokit.repos.getCommit(
          opts.context.repo({ ref: sha, per_page: 100, page }),
        );
        for (const f of data.files ?? []) {
          files.push({
            filename: f.filename,
            previousFilename: f.previous_filename,
            status: f.status,
            sha: f.sha,
          });
        }
        if ((data.files?.length ?? 0) < 100) break;
      }
      return files;
    } catch (error) {
      log(
        'backportImpl',
        LogLevel.WARN,
        `Could not list the files of ${sha} (attempt ${attempt})`,
        error,
      );
      if (attempt === 3) {
        throw new SandboxInfraError(
          `Could not list the files of ${sha} from GitHub`,
        );
      }
      await new Promise((r) => setTimeout(r, FILES_RETRY_DELAY_MS * attempt));
    }
  }
};

/**
 * Everything the sandbox and the server need about one commit: its diff,
 * cut out of its `.patch` against its `.diff` so no part of the message can
 * be applied, and the message and author `git am` would have given it.
 * `editPatch` adjusts the patch text first (the squash subject rewrite).
 */
const fetchBackportCommit = async (
  opts: TryBackportOptions,
  sha: string,
  editPatch: (patch: string) => string = (p) => p,
): Promise<BackportCommit> => {
  const [patch, diff, files] = await Promise.all([
    fetchCommitAs(opts, sha, 'patch'),
    fetchCommitAs(opts, sha, 'diff'),
    fetchCommitFiles(opts, sha),
  ]);
  const { head, diff: own } = splitPatch(editPatch(patch), diff);
  const { message, author } = commitMessage(head);
  if (!author) throw new PatchError(`The patch of ${sha} has no author`);
  return { diff: own, message, author, files };
};

/**
 * The squash commit's `.patch` with its subject made branch-aware, as trop
 * has always done: the PR's base branch replaced by the target, and the
 * trailing PR number dropped.
 */
const editSquashPatch =
  (opts: TryBackportOptions, pr: WebHookPR) => (rawPatch: string) => {
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

/**
 * The squash-merge commits of the PRs, or null if any of them is unmerged.
 */
const getSquashAttempt = async (
  opts: TryBackportOptions,
): Promise<BackportAttempt | null> => {
  // Fetch the merged squash commit(s).
  log('backportImpl', LogLevel.INFO, `Fetching squash commit details`);

  if (opts.prs.some((pr) => !pr.merged)) {
    log('backportImpl', LogLevel.INFO, `PR was not squash merged - skipping`);
    return null;
  }

  const commits: BackportCommit[] = [];
  for (const pr of opts.prs) {
    commits.push(
      await fetchBackportCommit(
        opts,
        pr.merge_commit_sha!,
        editSquashPatch(opts, pr),
      ),
    );
  }

  log('backportImpl', LogLevel.INFO, 'Got squash commit details');

  return { kind: 'squash', commits };
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

/**
 * The human users whose latest review on PR `prNumber` is an approval. A
 * later CHANGES_REQUESTED review supersedes an approval, a dismissed approval
 * shows up with state DISMISSED, and COMMENTED reviews leave it standing.
 */
export const getPRApprovers = async (
  context: SimpleWebHookRepoContext,
  prNumber: number,
) => {
  const reviews = await context.octokit.paginate(
    context.octokit.pulls.listReviews,
    context.repo({ pull_number: prNumber, per_page: 100 }),
  );

  // Reviews are returned in chronological order.
  const approved = new Map<string, boolean>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || review.user?.type === 'Bot' || login.endsWith('[bot]')) {
      continue;
    }
    if (review.state === 'APPROVED') {
      approved.set(login, true);
    } else if (['CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      approved.set(login, false);
    }
  }

  return [...approved].filter(([, isApproved]) => isApproved).map(([l]) => l);
};

export const tagBackportReviewers = async ({
  context,
  targetPrNumber,
  users = [],
}: {
  context: SimpleWebHookRepoContext;
  targetPrNumber: number;
  users?: string[];
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

  for (const user of new Set(users)) {
    // Only request review from users with write access, whose reviews count.
    if (await checkUserHasWriteAccess(context, user)) reviewers.push(user);
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
) =>
  backportUnitsImpl(robot, context, [prs], targetBranch, purpose, {
    labelToRemove,
    labelToAdd,
  });

export interface BatchBackportOptions {
  labelToRemove?: string;
  labelToAdd?: string;
  /**
   * Called once the backport is over, however it ended; `retryable` if an
   * internal error stopped it and it can be tried again.
   */
  onSettled?: (retryable: boolean) => void;
}

/**
 * Backports a batch of merged PRs to `targetBranch` as a single pull request.
 *
 * `units` are ordered by merge; each is a single PR or a stack (bottom to
 * top), whose last PR is the one that was queued for the batch. They are
 * applied in that order, and a unit that does not apply on top of the ones
 * before it is left out of the backport and flagged for a manual backport,
 * while the rest still go out together.
 */
export const backportBatchImpl = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  units: WebHookPR[][],
  targetBranch: string,
  options: BatchBackportOptions = {},
) =>
  backportUnitsImpl(
    robot,
    context,
    units,
    targetBranch,
    BackportPurpose.ExecuteBackport,
    { ...options, batch: true },
  );

/**
 * Removes `target/<targetBranch>` from `prs` and flags them (or the PRs
 * they backport) with `needs-manual-bp/<targetBranch>`.
 */
const flagForManualBackport = async (
  context: SimpleWebHookRepoContext,
  prs: WebHookPR[],
  targetBranch: string,
) => {
  const labelToRemove = PRStatus.TARGET + targetBranch;
  const labelToAdd = PRStatus.NEEDS_MANUAL + targetBranch;
  for (const member of prs) {
    await labelUtils.removeLabel(context, member.number, labelToRemove);

    const originalBackportNumber = await getOriginalBackportNumber(
      context,
      member,
    );
    await labelUtils.addLabels(context, originalBackportNumber, [labelToAdd]);
  }
};

const MANUAL_BACKPORT_LINK =
  '[backport manually](https://github.com/electron/trop/blob/main/docs/manual-backports.md#manual-backports)';

/**
 * Backports `units` to `targetBranch` as a single pull request. Each unit is
 * a single PR or a stack, ordered bottom to top; its last PR is the one that
 * carries its labels, check run and comments. Without `batch` there is one
 * unit and it is backported (or fails) as a whole; with `batch` the units
 * are applied one after another and those that don't apply are left out.
 */
const backportUnitsImpl = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  units: WebHookPR[][],
  targetBranch: string,
  purpose: BackportPurpose,
  {
    labelToRemove,
    labelToAdd,
    batch = false,
    onSettled,
  }: BatchBackportOptions & { batch?: boolean },
) => {
  const prs = units.flat();
  const tops = units.map((unit) => unit[unit.length - 1]);
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
      for (const top of tops) {
        await context.octokit.issues.createComment(
          context.repo({
            body: `${targetBranch} is no longer supported - no backport will be initiated.`,
            issue_number: top.number,
          }),
        );
      }
      // Otherwise the PRs would stay queued for every batch to come.
      if (batch && labelToRemove) {
        for (const p of prs) {
          await labelUtils.removeLabel(context, p.number, labelToRemove);
        }
      }
      onSettled?.(false);
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
    onSettled?.(false);
    return;
  }

  const base = pr.base;
  const slug = `${base.repo.owner.login}/${base.repo.name}`;
  const bp = `${batch ? 'batch ' : ''}backport from PR ${prs
    .map((p) => `#${p.number}`)
    .join(', ')} to "${targetBranch}"`;
  log('backportImpl', LogLevel.INFO, `Queuing ${bp} for "${slug}"`);

  // Whether an internal error stopped the backport, to be retried.
  let retryable = false;

  // The conflict diff from the sandbox job, for the check run's annotations:
  // empty once a job ran, undefined if none did.
  let conflictDiff: string | undefined;

  const getCheckRun = (p: WebHookPR) =>
    getOrCreateCheckRun(context, p, targetBranch, {
      supersedeCompleted: purpose === BackportPurpose.Check,
    });

  queue.enterQueue(
    batch
      ? `batch-backport-${prs.map((p) => p.number).join('-')}-${targetBranch}`
      : `backport-${pr.head.sha}-${targetBranch}-${purpose}`,
    async () => {
      log('backportImpl', LogLevel.INFO, `Executing ${bp} for "${slug}"`);
      const checkRuns = new Map<
        number,
        Awaited<ReturnType<typeof getOrCreateCheckRun>>
      >();
      for (const top of tops) {
        const checkRun = await getCheckRun(top);
        checkRuns.set(top.number, checkRun);
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
      }

      const repoAccessToken = await getRepoToken(robot, context);
      // As before the sandbox, a failure from here on reports an (empty)
      // diff with the failed check, a conflict its diff.
      conflictDiff = '';

      // Create temporary branch name.
      const sanitizedTitle = batch
        ? `batch-${tops.map((top) => top.number).join('-')}`
        : pr.title
            .replace(/\*/g, 'x')
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, '-');
      const tempBranch = `trop/${targetBranch}-bp-${sanitizedTitle}-${Date.now()}`;

      const tryOpts = {
        context,
        repoAccessToken,
        purpose,
        prs,
        slug,
        targetBranch,
      };

      // First try to backport all commits of the PRs, and if they don't
      // apply, their squash commit(s). Both are tried in one sandbox job.
      const getAttempts = async (unitPrs: WebHookPR[]) => {
        const opts = { ...tryOpts, prs: unitPrs };
        let squashError: unknown;
        const attempts = (
          await Promise.all([
            getAllCommitsAttempt(opts),
            // Fetched up front so both run in one sandbox job; trop used to
            // fetch it only after the first attempt failed, so a failure to
            // fetch it doesn't fail the backport.
            getSquashAttempt(opts).catch((error: unknown) => {
              log(
                'backportImpl',
                LogLevel.WARN,
                'Could not fetch the squash commit(s)',
                error,
              );
              // A patch `git am` could never apply just fails the attempt;
              // anything else only matters if the squash is needed.
              if (!(error instanceof PatchError)) squashError = error;
              return null;
            }),
          ])
        ).filter((attempt): attempt is BackportAttempt => attempt !== null);
        return { attempts, squashError };
      };

      // The units handed to the sandbox, by index into `units`: a unit with
      // nothing to backport can't apply, so it is left out up front.
      const candidates: { index: number; attempts: BackportAttempt[] }[] = [];
      let squashError: unknown;
      for (const [index, unit] of units.entries()) {
        const found = await getAttempts(unit);
        if (
          batch &&
          found.squashError instanceof SandboxInfraError &&
          found.squashError.retryable &&
          !found.attempts.some((a) => a.kind === 'all')
        ) {
          // Only its squash commit(s) might apply this unit, and GitHub did
          // not answer for them: retry the batch rather than leave it out.
          throw found.squashError;
        }
        // Otherwise a unit of a batch with nothing that can be applied is
        // left out below, like one that conflicts.
        if (!batch) squashError = found.squashError;
        if (found.attempts.length > 0) {
          candidates.push({ index, attempts: found.attempts });
        }
      }
      if (candidates.length === 0) {
        if (squashError instanceof SandboxInfraError) throw squashError;
        throw new Error(`Found nothing to backport to ${targetBranch}`);
      }

      log(
        'backportImpl',
        LogLevel.INFO,
        `Applying ${candidates
          .map((c) => c.attempts.map((a) => a.kind).join(', then '))
          .join('; ')} patches to "${targetBranch}" for temp: "${tempBranch}"`,
      );

      const timer = Date.now();
      const outcome = await runSandboxedBackport({
        slug,
        token: repoAccessToken,
        targetBranch,
        ...(batch
          ? { attempts: [], members: candidates.map((c) => c.attempts) }
          : { attempts: candidates[0].attempts }),
        includeChanges: purpose === BackportPurpose.ExecuteBackport,
        // Push the commits to the target repo.
        onSuccess:
          purpose === BackportPurpose.ExecuteBackport
            ? (success) =>
                createBackportCommits({
                  github: context.octokit,
                  context,
                  baseSha: success.baseSha,
                  commits: success.commits,
                  readBlob: success.readBlob,
                  tempBranch,
                })
            : undefined,
      });

      if (outcome.kind === 'success') {
        (outcome.attempt === 'all'
          ? backportViaAllHisto
          : backportViaSquashHisto
        ).observe((Date.now() - timer) / 1000);
        log(
          'backportImpl',
          LogLevel.INFO,
          `Cherry pick of ${outcome.attempt} commits success - pushed up to target_repo`,
        );
      } else {
        conflictDiff = outcome.diff;
        if (squashError !== undefined) {
          // The squash commit(s) might have applied, but couldn't be tried.
          throw squashError instanceof SandboxInfraError
            ? squashError
            : new SandboxInfraError(
                `Could not fetch the squash commit(s): ${squashError instanceof Error ? squashError.message : 'unknown error'}`,
              );
        }
      }

      console.log(
        JSON.stringify({
          msg: 'backport-result',
          pullRequest: pr.number,
          backportPurpose: purpose,
          success: outcome.kind === 'success',
        }),
      );

      // Throw if neither succeeded - if we don't we
      // never enter the ErrorExecutor and the check hangs.
      if (outcome.kind !== 'success') {
        log(
          'backportImpl',
          LogLevel.ERROR,
          `Cherry picking commits to branch failed`,
        );

        throw new Error(`Cherry picking commit(s) to branch failed`);
      }

      // The units left out of a batch: those with nothing to backport and
      // those that did not apply.
      const kept = new Set(
        candidates
          .filter((_, i) => !outcome.dropped?.includes(i))
          .map((c) => c.index),
      );
      const included = units.filter((_, i) => kept.has(i));
      const dropped = units.filter((_, i) => !kept.has(i));
      const includedPrs = included.flat();
      const includedTops = included.map((unit) => unit[unit.length - 1]);
      const driver = includedPrs[includedPrs.length - 1];

      if (purpose === BackportPurpose.ExecuteBackport) {
        log('backportImpl', LogLevel.INFO, 'Creating Pull Request');

        const title =
          included.length > 1
            ? `chore: batch backport of ${includedTops
                .map((top) => `#${top.number}`)
                .join(', ')}`
            : driver.title.replaceAll(
                `(${getEffectiveBaseRef(driver)})`,
                `(${targetBranch})`,
              );

        const { data: newPr } = await context.octokit.pulls.create(
          context.repo({
            head: `${tempBranch}`,
            base: targetBranch,
            title,
            body: await createBackportComment(context, includedPrs),
            maintainer_can_modify: false,
          }),
        );

        await tagBackportReviewers({
          context,
          targetPrNumber: newPr.number,
          // A stack's backport is reviewed by the author of its top PR, a
          // batch's by the authors of all its PRs.
          users: batch
            ? includedPrs.map((p) => p.user.login)
            : [driver.user.login],
        });

        for (const top of includedTops) {
          log(
            'backportImpl',
            LogLevel.INFO,
            `Adding breadcrumb comment to ${top.number}`,
          );
          await context.octokit.issues.createComment(
            context.repo({
              issue_number: top.number,
              body: `I have automatically backported this PR to "${targetBranch}"${batch ? ' as part of a batch backport' : ''}, \
    please check out #${newPr.number}`,
            }),
          );
        }

        // Every backported PR gets its labels updated, not only the top one.
        for (const member of includedPrs) {
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
            // A batch member keeps waiting for as long as it has the label.
            if (batch && originalPRNumber !== member.number) {
              await labelUtils.removeLabel(
                context,
                member.number,
                labelToRemove,
              );
            }
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

        for (const member of includedPrs) {
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

        const semverLabel = getStackSemverLabel(includedPrs);
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

        for (const unit of dropped) {
          const top = unit[unit.length - 1];
          log(
            'backportImpl',
            LogLevel.INFO,
            `#${top.number} did not apply to "${targetBranch}" - leaving it out of #${newPr.number}`,
          );
          await context.octokit.issues.createComment(
            context.repo({
              issue_number: top.number,
              body: `I was unable to backport this PR to "${targetBranch}" cleanly on top of the other PRs of its batch, so it was left out of #${newPr.number}; \
you will need to perform this ${MANUAL_BACKPORT_LINK}.`,
            }),
          );
          await flagForManualBackport(context, unit, targetBranch);
          await markBackportCheckFailed(
            context,
            checkRuns.get(top.number)!,
            targetBranch,
            {},
          );
        }

        log('backportImpl', LogLevel.INFO, 'Backport process complete');
      }

      for (const top of includedTops) {
        const checkRun = checkRuns.get(top.number)!;
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
      }
    },
    async (error: unknown) => {
      if (error instanceof SandboxInfraError && error.retryable) {
        // A transient failure (the sandbox or GitHub not answering, still
        // after retries): not a conflict, so no "needs manual" label or
        // comment; the backport can just be retried. Failures that would
        // recur (a job timing out or refusing the input) are left to a
        // manual backport below, as any failure always was.
        log(
          'backportImpl',
          LogLevel.ERROR,
          `${bp} for "${slug}" stopped by an internal error`,
          error,
        );
        retryable = true;
        for (const top of tops) {
          if (purpose === BackportPurpose.ExecuteBackport) {
            // A batch keeps its `target/*` labels, so it is still queued and
            // `/trop run backport` on any of its PRs runs it again.
            await context.octokit.issues.createComment(
              context.repo({
                issue_number: top.number,
                body: batch
                  ? `An internal error stopped me from backporting this PR to "${targetBranch}" as part of a batch backport; this is not a merge conflict. I will try again in a few minutes; to try again now, comment \`/trop run backport\`.`
                  : `An internal error stopped me from backporting this PR to "${targetBranch}"; this is not a merge conflict. To try again, comment \`/trop run backport-to ${targetBranch}\`.`,
              }),
            );
          }
          await markBackportCheckFailed(
            context,
            await getCheckRun(top),
            targetBranch,
            { infraError: true },
          );
        }
        return;
      }

      let annotations: unknown[] | null = null;
      let diff;
      let rawDiff;
      if (conflictDiff !== undefined) {
        rawDiff = conflictDiff;
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
      }

      if (purpose === BackportPurpose.ExecuteBackport) {
        for (const top of tops) {
          await context.octokit.issues.createComment(
            context.repo({
              issue_number: top.number,
              body: `I was unable to backport this PR to "${targetBranch}" cleanly;
   you will need to perform this ${MANUAL_BACKPORT_LINK}.`,
            }),
          );
        }
        await flagForManualBackport(context, prs, targetBranch);
      }

      for (const top of tops) {
        await markBackportCheckFailed(
          context,
          await getCheckRun(top),
          targetBranch,
          {
            rawDiff: diff ? rawDiff : undefined,
            annotations: annotations ? annotations : undefined,
          },
        );
      }
    },
    () => onSettled?.(retryable),
  );
};
