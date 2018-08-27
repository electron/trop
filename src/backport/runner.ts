import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as simpleGit from 'simple-git/promise';
import * as commands from './commands';

export interface InitRepoOptions {
  owner: string;
  repo: string;
}

export interface RemotesOptions {
  slug: string;
  remotes: {
    name: string,
    value: string,
  }[];
}

export interface BackportOptions {
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

const PATCH_NAME = 'current.patch';

const baseDir = path.resolve(os.tmpdir(), 'trop-working');
const getGit = (slug: string) => simpleGit(path.resolve(baseDir, slug));

const TROP_NAME = 'Electron Bot';
const TROP_EMAIL = 'electron@github.com';

const initRepo = async (options: InitRepoOptions) => {
  const slug = `${options.owner}/${options.repo}`;
  const dir = path.resolve(baseDir, slug);
  await fs.mkdirp(dir);
  await fs.remove(dir);
  await fs.mkdirp(dir);
  const git = getGit(slug);
  await git.clone(
    `https://github.com/${slug}.git`,
    '.',
  );

  // Clean up scraps
  try { await (git as any).raw(['cherry-pick', '--abort']); } catch (e) {}
  try { await (git as any).raw(['am', '--abort']); } catch (e) {}
  await (git as any).reset('hard');
  const status = await git.status();

  for (const file of status.not_added) {
    await fs.remove(path.resolve(dir, file));
  }

  await git.checkout('master');
  await git.pull();
  await git.addConfig('user.email', TROP_EMAIL);
  await git.addConfig('user.name', TROP_NAME);
  await git.addConfig('commit.gpgsign', 'false');
  return { success: true };
};

const setUpRemotes = async (options: RemotesOptions) => {
  const git = getGit(options.slug);

  // Add remotes
  for (const remote of options.remotes) {
    await git.addRemote(remote.name, remote.value);
  }

  // Fetch remotes
  for (const remote of options.remotes) {
    await (git as any).raw(['fetch', remote.name]);
  }
  return { success: true };
};

const backportCommitsToBranch = async (options: BackportOptions) => {
  const git = getGit(options.slug);
  // Create branch
  await git.checkout(`target_repo/${options.targetBranch}`);
  await git.pull('target_repo', options.targetBranch);
  await git.checkoutBranch(options.tempBranch, `target_repo/${options.targetBranch}`);

  // Cherry pick
  const patchPath = path.resolve(baseDir, options.slug, PATCH_NAME);
  for (const patch of options.patches) {
    await fs.writeFile(patchPath, patch, 'utf8');
    await (git as any).raw(['am', '-3', '>', PATCH_NAME]);
    await fs.remove(patchPath);
  }

  // Push
  await git.push(options.tempRemote, options.tempBranch, {
    '--set-upstream': true,
  });
  return { success: true };
};

export const runCommand = async (options: RunnerOptions) => {
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
