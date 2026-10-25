import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackportPurpose } from '../src/enums';
import queue from '../src/Queue';
import { runSandboxedBackport } from '../src/sandbox';
import { SandboxInfraError } from '../src/sandbox/runner';
import { backportBatchImpl, backportImpl } from '../src/utils';
import { markBackportCheckFailed } from '../src/utils/checks-util';
import { addLabels, removeLabel } from '../src/utils/label-utils';

vi.mock('../src/sandbox', () => ({ runSandboxedBackport: vi.fn() }));
vi.mock('../src/utils/token-util', () => ({
  getRepoToken: vi.fn().mockResolvedValue('token'),
}));
vi.mock('../src/utils/label-utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addLabels: vi.fn(),
  removeLabel: vi.fn(),
  labelExistsOnPR: vi.fn().mockResolvedValue(false),
}));
vi.mock('../src/utils/checks-util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrCreateCheckRun: vi.fn().mockResolvedValue({ id: 1, name: 'check' }),
  markBackportCheckFailed: vi.fn(),
}));

// GitHub's `.patch` and `.diff` of the PR's one commit.
const diff = [
  'diff --git a/README b/README',
  'index ce01362..94954ab 100644',
  '--- a/README',
  '+++ b/README',
  '@@ -1 +1,2 @@',
  ' hello',
  '+world',
  '',
].join('\n');
const patch = [
  'From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001',
  'From: Trop Test <trop@example.com>',
  'Date: Thu, 22 Oct 2026 12:00:00 -0700',
  'Subject: [PATCH] fix: a thing',
  '',
  '---',
  diff,
].join('\n');
vi.mock('node-fetch', () => ({
  default: vi.fn(
    async (_url: string, init: { headers: Record<string, string> }) => ({
      ok: true,
      status: 200,
      text: async () => (init.headers.Accept.endsWith('.patch') ? patch : diff),
    }),
  ),
}));

const pr = {
  number: 1234,
  title: 'fix: a thing',
  body: 'Notes: none',
  merged: false,
  head: { sha: 'a'.repeat(40) },
  base: {
    ref: 'main',
    sha: 'b'.repeat(40),
    repo: { name: 'electron', owner: { login: 'electron' } },
  },
  labels: [],
};

const context = () => {
  const octokit = {
    paginate: vi
      .fn()
      .mockResolvedValue([{ sha: 'c'.repeat(40), parents: [{}] }]),
    issues: { createComment: vi.fn() },
    checks: { update: vi.fn() },
    repos: {
      getCommit: vi.fn().mockResolvedValue({ data: { files: [] } }),
      getCollaboratorPermissionLevel: vi
        .fn()
        .mockResolvedValue({ data: { permission: 'write' } }),
    },
    pulls: {
      get: vi.fn(),
      create: vi.fn().mockResolvedValue({ data: { number: 99, labels: [] } }),
      requestReviewers: vi.fn(),
    },
  };
  return {
    octokit,
    repo: (o: object) => ({ owner: 'electron', repo: 'electron', ...o }),
    payload: { repository: { default_branch: 'main' } },
  };
};

const backport = async (
  purpose: BackportPurpose,
  setup: (ctx: ReturnType<typeof context>) => void = () => {},
  prOverrides: object = {},
) => {
  const ctx = context();
  setup(ctx);
  const done = new Promise((r) => queue.once('empty', r));
  await backportImpl(
    {} as never,
    ctx as never,
    { ...pr, ...prOverrides } as never,
    '42-x-y',
    purpose,
  );
  await done;
  return ctx;
};

