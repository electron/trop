import { RemotesOptions } from '../interfaces';
import { log } from '../utils/log-util';
import { LogLevel } from '../enums';
import { authenticatedGit } from '../utils/git-auth';

/**
 * Sets up remotes that trop will run backports with.
 *
 * @param options - an object containing:
 *  1) dir - the repo directory
 *  2) accessToken - the installation token to fetch the remotes with, passed
 *     to git through its environment rather than stored in the remote URL
 *  3) remotes - the list of remotes to set on the initialized git repository
 * @returns an object containing the repo initialization directory
 */
export const setupRemotes = async (options: RemotesOptions) => {
  log('setupRemotes', LogLevel.INFO, 'Setting up git remotes');

  const git = authenticatedGit(options.dir, options.accessToken);

  // Add git remotes.
  for (const remote of options.remotes) {
    await git.addRemote(remote.name, remote.value);
  }

  // Fetch git remotes.
  for (const remote of options.remotes) {
    await git.raw(['fetch', remote.name]);
  }
  return { dir: options.dir };
};
