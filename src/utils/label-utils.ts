import { Context } from 'probot';
import { Octokit } from '@octokit/rest';
import { log } from './log-util';
import { LogLevel } from '../enums';
import { SEMVER_LABELS, SEMVER_PREFIX } from '../constants';

export const addLabels = async (
  context: Context,
  prNumber: number,
  labelsToAdd: string[],
) => {
  log('addLabel', LogLevel.INFO, `Adding ${labelsToAdd} to PR #${prNumber}`);

  return context.github.issues.addLabels(
    context.repo({
      issue_number: prNumber,
      labels: labelsToAdd,
    }),
  );
};

export const getSemverLabel = (pr: Octokit.PullsGetResponse) => {
  return pr.labels.find((l: any) => l.name.startsWith(SEMVER_PREFIX));
};

export const getHighestSemverLabel = (...labels: string[]) => {
  const ranked = [
    SEMVER_LABELS.PATCH,
    SEMVER_LABELS.MINOR,
    SEMVER_LABELS.MAJOR,
  ];

  const indices = labels.map((label) => ranked.indexOf(label));
  if (indices.some((index) => index === -1)) {
    throw new Error('Invalid semver labels');
  }

  return ranked[Math.max(...indices)];
};

export const removeLabel = async (
  context: Context,
  prNumber: number,
  labelToRemove: string,
) => {
  log(
    'removeLabel',
    LogLevel.INFO,
    `Removing ${labelToRemove} from PR #${prNumber}`,
  );

  // If the issue does not have the label, don't try remove it
  if (!(await labelExistsOnPR(context, prNumber, labelToRemove))) return;

  return context.github.issues.removeLabel(
    context.repo({
      issue_number: prNumber,
      name: labelToRemove,
    }),
  );
};

export const labelToTargetBranch = (
  label: Octokit.PullsGetResponseLabelsItem,
  prefix: string,
) => {
  return label.name.replace(prefix, '');
};

export const labelExistsOnPR = async (
  context: Context,
  prNumber: number,
  labelName: string,
) => {
  log(
    'labelExistsOnPR',
    LogLevel.INFO,
    `Checking if ${labelName} exists on #${prNumber}`,
  );

  const labels = await context.github.issues.listLabelsOnIssue(
    context.repo({
      issue_number: prNumber,
      per_page: 100,
      page: 1,
    }),
  );

  return labels.data.some((label) => label.name === labelName);
};
