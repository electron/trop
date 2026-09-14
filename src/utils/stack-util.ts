import { SimpleWebHookRepoContext, WebHookPR } from '../types';

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

export const isStackedPR = (pr: StackablePR): boolean =>
  !!pr.stack && pr.stack.size > 1;

/**
 * The top PR of a stack is the one whose merge lands the whole stack, so it
 * is the only member whose `target/*` labels trop acts on.
 */
export const isTopOfStack = (pr: StackablePR): boolean =>
  isStackedPR(pr) && pr.stack!.position === pr.stack!.size;

// Shape of `GET /repos/{owner}/{repo}/stacks/{stack_number}`; `pull_requests`
// is ordered bottom to top. Not yet modelled by @octokit/openapi-types.
interface StackResponse {
  number: number;
  base: { ref: string };
  pull_requests: { number: number }[];
}

const STACK_FETCH_ATTEMPTS = 3;
const STACK_FETCH_RETRY_DELAY_MS = 3000;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const fetchStack = async (
  context: SimpleWebHookRepoContext,
  pr: StackablePR,
): Promise<StackResponse> => {
  if (!pr.stack) {
    throw new Error(`#${pr.number} is not part of a stack`);
  }

  const { data } = await context.octokit.request(
    'GET /repos/{owner}/{repo}/stacks/{stack_number}',
    context.repo({
      stack_number: pr.stack.number,
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    }),
  );
  return data;
};

/**
 * Resolves the top PR of the stack `pr` belongs to.
 */
export const getStackTopPR = async (
  context: SimpleWebHookRepoContext,
  pr: StackablePR,
): Promise<WebHookPR> => {
  const stack = await fetchStack(context, pr);
  const top = stack.pull_requests[stack.pull_requests.length - 1];
  if (!top) {
    throw new Error(`Stack #${stack.number} has no pull requests`);
  }
  if (top.number === pr.number) return pr;

  const { data } = await context.octokit.pulls.get(
    context.repo({ pull_number: top.number }),
  );
  return data as WebHookPR;
};

/**
 * Resolves every PR in the stack topped by `topPr`, ordered bottom to top with
 * the given payload as the last entry.
 *
 * GitHub marks the members of a merged stack as merged one at a time, so when
 * `requireMerged` is set (the default) an unmerged lower member is retried a
 * few times before giving up.
 */
export const getStackMemberPRs = async (
  context: SimpleWebHookRepoContext,
  topPr: StackablePR,
  { requireMerged = true }: { requireMerged?: boolean } = {},
): Promise<WebHookPR[]> => {
  const stack = await fetchStack(context, topPr);

  const memberNumbers = stack.pull_requests
    .map((member) => member.number)
    .filter((number) => number !== topPr.number);

  for (let attempt = 1; ; attempt++) {
    const members: WebHookPR[] = [];
    for (const pull_number of memberNumbers) {
      const { data } = await context.octokit.pulls.get(
        context.repo({ pull_number }),
      );
      members.push(data as WebHookPR);
    }

    const unmerged = members.filter((member) => !member.merged);
    if (!requireMerged || unmerged.length === 0) {
      return [...members, topPr];
    }

    if (attempt >= STACK_FETCH_ATTEMPTS) {
      throw new Error(
        `Stack #${stack.number} has unmerged member(s) ${unmerged
          .map((member) => `#${member.number}`)
          .join(', ')} - cannot backport #${topPr.number}`,
      );
    }
    await delay(STACK_FETCH_RETRY_DELAY_MS);
  }
};
