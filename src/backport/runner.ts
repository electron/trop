import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as simpleGit from 'simple-git/promise';
import * as commands from './commands';
import * as config from 'config-yml';

export interface InitRepoOptions {
  owner: string;
  repo: string;
}

export interface RemotesOptions {
  dir: string;
  remotes: {
    name: string,
    value: string,
  }[];
}

export interface BackportOptions {
  dir: string;
  slug: string;
  targetRemote: string;
  targetBranch: string;
  tempRemote: string;
  tempBranch: string;
  patches: string[];
}

export type RunnerOptions = {
  what: typeof commands.INIT_REPO;
  payload: InitRepoOptions;
} | {
  what: typeof commands.SET_UP_REMOTES;
  payload: RemotesOptions;
} | {
  what: typeof commands.BACKPORT;
  payload: BackportOptions;
};

const baseDir = path.resolve(os.tmpdir(), 'trop-working');

export const initRepo = async (options: InitRepoOptions) => {
  const slug = `${options.owner}/${options.repo}`;
  await fs.mkdirp(path.resolve(baseDir, slug));
  const prefix = path.resolve(baseDir, slug, 'tmp-');
  const dir = await fs.mkdtemp(prefix);
  await fs.mkdirp(dir);
  await fs.remove(dir);
  await fs.mkdirp(dir);
  const git = simpleGit(dir);
  // This adds support for the target_repo being private as long as the fork user has read access
  if (process.env.GITHUB_FORK_USER_CLONE_LOGIN) {
    await git.clone(
      `https://${process.env.GITHUB_FORK_USER_CLONE_LOGIN}:${process.env.GITHUB_FORK_USER_TOKEN}@github.com/${slug}.git`,
      '.',
    );
  } else {
    await git.clone(
      `https://github.com/${slug}.git`,
      '.',
    );
  }

  // Clean up just in case
  await git.reset('hard');
  const status = await git.status();

  for (const file of status.not_added) {
    await fs.remove(path.resolve(dir, file));
  }

  await git.checkout('master');
  await git.pull();
  await git.addConfig('user.email', config.tropEmail || 'trop@example.com');
  await git.addConfig('user.name', config.tropName || 'Trop Bot');
  await git.addConfig('commit.gpgsign', 'false');
  return { dir };
};

export const setUpRemotes = async (options: RemotesOptions) => {
  const git = simpleGit(options.dir);

  // Add remotes
  for (const remote of options.remotes) {
    await git.addRemote(remote.name, remote.value);
  }

  // Fetch remotes
  for (const remote of options.remotes) {
    await git.raw(['fetch', remote.name]);
  }
  return { dir: options.dir };
};

export const backportCommitsToBranch = async (options: BackportOptions) => {
  const git = simpleGit(options.dir);
  // Create branch
  await git.checkout(`target_repo/${options.targetBranch}`);
  await git.pull('target_repo', options.targetBranch);
  await git.checkoutBranch(options.tempBranch, `target_repo/${options.targetBranch}`);

  // Cherry pick
  const patchPath = `${options.dir}.patch`;
  for (const patch of options.patches) {
    await fs.writeFile(patchPath, patch, 'utf8');
    await git.raw(['am', '-3', patchPath]);
    await fs.remove(patchPath);
  }

  // Push
  await git.push(options.tempRemote, options.tempBranch, {
    '--set-upstream': true,
  });
  return { dir: options.dir };
};

export const runCommand = async (options: RunnerOptions): Promise<{ dir: string }> => {
  switch (options.what) {
    case commands.INIT_REPO:
      return await initRepo(options.payload);
    case commands.SET_UP_REMOTES:
      return await setUpRemotes(options.payload);
    case commands.BACKPORT:
      return await backportCommitsToBranch(options.payload);
    default:
      throw new Error('wut u doin\' kiddo');
  }
};