describe('backportImpl()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports a sandbox failure as an internal error, not a conflict', async () => {
    vi.mocked(runSandboxedBackport).mockRejectedValueOnce(
      new SandboxInfraError('the pod did not start'),
    );
    const ctx = await backport(BackportPurpose.ExecuteBackport);

    expect(ctx.octokit.issues.createComment).toHaveBeenCalledTimes(1);
    const { body } = ctx.octokit.issues.createComment.mock.calls[0][0];
    expect(body).toContain('internal error');
    expect(body).toContain('/trop run backport-to 42-x-y');
    expect(body).not.toContain('manually');
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
    expect(markBackportCheckFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '42-x-y',
      { infraError: true },
    );
  });

  it('only marks the check for a sandbox failure while checking', async () => {
    vi.mocked(runSandboxedBackport).mockRejectedValueOnce(
      new SandboxInfraError('the pod did not start'),
    );
    const ctx = await backport(BackportPurpose.Check);
    expect(ctx.octokit.issues.createComment).not.toHaveBeenCalled();
    expect(markBackportCheckFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '42-x-y',
      { infraError: true },
    );
  });

  it('fails closed as an internal error when GitHub lists no files', async () => {
    const ctx = await backport(BackportPurpose.ExecuteBackport, (c) =>
      c.octokit.repos.getCommit.mockRejectedValue(new Error('502')),
    );
    expect(runSandboxedBackport).not.toHaveBeenCalled();
    expect(ctx.octokit.repos.getCommit).toHaveBeenCalledTimes(3);
    const { body } = ctx.octokit.issues.createComment.mock.calls[0][0];
    expect(body).toContain('internal error');
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('reports a conflict as an internal error when the squash could not be tried', async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce({
      kind: 'conflict',
      diff: '',
    });
    const ctx = await backport(
      BackportPurpose.ExecuteBackport,
      (c) =>
        c.octokit.repos.getCommit.mockImplementation(
          async ({ ref }: { ref: string }) => {
            if (ref === 'd'.repeat(40)) throw new Error('502');
            return { data: { files: [] } };
          },
        ),
      { merged: true, merge_commit_sha: 'd'.repeat(40) },
    );
    const [opts] = vi.mocked(runSandboxedBackport).mock.calls[0];
    expect(opts.attempts.map((a) => a.kind)).toEqual(['all']);
    const { body } = ctx.octokit.issues.createComment.mock.calls[0][0];
    expect(body).toContain('internal error');
    expect(addLabels).not.toHaveBeenCalled();
  });

  it.each([
    ['a job that timed out', 'Sandbox job x timed out'],
    ['a refused upload', 'Sandbox job x failed: uploading a file failed: 413'],
  ])(
    'leaves %s to a manual backport, as any failure was',
    async (_, message) => {
      vi.mocked(runSandboxedBackport).mockRejectedValueOnce(
        new SandboxInfraError(message, false),
      );
      const ctx = await backport(BackportPurpose.ExecuteBackport);
      const { body } = ctx.octokit.issues.createComment.mock.calls[0][0];
      expect(body).toContain('backport manually');
      expect(addLabels).toHaveBeenCalledWith(expect.anything(), 1234, [
        'needs-manual-bp/42-x-y',
      ]);
      expect(markBackportCheckFailed).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        '42-x-y',
        expect.not.objectContaining({ infraError: true }),
      );
    },
  );

  it('still asks for a manual backport after a conflict', async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce({
      kind: 'conflict',
      diff: '',
    });
    const ctx = await backport(BackportPurpose.ExecuteBackport);

    const { body } = ctx.octokit.issues.createComment.mock.calls[0][0];
    expect(body).toContain('backport manually');
    expect(removeLabel).toHaveBeenCalledWith(
      expect.anything(),
      1234,
      'target/42-x-y',
    );
    expect(addLabels).toHaveBeenCalledWith(expect.anything(), 1234, [
      'needs-manual-bp/42-x-y',
    ]);
    expect(markBackportCheckFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '42-x-y',
      expect.not.objectContaining({ infraError: true }),
    );
  });

  it('hands the sandbox the diff alone, and the message and author separately', async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce({
      kind: 'conflict',
      diff: '',
    });
    await backport(BackportPurpose.Check);
    const [opts] = vi.mocked(runSandboxedBackport).mock.calls[0];
    expect(opts.attempts).toEqual([
      {
        kind: 'all',
        commits: [
          {
            diff,
            message: 'fix: a thing',
            author: { name: 'Trop Test', email: 'trop@example.com' },
            files: [],
          },
        ],
      },
    ]);
  });
});

