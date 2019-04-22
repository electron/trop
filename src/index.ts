import { Application, Context } from 'probot';

import {
  backportToBranch,
  backportToLabel,
  getLabelPrefixes,
  backportImpl,
  BackportPurpose,
  labelMergedPR,
  updateManualBackport,
} from './backport/utils';

import { labelToTargetBranch } from './utils/label-utils';
import { PullRequest, TropConfig } from './backport/Probot';
import { CHECK_PREFIX } from './constants';
import { PRChange } from './enums';
import { ChecksListForRefResponseCheckRunsItem } from '@octokit/rest';
import { getRepoToken } from './backport/token';

const probotHandler = async (robot: Application) => {
  const labelMergedPRs = async (context: Context, pr: PullRequest) => {
    for (const label of pr.labels) {
      const targetBranch = label.name.match(/(\d)-(\d)-x/);
      if (targetBranch && targetBranch[0]) {
        await labelMergedPR(context, pr, label.name);
      }
    }
  };

  const backportAllLabels = (context: Context, pr: PullRequest) => {
    for (const label of pr.labels) {
      context.payload.pull_request = context.payload.pull_request || pr;
      backportToLabel(robot, context, label);
    }
  };

  const runCheck = async (context: Context, pr: PullRequest) => {
    const allChecks = await context.github.checks.listForRef(context.repo({
      ref: pr.head.sha,
      per_page: 100,
    }));
    const checkRuns = allChecks.data.check_runs.filter(run => run.name.startsWith(CHECK_PREFIX));
    const labelPrefixes = await getLabelPrefixes(context);

    for (const label of pr.labels) {
      if (!label.name.startsWith(labelPrefixes.target)) continue;
      const targetBranch = labelToTargetBranch(label, labelPrefixes.target);
      const runName = `${CHECK_PREFIX}${targetBranch}`;
      const existing = checkRuns.find(run => run.name === runName);
      if (existing) {
        if (existing.conclusion !== 'neutral') continue;

        await context.github.checks.update(context.repo({
          name: existing.name,
          check_run_id: existing.id,
          status: 'queued' as 'queued',
        }));
      } else {
        await context.github.checks.create(context.repo({
          name: runName,
          head_sha: pr.head.sha,
          status: 'queued' as 'queued',
          details_url: 'https://github.com/electron/trop',
        }));
      }

      await backportImpl(
        robot,
        context,
        targetBranch,
        BackportPurpose.Check,
      );
    }

    for (const checkRun of checkRuns) {
      if (!pr.labels.find(
        label => label.name === `${labelPrefixes.target}${checkRun.name.replace(CHECK_PREFIX, '')}`,
      )) {
        context.github.checks.update(context.repo({
          check_run_id: checkRun.id,
          name: checkRun.name,
          conclusion: 'neutral' as 'neutral',
          completed_at: (new Date()).toISOString(),
          output: {
            title: 'Cancelled',
            summary: 'This trop check was cancelled and can be ignored as this \
PR is no longer targeting this branch for a backport',
            annotations: [],
          },
        }));
      }
    }
  };

  const maybeRunCheck = async (context: Context) => {
    const payload = context.payload;
    if (!payload.pull_request.merged) {
      await runCheck(context, payload.pull_request as any);
    }
  };

  const maybeGetManualBackportNumber = (context: Context) => {
    const pr = context.payload.pull_request;
    let backportNumber: null | number = null;

    if (!pr.user.login.endsWith('[bot]')) {
      // check if this PR is a manual backport of another PR
      const backportPattern = /(?:^|\n)(?:manual |manually )?backport.*(?:#(\d+)|\/pull\/(\d+))/im;
      const match: Array<string> | null = pr.body.match(backportPattern);
      if (match && match[1]) {
        backportNumber = parseInt(match[1], 10);
      }
    }

    return backportNumber;
  };

  const VALID_BACKPORT_CHECK_NAME = 'Valid Backport';

  robot.on(
    [
      'pull_request.opened',
      'pull_request.edited',
      'pull_request.synchronize',
      'pull_request.labeled',
      'pull_request.unlabeled',
    ],
    async (context: Context) => {
      const oldPRNumber = maybeGetManualBackportNumber(context);
      if (oldPRNumber) {
        await updateManualBackport(context, PRChange.OPEN, oldPRNumber);
      }

      // Check if the PR is going to master, if it's not check if it's correctly
      // tagged as a backport of a PR that has already been merged into master
      const pr = context.payload.pull_request;
      const { data: allChecks } = await context.github.checks.listForRef(context.repo({
        ref: pr.head.sha,
        per_page: 100,
      }));
      let checkRun = allChecks.check_runs.find(run => run.name === VALID_BACKPORT_CHECK_NAME);

      if (pr.base.ref !== 'master') {
        if (!checkRun) {
          checkRun = (await context.github.checks.create(context.repo({
            name: VALID_BACKPORT_CHECK_NAME,
            head_sha: pr.head.sha,
            status: 'queued' as 'queued',
            details_url: 'https://github.com/electron/trop',
          }))).data as any as ChecksListForRefResponseCheckRunsItem;
        }

        const FASTTRACK_PREFIXES = ['build:', 'ci:'];
        const FASTTRACK_USERS = ['electron-bot'];
        const FASTTRACK_LABELS: string[] = [];
        let failureCause = '';

        if (!oldPRNumber) {
          // Allow fast-track prefixes through this check
          if (
            !FASTTRACK_PREFIXES.some(pre => pr.title.startsWith(pre)) &&
            !FASTTRACK_USERS.some(user => pr.user.login === user) &&
            !FASTTRACK_LABELS.some(label => pr.labels.some((prLabel: any) => prLabel.name === label))
          ) {
            failureCause = 'is missing a "Backport of #{N}" declaration.  \
  Check out the trop documentation linked below for more information.';
          }
        } else {
          const oldPR = (await context.github.pullRequests.get(context.repo({
            number: oldPRNumber,
          }))).data;

          // The target PR is only "good" if it was merged to master
          if (oldPR.base.ref !== 'master') {
            failureCause = 'the PR that it is backporting was not targeting the master branch.';
          } else if (!oldPR.merged) {
            failureCause = 'the PR that is backporting has not been merged yet.';
          }
        }

        // No reason for failure === must be good
        if (failureCause === '') {
          await context.github.checks.update(context.repo({
            check_run_id: checkRun.id,
            name: checkRun.name,
            conclusion: 'success' as 'success',
            completed_at: (new Date()).toISOString(),
            details_url: 'https://github.com/electron/trop/blob/master/docs/manual-backports.md',
            output: {
              title: 'Valid Backport',
              summary: `This PR is declared as backporting "#${oldPRNumber}" which is a valid PR that has been merged into master`,
            },
          }));
        } else {
          await context.github.checks.update(context.repo({
            check_run_id: checkRun.id,
            name: checkRun.name,
            conclusion: 'failure' as 'failure',
            completed_at: (new Date()).toISOString(),
            details_url: 'https://github.com/electron/trop/blob/master/docs/manual-backports.md',
            output: {
              title: 'Invalid Backport',
              summary: `This PR is targeting a branch that is not master but ${failureCause}`,
            },
          }));
        }
      } else if (checkRun) {
        // We are targeting master but for some reason have a check run???
        // Let's mark this check as cancelled
        await context.github.checks.update(context.repo({
          check_run_id: checkRun.id,
          name: checkRun.name,
          conclusion: 'neutral' as 'neutral',
          completed_at: (new Date()).toISOString(),
          output: {
            title: 'Cancelled',
            summary: 'This PR is targeting `master` and is not a backport',
            annotations: [],
          },
        }));
      }

      // Only run the backportable checks on "opened" and "synchronize"
      // an "edited" change can not impact backportability
      if (context.payload.action === 'edited' || context.payload.action === 'synchronize') {
        maybeRunCheck(context);
      }
    },
  );

  robot.on('pull_request.reopened', maybeRunCheck);
  robot.on('pull_request.labeled', maybeRunCheck);
  robot.on('pull_request.unlabeled', maybeRunCheck);

  // backport pull requests to labeled targets when PR is merged
  robot.on('pull_request.closed', async (context) => {
    const payload = context.payload;
    if (payload.pull_request.merged) {
      const oldPRNumber = maybeGetManualBackportNumber(context);
      if (typeof oldPRNumber === 'number') {
        await updateManualBackport(context, PRChange.OPEN, oldPRNumber);
      }

      if (payload.pull_request.user.login.endsWith('[bot]')) {
        await labelMergedPRs(context, payload.pull_request as any);
      } else {
        backportAllLabels(context, payload.pull_request as any);
      }
    }
  });

  const TROP_COMMAND_PREFIX = '/trop ';

  // manually trigger backporting process on trigger comment phrase
  robot.on('issue_comment.created', async (context) => {
    const payload = context.payload;
    const config = await context.config<TropConfig>('config.yml');
    if (!config || !Array.isArray(config.authorizedUsers)) {
      robot.log('missing or invalid config', config);
      return;
    }

    const isPullRequest = (issue: { number: number, html_url: string }) =>
      issue.html_url.endsWith(`/pull/${issue.number}`);

    if (!isPullRequest(payload.issue)) return;

    const cmd = payload.comment.body;
    if (!cmd.startsWith(TROP_COMMAND_PREFIX)) return;

    if (!config.authorizedUsers.includes(payload.comment.user.login)) {
      await context.github.issues.createComment(context.repo({
        number: payload.issue.number,
        body: `@${payload.comment.user.login} is not authorized to run PR backports.`,
      }));
      return;
    }

    const actualCmd = cmd.substr(TROP_COMMAND_PREFIX.length);

    const actions = [{
      name: 'backport sanity checker',
      command: /^run backport/,
      execute: async () => {
        const pr = (await context.github.pullRequests.get(
          context.repo({ number: payload.issue.number }))
        ).data;
        if (!pr.merged) {
          await context.github.issues.createComment(context.repo({
            number: payload.issue.number,
            body: 'This PR has not been merged yet, and cannot be backported.',
          }));
          return false;
        }
        return true;
      },
    }, {
      name: 'backport automatically',
      command: /^run backport$/,
      execute: async () => {
        const pr = (await context.github.pullRequests.get(
          context.repo({ number: payload.issue.number }))
        ).data as any;
        await context.github.issues.createComment(context.repo({
          body: 'The backport process for this PR has been manually initiated, here we go! :D',
          number: payload.issue.number,
        }));
        backportAllLabels(context, pr);
        return true;
      },
    }, {
      name: 'backport to branch',
      command: /^run backport-to ([^\s:]+)/,
      execute: async (targetBranches: string) => {
        const branches = targetBranches.split(',');
        for (const branch of branches) {
          robot.log(`backport-to ${branch}`);

          if (!(branch.trim())) continue;
          const pr = (await context.github.pullRequests.get(
            context.repo({ number: payload.issue.number }))
          ).data;

          try {
            (await context.github.repos.getBranch(context.repo({ branch })));
          } catch (err) {
            await context.github.issues.createComment(context.repo({
              body: `The branch you provided "${branch}" does not appear to exist :cry:`,
              number: payload.issue.number,
            }));
            return true;
          }
          await context.github.issues.createComment(context.repo({
            body: `The backport process for this PR has been manually initiated,
sending your 1's and 0's to "${branch}" here we go! :D`,
            number: payload.issue.number,
          }));
          context.payload.pull_request = context.payload.pull_request || pr;
          backportToBranch(robot, context, branch);
        }
        return true;
      },
    }];

    for (const action of actions) {
      const match = actualCmd.match(action.command);
      if (!match) continue;

      robot.log(`running action: ${action.name} for comment`);

      // @ts-ignore (false positive on next line arg count)
      if (!await action.execute(...match.slice(1))) {
        robot.log(`${action.name} failed, stopping responder chain`);
        break;
      }
    }
  });
};

module.exports = probotHandler;

type ProbotHandler = typeof probotHandler;
export { ProbotHandler };
