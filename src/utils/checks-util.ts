import { Context } from 'probot';
import { CheckRunStatus } from '../enums';
import { ChecksListForRefResponseCheckRunsItem } from '@octokit/rest';

export async function updateBackportValidityCheck(
  context: Context,
  checkRun: ChecksListForRefResponseCheckRunsItem,
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