describe('backportBatchImpl()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('BOT_USER_NAME', 'trop[bot]');
  });
  afterEach(() => vi.unstubAllEnvs());

  const member = (number: number, overrides: object = {}) => ({
    ...pr,
    number,
    title: `fix: thing ${number}`,
    body: `Notes: fixed thing ${number}`,
    merged: true,
    merge_commit_sha: String(number).padStart(40, 'd'),
    head: { sha: String(number).padStart(40, 'a') },
    user: { login: `author${number}` },
    labels: [{ name: 'target/42-x-y' }],
    ...overrides,
  });

  const batch = async (
    units: object[][],
    setup: (ctx: ReturnType<typeof context>) => void = () => {},
  ) => {
    const ctx = context();
    setup(ctx);
    const onSettled = vi.fn();
    const done = new Promise((r) => queue.once('empty', r));
    await backportBatchImpl(
      {} as never,
      ctx as never,
      units as never,
      '42-x-y',
      {
        labelToRemove: 'target/42-x-y',
        labelToAdd: 'in-flight/42-x-y',
        onSettled,
      },
    );
    await done;
    expect(onSettled).toHaveBeenCalledTimes(1);
    return ctx;
  };

  const success = (dropped: number[]) => ({
    kind: 'success' as const,
    attempt: 'all' as const,
    baseSha: 'e'.repeat(40),
    commits: [],
    dropped,
  });

  const commentsOn = (ctx: ReturnType<typeof context>, number: number) =>
    ctx.octokit.issues.createComment.mock.calls
      .map(([c]) => c)
      .filter((c) => c.issue_number === number)
      .map((c) => c.body as string);

  it('backports every PR of the batch as one PR', async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce(success([]));
    const ctx = await batch([
      [member(1, { labels: [{ name: 'semver/minor' }] })],
      [member(2, { labels: [{ name: 'semver/patch' }] })],
    ]);

    // Each member applies on its own, its commits first, then its squash.
    const [opts] = vi.mocked(runSandboxedBackport).mock.calls[0];
    expect(opts.attempts).toEqual([]);
    expect(opts.members?.map((m) => m.map((a) => a.kind))).toEqual([
      ['all', 'squash'],
      ['all', 'squash'],
    ]);

    const [created] = ctx.octokit.pulls.create.mock.calls[0];
    expect(created.title).toBe('chore: batch backport of #1, #2');
    expect(created.base).toBe('42-x-y');
    expect(created.head).toMatch(/^trop\/42-x-y-bp-batch-1-2-\d+$/);
    expect(created.body).toContain('Backport of #1\nBackport of #2');
    expect(created.body).toContain('* fixed thing 1\n* fixed thing 2');

    expect(ctx.octokit.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 99,
        reviewers: ['author1', 'author2'],
      }),
    );
    for (const number of [1, 2]) {
      expect(commentsOn(ctx, number)).toEqual([
        expect.stringContaining('as part of a batch backport'),
      ]);
      expect(addLabels).toHaveBeenCalledWith(expect.anything(), number, [
        'in-flight/42-x-y',
      ]);
      expect(removeLabel).toHaveBeenCalledWith(
        expect.anything(),
        number,
        'target/42-x-y',
      );
    }
    expect(addLabels).toHaveBeenCalledWith(expect.anything(), 99, [
      'backport',
      '42-x-y',
      'semver/minor',
    ]);
    expect(ctx.octokit.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'success' }),
    );
    expect(markBackportCheckFailed).not.toHaveBeenCalled();
  });

  it('leaves out a PR that does not apply and backports the rest', async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce(success([0]));
    const ctx = await batch([[member(1)], [member(2)], [member(3)]]);

    const [created] = ctx.octokit.pulls.create.mock.calls[0];
    expect(created.title).toBe('chore: batch backport of #2, #3');
    expect(created.body).toContain('Backport of #2\nBackport of #3');
    expect(created.body).not.toContain('#1');
    expect(ctx.octokit.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: ['author2', 'author3'] }),
    );

    expect(commentsOn(ctx, 1)).toEqual([
      expect.stringMatching(/left out of #99.*backport manually/s),
    ]);
    expect(removeLabel).toHaveBeenCalledWith(
      expect.anything(),
      1,
      'target/42-x-y',
    );
    expect(addLabels).toHaveBeenCalledWith(expect.anything(), 1, [
      'needs-manual-bp/42-x-y',
    ]);
    expect(addLabels).not.toHaveBeenCalledWith(expect.anything(), 1, [
      'in-flight/42-x-y',
    ]);
    expect(markBackportCheckFailed).toHaveBeenCalledTimes(1);
    for (const number of [2, 3]) {
      expect(addLabels).toHaveBeenCalledWith(expect.anything(), number, [
        'in-flight/42-x-y',
      ]);
    }
  });

  it("gives the backport a PR's own title when only that PR is left", async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce(success([1]));
    const ctx = await batch([[member(1)], [member(2)]]);
    const [created] = ctx.octokit.pulls.create.mock.calls[0];
    expect(created.title).toBe('fix: thing 1');
  });

  it('keeps a stack in the batch together, and leaves it out as a whole', async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce(success([0]));
    const ctx = await batch([[member(5), member(6)], [member(7)]]);

    // The stack's commits and squash commits are one member.
    const [opts] = vi.mocked(runSandboxedBackport).mock.calls[0];
    expect(opts.members?.map((m) => m.map((a) => a.commits.length))).toEqual([
      [2, 2],
      [1, 1],
    ]);

    // Only the stack's top PR is commented on, every PR of it is flagged.
    expect(commentsOn(ctx, 5)).toEqual([]);
    expect(commentsOn(ctx, 6)).toEqual([
      expect.stringContaining('left out of #99'),
    ]);
    for (const number of [5, 6]) {
      expect(addLabels).toHaveBeenCalledWith(expect.anything(), number, [
        'needs-manual-bp/42-x-y',
      ]);
    }
  });

  it('flags every PR for a manual backport when none of them applies', async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce({
      kind: 'conflict',
      diff: '',
    });
    const ctx = await batch([[member(1)], [member(2)]]);
    expect(ctx.octokit.pulls.create).not.toHaveBeenCalled();
    for (const number of [1, 2]) {
      expect(commentsOn(ctx, number)).toEqual([
        expect.stringContaining('backport manually'),
      ]);
      expect(addLabels).toHaveBeenCalledWith(expect.anything(), number, [
        'needs-manual-bp/42-x-y',
      ]);
    }
    expect(markBackportCheckFailed).toHaveBeenCalledTimes(2);
  });

  it('keeps the batch queued after an internal error', async () => {
    vi.mocked(runSandboxedBackport).mockRejectedValueOnce(
      new SandboxInfraError('the pod did not start'),
    );
    const ctx = await batch([[member(1)], [member(2)]]);
    for (const number of [1, 2]) {
      expect(commentsOn(ctx, number)).toEqual([
        expect.stringContaining('`/trop run backport`'),
      ]);
    }
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
    expect(markBackportCheckFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '42-x-y',
      { infraError: true },
    );
  });

  it('goes on with the commits of a PR whose squash could not be fetched', async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce(success([]));
    await batch(
      [[member(1, { merge_commit_sha: 'f'.repeat(40) })], [member(2)]],
      (c) =>
        c.octokit.repos.getCommit.mockImplementation(
          async ({ ref }: { ref: string }) => {
            if (ref === 'f'.repeat(40)) throw new Error('502');
            return { data: { files: [] } };
          },
        ),
    );
    const [opts] = vi.mocked(runSandboxedBackport).mock.calls[0];
    expect(opts.members?.map((m) => m.map((a) => a.kind))).toEqual([
      ['all'],
      ['all', 'squash'],
    ]);
  });

  // #1 has no commits to backport, only its squash commit.
  const onlySquash = (c: ReturnType<typeof context>) =>
    c.octokit.paginate.mockImplementation(
      async (_route: string, { pull_number }: { pull_number: number }) =>
        pull_number === 1 ? [] : [{ sha: 'c'.repeat(40), parents: [{}] }],
    );

  it('retries the batch when GitHub does not answer for the only commit a PR can be backported with', async () => {
    const ctx = await batch(
      [[member(1, { merge_commit_sha: 'f'.repeat(40) })], [member(2)]],
      (c) => {
        onlySquash(c);
        c.octokit.repos.getCommit.mockImplementation(
          async ({ ref }: { ref: string }) => {
            if (ref === 'f'.repeat(40)) throw new Error('502');
            return { data: { files: [] } };
          },
        );
      },
    );
    expect(runSandboxedBackport).not.toHaveBeenCalled();
    expect(commentsOn(ctx, 1)).toEqual([
      expect.stringContaining('internal error'),
    ]);
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('does not retry a batch whose squash commit fails for good', async () => {
    const { default: fetch } = await import('node-fetch');
    const fetchPatch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if ((url as string).endsWith('f'.repeat(40)))
        throw new Error('ECONNRESET');
      return fetchPatch(url, init);
    });
    try {
      const ctx = await batch(
        [[member(1, { merge_commit_sha: 'f'.repeat(40) })], [member(2)]],
        onlySquash,
      );
      expect(runSandboxedBackport).not.toHaveBeenCalled();
      expect(commentsOn(ctx, 1)).toEqual([
        expect.stringContaining('backport manually'),
      ]);
      expect(markBackportCheckFailed).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        '42-x-y',
        expect.not.objectContaining({ infraError: true }),
      );
    } finally {
      vi.mocked(fetch).mockImplementation(fetchPatch);
    }
  });

  it('takes the target label off a PR in the batch that is itself a backport', async () => {
    vi.mocked(runSandboxedBackport).mockResolvedValueOnce(success([]));
    await batch(
      [[member(1, { body: 'Backport of #100\n\nNotes: none' })]],
      (c) =>
        c.octokit.pulls.get.mockResolvedValue({
          data: { number: 100, body: '' },
        }),
    );
    for (const number of [1, 100]) {
      expect(removeLabel).toHaveBeenCalledWith(
        expect.anything(),
        number,
        'target/42-x-y',
      );
    }
  });

  it('takes the target label off every PR of a batch to an EOL branch', async () => {
    vi.stubEnv('NO_EOL_SUPPORT', '1');
    const ctx = context();
    Object.assign(ctx.octokit, {
      repos: {
        ...ctx.octokit.repos,
        listBranches: vi.fn().mockResolvedValue({ data: [{ name: '50-x-y' }] }),
      },
    });
    const onSettled = vi.fn();
    await backportBatchImpl(
      {} as never,
      ctx as never,
      [[member(5), member(6)], [member(7)]] as never,
      '42-x-y',
      { labelToRemove: 'target/42-x-y', onSettled },
    );
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(runSandboxedBackport).not.toHaveBeenCalled();
    for (const number of [5, 6, 7]) {
      expect(removeLabel).toHaveBeenCalledWith(
        expect.anything(),
        number,
        'target/42-x-y',
      );
    }
    expect(commentsOn(ctx, 6)).toEqual([
      expect.stringContaining('no longer supported'),
    ]);
    expect(commentsOn(ctx, 5)).toEqual([]);
  });
});
