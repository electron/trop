import { Branch } from '../interfaces';
import { GH_API_PREFIX, NUM_SUPPORTED_VERSIONS } from '../constants';

import fetch from 'node-fetch';
import { getEnvVar } from './env-util';

/**
 * Fetches an array of the currently supported branches for a repository
 *
 * @returns string[] - an array of currently supported branches in x-y-z format
 */
// Get array of currently supported branches
export async function getSupportedBranches(): Promise<string[]> {
  const ORGANIZATION_NAME = getEnvVar('ORGANIZATION_NAME', true) || 'electron';
  const REPO_NAME = getEnvVar('ORGANIZATION_NAME', true) || 'electron';
  const SUPPORTED_BRANCH_PATTERN = getEnvVar('SUPPORTED_BRANCH_PATTERN', true) || /^[0-9]+-([0-9]+-x|x-y)$/;

  const branchEndpoint = `${GH_API_PREFIX}/repos/${ORGANIZATION_NAME}/${REPO_NAME}/branches`;
  const resp = await fetch(branchEndpoint);

  let branches: Branch[] = await resp.json();
  branches = branches.filter((branch) => {
    return branch.protected && branch.name.match(SUPPORTED_BRANCH_PATTERN);
  });

  const filtered: Record<string, string> = {};
  branches.sort().forEach((branch) => {
    return filtered[branch.name.split('-')[0]] = branch.name;
  });

  const values = Object.values(filtered);
  return values.sort().slice(-NUM_SUPPORTED_VERSIONS);
}
