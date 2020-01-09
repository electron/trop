import { Context } from 'probot';
import { PullsGetResponseLabelsItem } from '@octokit/rest';

export const addLabel = async (context: Context, prNumber: number, labelsToAdd: string[]) => {
  console.log(`addLabel: adding ${labelsToAdd} to PR #${prNumber}`);

  return context.github.issues.addLabels(context.repo({
    issue_number: prNumber,
    labels: labelsToAdd,
  }));
};

export const removeLabel = async (context: Context, prNumber: number, labelToRemove: string) => {
  console.log(`removeLabel: removing ${labelToRemove} from PR #${prNumber}`);

  // If the issue does not have the label, don't try remove it
  if (!await labelExistsOnPR(context, prNumber, labelToRemove)) return;

  return context.github.issues.removeLabel(context.repo({
    issue_number: prNumber,
    name: labelToRemove,
  }));
};

export const labelToTargetBranch = (label: PullsGetResponseLabelsItem, prefix: string) => {
  return label.name.replace(prefix, '');
};

export const labelExistsOnPR = async (context: Context, prNumber: number, labelName: string) => {
  const labels = await context.github.issues.listLabelsOnIssue(context.repo({
    issue_number: prNumber,
    per_page: 100,
    page: 1,
  }));

  return labels.data.some(label => label.name === labelName);
};
