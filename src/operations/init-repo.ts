import { parse } from 'yaml';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import simpleGit, { CheckRepoActions } from 'simple-git';
import { InitRepoOptions } from '../interfaces';
import { LogLevel } from '../enums';
import { log } from '../utils/log-util';
import { Mutex } from 'async-mutex';

const baseDir =
  process.env.WORKING_DIR ?? path.resolve(os.tmpdir(), 'trop-working');

function githubUrl({ slug, accessToken }: InitRepoOptions): string {
  return `https://x-access-token:${accessToken}@github.com/${slug}.git`;
}

const repoMutex = new Map<string, Mutex>();
function mutexForRepoCache(slug: string) {
  if (!repoMutex.has(slug)) repoMutex.set(slug, new Mutex());
  return repoMutex.get(slug)!;
}

async function updateRepoCache({ slug, accessToken }: InitRepoOptions) {
  const cacheDir = path.resolve(baseDir, slug, 'git-cache');

  await fs.mkdirp(cacheDir);
  const git = simpleGit(cacheDir);
  if (!(await git.checkIsRepo(CheckRepoActions.BARE))) {
    // The repo might be missing, or otherwise somehow corrupt. Re-clone it.
    log(
      'updateRepoCache',
      LogLevel.INFO,
      `${cacheDir} was not a git repo, cloning...`,
    );
    await fs.remove(cacheDir);
    await fs.mkdirp(cacheDir);
    await git.clone(githubUrl({ slug, accessToken }), '.', ['--bare']);
  }
  await git.fetch();

  return cacheDir;
}

/**
 * Initializes the cloned repo trop will use to run backports.
 *
 * @param {InitRepoOptions} options - repo and payload for repo initialization
 * @returns {{dir: string}} - an object containing the repo initialization directory
 */
export const initRepo = async ({
  slug,
  accessToken,
}: InitRepoOptions): Promise<{ dir: string }> => {
  log('initRepo', LogLevel.INFO, 'Setting up local repository');

  await fs.mkdirp(path.resolve(baseDir, slug));
  const prefix = path.resolve(baseDir, slug, 'job-');
  const dir = await fs.mkdtemp(prefix);
  const git = simpleGit(dir);

  // Concurrent access to the repo cache has the potential to mess things up.
  await mutexForRepoCache(slug).runExclusive(async () => {
    const cacheDir = await updateRepoCache({ slug, accessToken });
    await git.clone(cacheDir, '.');
  });

  return { dir };
};
