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

export const getHighestSemverLabel = (first: string, second: string) => {
  if ([first, second].every((label) => label.startsWith(SEMVER_PREFIX))) {
    throw new Error('Invalid semver labels');
  }

  // Labels are equal, return either.
  if (first === second) return first;
  // first is major, second is patch/minor/none.
  if (first === SEMVER_LABELS.MAJOR) return first;
  // second is major, first is patch/minor/none.
  if (second === SEMVER_LABELS.MAJOR) return second;
  // first is minor, second is patch/none.
  if (first === SEMVER_LABELS.MINOR) return first;
  // second is minor, first is patch/none.
  if (second === SEMVER_LABELS.MINOR) return second;
  // first is patch, second is none.
  if (first === SEMVER_LABELS.PATCH) return first;
  // second is patch, first is none.
  return second;
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
