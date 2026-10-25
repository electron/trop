import { createHash } from 'crypto';

import { describe, expect, it } from 'vitest';

import {
  LIMITS,
  UploadedBlobs,
  validateRepoPath,
  validateSandboxResult,
} from '../src/sandbox/protocol';

const sha256 = (s: string | Buffer) =>
  createHash('sha256').update(s).digest('hex');

// The blobs a job uploaded, by SHA-256.
const uploads = (...contents: (string | Buffer)[]): UploadedBlobs => {
  const blobs = new Map(contents.map((c) => [sha256(c), Buffer.from(c)]));
  return {
    size: (sha) => blobs.get(sha)?.length,
    read: (sha) => blobs.get(sha)!,
  };
};

const blobs = uploads('hi\n', '#!/bin/sh\n', '../a/b.txt', 'a\0b', '');

const applied = (changes?: unknown[], overrides: object = {}) => ({
  ...(changes ? { changes } : {}),
  ...overrides,
});

const success = (entries: unknown[], attempt = 0) => ({
  outcome: 'success',
  attempt,
  applied: entries,
});

const expectation = { patchCounts: [1, 2], includeChanges: true };
const validate = (value: unknown, expect = expectation) =>
  validateSandboxResult(value, expect, blobs);

describe('validateSandboxResult()', () => {
  it('accepts a well-formed success', () => {
    const result = validate(
      success([
        applied([
          { path: 'a/b.txt', mode: '100644', blob: sha256('hi\n') },
          { path: 'script.sh', mode: '100755', blob: sha256('#!/bin/sh\n') },
          { path: 'link', mode: '120000', blob: sha256('../a/b.txt') },
          { path: 'gone.txt', deleted: true },
        ]),
      ]),
    );
    expect(result).toMatchObject({ outcome: 'success', attempt: 0 });
  });

  it('accepts null for a patch that made no commit', () => {
    expect(validate(success([applied([]), null], 1))).toMatchObject({
      applied: [{ changes: [] }, null],
    });
  });

  it('accepts no changes when none were asked for', () => {
    expect(
      validate(success([{}]), { patchCounts: [1], includeChanges: false }),
    ).toEqual({ outcome: 'success', attempt: 0, applied: [{}] });
  });

  it('accepts a conflict and an error', () => {
    expect(validate({ outcome: 'conflict', diff: '<<<<<<<' })).toEqual({
      outcome: 'conflict',
      diff: '<<<<<<<',
    });
    expect(validate({ outcome: 'error', message: 'boom' })).toEqual({
      outcome: 'error',
      message: 'boom',
    });
  });

  const change = (c: object) => success([applied([c])]);

  it.each([
    ['not an object', []],
    ['an unknown outcome', { outcome: 'pwned' }],
    ['extra keys', { outcome: 'conflict', diff: '', extra: 1 }],
    ['an attempt that does not exist', success([applied([])], 2)],
    ['a fractional attempt', success([applied([])], 0.5)],
    ['too few patches', success([], 0)],
    ['too many patches', success([applied([]), applied([])], 0)],
    ['a non-string diff', { outcome: 'conflict', diff: 1 }],
    [
      'an oversized diff',
      { outcome: 'conflict', diff: 'x'.repeat(LIMITS.diffChars + 1) },
    ],
    [
      'an oversized error',
      { outcome: 'error', message: 'x'.repeat(LIMITS.errorChars + 1) },
    ],
    ['a lone surrogate', { outcome: 'error', message: 'a\ud800b' }],
    ['a missing changes list', success([applied()])],
    // Messages, authors and dates are the server's, never the job's.
    ['a commit message', success([applied([], { message: 'mine' })])],
    ['an author', success([applied([], { author: { name: 'me' } })])],
    [
      'changes when none were asked for',
      success([applied([])]),
      { patchCounts: [1], includeChanges: false },
    ],
    ['a bad mode', change({ path: 'a', mode: '100777', blob: sha256('hi\n') })],
    [
      'a submodule',
      change({ path: 'a', mode: '160000', blob: sha256('hi\n') }),
    ],
    ['inline contents', change({ path: 'a', mode: '100644', content: 'aGk=' })],
    [
      'a blob that is not a SHA-256',
      change({ path: 'a', mode: '100644', blob: 'x' }),
    ],
    [
      'a blob that was never uploaded',
      change({ path: 'a', mode: '100644', blob: sha256('other') }),
    ],
    [
      'a symlink with a NUL in its target',
      change({ path: 'a', mode: '120000', blob: sha256('a\0b') }),
    ],
    [
      'a symlink with an empty target',
      change({ path: 'a', mode: '120000', blob: sha256('') }),
    ],
    [
      'a symlinked .gitattributes',
      change({
        path: 'x/.GITATTRIBUTES',
        mode: '120000',
        blob: sha256('../a/b.txt'),
      }),
    ],
    ['deleted: false', change({ path: 'a', deleted: false })],
    [
      'a deletion with contents',
      change({ path: 'a', deleted: true, blob: sha256('hi\n') }),
    ],
    [
      'a duplicate path',
      success([
        applied([
          { path: 'a', mode: '100644', blob: sha256('hi\n') },
          { path: 'a', deleted: true },
        ]),
      ]),
    ],
  ])('rejects %s', (_, value, expected = expectation) => {
    expect(() => validate(value, expected)).toThrow('Invalid sandbox result');
  });

  it('caps the number of changes', () => {
    const files = Array.from(
      { length: LIMITS.changesPerCommit + 1 },
      (_, i) => ({ path: `f${i}`, deleted: true }),
    );
    expect(() => validate(success([applied(files)]))).toThrow('changes');
  });
});

