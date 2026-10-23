import { createHash } from 'crypto';

import { describe, expect, it } from 'vitest';

import {
  BackstopCommit,
  BackstopContext,
  BackstopError,
  checkBackstop,
  TreeFile,
} from '../src/sandbox/backstop';
import { SandboxApplied, SandboxFileChange } from '../src/sandbox/protocol';

// In these specs an uploaded blob's "SHA-256" is its git id.
const gitId = (s: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(s)}\0${s}`)
    .digest('hex');
const ID = (n: string) => n;

const modify = (path: string, pre: string, post: string, mode = '100644') =>
  [
    `diff --git a/${path} b/${path}`,
    `index ${pre.slice(0, 7)}..${post.slice(0, 7)} ${mode}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n');

const add = (path: string, post: string, mode = '100644') =>
  [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    `index 0000000..${post.slice(0, 7)}`,
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+b',
  ].join('\n');

const remove = (path: string, pre: string, mode = '100644') =>
  [
    `diff --git a/${path} b/${path}`,
    `deleted file mode ${mode}`,
    `index ${pre.slice(0, 7)}..0000000`,
    `--- a/${path}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-a',
  ].join('\n');

const chmod = (path: string, from: string, to: string) =>
  [`diff --git a/${path} b/${path}`, `old mode ${from}`, `new mode ${to}`].join(
    '\n',
  );

const write = (
  path: string,
  blob: string,
  mode: '100644' | '100755' | '120000' = '100644',
): SandboxFileChange => ({ path, mode, blob });

const file = (id: string, mode = '100644'): TreeFile => ({ id, mode });

const run = (opts: {
  commits: BackstopCommit[];
  applied: (SandboxApplied | null)[];
  target?: Record<string, TreeFile>;
  renamed?: string[];
}) => {
  const ctx: BackstopContext = {
    commits: opts.commits,
    applied: opts.applied,
    renamedOnTarget: async () => new Set(opts.renamed ?? []),
    targetFiles: async (paths) =>
      new Map(
        paths.flatMap((p) =>
          opts.target?.[p] ? [[p, opts.target[p]] as const] : [],
        ),
      ),
    gitBlobId: ID,
  };
  return checkBackstop(ctx);
};

const listed = (path: string, post: string) => [
  { filename: path, status: 'modified', sha: post },
];

const [A, B, C, D, EVIL] = ['a\n', 'b\n', 'c\n', 'd\n', 'evil\n'].map(gitId);

describe('checkBackstop()', () => {
  it('passes a backport that applied as the original did', async () => {
    await expect(
      run({
        commits: [{ diff: modify('a.txt', A, B), files: listed('a.txt', B) }],
        applied: [{ changes: [write('a.txt', B)] }],
        target: { 'a.txt': file(A) },
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a change to a file no commit touches', async () => {
    await expect(
      run({
        commits: [{ diff: modify('a.txt', A, B), files: [] }],
        applied: [
          {
            changes: [write('a.txt', B), write('.github/workflows/x.yml', C)],
          },
        ],
      }),
    ).rejects.toThrow(BackstopError);
  });

  it('allows the path the target branch renamed a file to', async () => {
    const opts = {
      commits: [{ diff: modify('a.txt', A, B), files: [] }],
      applied: [{ changes: [write('moved/a.txt', C)] }],
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
            diff: modify('a.txt', A, B),
            files: [
              {
                filename: 'b.txt',
                previousFilename: 'c.txt',
                status: 'renamed',
              },
            ],
          },
        ],
        applied: [{ changes: [write('c.txt', C), write('b.txt', D)] }],
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses contents other than the original where the target had the same file', async () => {
    await expect(
      run({
        commits: [{ diff: modify('a.txt', A, B), files: listed('a.txt', B) }],
        applied: [{ changes: [write('a.txt', EVIL)] }],
        target: { 'a.txt': file(A) },
      }),
    ).rejects.toThrow(BackstopError);
  });

  it("checks the diff's abbreviated id where GitHub's list falls short", async () => {
    const commits = [{ diff: modify('a.txt', A, B), files: [] }];
    const target = { 'a.txt': file(A) };
    await expect(
      run({ commits, applied: [{ changes: [write('a.txt', B)] }], target }),
    ).resolves.toBeUndefined();
    await expect(
      run({ commits, applied: [{ changes: [write('a.txt', EVIL)] }], target }),
    ).rejects.toThrow(BackstopError);
  });

  // The security review's PoCs (zz-poc3): a mode flip with the right blob.
  it.each([
    ['a symlink', '120000'],
    ['executable', '100755'],
  ] as const)('refuses a file made %s with the right blob', async (_, mode) => {
    await expect(
      run({
        commits: [{ diff: modify('a.txt', A, B), files: listed('a.txt', B) }],
        applied: [{ changes: [write('a.txt', B, mode)] }],
        target: { 'a.txt': file(A) },
      }),
    ).rejects.toThrow(BackstopError);
  });

  it('checks a change of mode only', async () => {
    const commits = [{ diff: chmod('run.sh', '100644', '100755'), files: [] }];
    const target = { 'run.sh': file(A) };
    await expect(
      run({
        commits,
        applied: [{ changes: [write('run.sh', A, '100755')] }],
        target,
      }),
    ).resolves.toBeUndefined();
    // The content has to stay the target's...
    await expect(
      run({
        commits,
        applied: [{ changes: [write('run.sh', EVIL, '100755')] }],
        target,
      }),
    ).rejects.toThrow(BackstopError);
    // ...and the mode has to change.
    await expect(
      run({ commits, applied: [{ changes: [] }], target }),
    ).rejects.toThrow(BackstopError);
  });

  it('checks a new file', async () => {
    const commits = [
      { diff: add('new.sh', B, '100755'), files: listed('new.sh', B) },
    ];
    await expect(
      run({ commits, applied: [{ changes: [write('new.sh', B, '100755')] }] }),
    ).resolves.toBeUndefined();
    await expect(
      run({ commits, applied: [{ changes: [write('new.sh', B)] }] }),
    ).rejects.toThrow(BackstopError);
  });

  it('checks a change of type as one change', async () => {
    // A symlink replaced by a regular file: a deletion and an addition.
    const commits = [
      {
        diff: `${remove('x', A, '120000')}\n${add('x', B)}`,
        files: listed('x', B),
      },
    ];
    const target = { x: file(A, '120000') };
    await expect(
      run({ commits, applied: [{ changes: [write('x', B)] }], target }),
    ).resolves.toBeUndefined();
    await expect(
      run({ commits, applied: [{ changes: [write('x', EVIL)] }], target }),
    ).rejects.toThrow(BackstopError);
  });

  it('does not check a three-way merge, where the target had another version', async () => {
    // Accepted: the merged content can't be predicted.
    await expect(
      run({
        commits: [{ diff: modify('a.txt', A, B), files: listed('a.txt', B) }],
        applied: [{ changes: [write('a.txt', C)] }],
        target: { 'a.txt': file(D) },
      }),
    ).resolves.toBeUndefined();
  });

  it('does not check a file whose mode the target changed', async () => {
    await expect(
      run({
        commits: [{ diff: modify('a.txt', A, B), files: listed('a.txt', B) }],
        applied: [{ changes: [write('a.txt', B, '100755')] }],
        target: { 'a.txt': file(A, '100755') },
      }),
    ).resolves.toBeUndefined();
  });

  it('checks that a deletion deletes', async () => {
    const commits = [{ diff: remove('a.txt', A), files: [] }];
    const target = { 'a.txt': file(A) };
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
          { diff: modify('a.txt', A, B), files: listed('a.txt', B) },
          { diff: modify('a.txt', B, C), files: listed('a.txt', C) },
          { diff: modify('a.txt', C, D), files: listed('a.txt', D) },
        ],
        applied: [
          null,
          { changes: [write('a.txt', C)] },
          { changes: [write('a.txt', D)] },
        ],
        // The first commit is on the target already.
        target: { 'a.txt': file(B) },
      }),
    ).resolves.toBeUndefined();
  });

  it('notices a stacked commit whose contents were swapped', async () => {
    await expect(
      run({
        commits: [
          { diff: modify('a.txt', A, B), files: listed('a.txt', B) },
          { diff: modify('a.txt', B, C), files: listed('a.txt', C) },
        ],
        applied: [
          { changes: [write('a.txt', B)] },
          { changes: [write('a.txt', EVIL)] },
        ],
        target: { 'a.txt': file(A) },
      }),
    ).rejects.toThrow(BackstopError);
  });
});
