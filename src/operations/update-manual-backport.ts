import * as labelUtils from '../utils/label-utils';
import { log } from '../utils/log-util';
import { PRChange, PRStatus, LogLevel } from '../enums';
import { Context } from 'probot';
import { BACKPORT_REQUESTED_LABEL, SEMVER_PREFIX } from '../constants';
import { isSemverMinorPR } from '../utils';

/**
 * Updates the labels on a backport's original PR as well as comments with links
 * to the backport if it's a newly opened PR.
 *
 * @param {Context} context - the context of the event that was triggered
 * @param {PRChange} type - the type of PR status change: either OPEN or CLOSE
 * @param {number} oldPRNumber - the number corresponding to the backport's original PR
 * @returns {Object} - an object containing the repo initialization directory
 */
export const updateManualBackport = async (
  context: Context,
  type: PRChange,
  oldPRNumber: number,
) => {
  const pr = context.payload.pull_request;
  let labelToRemove;
  const labelsToAdd = [pr.base.ref];

  log(
    'updateManualBackport',
    LogLevel.INFO,
    `Updating backport of ${oldPRNumber} to ${pr.base.ref}`,
  );

  if (type === PRChange.OPEN) {
    log(
      'updateManualBackport',
      LogLevel.INFO,
      `New manual backport opened at #${pr.number}`,
    );

    labelsToAdd.push(PRStatus.IN_FLIGHT + pr.base.ref);
    labelToRemove = PRStatus.NEEDS_MANUAL + pr.base.ref;

    const removeLabelExists = await labelUtils.labelExistsOnPR(
      context,
      oldPRNumber,
      labelToRemove,
    );
    if (!removeLabelExists) {
      labelToRemove = PRStatus.TARGET + pr.base.ref;
    }

    // Propagate semver label from the original PR if the maintainer didn't add it.
    const { data: oldPR } = await context.github.pulls.get(
      context.repo({ pull_number: oldPRNumber }),
    );
    const semverLabel = oldPR.labels.find((l: any) =>
      l.name.startsWith(SEMVER_PREFIX),
    );
    if (
      semverLabel &&
      !labelUtils.labelExistsOnPR(context, pr.number, semverLabel.name)
    ) {
      labelsToAdd.push(semverLabel.name);
    }

    if (await isSemverMinorPR(context, pr)) {
      log(
        'updateManualBackport',
        LogLevel.INFO,
        `Determined that ${pr.number} is semver-minor`,
      );
      labelsToAdd.push(BACKPORT_REQUESTED_LABEL);
    }

    // We should only comment if there is not a previous existing comment
    const commentBody = `@${pr.user.login} has manually backported this PR to "${pr.base.ref}", \
please check out #${pr.number}`;

    // TODO(codebytere): Once probot updates to @octokit/rest@16 we can use .paginate to
    // get all the comments properly, for now 100 should do
    const { data: existingComments } = await context.github.issues.listComments(
      context.repo({
        issue_number: oldPRNumber,
        per_page: 100,
      }),
    );

    // We should only comment if there is not a previous existing comment
    const shouldComment = !existingComments.some(
      (comment) => comment.body === commentBody,
    );

    if (shouldComment) {
      // Comment on the original PR with the manual backport link
      await context.github.issues.createComment(
        context.repo({
          issue_number: oldPRNumber,
          body: commentBody,
        }),
      );
    }
  } else if (type === PRChange.MERGE) {
    log(
      'updateManualBackport',
      LogLevel.INFO,
      `Backport of ${oldPRNumber} at #${pr.number} merged to ${pr.base.ref}`,
    );

    labelToRemove = PRStatus.IN_FLIGHT + pr.base.ref;
    labelsToAdd.push(PRStatus.MERGED + pr.base.ref);
  } else {
    log(
      'updateManualBackport',
      LogLevel.INFO,
      `Backport of ${oldPRNumber} at #${pr.number} to ${pr.base.ref} was closed`,
    );

    // If a backport is closed with unmerged commits, we just want
    // to remove the old in-flight/<branch> label.
    labelToRemove = PRStatus.IN_FLIGHT + pr.base.ref;
  }

  await labelUtils.removeLabel(context, oldPRNumber, labelToRemove);
  await labelUtils.addLabels(context, pr.number, labelsToAdd);
};
