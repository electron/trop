export interface RemotesOptions {
  dir: string;
  remotes: {
    name: string;
    value: string;
  }[];
}

export interface InitRepoOptions {
  slug: string;
  accessToken: string;
}

export interface BackportOptions {
  dir: string;
  slug: string;
  targetRemote: string;
  targetBranch: string;
  tempBranch: string;
  patch: string;
  shouldPush: boolean;
}
