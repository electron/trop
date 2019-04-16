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
  html_url: string;
}

interface Ref {
  sha: string;
  repo: Repository;
  ref: string;
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
  body: string;
}

export interface TropConfig {
  targetLabelPrefix?: string;
  inFlightLabelPrefix?: string;
  mergedLabelPrefix?: string;
  needsManualLabelPrefix?: string;
  authorizedUsers?: string[];
}
