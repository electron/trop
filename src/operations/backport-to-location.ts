import { PRStatus, BackportPurpose, LogLevel } from '../enums';
import * as labelUtils from '../utils/label-utils';
import { log } from '../utils/log-util';
import { backportImpl } from '../utils';
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
  await backportImpl(
    robot,
    context,
    pr,
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
) => {
  log(
    'backportToBranch',
    LogLevel.INFO,
    `Executing backport to branch '${targetBranch}'`,
  );

  const labelToRemove = undefined;
  const labelToAdd = PRStatus.IN_FLIGHT + targetBranch;
  await backportImpl(
    robot,
    context,
    pr,
    targetBranch,
    BackportPurpose.ExecuteBackport,
    labelToRemove,
    labelToAdd,
  );
};
