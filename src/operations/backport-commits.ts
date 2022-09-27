import * as config from 'config-yml';
import * as fs from 'fs-extra';
import { IQueue } from 'queue';
import * as path from 'path';
import * as simpleGit from 'simple-git/promise';
import { BackportOptions } from '../interfaces';
import { log } from '../utils/log-util';
import { LogLevel } from '../enums';

const makeQueue: IQueue = require('queue');

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
    } catch (error) {
      log(
        'backportCommitsToBranch',
        LogLevel.ERROR,
        `Failed to apply patch to ${options.targetBranch}`,
        error,
      );

      return false;
    } finally {
      if (await fs.pathExists(patchPath)) {
        await fs.remove(patchPath);
      }
    }
  }

  // Push the commit to the target branch on the remote.
  if (options.shouldPush) {
    const appliedCommits = await git.log({
      from: `target_repo/${options.targetBranch}`,
      to: options.tempBranch,
    });
    let baseCommitSha = await git.revparse([
      `target_repo/${options.targetBranch}`,
    ]);
    const baseTree = await options.github.git.getCommit({
      owner: 'electron',
      repo: 'electron',
      commit_sha: baseCommitSha,
    });
    let baseTreeSha = baseTree.data.sha;

    for (const commit of [...appliedCommits.all].reverse()) {
      const rawDiffTree = await git.raw([
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        commit.hash,
      ]);
      const changedFiles = rawDiffTree
        .trim()
        .split('\n')
        .map((s) => s.trim());
      await git.checkout(commit.hash);

      const newTree = await options.github.git.createTree({
        base_tree: baseTreeSha,
        owner: 'electron',
        repo: 'electron',
        tree: await Promise.all(
          changedFiles.map(async (changedFile) => {
            const onDiskPath = path.resolve(options.dir, changedFile);
            if (!(await fs.pathExists(onDiskPath))) {
              return {
                path: changedFile,
                mode: '100644',
                type: 'blob',
                sha: null as any,
              };
            }
            const fileContents = await fs.readFile(onDiskPath, 'utf-8');
            const stat = await fs.stat(onDiskPath);
            return {
              path: changedFile,
              mode: stat.mode === 33188 ? '100644' : '100755',
              type: 'blob',
              contents: fileContents,
            };
          }),
        ),
      });

      const authorEmail = await git.raw(['log', "--format='%ae'", commit.hash]);
      const authorName = await git.raw(['log', "--format='%an'", commit.hash]);
      const commitMessage = await git.raw([
        'log',
        "--format='%B'",
        commit.hash,
      ]);

      const newCommit = await options.github.git.createCommit({
        owner: 'electron',
        repo: 'electron',
        parents: [baseCommitSha],
        tree: baseTreeSha,
        message: commitMessage.trim(),
        author: {
          email: authorEmail.trim(),
          name: authorName.trim(),
        },
        committer: {
          email: config.tropEmail,
          name: config.tropName,
        },
      });

      baseTreeSha = newTree.data.sha;
      baseCommitSha = newCommit.data.sha;
    }

    await options.github.git.createRef({
      owner: 'electron',
      repo: 'electron',
      sha: baseCommitSha,
      ref: options.tempBranch,
    });
  }

  return { dir: options.dir };
};
