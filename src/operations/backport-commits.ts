import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import { BackportOptions } from '../interfaces';
import { log } from '../utils/log-util';
import { LogLevel } from '../enums';
import { isUtf8 } from 'buffer';
import { parse } from 'yaml';

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
 * @param options - an object containing:
 *   1) dir - the repo directory
 *   2) targetBranch - the target branch
 *   3) patches - a list of patches to apply to the target branch
 *   4) tempBranch - the temporary branch to PR against the target branch
 * @returns false on failure, otherwise an object containing the repo initialization directory
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
      await fs.promises.writeFile(patchPath, patch, 'utf8');
      await git.raw(['am', '-3', '--keep-cr', patchPath]);
    } catch (error) {
      log(
        'backportCommitsToBranch',
        LogLevel.ERROR,
        `Failed to apply patch to ${options.targetBranch}`,
        error,
      );

      return false;
    } finally {
      if (fs.existsSync(patchPath)) {
        await fs.promises.rm(patchPath, { force: true, recursive: true });
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
    const baseTree = await options.github.git.getCommit(
      options.context.repo({
        commit_sha: baseCommitSha,
      }),
    );
    let baseTreeSha = baseTree.data.sha;

    const config = parse(fs.readFileSync('./config.yml', 'utf8'));
    const committer = {
      email: config.tropEmail,
      name: config.tropName,
    };

    for (const commit of [...appliedCommits.all].reverse()) {
      const rawDiffTree: string = await git.raw([
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        commit.hash,
      ]);
      const changedFiles = rawDiffTree
        .trim()
        .split('\n')
        .map((s: string) => s.trim());
      await git.checkout(commit.hash);

      const newTree = await options.github.git.createTree(
        options.context.repo({
          base_tree: baseTreeSha,
          tree: await Promise.all(
            changedFiles.map(async (changedFile) => {
              const onDiskPath = path.resolve(options.dir, changedFile);
              if (!fs.existsSync(onDiskPath)) {
                return {
                  path: changedFile,
                  mode: '100644',
                  type: 'blob',
                  sha: null,
                };
              }
              const fileContents = await fs.promises.readFile(onDiskPath);
              const stat = await fs.promises.stat(onDiskPath);
              const userMode = (stat.mode & parseInt('777', 8)).toString(8)[0];
              if (isUtf8(fileContents)) {
                return {
                  path: changedFile,
                  mode: userMode === '6' ? '100644' : '100755',
                  type: 'blob',
                  content: fileContents.toString('utf-8'),
                };
              }

              const blob = await options.github.git.createBlob(
                options.context.repo({
                  content: fileContents.toString('base64'),
                  encoding: 'base64',
                }),
              );

              return {
                path: changedFile,
                mode: userMode === '6' ? '100644' : '100755',
                type: 'blob',
                sha: blob.data.sha,
              };
            }),
          ),
        }),
      );

      const gitShowClean = async (fmt: string) => {
        const args: string[] = ['show', '-s', `--format='${fmt}'`, commit.hash];
        return cleanRawGitString(await git.raw(args));
      };

      const author = {
        email: await gitShowClean('%ae'),
        name: await gitShowClean('%an'),
      };

      const message = await gitShowClean('%B');

      const newCommit = await options.github.git.createCommit(
        options.context.repo({
          author,
          committer,
          message,
          parents: [baseCommitSha],
          tree: newTree.data.sha,
        }),
      );

      baseTreeSha = newTree.data.sha;
      baseCommitSha = newCommit.data.sha;
    }

    await options.github.git.createRef(
      options.context.repo({
        sha: baseCommitSha,
        ref: `refs/heads/${options.tempBranch}`,
      }),
    );
  }

  return { dir: options.dir };
};
