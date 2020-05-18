import { Application, Context } from 'probot';

import { backportImpl, labelMergedPR } from './utils';
import { labelToTargetBranch, labelExistsOnPR } from './utils/label-utils';
import { TropConfig } from './interfaces';
import { CHECK_PREFIX, SKIP_CHECK_LABEL } from './constants';
import { getEnvVar } from './utils/env-util';
import { PRChange, PRStatus, BackportPurpose, CheckRunStatus } from './enums';
import { ChecksListForRefResponseCheckRunsItem, PullsGetResponse } from '@octokit/rest';
import { backportToLabel, backportToBranch } from './operations/backport-to-location';
import { updateManualBackport } from './operations/update-manual-backport';
import { getSupportedBranches, getBackportPattern } from './utils/branch-util';
import { updateBackportValidityCheck } from './utils/checks-util';

const probotHandler = async (robot: Application) => {
  const labelMergedPRs = async (context: Context, pr: PullsGetResponse) => {
    for (const label of pr.labels) {
      const targetBranch = label.name.match(/^(\d)+-(?:(?:[0-9]+-x$)|(?:x+-y$))$/);
      if (targetBranch && targetBranch[0]) {
        await labelMergedPR(context, pr, label.name);
      }
    }
  };

  const backportAllLabels = (context: Context, pr: PullsGetResponse) => {
    for (const label of pr.labels) {
      context.payload.pull_request = context.payload.pull_request || pr;
      backportToLabel(robot, context, label);
    }
  };

  const runCheck = async (context: Context, pr: PullsGetResponse) => {
    const allChecks = await context.github.checks.listForRef(context.repo({
      ref: pr.head.sha,
      per_page: 100,
    }));
    const checkRuns = allChecks.data.check_runs.filter(run => run.name.startsWith(CHECK_PREFIX));

    for (const label of pr.labels) {
      if (!label.name.startsWith(PRStatus.TARGET)) continue;
      const targetBranch = labelToTargetBranch(label, PRStatus.TARGET);
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
        label => label.name === `${PRStatus.TARGET}${checkRun.name.replace(CHECK_PREFIX, '')}`,
      )) {
        await updateBackportValidityCheck(context, checkRun, {
          title: 'Cancelled',
          summary: 'This trop check was cancelled and can be ignored as this \
          PR is no longer targeting this branch for a backport',
          conclusion: CheckRunStatus.NEUTRAL,
        });
      }
    }
  };

  const maybeRunCheck = async (context: Context) => {
    const payload = context.payload;
    if (!payload.pull_request.merged) {
      await runCheck(context, payload.pull_request as any);
    }
  };

  const maybeGetManualBackportNumbers = (context: Context) => {
    const pr = context.payload.pull_request;
    const backportNumbers: number[] = [];

    if (pr.user.login !== getEnvVar('BOT_USER_NAME')) {
      const backportPattern = getBackportPattern();
      // Check if this PR is a manual backport of another PR.
      let match: RegExpExecArray | null;
      while (match = backportPattern.exec(pr.body)) {
        // This might be the first or second capture group depending on if it's a link or not.
        backportNumbers.push(match[1] ? parseInt(match[1], 10) : parseInt(match[2], 10));
      }
    }

    return backportNumbers;
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
      const oldPRNumbers = maybeGetManualBackportNumbers(context);

      // Only check for manual backports when a new PR is opened or if the PR body is edited.
      if (oldPRNumbers.length > 0 && ['opened', 'edited'].includes(context.payload.action)) {
        for (const oldPRNumber of oldPRNumbers) {
          await updateManualBackport(context, PRChange.OPEN, oldPRNumber);
        }
      }

      // Check if the PR is going to master, if it's not check if it's correctly
      // tagged as a backport of a PR that has already been merged into master.
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

        // If a branch is targeting something that isn't master it might not be a backport;
        // allow for a label to skip backport validity check for these branches.
        if (await labelExistsOnPR(context, pr.number, SKIP_CHECK_LABEL)) {
          await updateBackportValidityCheck(context, checkRun, {
            title: 'Backport Check Skipped',
            summary: 'This PR is not a backport - skip backport validation check',
            conclusion: CheckRunStatus.NEUTRAL,
          });
          return;
        }

        const FASTTRACK_PREFIXES = ['build:', 'ci:'];
        const FASTTRACK_USERS = [
          getEnvVar('BOT_USER_NAME'),
          getEnvVar('COMMITTER_USER_NAME'),
        ];
        const FASTTRACK_LABELS: string[] = ['fast-track 🚅'];

        const failureMap = new Map();

        // There are several types of PRs which might not target master yet which are
        // inherently valid; e.g roller-bot PRs. Check for and allow those here.
        if (oldPRNumbers.length === 0) {
          if (
            !FASTTRACK_PREFIXES.some(pre => pr.title.startsWith(pre)) &&
            !FASTTRACK_USERS.some(user => pr.user.login === user) &&
            !FASTTRACK_LABELS.some(label => pr.labels.some((prLabel: any) => prLabel.name === label))
          ) {
            await updateBackportValidityCheck(context, checkRun, {
              title: 'Invalid Backport',
              summary: 'This PR is targeting a branch that is not master but is missing a "Backport of #{N}" declaration.  \
              Check out the trop documentation linked below for more information.',
              conclusion: CheckRunStatus.FAILURE,
            });
          } else {
            await updateBackportValidityCheck(context, checkRun, {
              title: 'Valid Backport',
              summary: 'This PR is targeting a branch that is not master but a designated fast-track backport which does  \
              not require a manual backport number.',
              conclusion: CheckRunStatus.SUCCESS,
            });
          }
        } else {
          const supported = await getSupportedBranches(context);

          for (const oldPRNumber of oldPRNumbers) {
            const oldPR = (await context.github.pulls.get(context.repo({
              pull_number: oldPRNumber,
            }))).data;

            // The current PR is only valid if the PR it is backporting
            // was merged to master or to a supported release branch.
            if (!['master', ...supported].includes(oldPR.base.ref)) {
              const cause = 'the PR that it is backporting was not targeting the master branch.';
              failureMap.set(oldPRNumber, cause);
            } else if (!oldPR.merged) {
              const cause = 'the PR that is backporting has not been merged yet.';
              failureMap.set(oldPRNumber, cause);
            }
          }
        }

        for (const oldPRNumber of oldPRNumbers) {
          if (failureMap.has(oldPRNumber)) {
            await updateBackportValidityCheck(context, checkRun, {
              title: 'Invalid Backport',
              summary: `This PR is targeting a branch that is not master but ${failureMap.get(oldPRNumber)}`,
              conclusion: CheckRunStatus.FAILURE,
            });
          } else {
            await updateBackportValidityCheck(context, checkRun, {
              title: 'Valid Backport',
              summary: `This PR is declared as backporting "#${oldPRNumber}" which is a valid PR that has been merged into master`,
              conclusion: CheckRunStatus.SUCCESS,
            });
          }
        }
      } else if (checkRun) {
        // If we're somehow targeting master and have a check run,
        // we mark this check as cancelled.
        await updateBackportValidityCheck(context, checkRun, {
          title: 'Cancelled',
          summary: 'This PR is targeting `master` and is not a backport',
          conclusion: CheckRunStatus.NEUTRAL,
        });
      }

      // Only run the backportable checks on "opened" and "synchronize"
      // an "edited" change can not impact backportability.
      if (context.payload.action === 'edited' || context.payload.action === 'synchronize') {
        maybeRunCheck(context);
      }
    },
  );

  robot.on('pull_request.reopened', maybeRunCheck);
  robot.on('pull_request.labeled', maybeRunCheck);
  robot.on('pull_request.unlabeled', maybeRunCheck);

  // Backport pull requests to labeled targets when PR is merged.
  robot.on('pull_request.closed', async (context: Context) => {
    const pr: PullsGetResponse = context.payload.pull_request;
    if (pr.merged) {
      robot.log(`Automatic backport merged for: #${pr.number}`);
      const oldPRNumbers = maybeGetManualBackportNumbers(context);
      if (oldPRNumbers.length > 0) {
        robot.log(`Labeling original PR for merged PR: #${pr.number}`);
        for (const oldPRNumber of oldPRNumbers) {
          await updateManualBackport(context, PRChange.CLOSE, oldPRNumber);
        }
        await labelMergedPRs(context, pr);
      }

      // Check that the closed PR is trop's own and act accordingly.
      if (pr.user.login === getEnvVar('BOT_USER_NAME')) {
        robot.log(`Labeling original PR for merged PR: #${pr.number}`);
        await labelMergedPRs(context, pr);

        robot.log(`Deleting base branch: ${pr.base.ref}`);
        try {
          await context.github.git.deleteRef(context.repo({ ref: pr.base.ref }));
        } catch (e) {
          robot.log('Failed to delete base branch: ', e);
        }
      } else {
        backportAllLabels(context, pr);
      }
    }
  });

  const TROP_COMMAND_PREFIX = '/trop ';

  // Manually trigger backporting process on trigger comment phrase.
  robot.on('issue_comment.created', async (context: Context) => {
    const payload = context.payload;
    const config = await context.config<TropConfig>('config.yml') as TropConfig;
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
        issue_number: payload.issue.number,
        body: `@${payload.comment.user.login} is not authorized to run PR backports.`,
      }));
      return;
    }

    const actualCmd = cmd.substr(TROP_COMMAND_PREFIX.length);

    const actions = [{
      name: 'backport sanity checker',
      command: /^run backport/,
      execute: async () => {
        const pr = (await context.github.pulls.get(
          context.repo({ pull_number: payload.issue.number }))
        ).data;
        if (!pr.merged) {
          await context.github.issues.createComment(context.repo({
            issue_number: payload.issue.number,
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
        const pr = (await context.github.pulls.get(
          context.repo({ pull_number: payload.issue.number }))
        ).data as any;
        await context.github.issues.createComment(context.repo({
          body: 'The backport process for this PR has been manually initiated, here we go! :D',
          issue_number: payload.issue.number,
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
          const pr = (await context.github.pulls.get(
            context.repo({ pull_number: payload.issue.number }))
          ).data;

          try {
            (await context.github.repos.getBranch(context.repo({ branch })));
          } catch (err) {
            await context.github.issues.createComment(context.repo({
              body: `The branch you provided "${branch}" does not appear to exist :cry:`,
              issue_number: payload.issue.number,
            }));
            return true;
          }

          // Optionally disallow backports to EOL branches
          const noEOLSupport = getEnvVar('NO_EOL_SUPPORT', '');
          if (noEOLSupport) {
            const supported = await getSupportedBranches(context);
            if (!supported.includes(branch)) {
              await context.github.issues.createComment(context.repo({
                body: `${branch} is no longer supported - no backport will be initiated.`,
                issue_number: payload.issue.number,
              }));
              return false;
            }
          }

          await context.github.issues.createComment(context.repo({
            body: `The backport process for this PR has been manually initiated -
sending your commits to "${branch}"!`,
            issue_number: payload.issue.number,
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
