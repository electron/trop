import * as labelUtils from '../utils/label-utils';
import { log } from '../utils/log-util';
import { PRChange, PRStatus, LogLevel } from '../enums';
import { Context } from 'probot';

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
  let labelToAdd;

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

    if (
      !(await labelUtils.labelExistsOnPR(context, oldPRNumber, labelToRemove))
    ) {
      labelToRemove = PRStatus.TARGET + pr.base.ref;
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
  } else if (PRChange.MERGE) {
    log(
      'updateManualBackport',
      LogLevel.INFO,
      `Backport of ${oldPRNumber} at #${pr.number} merged to ${pr.base.ref}`,
    );

    labelToRemove = PRStatus.IN_FLIGHT + pr.base.ref;
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

  await labelUtils.removeLabel(context, oldPRNumber, labelToRemove);

  if (labelToAdd) {
    await labelUtils.addLabel(context, oldPRNumber, [labelToAdd]);
  }

  // Add labels for the backport and target branch to the manual backport if
  // the maintainer forgot to do so themselves
  await labelUtils.addLabel(context, pr.number, ['backport', pr.base.ref]);
};
