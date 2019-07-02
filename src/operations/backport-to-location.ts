import { Application, Context } from 'probot';
import { Label } from '../Probot';
import { PRStatus, BackportPurpose } from '../enums';
import * as labelUtils from '../utils/label-utils';
import { backportImpl } from '../backport/utils';

/*
* Performs a backport to a specified label.
*
* @param {Label} the label representing the target branch for backporting
*/
export const backportToLabel = async (
  robot: Application,
  context: Context,
  label: Label,
) => {
  if (!label.name.startsWith(PRStatus.TARGET)) {
    robot.log(`Label '${label.name}' does not begin with '${PRStatus.TARGET}'`);
    return;
  }

  const targetBranch = labelUtils.labelToTargetBranch(label, PRStatus.TARGET);
  if (!targetBranch) {
    robot.log('Nothing to do');
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

/*
* Performs a backport to a specified target branch
*
* @param {string} the branch to which the backport will be performed.
*/
export const backportToBranch = async (
  robot: Application,
  context: Context,
  targetBranch: string,
) => {
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
