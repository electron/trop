import { NUM_SUPPORTED_VERSIONS } from '../constants';

import { getEnvVar } from './env-util';
import { Context } from 'probot';
import { log } from './log-util';
import { LogLevel } from '../enums';

/**
 * Fetches an array of the currently supported branches for a repository.
 *
 * @param {Context} context - the context of the event that was triggered
 * @returns {Promise<string[]>} - an array of currently supported branches in x-y-z format
 */
export async function getSupportedBranches(
  context: Context,
): Promise<string[]> {
  log(
    'getSupportedBranches',
    LogLevel.INFO,
    'Fetching supported branches for this repository',
  );

  const SUPPORTED_BRANCH_ENV_PATTERN = getEnvVar(
    'SUPPORTED_BRANCH_PATTERN',
    '^(d)+-(?:(?:[0-9]+-x$)|(?:x+-y$))$',
  );
  const SUPPORTED_BRANCH_PATTERN = new RegExp(SUPPORTED_BRANCH_ENV_PATTERN);

  const { data: branches } = await context.github.repos.listBranches(
    context.repo({
      protected: true,
    }),
  );

  const releaseBranches = branches.filter((branch) =>
    branch.name.match(SUPPORTED_BRANCH_PATTERN),
  );
  const filtered: Record<string, string> = {};
  releaseBranches
    .sort((a, b) => {
      const aParts = a.name.split('-');
      const bParts = b.name.split('-');
      for (let i = 0; i < aParts.length; i += 1) {
        if (aParts[i] === bParts[i]) continue;
        return parseInt(aParts[i], 10) - parseInt(bParts[i], 10);
      }
      return 0;
    })
    .forEach((branch) => {
      return (filtered[branch.name.split('-')[0]] = branch.name);
    });

  const values = Object.values(filtered);
  return values
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .slice(-NUM_SUPPORTED_VERSIONS);
}

/**
 * @returns A scoped Regex matching the backport pattern present in PR bodies.
 */
export const getBackportPattern = () => {
  return /(?:^|\n)(?:manual |manually )?backport.*(?:#(\d+)|\/pull\/(\d+))/gim;
};
