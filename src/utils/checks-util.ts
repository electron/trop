import { CheckRunStatus, LogLevel } from '../enums';
import {
  BACKPORT_APPROVAL_CHECK,
  BACKPORT_INFORMATION_CHECK,
  CHECK_PREFIX,
} from '../constants';
import {
  SimpleWebHookRepoContext,
  WebHookPR,
  WebHookPRContext,
} from '../types';
import { log } from '../utils/log-util';

export async function updateBackportValidityCheck(
  context: WebHookPRContext,
  checkRun: BackportCheck,
  statusItems: {
    conclusion: CheckRunStatus;
    title: string;
    summary: string;
  },
) {
  await context.octokit.checks.update(
    context.repo({
      check_run_id: checkRun.id,
      name: checkRun.name,
      conclusion: statusItems.conclusion as CheckRunStatus,
      completed_at: new Date().toISOString(),
      details_url:
        'https://github.com/electron/trop/blob/main/docs/manual-backports.md',
      output: {
        title: statusItems.title,
        summary: statusItems.summary,
      },
    }),
  );
}

export async function getBackportInformationCheck(context: WebHookPRContext) {
  const pr = context.payload.pull_request;
  const allChecks = await context.octokit.checks.listForRef(
    context.repo({
      ref: pr.head.sha,
      per_page: 100,
    }),
  );

  const backportCheck = allChecks.data.check_runs.filter((run) =>
    run.name.startsWith(BACKPORT_INFORMATION_CHECK),
  );

  return backportCheck.length > 0 ? backportCheck[0] : null;
}

type BackportCheck = NonNullable<
  Awaited<ReturnType<typeof getBackportInformationCheck>>
>;

export async function updateBackportInformationCheck(
  context: WebHookPRContext,
  backportCheck: BackportCheck,
  statusItems: {
    conclusion: CheckRunStatus;
    title: string;
    summary: string;
  },
) {
  await context.octokit.checks.update(
    context.repo({
      check_run_id: backportCheck.id,
      name: backportCheck.name,
      conclusion: statusItems.conclusion as CheckRunStatus,
      completed_at: new Date().toISOString(),
      details_url: 'https://github.com/electron/trop',
      output: {
        title: statusItems.title,
        summary: statusItems.summary,
      },
    }),
  );
}

export async function queueBackportInformationCheck(context: WebHookPRContext) {
  const pr = context.payload.pull_request;

  await context.octokit.checks.create(
    context.repo({
      name: BACKPORT_INFORMATION_CHECK,
      head_sha: pr.head.sha,
      status: 'queued',
      details_url: 'https://github.com/electron/trop',
      output: {
        title: 'Needs Backport Information',
        summary:
          'This PR requires backport information. It should have a "no-backport" or a "target/<branch>" label.',
      },
    }),
  );
}

export async function getBackportApprovalCheck(context: WebHookPRContext) {
  const pr = context.payload.pull_request;
  const allChecks = await context.octokit.checks.listForRef(
    context.repo({
      ref: pr.head.sha,
      per_page: 100,
    }),
  );

  const backportCheck = allChecks.data.check_runs.filter((run) =>
    run.name.startsWith(BACKPORT_APPROVAL_CHECK),
  );

  return backportCheck.length > 0 ? backportCheck[0] : null;
}

export async function updateBackportApprovalCheck(
  context: WebHookPRContext,
  backportCheck: BackportCheck,
  statusItems: {
    conclusion: CheckRunStatus;
    title: string;
    summary: string;
  },
) {
  await context.octokit.checks.update(
    context.repo({
      check_run_id: backportCheck.id,
      name: backportCheck.name,
      conclusion: statusItems.conclusion as CheckRunStatus,
      completed_at: new Date().toISOString(),
      details_url: 'https://github.com/electron/trop',
      output: {
        title: statusItems.title,
        summary: statusItems.summary,
      },
    }),
  );
}

