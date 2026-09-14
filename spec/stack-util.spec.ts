import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SimpleWebHookRepoContext } from '../src/types';
import {
  getEffectiveBaseRef,
  getStackMemberPRs,
  isStackedPR,
  isTopOfStack,
  StackablePR,
} from '../src/utils/stack-util';

describe('getEffectiveBaseRef', () => {
  const pr = { base: { ref: 'fix/some-parent' } } as StackablePR;

  it('returns the base ref of a PR that is not in a stack', () => {
    expect(getEffectiveBaseRef(pr)).toEqual('fix/some-parent');
    expect(getEffectiveBaseRef({ ...pr, stack: null })).toEqual(
      'fix/some-parent',
    );
  });

  it('returns the base ref of the stack for a stacked PR', () => {
    const stacked = {
      ...pr,
      stack: {
        number: 8,
        size: 2,
        position: 2,
        base: { ref: 'main', sha: 'DEF' },
      },
    };
    expect(getEffectiveBaseRef(stacked)).toEqual('main');
  });
});

describe('isStackedPR / isTopOfStack', () => {
  const pr = { number: 3, base: { ref: 'main' } } as StackablePR;
  const stack = (position: number, size: number) => ({
    number: 8,
    size,
    position,
    base: { ref: 'main', sha: 'DEF' },
  });

  it('treats PRs without a stack, or in a stack of one, as unstacked', () => {
    expect(isStackedPR(pr)).toBe(false);
    expect(isStackedPR({ ...pr, stack: null })).toBe(false);
    expect(isStackedPR({ ...pr, stack: stack(1, 1) })).toBe(false);
    expect(isTopOfStack({ ...pr, stack: stack(1, 1) })).toBe(false);
  });

  it('identifies the top of a stack by its position', () => {
    expect(isStackedPR({ ...pr, stack: stack(1, 3) })).toBe(true);
    expect(isTopOfStack({ ...pr, stack: stack(1, 3) })).toBe(false);
    expect(isTopOfStack({ ...pr, stack: stack(2, 3) })).toBe(false);
    expect(isTopOfStack({ ...pr, stack: stack(3, 3) })).toBe(true);
  });
});

describe('getStackMemberPRs', () => {
  const topPr = {
    number: 30,
    merged: true,
    base: { ref: 'stack/two' },
    stack: { number: 8, size: 3, position: 3, base: { ref: 'main', sha: 'X' } },
  } as unknown as StackablePR;

  const makeContext = (members: Record<number, { merged: boolean }>) => {
    const request = vi.fn().mockResolvedValue({
      data: {
        number: 8,
        base: { ref: 'main' },
        pull_requests: [{ number: 10 }, { number: 20 }, { number: 30 }],
      },
    });
    const get = vi.fn(async ({ pull_number }: { pull_number: number }) => ({
      data: { number: pull_number, ...members[pull_number] },
    }));
    const context = {
      octokit: { request, pulls: { get } },
      repo: (obj: object) => ({ owner: 'electron', repo: 'electron', ...obj }),
      payload: {},
    } as unknown as SimpleWebHookRepoContext;
    return { context, request, get };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the members bottom to top, ending with the given top PR', async () => {
    const { context, request, get } = makeContext({
      10: { merged: true },
      20: { merged: true },
    });

    const members = await getStackMemberPRs(context, topPr);

    expect(members.map((pr) => pr.number)).toEqual([10, 20, 30]);
    // The top PR is the payload that was passed in, not a re-fetched copy.
    expect(members[2]).toBe(topPr);
    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/stacks/{stack_number}',
      expect.objectContaining({
        stack_number: 8,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      }),
    );
    expect(get.mock.calls.map(([args]) => args.pull_number)).toEqual([10, 20]);
  });

  it('retries until every lower member is marked merged', async () => {
    const merged = { 10: { merged: true }, 20: { merged: false } };
    const { context, get } = makeContext(merged);

    const promise = getStackMemberPRs(context, topPr);
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(2);

    merged[20].merged = true;
    await vi.advanceTimersByTimeAsync(3000);

    expect((await promise).map((pr) => pr.number)).toEqual([10, 20, 30]);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('throws when a lower member stays unmerged', async () => {
    const { context, get } = makeContext({
      10: { merged: false },
      20: { merged: true },
    });

    const promise = getStackMemberPRs(context, topPr);
    // Avoid an unhandled rejection while the timers are advanced.
    const result = promise.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await result).toEqual(
      new Error('Stack #8 has unmerged member(s) #10 - cannot backport #30'),
    );
    expect(get).toHaveBeenCalledTimes(6);
  });

  it('accepts unmerged members when requireMerged is false', async () => {
    const { context, get } = makeContext({
      10: { merged: false },
      20: { merged: false },
    });

    const members = await getStackMemberPRs(context, topPr, {
      requireMerged: false,
    });

    expect(members.map((pr) => pr.number)).toEqual([10, 20, 30]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('rejects a PR that is not part of a stack', async () => {
    const { context } = makeContext({});
    await expect(
      getStackMemberPRs(context, { ...topPr, stack: null }),
    ).rejects.toThrow('#30 is not part of a stack');
  });
});
