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

export async function queueBackportApprovalCheck(context: WebHookPRContext) {
  const pr = context.payload.pull_request;

  await context.octokit.checks.create(
    context.repo({
      name: BACKPORT_APPROVAL_CHECK,
      head_sha: pr.head.sha,
      status: 'queued',
      details_url: 'https://github.com/electron/trop',
      output: {
        title: 'Needs Backport Approval',
        summary: 'This PR requires backport approval.',
      },
    }),
  );
}

export async function getOrCreateCheckRun(
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
  targetBranch: string,
) {
  const allChecks = await context.octokit.checks.listForRef(
    context.repo({
      ref: pr.head.sha,
      per_page: 100,
    }),
  );

  let checkRun = allChecks.data.check_runs.find((run) => {
    return run.name === `${CHECK_PREFIX}${targetBranch}`;
  });

  if (!checkRun) {
    const response = await context.octokit.checks.create(
      context.repo({
        name: `${CHECK_PREFIX}${targetBranch}`,
        head_sha: pr.head.sha,
        status: 'queued' as 'queued',
        details_url: 'https://github.com/electron/trop',
      }),
    );
    checkRun = response.data;
    log(
      'backportImpl',
      LogLevel.INFO,
      `Created check run '${CHECK_PREFIX}${targetBranch}' (${checkRun.id}) with status 'queued'`,
    );
  }

  return checkRun;
}
