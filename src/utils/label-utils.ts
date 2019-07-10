import { Context } from 'probot';
import { Label } from '../Probot';

export const addLabel = async (context: Context, prNumber: number, labelsToAdd: string[]) => {
  return context.github.issues.addLabels(context.repo({
    number: prNumber,
    labels: labelsToAdd,
  }));
};

export const removeLabel = async (context: Context, prNumber: number, labelToRemove: string) => {
  // If the issue does not have the label, don't try remove it
  if (!await labelExistsOnPR(context, prNumber, labelToRemove)) return;

  return context.github.issues.removeLabel(context.repo({
    number: prNumber,
    name: labelToRemove,
  }));
};

export const labelToTargetBranch = (label: Label, prefix: string) => {
  return label.name.replace(prefix, '');
};

export const labelExistsOnPR = async (context: Context, prNumber: number, labelName: string) => {
  const baseParams = context.repo({ number: prNumber });
  const labels = await context.github.paginate(
    context.github.issues.listLabelsOnIssue(baseParams),
    res => res.data,
  );

  return labels.some(label => label.name === labelName);
};
