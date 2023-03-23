import { ApplicationFunction, Context } from 'probot';

import {
  backportImpl,
  getPRNumbersFromPRBody,
  isAuthorizedUser,
  labelClosedPR,
} from './utils';
import {
  labelToTargetBranch,
  labelExistsOnPR,
  removeLabel,
} from './utils/label-utils';
import { CHECK_PREFIX, NO_BACKPORT_LABEL, SKIP_CHECK_LABEL } from './constants';
import { getEnvVar } from './utils/env-util';
import { PRChange, PRStatus, BackportPurpose, CheckRunStatus } from './enums';
import { Label } from '@octokit/webhooks-types';
import {
  backportToLabel,
  backportToBranch,
} from './operations/backport-to-location';
import { updateManualBackport } from './operations/update-manual-backport';
import { getSupportedBranches } from './utils/branch-util';
import {
  getBackportInformationCheck,
  queueBackportInformationCheck,
  updateBackportInformationCheck,
  updateBackportValidityCheck,
} from './utils/checks-util';
import { register } from './utils/prom';
import { SimpleWebHookRepoContext, WebHookPR, WebHookPRContext } from './types';

// Built in fetch doesn't support global-agent...
// @ts-ignore
delete globalThis.fetch;

const probotHandler: ApplicationFunction = async (robot, { getRouter }) => {
  getRouter?.('/metrics').get('/', (req, res) => {
    register
      .metrics()
      .then((metrics) => {
        res.setHeader('Content-Type', register.contentType);
        res.end(metrics);
      })
      .catch((err) => {
        console.error('Failed to send metrics:', err);
        res.status(500).end('');
      });
  });

  const handleClosedPRLabels = async (
    context: WebHookPRContext,
    pr: WebHookPR,
    change: PRChange,
  ) => {
    for (const label of pr.labels) {
      const targetBranch = label.name.match(
        /^(\d)+-(?:(?:[0-9]+-x$)|(?:x+-y$))$/,
      );
      if (targetBranch && targetBranch[0]) {
        await labelClosedPR(context, pr, label.name, change);
      }
    }
  };

  const backportAllLabels = (
    context: SimpleWebHookRepoContext,
    pr: WebHookPR,
  ) => {
    for (const label of pr.labels) {
      backportToLabel(robot, context, pr, label);
    }
  };

  const handleTropBackportClosed = async (
    context: WebHookPRContext,
    pr: WebHookPR,
    change: PRChange,
  ) => {
    const closeType = change === PRChange.MERGE ? 'merged' : 'closed';
    robot.log(
      `Updating labels on original PR for ${closeType} PR: #${pr.number}`,
    );
    await handleClosedPRLabels(context, pr, change);

    robot.log(`Deleting base branch: ${pr.head.ref}`);
    try {
      await context.octokit.git.deleteRef(
        context.repo({ ref: `heads/${pr.head.ref}` }),
      );
    } catch (e) {
      robot.log('Failed to delete backport branch: ', e);
    }
  };

  const runCheck = async (context: WebHookPRContext, pr: WebHookPR) => {
    const allChecks = await context.octokit.checks.listForRef(
      context.repo({
        ref: pr.head.sha,
        per_page: 100,
      }),
    );
    const checkRuns = allChecks.data.check_runs.filter((run) =>
      run.name.startsWith(CHECK_PREFIX),
    );

    for (const label of pr.labels) {
      if (!label.name.startsWith(PRStatus.TARGET)) continue;
      const targetBranch = labelToTargetBranch(label, PRStatus.TARGET);
      const runName = `${CHECK_PREFIX}${targetBranch}`;
      const existing = checkRuns.find((run) => run.name === runName);
      if (existing) {
        if (existing.conclusion !== 'neutral') continue;

        await context.octokit.checks.update(
          context.repo({
            name: existing.name,
            check_run_id: existing.id,
            status: 'queued' as 'queued',
          }),
        );
      } else {
        await context.octokit.checks.create(
          context.repo({
            name: runName,
            head_sha: pr.head.sha,
            status: 'queued' as 'queued',
            details_url: 'https://github.com/electron/trop',
          }),
        );
      }

      await backportImpl(
        robot,
        context,
        pr,
        targetBranch,
        BackportPurpose.Check,
      );
    }

    for (const checkRun of checkRuns) {
      if (
        !pr.labels.find(
          (prLabel) =>
            prLabel.name ===
            `${PRStatus.TARGET}${checkRun.name.replace(CHECK_PREFIX, '')}`,
        )
      ) {
        await updateBackportValidityCheck(context, checkRun, {
          title: 'Cancelled',
          summary:
            'This trop check was cancelled and can be ignored as this \
          PR is no longer targeting this branch for a backport',
          conclusion: CheckRunStatus.NEUTRAL,
        });
      }
    }
  };

  const maybeRunCheck = async (context: WebHookPRContext) => {
    const payload = context.payload;
    if (!payload.pull_request.merged) {
      await runCheck(context, payload.pull_request);
    }
  };

  /**
   * Checks that a PR done to `main` contains the required
   * backport information, i.e.: at least a `no-backport` or
   * a `target/XYZ` labels.
   *
   * @param context
   * @returns
   */

  const VALID_BACKPORT_CHECK_NAME = 'Valid Backport';

  robot.on(
    [
      'pull_request.opened',
      'pull_request.edited',
      'pull_request.synchronize',
      'pull_request.labeled',
      'pull_request.unlabeled',
    ],
    async (context) => {
      const { pull_request: pr, action } = context.payload;
      let label: Label;
      if ('label' in context.payload) {
        label = context.payload.label;
      }
      const oldPRNumbers = getPRNumbersFromPRBody(pr, true);

      robot.log(`Found ${oldPRNumbers.length} backport numbers for this PR`);

      // Only check for manual backports when a new PR is opened or if the PR body is edited.
      if (oldPRNumbers.length > 0 && ['opened', 'edited'].includes(action)) {
        for (const oldPRNumber of oldPRNumbers) {
          robot.log(
            `Updating original backport at ${oldPRNumber} for ${pr.number}`,
          );
          await updateManualBackport(context, PRChange.OPEN, oldPRNumber);
        }
      }

      // Check if the PR is going to main, if it's not check if it's correctly
      // tagged as a backport of a PR that has already been merged into main.
      const { data: allChecks } = await context.octokit.checks.listForRef(
        context.repo({
          ref: pr.head.sha,
          per_page: 100,
        }),
      );
      let checkRun = allChecks.check_runs.find(
        (run) => run.name === VALID_BACKPORT_CHECK_NAME,
      );

      if (!checkRun) {
        robot.log(`Queueing new check run for #${pr.number}`);
        const response = await context.octokit.checks.create(
          context.repo({
            name: VALID_BACKPORT_CHECK_NAME,
            head_sha: pr.head.sha,
            status: 'queued' as 'queued',
            details_url: 'https://github.com/electron/trop',
          }),
        );

        checkRun = response.data;
      }

      if (pr.base.ref !== pr.base.repo.default_branch) {
        // Ensure that we aren't including our own base branch in the backport process.
        if (action === 'labeled') {
          if (
            Object.values(PRStatus).some((status) =>
              label.name.startsWith(status),
            )
          ) {
            const targetBranch = label!.name.match(
              /^(\d)+-(?:(?:[0-9]+-x$)|(?:x+-y$))$/,
            );
            if (targetBranch?.[0] && targetBranch?.[0] === pr.base.ref) {
              robot.log(
                `#${pr.number} is trying to backport to itself - this is not allowed`,
              );
              await removeLabel(context, 1, '');
            }
          }
        }

        // If a branch is targeting something that isn't main it might not be a backport;
        // allow for a label to skip backport validity check for these branches.
        if (await labelExistsOnPR(context, pr.number, SKIP_CHECK_LABEL)) {
          robot.log(
            `#${pr.number} is labeled with ${SKIP_CHECK_LABEL} - skipping backport validation check`,
          );
          await updateBackportValidityCheck(context, checkRun, {
            title: 'Backport Check Skipped',
            summary:
              'This PR is not a backport - skip backport validation check',
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

        // There are several types of PRs which might not target main yet which are
        // inherently valid; e.g roller-bot PRs. Check for and allow those here.
        if (oldPRNumbers.length === 0) {
          robot.log(
            `#${pr.number} does not have backport numbers - checking fast track status`,
          );
          if (
            !FASTTRACK_PREFIXES.some((pre) => pr.title.startsWith(pre)) &&
            !FASTTRACK_USERS.some((user) => pr.user.login === user) &&
            !FASTTRACK_LABELS.some((label) =>
              pr.labels.some((prLabel) => prLabel.name === label),
            )
          ) {
            robot.log(
              `#${pr.number} is not a fast track PR - marking check run as failed`,
            );
            await updateBackportValidityCheck(context, checkRun, {
              title: 'Invalid Backport',
              summary: `This PR is targeting a branch that is not ${pr.base.repo.default_branch} but is missing a "Backport of #{N}" declaration.  Check out the trop documentation linked below for more information.`,
              conclusion: CheckRunStatus.FAILURE,
            });
          } else {
            robot.log(
              `#${pr.number} is a fast track PR - marking check run as succeeded`,
            );
            await updateBackportValidityCheck(context, checkRun, {
              title: 'Valid Backport',
              summary: `This PR is targeting a branch that is not ${pr.base.repo.default_branch} but a designated fast-track backport which does not require a manual backport number.`,
              conclusion: CheckRunStatus.SUCCESS,
            });
          }
        } else {
          robot.log(
            `#${pr.number} has backport numbers - checking their validity now`,
          );
          const supported = await getSupportedBranches(context);

          for (const oldPRNumber of oldPRNumbers) {
            robot.log(`Checking validity of #${oldPRNumber}`);
            const { data: oldPR } = await context.octokit.pulls.get(
              context.repo({
                pull_number: oldPRNumber,
              }),
            );

            // The current PR is only valid if the PR it is backporting
            // was merged to main or to a supported release branch.
            if (
              ![pr.base.repo.default_branch, ...supported].includes(
                oldPR.base.ref,
              )
            ) {
              const cause =
                'the PR that it is backporting was not targeting the default branch.';
              failureMap.set(oldPRNumber, cause);
            } else if (!oldPR.merged) {
              const cause =
                'the PR that this is backporting has not been merged yet.';
              failureMap.set(oldPRNumber, cause);
            }
          }
        }

        for (const oldPRNumber of oldPRNumbers) {
          if (failureMap.has(oldPRNumber)) {
            robot.log(
              `#${pr.number} is targeting a branch that is not ${
                pr.base.repo.default_branch
              } - ${failureMap.get(oldPRNumber)}`,
            );
            await updateBackportValidityCheck(context, checkRun, {
              title: 'Invalid Backport',
              summary: `This PR is targeting a branch that is not ${
                pr.base.repo.default_branch
              } but ${failureMap.get(oldPRNumber)}`,
              conclusion: CheckRunStatus.FAILURE,
            });
          } else {
            robot.log(`#${pr.number} is a valid backport of #${oldPRNumber}`);
            await updateBackportValidityCheck(context, checkRun, {
              title: 'Valid Backport',
              summary: `This PR is declared as backporting "#${oldPRNumber}" which is a valid PR that has been merged into ${pr.base.repo.default_branch}`,
              conclusion: CheckRunStatus.SUCCESS,
            });
          }
        }
      } else {
        // If we're somehow targeting main and have a check run,
        // we mark this check as cancelled.
        robot.log(
          `#${pr.number} is targeting '${pr.base.repo.default_branch}' and is not a backport - marking as cancelled`,
        );
        await updateBackportValidityCheck(context, checkRun, {
          title: 'Cancelled',
          summary: `This PR is targeting '${pr.base.repo.default_branch}' and is not a backport`,
          conclusion: CheckRunStatus.NEUTRAL,
        });
      }

      // Only run the backportable checks on "opened" and "synchronize"
      // an "edited" change can not impact backportability.
      if (['edited', 'synchronize'].includes(action)) {
        maybeRunCheck(context);
      }
    },
  );

  robot.on('pull_request.reopened', maybeRunCheck);
  robot.on('pull_request.labeled', maybeRunCheck);
  robot.on('pull_request.unlabeled', maybeRunCheck);

  robot.on(
    [
      'pull_request.opened',
      'pull_request.reopened',
      'pull_request.labeled',
      'pull_request.unlabeled',
      'pull_request.synchronize',
    ],
    async (context) => {
      const pr = context.payload.pull_request;

      if (pr.base.ref !== pr.base.repo.default_branch) {
        return;
      }

      let backportCheck = await getBackportInformationCheck(context);

      if (!backportCheck) {
        await queueBackportInformationCheck(context);
        backportCheck = (await getBackportInformationCheck(context))!;
      }

      const isNoBackport = pr.labels.some(
        (prLabel) => prLabel.name === NO_BACKPORT_LABEL,
      );
      const hasTarget = pr.labels.some(
        (prLabel) =>
          prLabel.name.startsWith(PRStatus.TARGET) ||
          prLabel.name.startsWith(PRStatus.IN_FLIGHT) ||
          prLabel.name.startsWith(PRStatus.NEEDS_MANUAL) ||
          prLabel.name.startsWith(PRStatus.MERGED),
      );

      if (hasTarget && isNoBackport) {
        await updateBackportInformationCheck(context, backportCheck, {
          title: 'Conflicting Backport Information',
          summary:
            'The PR has a "no-backport" and at least one "target/x-y-z" label. Impossible to determine backport action.',
          conclusion: CheckRunStatus.FAILURE,
        });

        return;
      }

      if (!hasTarget && !isNoBackport) {
        if (backportCheck.status !== 'queued') {
          await queueBackportInformationCheck(context);
        }

        return;
      }

      await updateBackportInformationCheck(context, backportCheck, {
        title: 'Backport Information Provided',
        summary: 'This PR contains the required  backport information.',
        conclusion: CheckRunStatus.SUCCESS,
      });
    },
  );

  // Backport pull requests to labeled targets when PR is merged.
  robot.on('pull_request.closed', async (context) => {
    const pr = context.payload.pull_request;
    const oldPRNumbers = getPRNumbersFromPRBody(pr, true);
    if (pr.merged) {
      if (oldPRNumbers.length > 0) {
        robot.log(`Automatic backport merged for: #${pr.number}`);
        robot.log(`Labeling original PR for merged PR: #${pr.number}`);
        for (const oldPRNumber of oldPRNumbers) {
          await updateManualBackport(context, PRChange.MERGE, oldPRNumber);
        }
        await handleClosedPRLabels(context, pr, PRChange.MERGE);
      }

      // Check that the closed PR is trop's own and act accordingly.
      if (pr.user.login === getEnvVar('BOT_USER_NAME')) {
        await handleTropBackportClosed(context, pr, PRChange.MERGE);
      } else {
        robot.log(
          `Backporting #${pr.number} to all branches specified by labels`,
        );
        backportAllLabels(context, pr);
      }
    } else {
      robot.log(
        `Automatic backport #${pr.number} closed with unmerged commits`,
      );

      if (oldPRNumbers.length > 0) {
        robot.log(`Updating label on original PR for closed PR: #${pr.number}`);
        for (const oldPRNumber of oldPRNumbers) {
          await updateManualBackport(context, PRChange.CLOSE, oldPRNumber);
        }
      }

      if (pr.user.login === getEnvVar('BOT_USER_NAME')) {
        // If the closed PR is trop's own, remove labels
        // from the original PR and delete the base branch.
        await handleTropBackportClosed(context, pr, PRChange.CLOSE);
      } else {
        await handleClosedPRLabels(context, pr, PRChange.CLOSE);
      }
    }
  });

  const TROP_COMMAND_PREFIX = '/trop ';

  // Manually trigger backporting process on trigger comment phrase.
  robot.on('issue_comment.created', async (context) => {
    const { issue, comment } = context.payload;

    const isPullRequest = (i: { number: number; html_url: string }) =>
      i.html_url.endsWith(`/pull/${i.number}`);

    if (!isPullRequest(issue)) return;

    const cmd = comment.body;
    if (!cmd.startsWith(TROP_COMMAND_PREFIX)) return;

    // Allow all users with push access to handle backports.
    if (!(await isAuthorizedUser(context, comment.user.login))) {
      robot.log(
        `@${comment.user.login} is not authorized to run PR backports - stopping`,
      );
      await context.octokit.issues.createComment(
        context.repo({
          issue_number: issue.number,
          body: `@${comment.user.login} is not authorized to run PR backports.`,
        }),
      );
      return;
    }

    const actualCmd = cmd.substr(TROP_COMMAND_PREFIX.length);

    const actions = [
      {
        name: 'backport sanity checker',
        command: /^run backport/,
        execute: async () => {
          const pr = (
            await context.octokit.pulls.get(
              context.repo({ pull_number: issue.number }),
            )
          ).data;
          if (!pr.merged) {
            await context.octokit.issues.createComment(
              context.repo({
                issue_number: issue.number,
                body:
                  'This PR has not been merged yet, and cannot be backported.',
              }),
            );
            return false;
          }
          return true;
        },
      },
      {
        name: 'backport automatically',
        command: /^run backport$/,
        execute: async () => {
          const pr = (
            await context.octokit.pulls.get(
              context.repo({ pull_number: issue.number }),
            )
          ).data as WebHookPR;
          await context.octokit.issues.createComment(
            context.repo({
              body:
                'The backport process for this PR has been manually initiated - here we go! :D',
              issue_number: issue.number,
            }),
          );
          backportAllLabels(context, pr);
          return true;
        },
      },
      {
        name: 'backport to branch',
        command: /^run backport-to (([^,]*)(, ?([^,]*))*)/,
        execute: async (targetBranches: string) => {
          const branches = targetBranches.split(',').map((b) => b.trim());
          for (const branch of branches) {
            robot.log(
              `Initiating backport to \`${branch}\` from 'backport-to' comment`,
            );

            if (!branch.trim()) continue;
            const pr = (
              await context.octokit.pulls.get(
                context.repo({ pull_number: issue.number }),
              )
            ).data as WebHookPR;

            try {
              await context.octokit.repos.getBranch(context.repo({ branch }));
            } catch (err) {
              await context.octokit.issues.createComment(
                context.repo({
                  body: `The branch you provided \`${branch}\` does not appear to exist.`,
                  issue_number: issue.number,
                }),
              );
              return true;
            }

            // Optionally disallow backports to EOL branches
            const noEOLSupport = getEnvVar('NO_EOL_SUPPORT', '');
            if (noEOLSupport) {
              const supported = await getSupportedBranches(context);
              if (!supported.includes(branch)) {
                robot.log(
                  `${branch} is no longer supported - no backport will be initiated`,
                );
                await context.octokit.issues.createComment(
                  context.repo({
                    body: `\`${branch}\` is no longer supported - no backport will be initiated.`,
                    issue_number: issue.number,
                  }),
                );
                return false;
              }
            }

            robot.log(
              `Initiating manual backport process for #${issue.number} to ${branch}`,
            );
            await context.octokit.issues.createComment(
              context.repo({
                body: `The backport process for this PR has been manually initiated - sending your PR to \`${branch}\`!`,
                issue_number: issue.number,
              }),
            );
            backportToBranch(robot, context, pr, branch);
          }
          return true;
        },
      },
    ];

    for (const action of actions) {
      const match = actualCmd.match(action.command);
      if (!match) continue;

      robot.log(`running action: ${action.name} for comment`);

      // @ts-ignore (false positive on next line arg count)
      if (!(await action.execute(...match.slice(1)))) {
        robot.log(`${action.name} failed, stopping responder chain`);
        break;
      }
    }
  });
};

module.exports = probotHandler;

type ProbotHandler = typeof probotHandler;
export { ProbotHandler };
