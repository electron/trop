import { Octokit } from '@octokit/rest';
import { Context } from 'probot';
import { BackportPurpose } from './enums';

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
}

export interface TryBackportOptions {
  context?: Context;
  repoAccessToken: string;
  purpose: BackportPurpose;
  pr: Octokit.PullsGetResponse;
  dir: string;
  slug: string;
  targetBranch: string;
  tempBranch: string;
}
