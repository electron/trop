import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackportPurpose } from '../src/enums';
import queue from '../src/Queue';
import { runSandboxedBackport } from '../src/sandbox';
import { SandboxInfraError } from '../src/sandbox/runner';
import { backportImpl } from '../src/utils';
import { markBackportCheckFailed } from '../src/utils/checks-util';
import { addLabels, removeLabel } from '../src/utils/label-utils';

vi.mock('../src/sandbox', () => ({ runSandboxedBackport: vi.fn() }));
vi.mock('../src/utils/token-util', () => ({
  getRepoToken: vi.fn().mockResolvedValue('token'),
}));
vi.mock('../src/utils/label-utils', () => ({
  addLabels: vi.fn(),
  removeLabel: vi.fn(),
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
    repos: { getCommit: vi.fn().mockResolvedValue({ data: { files: [] } }) },
    pulls: { get: vi.fn() },
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
