import { describe, expect, it } from 'vitest';

import {
  BackstopCommit,
  BackstopContext,
  BackstopError,
  checkBackstop,
} from '../src/sandbox/backstop';
import { SandboxApplied, SandboxFileChange } from '../src/sandbox/protocol';

// In these specs a blob's "SHA-256" is just a name, which is also its git
// id.
const ID = (n: string) => n;

const modify = (path: string, pre: string, post: string) =>
  [
    `diff --git a/${path} b/${path}`,
    `index ${pre}..${post} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n');

const remove = (path: string, pre: string) =>
  [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    `index ${pre}..0000000`,
    `--- a/${path}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-a',
  ].join('\n');

const write = (path: string, blob: string): SandboxFileChange => ({
  path,
  mode: '100644',
  blob,
});

const run = (opts: {
  commits: BackstopCommit[];
  applied: (SandboxApplied | null)[];
  target?: Record<string, string>;
  renamed?: string[];
}) => {
  const ctx: BackstopContext = {
    commits: opts.commits,
    applied: opts.applied,
    renamedOnTarget: async () => new Set(opts.renamed ?? []),
    targetBlobIds: async (paths) =>
      new Map(paths.map((p) => [p, opts.target?.[p] ?? null])),
    gitBlobId: ID,
  };
  return checkBackstop(ctx);
};

const files = (path: string, post: string) => [
  { filename: path, status: 'modified', sha: ID(post) },
];

describe('checkBackstop()', () => {
  it('passes a backport that applied as the original did', async () => {
    await expect(
      run({
        commits: [
          {
            diff: modify('a.txt', 'aaaa', 'bbbb'),
            files: files('a.txt', 'new'),
          },
        ],
        applied: [{ changes: [write('a.txt', 'new')] }],
        target: { 'a.txt': 'aaaa111' },
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a change to a file no commit touches', async () => {
    await expect(
      run({
        commits: [{ diff: modify('a.txt', 'aaaa', 'bbbb'), files: null }],
        applied: [
          {
            changes: [
              write('a.txt', 'new'),
              write('.github/workflows/x.yml', 'evil'),
            ],
          },
        ],
      }),
    ).rejects.toThrow(BackstopError);
  });

  it('allows the path the target branch renamed a file to', async () => {
    const opts = {
      commits: [{ diff: modify('a.txt', 'aaaa', 'bbbb'), files: null }],
      applied: [{ changes: [write('moved/a.txt', 'merged')] }],
    };
    await expect(run(opts)).rejects.toThrow(BackstopError);
    await expect(
      run({ ...opts, renamed: ['moved/a.txt'] }),
    ).resolves.toBeUndefined();
  });

  it("allows GitHub's file list where the diff headers fall short", async () => {
    await expect(
      run({
        commits: [
          {
            diff: modify('a.txt', 'aaaa', 'bbbb'),
            files: [
              {
                filename: 'b.txt',
                previousFilename: 'c.txt',
                status: 'renamed',
              },
            ],
          },
        ],
        applied: [{ changes: [write('c.txt', 'x'), write('b.txt', 'y')] }],
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses contents other than the original where the target had the same file', async () => {
    await expect(
      run({
        commits: [
          {
            diff: modify('a.txt', 'aaaa', 'bbbb'),
            files: files('a.txt', 'new'),
          },
        ],
        applied: [{ changes: [write('a.txt', 'evil')] }],
        target: { 'a.txt': 'aaaa111' },
      }),
    ).rejects.toThrow(BackstopError);
  });

  it('does not check a three-way merge, where the target had another version', async () => {
    await expect(
      run({
        commits: [
          {
            diff: modify('a.txt', 'aaaa', 'bbbb'),
            files: files('a.txt', 'new'),
          },
        ],
        applied: [{ changes: [write('a.txt', 'merged')] }],
        target: { 'a.txt': 'ffff000' },
      }),
    ).resolves.toBeUndefined();
  });

  it('checks that a deletion deletes', async () => {
    const commits = [{ diff: remove('a.txt', 'aaaa'), files: null }];
    const target = { 'a.txt': 'aaaa111' };
    await expect(
      run({
        commits,
        applied: [{ changes: [{ path: 'a.txt', deleted: true }] }],
        target,
      }),
    ).resolves.toBeUndefined();
    await expect(
      run({ commits, applied: [{ changes: [] }], target }),
    ).rejects.toThrow(BackstopError);
  });

  it('skips a commit already on the target and follows a stack', async () => {
    await expect(
      run({
        commits: [
          {
            diff: modify('a.txt', 'aaaa', 'bbbb'),
            files: files('a.txt', 'one'),
          },
          {
            diff: modify('a.txt', 'bbbb', 'cccc'),
            files: files('a.txt', 'two'),
          },
          {
            diff: modify('a.txt', 'cccc', 'dddd'),
            files: files('a.txt', 'three'),
          },
        ],
        applied: [
          null,
          { changes: [write('a.txt', 'two')] },
          { changes: [write('a.txt', 'three')] },
        ],
        // The first commit is on the target already.
        target: { 'a.txt': 'bbbb222' },
      }),
    ).resolves.toBeUndefined();
  });

  it('notices a stacked commit whose contents were swapped', async () => {
    await expect(
      run({
        commits: [
          {
            diff: modify('a.txt', 'aaaa', 'bbbb'),
            files: files('a.txt', 'bbbb'),
          },
          {
            diff: modify('a.txt', 'bbbb', 'cccc'),
            files: files('a.txt', 'cccc'),
          },
        ],
        applied: [
          { changes: [write('a.txt', 'bbbb')] },
          { changes: [write('a.txt', 'evil')] },
        ],
        target: { 'a.txt': 'aaaa111' },
      }),
    ).rejects.toThrow(BackstopError);
  });
});
