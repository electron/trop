import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backportBatchToBranch } from '../src/operations/backport-to-location';
import { BatchBackportQueue } from '../src/operations/batch-backport';

vi.mock('../src/operations/backport-to-location', () => ({
  backportBatchToBranch: vi.fn(),
}));

const NOW = Date.parse('2026-10-25T12:00:00Z');
const HOUR = 60 * 60 * 1000;

interface FakePR {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  labels: { name: string }[];
  stack?: object;
}

const labels = (...names: string[]) => names.map((name) => ({ name }));

/** A merged PR labeled `batch-backport`, merged `hoursAgo` hours ago. */
const merged = (
  number: number,
  hoursAgo: number,
  targets = ['42-x-y'],
  overrides: Partial<FakePR> = {},
): FakePR => ({
  number,
  state: 'closed',
  merged: true,
  merged_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
  labels: labels('batch-backport', ...targets.map((t) => `target/${t}`)),
  ...overrides,
});

const open = (number: number): FakePR => ({
  number,
  state: 'open',
  merged: false,
  merged_at: null,
  labels: labels('batch-backport', 'target/42-x-y'),
});

/**
 * A stand-in for a repository on GitHub: its PRs, listed as issues by
 * label and fetched one by one.
 */
const repository = (...prs: FakePR[]) => {
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const octokit = {
    issues: {
      listForRepo: vi.fn(),
      listComments: vi.fn(),
      createComment: vi.fn(),
    },
    pulls: {
      get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({
        data: byNumber.get(pull_number),
      })),
    },
    paginate: vi.fn(
      async (_route: unknown, params: { state: string; labels: string }) =>
        [...byNumber.values()]
          .filter(
            (pr) =>
              pr.state === params.state &&
              pr.labels.some((l) => l.name === params.labels),
          )
          .map((pr) => ({
            number: pr.number,
            pull_request: { merged_at: pr.merged_at },
            labels: pr.labels,
          })),
    ),
  };
  const comments: { body: string }[][] = [];
  octokit.issues.createComment.mockImplementation(
    async ({ issue_number, body }: { issue_number: number; body: string }) => {
      (comments[issue_number] ??= []).push({ body });
    },
  );
  const paginate = octokit.paginate;
  octokit.paginate = vi.fn(async (route: unknown, params: never) =>
    route === octokit.issues.listComments
      ? (comments[(params as { issue_number: number }).issue_number] ?? [])
      : paginate(route, params),
  );
  const context = {
    octokit,
    repo: (o?: object) => ({ owner: 'electron', repo: 'electron', ...o }),
    payload: {
      repository: { name: 'electron', owner: { login: 'electron' } },
      installation: { id: 7 },
    },
  };
  return {
    context: context as never,
    octokit,
    set: (pr: FakePR) => byNumber.set(pr.number, pr),
    comments: () =>
      octokit.issues.createComment.mock.calls.map(([c]) => ({
        number: c.issue_number as number,
        body: c.body as string,
      })),
  };
};

/** The batches handed to backportBatchToBranch, as PR numbers. */
const batches = () =>
  vi.mocked(backportBatchToBranch).mock.calls.map(([, , units, branch]) => ({
    branch,
    units: units.map((unit) => unit.map((pr) => pr.number)),
  }));

const settleAll = () => {
  for (const [, , , , onSettled] of vi.mocked(backportBatchToBranch).mock
    .calls) {
    onSettled?.();
  }
};

