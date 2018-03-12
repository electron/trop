import * as GitHub from '@octokit/rest';

export interface Label {
  id: number;
  url: string;
  name: string;
  description: string;
  color: string;
  default: boolean;
}

interface GitHubUser {
  login: string;
  id: number;
  type: string;
}

export interface Repository {
  owner: GitHubUser;
  name: string;
}

interface Ref {
  sha: string;
  repo: Repository;
}

export interface PullRequest {
  id: number;
  labels: Label[];
  locked: boolean;
  active_lock_reason: string;
  head: Ref;
  base: Ref;
  merged: boolean;
  author: GitHubUser;
  number: number;
  title: string;
}

export interface PullRequestEvent {
  action: 'assigned' | 'unassigned' | 'review_requested'
          | 'review_request_removed' | 'labeled' | 'unlabeled'
          | 'opened' | 'edited' | 'closed' | 'reopened';
  number: number;
  pull_request: PullRequest;
}

interface Config {
  targetLabelPrefix: string;
  mergedLabelPrefix: string;
}

export interface ProbotContext<T> {
  payload: T;
  github: GitHub;
  config: (key: string) => Config;
  repo<U>(a: U): U & { repo: string, owner: string };
}

type HookHandler<T> = (context: ProbotContext<T>) => void;

export interface Probot {
  on(
    event: 'pull_request.closed',
    handler: HookHandler<PullRequestEvent>): void;
  log(...things: string[]): void;
}