export async function queueBackportApprovalCheck(
  context: WebHookPRContext,
  { supersedeCompleted = true }: { supersedeCompleted?: boolean } = {},
) {
  const pr = context.payload.pull_request;

  const output = {
    title: 'Needs Backport Approval',
    summary: 'This PR requires backport approval.',
  };

  // Re-fetch the existing check run immediately before writing - concurrent
  // webhook deliveries race through check-then-create and would otherwise
  // create duplicate check runs for the same head SHA (branch protection
  // only consults the latest run per name). If a run already exists and is
  // still pending, reset it to queued by id instead of creating another.
  const existingCheck = await getBackportApprovalCheck(context);

  if (existingCheck && existingCheck.status !== 'completed') {
    await context.octokit.checks.update(
      context.repo({
        check_run_id: existingCheck.id,
        name: existingCheck.name,
        status: 'queued' as 'queued',
        details_url: 'https://github.com/electron/trop',
        output,
      }),
    );
    return;
  }

  // A completed check run is terminal in the Checks API: a PATCH asking to
  // move it back to 'queued' succeeds and applies the output, but silently
  // keeps the old status and conclusion. Updating a stale completed run
  // would therefore leave a green check that claims to need approval, so
  // create a fresh queued run instead - branch protection only consults
  // the latest run per name, so the new run supersedes the completed one.
  //
  // Callers that merely want a pending run to exist (rather than to
  // invalidate a verdict) pass supersedeCompleted: false - a run that
  // concluded between the caller's snapshot and this re-fetch was settled
  // from the live labels by a concurrent delivery, and superseding it would
  // leave a queued run that no follow-up event ever completes
  // (electron/electron#53332).
  if (existingCheck && !supersedeCompleted) {
    log(
      'queueBackportApprovalCheck',
      LogLevel.INFO,
      `Backport approval check run (${existingCheck.id}) for #${pr.number} already concluded '${existingCheck.conclusion}' - not superseding it`,
    );
    return;
  }

  await context.octokit.checks.create(
    context.repo({
      name: BACKPORT_APPROVAL_CHECK,
      head_sha: pr.head.sha,
      status: 'queued',
      details_url: 'https://github.com/electron/trop',
      output,
    }),
  );
}

export async function getOrCreateCheckRun(
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
  targetBranch: string,
) {
  const checkName = `${CHECK_PREFIX}${targetBranch}`;
  const allChecks = await context.octokit.checks.listForRef(
    context.repo({
      ref: pr.head.sha,
      per_page: 100,
    }),
  );

  const matchingRuns = allChecks.data.check_runs.filter(
    (run) => run.name === checkName,
  );

  // A completed check run is terminal in the Checks API: a PATCH moving it
  // back to 'in_progress' is silently ignored, so a run that was concluded
  // (e.g. marked 'Cancelled' after its target label was removed) can never
  // show as pending again. Reuse a run only while it is still pending and
  // otherwise create a fresh one, which supersedes the completed run as the
  // latest run for that name (electron/electron#53925).
  let checkRun = matchingRuns.find((run) => run.status !== 'completed');

  if (!checkRun) {
    const completedRun = matchingRuns[0];
    if (completedRun) {
      log(
        'getOrCreateCheckRun',
        LogLevel.INFO,
        `Check run '${checkName}' (${completedRun.id}) already concluded '${completedRun.conclusion}' - creating a fresh run to supersede it`,
      );
    }
    const response = await context.octokit.checks.create(
      context.repo({
        name: checkName,
        head_sha: pr.head.sha,
        status: 'queued' as 'queued',
        details_url: 'https://github.com/electron/trop',
      }),
    );
    checkRun = response.data;
    log(
      'getOrCreateCheckRun',
      LogLevel.INFO,
      `Created check run '${checkName}' (${checkRun.id}) with status 'queued'`,
    );
  }

  return checkRun;
}

