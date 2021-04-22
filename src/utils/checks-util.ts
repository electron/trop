import { Context } from 'probot';
import { CheckRunStatus } from '../enums';
import { Octokit } from '@octokit/rest';
import { BACKPORT_INFORMATION_CHECK } from '../constants';

export async function updateBackportValidityCheck(
  context: Context,
  checkRun: Octokit.ChecksListForRefResponseCheckRunsItem,
  statusItems: {
    conclusion: CheckRunStatus;
    title: string;
    summary: string;
  },
) {
  await context.github.checks.update(
    context.repo({
      check_run_id: checkRun.id,
      name: checkRun.name,
      conclusion: statusItems.conclusion as CheckRunStatus,
      completed_at: new Date().toISOString(),
      details_url:
        'https://github.com/electron/trop/blob/master/docs/manual-backports.md',
      output: {
        title: statusItems.title,
        summary: statusItems.summary,
      },
    }),
  );
}

export async function getBackportInformationCheck(context: Context) {
  const pr: Octokit.PullsGetResponse = context.payload.pull_request;
  const allChecks = await context.github.checks.listForRef(
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

export async function updateBackportInformationCheck(
  context: Context,
  backportCheck: Octokit.ChecksListForRefResponseCheckRunsItem,
  statusItems: {
    conclusion: CheckRunStatus;
    title: string;
    summary: string;
  },
) {
  await context.github.checks.update(
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

export async function queueBackportInformationCheck(context: Context) {
  const pr: Octokit.PullsGetResponse = context.payload.pull_request;

  await context.github.checks.create(
    context.repo({
      name: BACKPORT_INFORMATION_CHECK,
      head_sha: pr.head.sha,
      status: 'queued' as 'queued',
      details_url: 'https://github.com/electron/trop',
    }),
  );
}
