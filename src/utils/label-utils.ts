import { Context } from 'probot';
import { Label } from '../backport/Probot';

export const addLabel = async (context: Context, prNumber: number, labelsToAdd: string[]) => {
  return context.github.issues.addLabels(context.repo({
    number: prNumber,
    labels: labelsToAdd,
  }));
};

export const removeLabel = async (context: Context, prNumber: number, labelToRemove: string) => {
  // If the issue does not have the label, don't try remove it
  if (!await labelExistsOnPR(context, labelToRemove)) return;

  return context.github.issues.removeLabel(context.repo({
    number: prNumber,
    name: labelToRemove,
  }));
};

export const labelToTargetBranch = (label: Label, prefix: string) => {
  return label.name.replace(prefix, '');
};

export const labelExistsOnPR = async (context: Context, labelName: string) => {
  const labels = await context.github.issues.listLabelsOnIssue(context.repo({
    number: context.payload.pull_request.number,
    per_page: 100,
    page: 1,
  }));

  return labels.data.some(label => label.name === labelName);
};
