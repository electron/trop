import * as fs from 'fs-extra';
import * as path from 'path';
import * as simpleGit from 'simple-git/promise';
import { BackportOptions } from '../interfaces';
import { log } from '../utils/log-util';
import { LogLevel } from '../enums';

const cleanRawGitString = (s: string) => {
  let nS = s.trim();
  if (nS.startsWith(`'`)) {
    nS = nS.slice(1).trim();
  }
  if (nS.endsWith(`'`)) {
    nS = nS.slice(0, nS.length - 1).trim();
  }
  return nS;
};

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
              return <const>{
                path: changedFile,
                mode: <const>'100644',
                type: 'blob',
                sha: null as any,
              };
            }
            const fileContents = await fs.readFile(onDiskPath, 'utf-8');
            const stat = await fs.stat(onDiskPath);
            const userMode = (stat.mode & parseInt('777', 8)).toString(8)[0];
            return <const>{
              path: changedFile,
              mode: userMode === '6' ? '100644' : '100755',
              type: 'blob',
              content: fileContents,
            };
          }),
        ),
      });

      const authorEmail = cleanRawGitString(
        await git.raw(['show', '-s', "--format='%ae'", commit.hash]),
      );
      const authorName = cleanRawGitString(
        await git.raw(['show', '-s', "--format='%an'", commit.hash]),
      );
      const commitMessage = cleanRawGitString(
        await git.raw(['show', '-s', "--format='%B'", commit.hash]),
      );

      const newMessage = `${commitMessage}\n\nCo-authored-by: ${authorName} <${authorEmail}>`;

      const newCommit = await options.github.git.createCommit({
        owner: 'electron',
        repo: 'electron',
        parents: [baseCommitSha],
        tree: newTree.data.sha,
        message: newMessage,
      });

      baseTreeSha = newTree.data.sha;
      baseCommitSha = newCommit.data.sha;
    }

    await options.github.git.createRef({
      owner: 'electron',
      repo: 'electron',
      sha: baseCommitSha,
      ref: `refs/heads/${options.tempBranch}`,
    });
  }

  return { dir: options.dir };
};
