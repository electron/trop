import * as config from 'config-yml';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as simpleGit from 'simple-git/promise';

const baseDir = path.resolve(os.tmpdir(), 'trop-working');

export interface InitRepoOptions {
  owner: string;
  repo: string;
}

/*
* Initializes the cloned repo trop will use to run backports
*
* @param {InitRepoOptions} repo and payload for repo initialization
* @returns {Object} - an object containing the repo initialization directory
*/
export const initRepo = async (options: InitRepoOptions) => {
  const slug = `${options.owner}/${options.repo}`;
  await fs.mkdirp(path.resolve(baseDir, slug));
  const prefix = path.resolve(baseDir, slug, 'tmp-');
  const dir = await fs.mkdtemp(prefix);
  await fs.mkdirp(dir);
  await fs.remove(dir);
  await fs.mkdirp(dir);
  const git = simpleGit(dir);

  const forkLogin = process.env.GITHUB_FORK_USER_CLONE_LOGIN;
  const forkToken = process.env.GITHUB_FORK_USER_TOKEN;

  // Adds support for the target_repo being private as
  // long as the fork user has read access
  if (forkLogin) {
    await git.clone(
      `https://${forkLogin}:${forkToken}@github.com/${slug}.git`,
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
