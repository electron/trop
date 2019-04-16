import { Context } from 'probot';
import { PRChange } from '../enums';
import * as labelUtils from '../utils/label-utils';

export const updateManualBackport = async (
  context: Context,
  type: PRChange,
  oldPRNumber: number,
) => {
  const pr = context.payload.pull_request;
  let labelToRemove;
  let labelToAdd;

  const labelPrefixes = await labelUtils.getLabelPrefixes(context);

  if (type === PRChange.OPEN) {
    labelToRemove = labelPrefixes.needsManual + pr.base.ref;
    if (!await labelUtils.labelExistsOnPR(context, labelToRemove)) {
      labelToRemove = labelPrefixes.target + pr.base.ref;
    }
    labelToAdd = labelPrefixes.inFlight + pr.base.ref;

    const commentBody = `A maintainer has manually backported this PR to "${pr.base.ref}", \
please check out #${pr.number}`;

    // TODO: Once probot updates to @octokit/rest@16 we can use .paginate to
    // get all the comments properly, for now 100 should do
    const { data: existingComments } = await context.github.issues.listComments(context.repo({
      number: oldPRNumber,
      per_page: 100,
    }));

    // We should only comment if we haven't done it before
    const shouldComment = !existingComments.some(comment => comment.body === commentBody);

    if (shouldComment) {
      // comment on the original PR with the manual backport link
      await context.github.issues.createComment(context.repo({
        number: oldPRNumber,
        body: commentBody,
      }));
    }
  } else {
    labelToRemove = labelPrefixes.inFlight + pr.base.ref;
    labelToAdd = labelPrefixes.merged + pr.base.ref;
  }

  await labelUtils.removeLabel(context, oldPRNumber, labelToRemove);
  await labelUtils.addLabel(context, oldPRNumber, [labelToAdd]);
};
