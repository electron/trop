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

export interface PullRequest {
  id: number;
  labels: Label[];
  locked: boolean;
  active_lock_reason: string;
  head: {
    sha: string;
  };
  base: {
    sha: string;
  };
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

export interface ProbotContext<T> {
  payload: T;
  github: GitHub;
  repo<U>(a: U): U & { repo: string, owner: string };
}

type HookHandler<T> = (context: ProbotContext<T>) => void;

export interface Probot {
  on(
    event: 'pull_request.closed',
    handler: HookHandler<PullRequestEvent>): void;
  log(...things: string[]): void;
}