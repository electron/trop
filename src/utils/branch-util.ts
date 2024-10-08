import { NUM_SUPPORTED_VERSIONS } from '../constants';

import { getEnvVar } from './env-util';
import { log } from './log-util';
import { LogLevel } from '../enums';
import { WebHookRepoContext } from '../types';

const SUPPORTED_BRANCH_PATTERN = new RegExp(
  getEnvVar('SUPPORTED_BRANCH_PATTERN', '^(\\d+)-(?:(\\d+)-x|x-y)$'),
);

export class BranchMatcher {
  branchPattern: RegExp;
  numSupportedVersions: number;

  constructor(branchPattern: RegExp, numSupportedVersions: number) {
    this.branchPattern = branchPattern;
    this.numSupportedVersions = numSupportedVersions;
  }

  isBranchSupported(branchName: string): boolean {
    return this.branchPattern.test(branchName);
  }

  getSupportedBranches(allBranches: string[]): string[] {
    const releaseBranches = allBranches.filter((branch) =>
      this.isBranchSupported(branch),
    );
    console.log(allBranches, releaseBranches);
    const filtered: Record<string, string> = {};
    releaseBranches.sort((a, b) => {
      const [, ...aParts] = this.branchPattern.exec(a)!;
      const [, ...bParts] = this.branchPattern.exec(b)!;
      for (let i = 0; i < aParts.length; i += 1) {
        if (aParts[i] === bParts[i]) continue;
        return comparePart(aParts[i], bParts[i]);
      }
      return 0;
    });
    for (const branch of releaseBranches)
      filtered[this.branchPattern.exec(branch)![1]] = branch;

    const values = Object.values(filtered);
    return values.sort(comparePart).slice(-this.numSupportedVersions);
  }
}

const branchMatcher = new BranchMatcher(
  SUPPORTED_BRANCH_PATTERN,
  NUM_SUPPORTED_VERSIONS,
);

export const isBranchSupported =
  branchMatcher.isBranchSupported.bind(branchMatcher);

function comparePart(a: string, b: string): number {
  if (a == null && b != null) return 1;
  if (b == null) return -1;
  if (/^\d+$/.test(a)) {
    return parseInt(a, 10) - parseInt(b, 10);
  } else {
    return a.localeCompare(b);
  }
}

/**
 * Fetches an array of the currently supported branches for a repository.
 *
 * @param context - the context of the event that was triggered
 * @returns an array of currently supported branches in x-y-z format
 */
export async function getSupportedBranches(
  context: Pick<WebHookRepoContext, 'octokit' | 'repo'>,
): Promise<string[]> {
  log(
    'getSupportedBranches',
    LogLevel.INFO,
    'Fetching supported branches for this repository',
  );

  const { data: branches } = await context.octokit.repos.listBranches(
    context.repo({
      protected: true,
    }),
  );

  return branchMatcher.getSupportedBranches(branches.map((b) => b.name));
}

/**
 * @returns A scoped Regex matching the backport pattern present in PR bodies.
 */
export const getBackportPattern = () =>
  /(?:^|\n)(?:manual |manually )?backport (?:of )?(?:#(\d+)|https:\/\/github.com\/.*\/pull\/(\d+))/gim;
