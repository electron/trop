import * as simpleGit from 'simple-git/promise';
import { RemotesOptions } from '../interfaces';
import { log } from '../utils/log-util';
import { LogLevel } from '../enums';

/**
 * Sets up remotes that trop will run backports with.
 *
 * @param {RemotesOptions} options - an object containing:
 *  1) dir - the repo directory
 *  2) remotes - the list of remotes to set on the initialized git repository
 * @returns {Object} - an object containing the repo initialization directory
 */
export const setupRemotes = async (options: RemotesOptions) => {
  log('setupRemotes', LogLevel.INFO, 'Setting up git remotes');

  const git = simpleGit(options.dir);

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
