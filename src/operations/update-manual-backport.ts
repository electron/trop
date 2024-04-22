import { BACKPORT_LABEL, BACKPORT_REVIEW_LABELS } from '../constants';
import { PRChange, PRStatus, LogLevel } from '../enums';
import { WebHookPRContext } from '../types';
import { needsSemverMinorBackportLabel, tagBackportReviewers } from '../utils';
import * as labelUtils from '../utils/label-utils';
import { log } from '../utils/log-util';

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
  context: WebHookPRContext,
  type: PRChange,
  oldPRNumber: number,
) => {
  const pr = context.payload.pull_request;

  const newPRLabelsToAdd = [pr.base.ref];

  // Changed labels on the original PR.
  let labelToAdd;
  let labelToRemove;

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

    labelToAdd = PRStatus.IN_FLIGHT + pr.base.ref;
    labelToRemove = PRStatus.NEEDS_MANUAL + pr.base.ref;

    const removeLabelExists = await labelUtils.labelExistsOnPR(
      context,
      oldPRNumber,
      labelToRemove,
    );
    if (!removeLabelExists) {
      labelToRemove = PRStatus.TARGET + pr.base.ref;
    }

    const skipCheckLabelExists = await labelUtils.labelExistsOnPR(
      context,
      pr.number,
      BACKPORT_REVIEW_LABELS.SKIP,
    );
    if (!skipCheckLabelExists) {
      newPRLabelsToAdd.push(BACKPORT_LABEL);
    }

    const { data: originalPR } = await context.octokit.pulls.get(
      context.repo({ pull_number: oldPRNumber }),
    );

    // Propagate semver label from the original PR if the maintainer didn't add it.
    const originalPRSemverLabel = labelUtils.getSemverLabel(originalPR);
    if (originalPRSemverLabel) {
      // If the new PR for some reason has a semver label already, then
      // we need to compare the two semver labels and ensure the higher one
      // takes precedence.
      const newPRSemverLabel = labelUtils.getSemverLabel(pr);
      if (
        newPRSemverLabel &&
        newPRSemverLabel.name !== originalPRSemverLabel.name
      ) {
        const higherLabel = labelUtils.getHighestSemverLabel(
          originalPRSemverLabel.name,
          newPRSemverLabel.name,
        );
        // The existing label is lower precedence - remove and replace it.
        if (higherLabel === originalPRSemverLabel.name) {
          await labelUtils.removeLabel(
            context,
            pr.number,
            newPRSemverLabel.name,
          );
          newPRLabelsToAdd.push(originalPRSemverLabel.name);
        }
      } else {
        newPRLabelsToAdd.push(originalPRSemverLabel.name);
      }
    }

    if (await needsSemverMinorBackportLabel(context, pr)) {
      log(
        'updateManualBackport',
        LogLevel.INFO,
        `Determined that ${pr.number} is semver-minor and needs backport review`,
      );

      newPRLabelsToAdd.push(BACKPORT_REVIEW_LABELS.REQUESTED);
    }

    // We should only comment if there is not a previous existing comment
    const commentBody = `@${pr.user.login} has manually backported this PR to "${pr.base.ref}", \
please check out #${pr.number}`;

    // TODO(codebytere): Once probot updates to @octokit/rest@16 we can use .paginate to
    // get all the comments properly, for now 100 should do
    const { data: existingComments } =
      await context.octokit.issues.listComments(
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
      await context.octokit.issues.createComment(
        context.repo({
          issue_number: oldPRNumber,
          body: commentBody,
        }),
      );
    }

    // Tag default reviewers to manual backport
    await tagBackportReviewers({
      context,
      targetPrNumber: pr.number,
    });
  } else if (type === PRChange.MERGE) {
    log(
      'updateManualBackport',
      LogLevel.INFO,
      `Backport of ${oldPRNumber} at #${pr.number} merged to ${pr.base.ref}`,
    );

    labelToRemove = PRStatus.IN_FLIGHT + pr.base.ref;

    // The old PR should now show that the backport PR has been merged to this branch.
    labelToAdd = PRStatus.MERGED + pr.base.ref;
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

  // Add labels to the new manual backport PR.
  await labelUtils.addLabels(context, pr.number, newPRLabelsToAdd);

  // Update labels on the original PR.
  await labelUtils.removeLabel(context, oldPRNumber, labelToRemove);
  if (labelToAdd) {
    await labelUtils.addLabels(context, oldPRNumber, [labelToAdd]);
  }
};
