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

export async function getBackportInformationCheck(
  context: WebHookPRContext,
  headSha = context.payload.pull_request.head.sha,
) {
  const allChecks = await context.octokit.checks.listForRef(
    context.repo({
      ref: headSha,
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

export async function queueBackportInformationCheck(
  context: WebHookPRContext,
  headSha = context.payload.pull_request.head.sha,
) {
  await context.octokit.checks.create(
    context.repo({
      name: BACKPORT_INFORMATION_CHECK,
      head_sha: headSha,
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
        status: 'queued' as const,
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
  { supersedeCompleted = false }: { supersedeCompleted?: boolean } = {},
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

  // Prefer a run that is still pending over a completed one with the same
  // name, whatever order GitHub lists them in.
  let checkRun = matchingRuns.find((run) => run.status !== 'completed');

  // A completed check run is terminal in the Checks API: a PATCH moving it
  // back to 'in_progress' is silently ignored, so a run that was concluded
  // (e.g. marked 'Cancelled' after its target label was removed) can never
  // show as pending again. Dry-run checks pass supersedeCompleted so a fresh
  // run is created instead, which supersedes the completed run as the
  // latest run for that name (electron/electron#53925). By default the
  // completed run is reused, so executing a backport on merge rewrites the
  // dry run's check rather than adding a second run.
  if (!checkRun && !supersedeCompleted) {
    checkRun = matchingRuns[0];
  }

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
        status: 'queued' as const,
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
 * GitHub caps each annotation's `raw_details` (and `message`) at 64 KB and
 * accepts at most 50 annotations per check run update request. See
 * https://docs.github.com/en/rest/checks/runs#update-a-check-run
 */
export const CHECK_RUN_ANNOTATION_RAW_DETAILS_LIMIT = 64 * 1024;
export const CHECK_RUN_MAX_ANNOTATIONS = 50;

// Same headroom rationale as FAILED_DIFF_TEXT_BUDGET above.
const ANNOTATION_RAW_DETAILS_BUDGET = 60000;

/**
 * Caps an annotation's `raw_details` under GitHub's limit, cutting at a line
 * boundary where possible and noting how many characters were omitted.
 */
export function truncateAnnotationDetails(rawDetails: string): string {
  if (rawDetails.length <= ANNOTATION_RAW_DETAILS_BUDGET) {
    return rawDetails;
  }

  const truncationNote = (omitted: number) =>
    `\n... (${omitted} characters omitted)`;

  let keep =
    ANNOTATION_RAW_DETAILS_BUDGET - truncationNote(rawDetails.length).length;
  const lastNewline = rawDetails.lastIndexOf('\n', keep);
  if (lastNewline > keep - 500) {
    keep = lastNewline;
  }

  return `${rawDetails.slice(0, keep)}${truncationNote(rawDetails.length - keep)}`;
}

/**
 * Concludes a "Backportable?" check run as 'neutral' with a "Backport Failed"
 * output. If GitHub rejects the rich output the update is retried first
 * without the annotations (whose `raw_details` may be oversized) and then
 * without the diff text as well, so the run never stays pending.
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
    conclusion: 'neutral' as const,
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

  const update = () => context.octokit.checks.update(updateOpts);
  const output = updateOpts.output!;
  // Progressively drop the parts of the output GitHub is most likely to
  // reject, so the run is concluded with as much detail as GitHub accepts.
  const fallbacks = [
    {
      what: 'annotations',
      present: () => output.annotations !== undefined,
      drop: () => {
        output.annotations = undefined;
      },
    },
    {
      what: 'diff text',
      present: () => output.text !== undefined,
      drop: () => {
        output.text = undefined;
      },
    },
  ];

  let lastError: unknown;
  try {
    await update();
    return;
  } catch (err) {
    lastError = err;
  }

  for (const fallback of fallbacks) {
    if (!fallback.present()) continue;
    log(
      'markBackportCheckFailed',
      LogLevel.ERROR,
      `GitHub rejected the update for check run '${checkRun.name}' (${checkRun.id}), retrying without ${fallback.what}: ${String(lastError)}`,
    );
    fallback.drop();
    try {
      await update();
      return;
    } catch (err) {
      lastError = err;
    }
  }

  log(
    'markBackportCheckFailed',
    LogLevel.ERROR,
    `Failed to conclude check run '${checkRun.name}' (${checkRun.id}): ${String(lastError)}`,
  );
  throw lastError;
}
