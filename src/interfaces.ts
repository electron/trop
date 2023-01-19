import { BackportPurpose } from './enums';
import {
  SimpleWebHookRepoContext,
  WebHookPR,
  WebHookRepoContext,
} from './types';

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
  patches: string[];
  shouldPush: boolean;
  github: WebHookRepoContext['octokit'];
}

export interface TryBackportOptions {
  context: SimpleWebHookRepoContext;
  repoAccessToken: string;
  purpose: BackportPurpose;
  pr: WebHookPR;
  dir: string;
  slug: string;
  targetBranch: string;
  tempBranch: string;
}
