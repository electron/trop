import { Context } from 'probot';
import { Label, TropConfig } from '../backport/Probot';
import { PRStatus } from '../enums';

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

export const getLabelPrefixes = async (context: Pick<Context, 'config'>) => {
  const config = await context.config<TropConfig>('config.yml') || {};
  const target = config.targetLabelPrefix || PRStatus.TARGET;
  const inFlight = config.inFlightLabelPrefix || PRStatus.IN_FLIGHT;
  const merged = config.mergedLabelPrefix || PRStatus.MERGED;
  const needsManual = config.needsManualLabelPrefix || PRStatus.NEEDS_MANUAL;

  return { target, inFlight, merged, needsManual };
};
