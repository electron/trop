import { Application, Context } from 'probot';
import { PRStatus, BackportPurpose, LogLevel } from '../enums';
import * as labelUtils from '../utils/label-utils';
import { log } from '../utils/log-util';
import { backportImpl } from '../utils';
import { PullsGetResponseLabelsItem } from '@octokit/rest';

/**
 * Performs a backport to a specified label representing a branch.
 *
 * @param {Application} robot - an instance of Probot
 * @param {Context} context - the context of the event that was triggered
 * @param {PullsGetResponseLabelsItem} label - the label representing the target branch for backporting
 */
export const backportToLabel = async (
  robot: Application,
  context: Context,
  label: PullsGetResponseLabelsItem,
) => {
  log('backportToLabel', `Executing backport to branch from label ${label}`, LogLevel.INFO);

  if (!label.name.startsWith(PRStatus.TARGET)) {
    log('backportToLabel', `Label '${label.name}' does not begin with '${PRStatus.TARGET}'`, LogLevel.ERROR);
    return;
  }

  const targetBranch = labelUtils.labelToTargetBranch(label, PRStatus.TARGET);
  if (!targetBranch) {
    log('backportToLabel', 'No target branch specified - aborting backport process', LogLevel.WARN);
    return;
  }

  const labelToRemove = label.name;
  const labelToAdd = label.name.replace(PRStatus.TARGET, PRStatus.IN_FLIGHT);
  await backportImpl(
    robot,
    context,
    targetBranch,
    BackportPurpose.ExecuteBackport,
    labelToRemove,
    labelToAdd,
  );
};

/**
 * Performs a backport to a specified target branch.
 *
 * @param {Application} robot - an instance of Probot
 * @param {Context} context - the context of the event that was triggered
 * @param {string} targetBranch - the branch to which the backport will be performed
 */
export const backportToBranch = async (
  robot: Application,
  context: Context,
  targetBranch: string,
) => {
  log('backportToLabel', `Executing backport to branch '${targetBranch}'`, LogLevel.INFO);

  const labelToRemove = undefined;
  const labelToAdd = PRStatus.IN_FLIGHT + targetBranch;
  await backportImpl(
    robot,
    context,
    targetBranch,
    BackportPurpose.ExecuteBackport,
    labelToRemove,
    labelToAdd,
  );
};
