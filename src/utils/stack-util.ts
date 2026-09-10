import { WebHookPR } from '../types';

/**
 * Stack metadata GitHub adds to a `pull_request` payload when the PR is part
 * of a stacked pull request. Not yet modelled by @octokit/webhooks-types.
 */
export interface PullRequestStack {
  id?: number;
  number: number;
  size: number;
  position: number;
  base: {
    ref: string;
    sha: string;
  };
}

export type StackablePR = WebHookPR & { stack?: PullRequestStack | null };

/**
 * Returns the branch a PR will ultimately land on. A PR in a stack targets
 * the PR below it, so its own base ref is an intermediate branch - the
 * stack's base ref is the one that matters for backport purposes.
 */
export const getEffectiveBaseRef = (pr: StackablePR): string =>
  pr.stack?.base?.ref ?? pr.base.ref;
