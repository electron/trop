import { CHECK_PREFIX } from '../constants';
import { PRStatus, BackportPurpose, LogLevel } from '../enums';
import { getCheckRun } from '../utils/checks-util';
import * as labelUtils from '../utils/label-utils';
import { log } from '../utils/log-util';
import { backportImpl } from '../utils';
import { Probot } from 'probot';
import { SimpleWebHookRepoContext, WebHookPR } from '../types';

const createOrUpdateCheckRun = async (
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
  targetBranch: string,
) => {
  let check = await getCheckRun(context, pr, targetBranch);

  if (check) {
    if (check.conclusion === 'neutral') {
      log(
        'createOrUpdateCheckRun',
        LogLevel.INFO,
        `Updating check run ID ${check.id} with status 'queued'`,
      );

      await context.octokit.checks.update(
        context.repo({
          name: check.name,
          check_run_id: check.id,
          status: 'queued' as 'queued',
        }),
      );
    }
  } else {
    const response = await context.octokit.checks.create(
      context.repo({
        name: `${CHECK_PREFIX}${targetBranch}`,
        head_sha: pr.head.sha,
        status: 'queued' as 'queued',
        details_url: 'https://github.com/electron/trop',
      }),
    );

    check = response.data;
  }

  return check;
};

/**
 * Performs a backport to a specified label representing a branch.
 *
 * @param {Probot} robot - an instance of Probot
 * @param {WebHookRepoContext} context - the context of the event that was triggered
 * @param {PullsGetResponseLabelsItem} label - the label representing the target branch for backporting
 */
export const backportToLabel = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
  label: { name: string },
) => {
  log(
    'backportToLabel',
    LogLevel.INFO,
    `Executing backport to branch from label ${label.name}`,
  );

  if (!label.name.startsWith(PRStatus.TARGET)) {
    log(
      'backportToLabel',
      LogLevel.ERROR,
      `Label '${label.name}' does not begin with '${PRStatus.TARGET}'`,
    );
    return;
  }

  const targetBranch = labelUtils.labelToTargetBranch(label, PRStatus.TARGET);
  if (!targetBranch) {
    log(
      'backportToLabel',
      LogLevel.WARN,
      'No target branch specified - aborting backport process',
    );
    return;
  }

  const checkRun = await createOrUpdateCheckRun(context, pr, targetBranch);

  const labelToRemove = label.name;
  const labelToAdd = label.name.replace(PRStatus.TARGET, PRStatus.IN_FLIGHT);
  await backportImpl(
    robot,
    context,
    pr,
    targetBranch,
    BackportPurpose.ExecuteBackport,
    checkRun,
    labelToRemove,
    labelToAdd,
  );
};

/**
 * Performs a backport to a specified target branch.
 *
 * @param {Probot} robot - an instance of Probot
 * @param {WebHookRepoContext} context - the context of the event that was triggered
 * @param {string} targetBranch - the branch to which the backport will be performed
 */
export const backportToBranch = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
  targetBranch: string,
) => {
  log(
    'backportToLabel',
    LogLevel.INFO,
    `Executing backport to branch '${targetBranch}'`,
  );

  const checkRun = await createOrUpdateCheckRun(context, pr, targetBranch);

  const labelToRemove = undefined;
  const labelToAdd = PRStatus.IN_FLIGHT + targetBranch;
  await backportImpl(
    robot,
    context,
    pr,
    targetBranch,
    BackportPurpose.ExecuteBackport,
    checkRun,
    labelToRemove,
    labelToAdd,
  );
};
