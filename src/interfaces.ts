// Used for git repo initialization and setup
export interface InitRepoOptions {
  owner: string;
  repo: string;
}

// Used for adding and fetching repo remotes
export interface RemotesOptions {
  dir: string;
  remotes: {
    name: string,
    value: string,
  }[];
}

// Used for the actual backport application process
export interface BackportOptions {
  dir: string;
  slug: string;
  targetRemote: string;
  targetBranch: string;
  tempRemote: string;
  tempBranch: string;
  patches: string[];
}