describe('BatchBackportQueue', () => {
  let queue: BatchBackportQueue;
  let robot: { auth: ReturnType<typeof vi.fn> };
  const resolvePRs = vi.fn(async (_context: unknown, pr: unknown) => [pr]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backportBatchToBranch).mockResolvedValue(undefined);
    resolvePRs.mockImplementation(async (_context, pr) => [pr]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    robot = { auth: vi.fn() };
    queue = new BatchBackportQueue(robot as never, resolvePRs as never);
  });

  afterEach(() => {
    queue.dispose();
    vi.useRealTimers();
  });

  describe('when a labeled PR merges', () => {
    it('holds it while another labeled PR is open, and says so once', async () => {
      const pr = merged(1, 0);
      const repo = repository(pr, open(2), open(3));

      await queue.onMerged(repo.context, pr as never);

      expect(backportBatchToBranch).not.toHaveBeenCalled();
      expect(repo.comments()).toHaveLength(1);
      const [{ number, body }] = repo.comments();
      expect(number).toBe(1);
      expect(body).toContain('queued for a batch backport to "42-x-y"');
      expect(body).toContain('once #2, #3 are merged or closed');
      expect(body).toContain('2026-10-25 14:00 UTC at the latest');
    });

    it('says so only once, however often the merge is handled', async () => {
      const pr = merged(1, 0);
      const repo = repository(pr, open(2));

      await queue.onMerged(repo.context, pr as never);
      await queue.onMerged(repo.context, pr as never);

      expect(repo.comments()).toHaveLength(1);
    });

    it('gives the deadline of the oldest PR waiting', async () => {
      const pr = merged(2, 0);
      const repo = repository(merged(1, 1.5), pr, open(3));

      await queue.onMerged(repo.context, pr as never);

      expect(backportBatchToBranch).not.toHaveBeenCalled();
      expect(repo.comments()[0].body).toContain('2026-10-25 12:30 UTC');
    });

    it('backports the batch when it was the last labeled PR open', async () => {
      const pr = merged(2, 0);
      const repo = repository(merged(1, 1), pr);

      await queue.onMerged(repo.context, pr as never);

      expect(repo.comments()).toEqual([]);
      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1], [2]] }]);
    });

    it('counts the merged PR even before GitHub lists it as closed', async () => {
      const pr = merged(2, 0);
      // GitHub still lists #2 as open.
      const repo = repository(merged(1, 1), { ...pr, state: 'open' });

      await queue.onMerged(repo.context, pr as never);

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1], [2]] }]);
    });

    it('backports each target branch as its own batch of the PRs targeting it', async () => {
      const pr = merged(3, 0, ['41-x-y']);
      const repo = repository(
        merged(1, 2 / 3, ['42-x-y', '41-x-y']),
        merged(2, 1 / 3, ['42-x-y']),
        pr,
      );

      await queue.onMerged(repo.context, pr as never);

      expect(batches()).toEqual([
        { branch: '42-x-y', units: [[1], [2]] },
        { branch: '41-x-y', units: [[1], [3]] },
      ]);
    });

    it('orders the batch by merge time', async () => {
      const pr = merged(1, 0);
      const repo = repository(merged(3, 1), merged(2, 0.5), pr);

      await queue.onMerged(repo.context, pr as never);

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[3], [2], [1]] }]);
    });

    it('backports at once when the oldest PR has waited long enough', async () => {
      const pr = merged(2, 0);
      const repo = repository(merged(1, 2.5), pr, open(3));

      await queue.onMerged(repo.context, pr as never);

      expect(repo.comments()).toEqual([]);
      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1], [2]] }]);
    });

    it('does not queue a PR without target labels, but may let the batch go', async () => {
      const pr = merged(2, 0, []);
      const repo = repository(merged(1, 1), pr);

      await queue.onMerged(repo.context, pr as never);

      expect(repo.comments()).toEqual([]);
      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1]] }]);
    });

    it('does not even fetch PRs closed unmerged or whose target labels were consumed', async () => {
      const pr = merged(3, 0);
      const repo = repository(
        merged(1, 1, []),
        { ...merged(2, 1), merged: false, merged_at: null },
        pr,
      );

      await queue.onMerged(repo.context, pr as never);

      expect(repo.octokit.pulls.get).not.toHaveBeenCalled();
    });

    it('ignores PRs whose target labels were consumed or that never merged', async () => {
      const pr = merged(3, 0);
      const repo = repository(
        merged(1, 1, []),
        { ...merged(2, 1), merged: false, merged_at: null },
        pr,
      );

      await queue.onMerged(repo.context, pr as never);

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[3]] }]);
    });
  });

  describe('stacks', () => {
    const stack = (position: number) => ({
      stack: { number: 8, size: 2, position, base: { ref: 'main' } },
    });

    it('backports a stack in the batch with its members, driven by its top PR', async () => {
      const top = merged(6, 0, ['42-x-y'], stack(2));
      const repo = repository(
        merged(4, 1),
        merged(5, 0, ['42-x-y'], stack(1)),
        top,
      );
      resolvePRs.mockImplementation(async (_context, pr) =>
        (pr as FakePR).number === 6 ? [{ number: 5 }, pr] : [pr],
      );

      await queue.onMerged(repo.context, top as never);

      expect(resolvePRs).toHaveBeenCalledTimes(2);
      expect(batches()).toEqual([{ branch: '42-x-y', units: [[4], [5, 6]] }]);
    });

    it('leaves out a stack that could not be resolved', async () => {
      const pr = merged(2, 0);
      const repo = repository(merged(1, 1), pr);
      resolvePRs.mockImplementation(async (_context, p) =>
        (p as FakePR).number === 1 ? null : [p],
      );

      await queue.onMerged(repo.context, pr as never);

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[2]] }]);
    });
  });

  describe('the deadline', () => {
    it('backports the batch two hours after its oldest PR merged', async () => {
      const pr = merged(1, 0);
      const repo = repository(pr, open(2));
      robot.auth.mockResolvedValue(repo.octokit);

      await queue.onMerged(repo.context, pr as never);
      await vi.advanceTimersByTimeAsync(2 * HOUR - 1000);
      expect(backportBatchToBranch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(backportBatchToBranch).toHaveBeenCalled());

      // With a fresh client for the installation.
      expect(robot.auth).toHaveBeenCalledWith(7);
      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1]] }]);
    });

    it('keeps the earliest deadline when more PRs join the batch', async () => {
      const first = merged(1, 0);
      const repo = repository(first, open(2), open(3));
      robot.auth.mockResolvedValue(repo.octokit);
      await queue.onMerged(repo.context, first as never);

      await vi.advanceTimersByTimeAsync(HOUR);
      const second = merged(2, 0);
      repo.set(second);
      await queue.onMerged(repo.context, second as never);

      await vi.advanceTimersByTimeAsync(HOUR);
      await vi.waitFor(() => expect(backportBatchToBranch).toHaveBeenCalled());
      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1], [2]] }]);
    });

    it('is dropped once the batch has gone', async () => {
      const first = merged(1, 0);
      const repo = repository(first, open(2));
      robot.auth.mockResolvedValue(repo.octokit);
      await queue.onMerged(repo.context, first as never);

      const second = merged(2, 0);
      repo.set(second);
      await queue.onMerged(repo.context, second as never);
      expect(batches()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(3 * HOUR);
      expect(robot.auth).not.toHaveBeenCalled();
      expect(batches()).toHaveLength(1);
    });

    it('tries again later when handling the deadline fails', async () => {
      const pr = merged(1, 0);
      const repo = repository(pr, open(2));
      robot.auth
        .mockRejectedValueOnce(new Error('GitHub is down'))
        .mockResolvedValue(repo.octokit);
      await queue.onMerged(repo.context, pr as never);

      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(backportBatchToBranch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.waitFor(() => expect(backportBatchToBranch).toHaveBeenCalled());
    });
  });

  describe('when a labeled PR leaves the batch', () => {
    it('backports the batch when the last open one closes unmerged', async () => {
      const repo = repository(merged(1, 1), merged(2, 0.5));

      await queue.onLeft(repo.context, { number: 3 } as never);

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1], [2]] }]);
    });

    it('backports the batch when the label is removed from the last open one', async () => {
      // GitHub may still list #3 with the label.
      const repo = repository(merged(1, 1), open(3));

      await queue.onLeft(repo.context, { number: 3 } as never);

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1]] }]);
    });

    it('keeps holding the batch, quietly, while another one is open', async () => {
      const repo = repository(merged(1, 1), open(3), open(4));

      await queue.onLeft(repo.context, { number: 3 } as never);

      expect(backportBatchToBranch).not.toHaveBeenCalled();
      expect(repo.comments()).toEqual([]);
    });

    it('does nothing when no PR is queued', async () => {
      const repo = repository(open(4));

      await queue.onLeft(repo.context, { number: 3 } as never);

      expect(backportBatchToBranch).not.toHaveBeenCalled();
      expect(repo.octokit.pulls.get).not.toHaveBeenCalled();
    });
  });

  describe('/trop run backport', () => {
    it('backports the whole batch at once, open PRs or not', async () => {
      const repo = repository(merged(1, 1), merged(2, 0), open(3));

      await expect(queue.flushNow(repo.context)).resolves.toBe(true);

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1], [2]] }]);
    });

    it('says when there is nothing to backport', async () => {
      const repo = repository(merged(1, 1, []), open(3));

      await expect(queue.flushNow(repo.context)).resolves.toBe(false);

      expect(backportBatchToBranch).not.toHaveBeenCalled();
    });
  });

  describe('running batches', () => {
    it('backports a batch once, however many events see it go', async () => {
      const first = merged(1, 0);
      const second = merged(2, 0);
      const repo = repository(first, second);

      await Promise.all([
        queue.onMerged(repo.context, first as never),
        queue.onMerged(repo.context, second as never),
        queue.flushNow(repo.context),
      ]);

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1], [2]] }]);
    });

    it('queues a PR again once its batch backport is over', async () => {
      // e.g. an internal error, which leaves the target labels in place.
      const repo = repository(merged(1, 1));
      await queue.flushNow(repo.context);
      await queue.flushNow(repo.context);
      expect(batches()).toHaveLength(1);

      settleAll();
      await queue.flushNow(repo.context);
      expect(batches()).toHaveLength(2);
    });

    it('queues a PR again when its batch backport could not start', async () => {
      vi.mocked(backportBatchToBranch).mockRejectedValueOnce(
        new Error('GitHub is down'),
      );
      const repo = repository(merged(1, 1));
      await queue.flushNow(repo.context);
      await vi.waitFor(async () => {
        await queue.flushNow(repo.context);
        expect(batches()).toHaveLength(2);
      });
    });

    it('only holds back the target branches being backported', async () => {
      const repo = repository(merged(1, 1, ['42-x-y']));
      await queue.flushNow(repo.context);

      repo.set(merged(1, 1, ['42-x-y', '41-x-y']));
      await queue.flushNow(repo.context);

      expect(batches()).toEqual([
        { branch: '42-x-y', units: [[1]] },
        { branch: '41-x-y', units: [[1]] },
      ]);
    });
  });

  describe('rescan()', () => {
    // trop installed on the electron org, where a search finds `found`.
    const installed = (
      repo: ReturnType<typeof repository>,
      found: { labels: { name: string }[] }[],
    ) => {
      const app = {
        apps: { listInstallations: vi.fn() },
        paginate: vi.fn(async () => [
          { id: 7, account: { login: 'electron', type: 'Organization' } },
        ]),
      };
      const search = {
        issuesAndPullRequests: vi.fn(),
      };
      const installation = {
        ...repo.octokit,
        search,
        repos: {
          get: vi.fn(async () => ({
            data: {
              name: 'electron',
              owner: { login: 'electron' },
              default_branch: 'main',
            },
          })),
        },
        paginate: vi.fn(async (route: unknown, params: { q?: string }) =>
          route === search.issuesAndPullRequests
            ? found.map((item) => ({
                ...item,
                repository_url:
                  'https://api.github.com/repos/electron/electron',
              }))
            : repo.octokit.paginate(route, params as never),
        ),
      };
      robot.auth.mockImplementation(async (id?: number) =>
        id === undefined ? app : installation,
      );
      return installation;
    };

    it('searches each installation once for merged PRs with the label', async () => {
      const repo = repository(merged(1, 0.5));
      const installation = installed(repo, [merged(1, 0.5)]);

      await queue.rescan();

      expect(installation.paginate).toHaveBeenCalledWith(
        installation.search.issuesAndPullRequests,
        expect.objectContaining({
          q: 'org:electron is:pr is:merged label:"batch-backport"',
        }),
      );
      expect(installation.repos.get).toHaveBeenCalledWith({
        owner: 'electron',
        repo: 'electron',
      });
    });

    it('leaves alone repositories without merged PRs still waiting', async () => {
      const repo = repository(merged(1, 3, []));
      const installation = installed(repo, [merged(1, 3, [])]);

      await queue.rescan();

      expect(installation.repos.get).not.toHaveBeenCalled();
      expect(backportBatchToBranch).not.toHaveBeenCalled();
    });

    it('re-arms the deadline of a batch that is still waiting', async () => {
      const repo = repository(merged(1, 1), open(2));
      installed(repo, [merged(1, 1)]);

      await queue.rescan();
      expect(backportBatchToBranch).not.toHaveBeenCalled();
      expect(repo.comments()).toEqual([]);

      await vi.advanceTimersByTimeAsync(HOUR);
      await vi.waitFor(() => expect(backportBatchToBranch).toHaveBeenCalled());
      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1]] }]);
    });

    it('backports an overdue batch at once', async () => {
      const repo = repository(merged(1, 3), open(2));
      installed(repo, [merged(1, 3)]);

      await queue.rescan();

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1]] }]);
    });

    it('backports a batch whose last open PR went while trop was down', async () => {
      const repo = repository(merged(1, 0.5));
      installed(repo, [merged(1, 0.5)]);

      await queue.rescan();

      expect(batches()).toEqual([{ branch: '42-x-y', units: [[1]] }]);
    });

    it('carries on with the other repositories when one fails', async () => {
      const repo = repository(merged(1, 3));
      installed(repo, [merged(1, 3)]);
      repo.octokit.pulls.get.mockRejectedValueOnce(new Error('boom'));

      await expect(queue.rescan()).resolves.toBeUndefined();
    });
  });
});
