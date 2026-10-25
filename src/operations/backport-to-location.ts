import { PRStatus, BackportPurpose, LogLevel } from '../enums';
import * as labelUtils from '../utils/label-utils';
import { log } from '../utils/log-util';
import { backportBatchImpl, backportStackImpl } from '../utils';
import { Probot } from 'probot';
import { SimpleWebHookRepoContext, WebHookPR } from '../types';

/**
 * Performs a backport to a specified label representing a branch.
 *
 * @param robot - an instance of Probot
 * @param context - the context of the event that was triggered
 * @param label - the label representing the target branch for backporting
 */
export const backportToLabel = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
  label: { name: string },
) => backportStackToLabel(robot, context, [pr], label);

/**
 * Backports a merged stack of PRs (ordered bottom to top) as one pull request
 * to the branch a label represents.
 */
export const backportStackToLabel = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  prs: WebHookPR[],
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

  const labelToRemove = label.name;
  const labelToAdd = label.name.replace(PRStatus.TARGET, PRStatus.IN_FLIGHT);
  await backportStackImpl(
    robot,
    context,
    prs,
    targetBranch,
    BackportPurpose.ExecuteBackport,
    labelToRemove,
    labelToAdd,
  );
};

/**
 * Performs a backport to a specified target branch.
 *
 * @param robot - an instance of Probot
 * @param context - the context of the event that was triggered
 * @param targetBranch - the branch to which the backport will be performed
 */
export const backportToBranch = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
  targetBranch: string,
) => backportStackToBranch(robot, context, [pr], targetBranch);

/**
 * Backports a merged stack of PRs (ordered bottom to top) as one pull request
 * to the given branch.
 */
export const backportStackToBranch = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  prs: WebHookPR[],
  targetBranch: string,
) => {
  log(
    'backportToBranch',
    LogLevel.INFO,
    `Executing backport to branch '${targetBranch}'`,
  );

  const labelToRemove = undefined;
  const labelToAdd = PRStatus.IN_FLIGHT + targetBranch;
  await backportStackImpl(
    robot,
    context,
    prs,
    targetBranch,
    BackportPurpose.ExecuteBackport,
    labelToRemove,
    labelToAdd,
  );
};

/**
 * Backports a batch of merged PRs (units ordered by merge, each a single PR
 * or a stack bottom to top) as one pull request to the given branch, as if
 * each was labeled `target/<targetBranch>`.
 */
export const backportBatchToBranch = async (
  robot: Probot,
  context: SimpleWebHookRepoContext,
  units: WebHookPR[][],
  targetBranch: string,
  onSettled?: (retryable: boolean) => void,
) => {
  log(
    'backportBatchToBranch',
    LogLevel.INFO,
    `Executing batch backport of ${units
      .map((unit) => `#${unit[unit.length - 1].number}`)
      .join(', ')} to branch '${targetBranch}'`,
  );

  await backportBatchImpl(robot, context, units, targetBranch, {
    labelToRemove: PRStatus.TARGET + targetBranch,
    labelToAdd: PRStatus.IN_FLIGHT + targetBranch,
    onSettled,
  });
};