/**
 * GitHub rejects check run `output.text` longer than this with a 422
 * ("Only 65535 characters are allowed").
 */
export const CHECK_RUN_OUTPUT_TEXT_LIMIT = 65535;

// Leave headroom under the hard limit for the surrounding markdown, the
// truncation note and any difference between GitHub's and JavaScript's
// notion of a "character".
const FAILED_DIFF_TEXT_BUDGET = 60000;

const FAILED_DIFF_FENCE = '``````````````````````````````';

/**
 * Renders the conflict diff shown in the "Backport Failed" check run output,
 * truncating it so the whole text stays under GitHub's check run limit.
 */
export function buildFailedDiffText(rawDiff: string): string {
  const header = `Failed Diff:\n\n${FAILED_DIFF_FENCE}diff\n`;
  const footer = `\n${FAILED_DIFF_FENCE}`;

  const fullText = `${header}${rawDiff}${footer}`;
  if (fullText.length <= FAILED_DIFF_TEXT_BUDGET) {
    return fullText;
  }

  const truncationNote = (omitted: number) =>
    `\n... (${omitted} characters omitted, diff truncated to fit GitHub's ${CHECK_RUN_OUTPUT_TEXT_LIMIT} character check run output limit)`;

  // Size the note for the largest possible omitted count so the final text
  // is guaranteed to fit the budget.
  const overhead =
    header.length + truncationNote(rawDiff.length).length + footer.length;
  let keep = FAILED_DIFF_TEXT_BUDGET - overhead;

  // Prefer cutting at a line boundary so the tail of the diff stays readable.
  const lastNewline = rawDiff.lastIndexOf('\n', keep);
  if (lastNewline > keep - 500) {
    keep = lastNewline;
  }

  const omitted = rawDiff.length - keep;
  return `${header}${rawDiff.slice(0, keep)}${truncationNote(omitted)}${footer}`;
}

/**
 * Concludes a "Backportable?" check run as 'neutral' with a "Backport Failed"
 * output. If GitHub rejects the rich output (oversized diff text, too many
 * annotations, ...) the update is retried with only the title and summary so
 * the run never stays pending.
 */
export async function markBackportCheckFailed(
  context: SimpleWebHookRepoContext,
  checkRun: Pick<BackportCheck, 'id' | 'name'>,
  targetBranch: string,
  {
    rawDiff,
    annotations,
  }: {
    rawDiff?: string;
    annotations?: unknown[];
  },
) {
  const updateOpts = context.repo({
    check_run_id: checkRun.id,
    name: checkRun.name,
    conclusion: 'neutral' as 'neutral',
    completed_at: new Date().toISOString(),
    output: {
      title: 'Backport Failed',
      summary: `This PR was checked and could not be automatically backported to "${targetBranch}" cleanly`,
      text: rawDiff !== undefined ? buildFailedDiffText(rawDiff) : undefined,
      annotations,
    },
  });

  log(
    'markBackportCheckFailed',
    LogLevel.INFO,
    `Updating check run '${checkRun.name}' (${checkRun.id}) with conclusion 'neutral'`,
  );

  try {
    await context.octokit.checks.update(updateOpts);
  } catch (err) {
    // A GitHub error occurred - the run must still be concluded or it stays
    // pending forever, so retry without the diff text and annotations.
    log(
      'markBackportCheckFailed',
      LogLevel.ERROR,
      `Failed to update check run '${checkRun.name}' (${checkRun.id}) with diff and annotations, retrying without them: ${err}`,
    );
    updateOpts.output!.annotations = undefined;
    updateOpts.output!.text = undefined;
    try {
      await context.octokit.checks.update(updateOpts);
    } catch (retryErr) {
      log(
        'markBackportCheckFailed',
        LogLevel.ERROR,
        `Failed to conclude check run '${checkRun.name}' (${checkRun.id}): ${retryErr}`,
      );
      throw retryErr;
    }
  }
}
