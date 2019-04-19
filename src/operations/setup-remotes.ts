import * as simpleGit from 'simple-git/promise';

export interface RemotesOptions {
  dir: string;
  remotes: {
    name: string,
    value: string,
  }[];
}

/*
* Sets up remotes that trop will run backports with.
*
* @param {RemotesOptions} - an object containing:
* 1) dir - the repo directory
* 2) remotes - the list of remotes to set on the initialized git repository
* @returns {Object} - an object containing the repo initialization directory
*/
export const setupRemotes = async (options: RemotesOptions) => {
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
