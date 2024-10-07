import { log } from './log-util';
import { LogLevel } from '../enums';
import { SEMVER_LABELS, SEMVER_PREFIX } from '../constants';
import {
  SimpleWebHookRepoContext,
  WebHookPR,
  WebHookRepoContext,
} from '../types';

export const addLabels = async (
  context: SimpleWebHookRepoContext,
  prNumber: number,
  labelsToAdd: string[],
) => {
  log('addLabel', LogLevel.INFO, `Adding ${labelsToAdd} to PR #${prNumber}`);

  return context.octokit.issues.addLabels(
    context.repo({
      issue_number: prNumber,
      labels: labelsToAdd,
    }),
  );
};

export const getSemverLabel = (pr: Pick<WebHookPR, 'labels'>) => {
  return pr.labels.find((l) => l.name.startsWith(SEMVER_PREFIX));
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
  context: Pick<WebHookRepoContext, 'octokit' | 'repo'>,
  prNumber: number,
  labelToRemove: string,
) => {
  log(
    'removeLabel',
    LogLevel.INFO,
    `Removing ${labelToRemove} from PR #${prNumber}`,
  );

  // If the issue does not have the label, don't try remove it.
  const hasLabel = await labelExistsOnPR(context, prNumber, labelToRemove);
  if (!hasLabel) return;

  return context.octokit.issues.removeLabel(
    context.repo({
      issue_number: prNumber,
      name: labelToRemove,
    }),
  );
};

export const labelToTargetBranch = (
  label: { name: string },
  prefix: string,
) => {
  return label.name.replace(prefix, '');
};

export const labelExistsOnPR = async (
  context: Pick<WebHookRepoContext, 'octokit' | 'repo'>,
  prNumber: number,
  labelName: string,
) => {
  log(
    'labelExistsOnPR',
    LogLevel.INFO,
    `Checking if ${labelName} exists on #${prNumber}`,
  );

  const labels = await context.octokit.issues.listLabelsOnIssue(
    context.repo({
      issue_number: prNumber,
      per_page: 100,
      page: 1,
    }),
  );

  return labels.data.some((label) => label.name === labelName);
};
