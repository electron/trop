import { BackportPurpose } from './enums';
import {
  SimpleWebHookRepoContext,
  WebHookPR,
  WebHookRepoContext,
} from './types';

export interface RemotesOptions {
  dir: string;
  // Installation token for fetching the remotes; never stored in the clone.
  accessToken: string;
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
  // Installation token for `git pull`; never stored in the clone.
  accessToken: string;
  slug: string;
  targetRemote: string;
  targetBranch: string;
  tempBranch: string;
  patches: string[];
  shouldPush: boolean;
  github: WebHookRepoContext['octokit'];
  context: SimpleWebHookRepoContext;
}

export interface TryBackportOptions {
  context: SimpleWebHookRepoContext;
  repoAccessToken: string;
  purpose: BackportPurpose;
  // Every PR whose commits are backported together, ordered bottom to top.
  prs: WebHookPR[];
  dir: string;
  slug: string;
  targetBranch: string;
  tempBranch: string;
}