describe('validateSandboxResult() for a batch', () => {
  const batchExpectation = {
    patchCounts: [],
    memberPatchCounts: [[2, 1], [1]],
    includeChanges: true,
  };
  const validateBatch = (value: unknown) =>
    validateSandboxResult(value, batchExpectation, blobs);
  const file = { path: 'a.txt', mode: '100644', blob: sha256('hi\n') };

  it('accepts members that applied and members left out', () => {
    expect(
      validateBatch({
        outcome: 'batch',
        members: [{ attempt: 1, applied: [applied([file])] }, null],
      }),
    ).toEqual({
      outcome: 'batch',
      members: [{ attempt: 1, applied: [{ changes: [file] }] }, null],
    });
  });

  it('checks each member against its own attempts', () => {
    expect(() =>
      validateBatch({
        outcome: 'batch',
        members: [null, { attempt: 1, applied: [applied([])] }],
      }),
    ).toThrow('members[1].attempt: not one of the attempts');
    expect(() =>
      validateBatch({
        outcome: 'batch',
        members: [{ attempt: 0, applied: [applied([])] }, null],
      }),
    ).toThrow('members[0].results for 1 patches, expected 2');
  });

  it('rejects the wrong number of members and unexpected keys', () => {
    expect(() => validateBatch({ outcome: 'batch', members: [null] })).toThrow(
      'results for 1 members, expected 2',
    );
    expect(() =>
      validateBatch({
        outcome: 'batch',
        members: [{ attempt: 0, applied: [null, null], message: 'x' }, null],
      }),
    ).toThrow('unexpected key "message"');
    expect(() =>
      validateBatch({ outcome: 'batch', members: ['x', null] }),
    ).toThrow('members[0]: expected an object');
  });

  it('validates the changes of every member', () => {
    expect(() =>
      validateBatch({
        outcome: 'batch',
        members: [
          {
            attempt: 1,
            applied: [applied([{ ...file, path: '.git/config' }])],
          },
          null,
        ],
      }),
    ).toThrow('path has a .git component');
  });

  it('only accepts a batch result for a batch job', () => {
    expect(() =>
      validateBatch({ outcome: 'success', attempt: 0, applied: [] }),
    ).toThrow('expected a batch result');
    expect(() => validateBatch({ outcome: 'conflict', diff: '' })).toThrow(
      'expected a batch result',
    );
    expect(() => validate({ outcome: 'batch', members: [] })).toThrow(
      'not a batch',
    );
    expect(validateBatch({ outcome: 'error', message: 'boom' })).toEqual({
      outcome: 'error',
      message: 'boom',
    });
  });
});

describe('validateRepoPath()', () => {
  it.each([
    'README.md',
    'a/b/c.txt',
    'patches/chromium/.patches',
    '.github/workflows/test.yml',
    '.gitignore',
    'a/.gitkeep',
    'a/..b/c',
    'unicode/文件.txt',
    // git allows these, so a backport may carry them.
    'a\\b',
    'a\nb',
    'tab\there',
  ])('accepts %j', (p) => {
    expect(validateRepoPath('path', p)).toBe(p);
  });

  it.each([
    '',
    '/etc/passwd',
    '../x',
    'a/../../x',
    'a/./b',
    './a',
    'a//b',
    'a/',
    '.git',
    '.git/config',
    'a/.git/hooks/pre-commit',
    '.GIT/config',
    '.Git/config',
    '.git./config',
    '.git /config',
    'git~1/config',
    'GIT~1/config',
    '.g‌it/config',
    '.git﻿/config',
    'a\0b',
    'x'.repeat(LIMITS.pathBytes + 1),
    42,
    null,
  ])('rejects %j', (p) => {
    expect(() => validateRepoPath('path', p)).toThrow('Invalid sandbox result');
  });
});
