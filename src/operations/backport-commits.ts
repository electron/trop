import * as fs from 'fs-extra';
import * as simpleGit from 'simple-git/promise';
import { BackportOptions } from '../interfaces';
import { log } from '../utils/log-util';
import { LogLevel } from '../enums';

/**
 * Runs the git commands to apply backports in a series of cherry-picked commits.
 *
 * @param {BackportOptions} options - an object containing:
 *   1) dir - the repo directory
 *   2) targetBranch - the target branch
 *   3) patches - a list of patches to apply to the target branch
 *   4) tempBranch - the temporary branch to PR against the target branch
 * @returns {Object} - an object containing the repo initialization directory
 */
export const backportCommitsToBranch = async (options: BackportOptions) => {
  log(
    'backportCommitsToBranch',
    LogLevel.INFO,
    `Backporting ${options.patches.length} commits to ${options.targetBranch}`,
  );

  const git = simpleGit(options.dir);

  // Abort previous patch attempts
  try {
    await git.raw(['am', '--abort']);
  } catch {}

  // Create branch to cherry-pick the commits to.
  try {
    await git.checkout(`target_repo/${options.targetBranch}`);
    await git.pull('target_repo', options.targetBranch);
    if (
      Object.keys((await git.branchLocal()).branches).includes(
        options.tempBranch,
      )
    ) {
      log(
        'backportCommitsToBranch',
        LogLevel.INFO,
        `The provided temporary branch name "${options.tempBranch}" already exists, deleting existing ref before backporting`,
      );
      await git.branch(['-D', options.tempBranch]);
    }
    await git.checkoutBranch(
      options.tempBranch,
      `target_repo/${options.targetBranch}`,
    );
  } catch (error) {
    log(
      'backportCommitsToBranch',
      LogLevel.ERROR,
      `Failed to checkout new backport branch`,
      error,
    );

    return false;
  }

  // Cherry pick the commits to be backported.
  const patchPath = `${options.dir}.patch`;

  for (const patch of options.patches) {
    try {
      await fs.writeFile(patchPath, patch, 'utf8');
      await git.raw(['am', '-3', patchPath]);
      await fs.remove(patchPath);
    } catch (error) {
      log(
        'backportCommitsToBranch',
        LogLevel.ERROR,
        `Failed to apply patch to ${options.targetBranch}`,
        error,
      );

      return false;
    }
  }

  // Push the commit to the target branch on the remote.
  if (options.shouldPush) {
    await git.push(options.targetRemote, options.tempBranch, {
      '--set-upstream': null,
    });
  }

  return { dir: options.dir };
};
