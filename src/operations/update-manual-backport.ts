import * as labelUtils from '../utils/label-utils';
import { PRChange, PRStatus } from '../enums';
import { Context } from 'probot';

/*
* Updates the labels on a backport's original PR as well as comments with links
* to the backport if it's a newly opened PR
*
* @param {PRChange} The type of PR status change: either OPEN or CLOSE
* @param {number} the number corresponding to the backport's original PR
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

  if (type === PRChange.OPEN) {
    labelToAdd = PRStatus.IN_FLIGHT + pr.base.ref;
    labelToRemove = PRStatus.NEEDS_MANUAL + pr.base.ref;

    if (!await labelUtils.labelExistsOnPR(context, oldPRNumber, labelToRemove)) {
      labelToRemove = PRStatus.TARGET + pr.base.ref;
    }

    // Fetch all existing comments across pages
    const baseParams = context.repo({ number: oldPRNumber });
    const existingComments = await context.github.paginate(
      context.github.issues.listComments(baseParams),
      res => res.data,
    );

    // We should only comment if there is not a previous existing comment
    const commentBody = `A maintainer has manually backported this PR to "${pr.base.ref}", \
please check out #${pr.number}`;
    const shouldComment = !existingComments.some(comment => comment.body === commentBody);

    if (shouldComment) {
      // Comment on the original PR with the manual backport link
      await context.github.issues.createComment(context.repo({
        number: oldPRNumber,
        body: commentBody,
      }));
    }
  } else {
    labelToRemove = PRStatus.IN_FLIGHT + pr.base.ref;
    labelToAdd = PRStatus.MERGED + pr.base.ref;
  }

  await labelUtils.removeLabel(context, oldPRNumber, labelToRemove);
  await labelUtils.addLabel(context, oldPRNumber, [labelToAdd]);
};
