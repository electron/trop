import { describe, expect, it } from 'vitest';

import { assertChangesMatchPatches } from '../src/sandbox';
import { patchPaths, unquoteGitPath } from '../src/sandbox/patch-paths';
import {
  LIMITS,
  validateRepoPath,
  validateSandboxResult,
} from '../src/sandbox/protocol';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

const commit = (changes?: unknown[], overrides: object = {}) => ({
  message: 'fix: a thing\n\nNotes: none\n',
  author: {
    name: 'Some One',
    email: 'some.one@example.com',
    date: '2026-10-22T12:00:00-07:00',
  },
  ...(changes ? { changes } : {}),
  ...overrides,
});

const success = (commits: unknown[], attempt = 0) => ({
  outcome: 'success',
  attempt,
  commits,
});

const expectation = { patchCounts: [1, 2], includeChanges: true };
const validate = (value: unknown, expect = expectation) =>
  validateSandboxResult(value, expect);

describe('validateSandboxResult()', () => {
  it('accepts a well-formed success', () => {
    const result = validate(
      success([
        commit([
          { path: 'a/b.txt', mode: '100644', content: b64('hi\n') },
          { path: 'script.sh', mode: '100755', content: b64('#!/bin/sh\n') },
          { path: 'link', mode: '120000', content: b64('../a/b.txt') },
          { path: 'gone.txt', deleted: true },
        ]),
      ]),
    );
    expect(result).toMatchObject({ outcome: 'success', attempt: 0 });
  });

  it('accepts null for a patch that made no commit', () => {
    expect(validate(success([commit([]), null], 1))).toMatchObject({
      commits: [expect.anything(), null],
    });
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

  it.each([
    ['not an object', []],
    ['an unknown outcome', { outcome: 'pwned' }],
    ['extra keys', { outcome: 'conflict', diff: '', extra: 1 }],
    ['an attempt that does not exist', success([commit([])], 2)],
    ['a fractional attempt', success([commit([])], 0.5)],
    ['too few commits', success([], 0)],
    ['too many commits', success([commit([]), commit([])], 0)],
    ['a non-string diff', { outcome: 'conflict', diff: 1 }],
    [
      'an oversized diff',
      { outcome: 'conflict', diff: 'x'.repeat(LIMITS.diffChars + 1) },
    ],
    [
      'an oversized error',
      { outcome: 'error', message: 'x'.repeat(LIMITS.errorChars + 1) },
    ],
    ['a missing changes list', success([commit()])],
    [
      'changes on a check',
      success([commit([])]),
      { patchCounts: [1], includeChanges: false },
    ],
    [
      'an author with a newline',
      success([
        commit([], {
          author: {
            name: 'a\nSigned-off-by: x',
            email: 'e@x',
            date: '2026-01-01',
          },
        }),
      ]),
    ],
    [
      'an email with angle brackets',
      success([
        commit([], {
          author: { name: 'a', email: 'e@x> <f@y', date: '2026-01-01' },
        }),
      ]),
    ],
    [
      'an invalid date',
      success([
        commit([], { author: { name: 'a', email: 'e@x', date: 'yesterday' } }),
      ]),
    ],
    ['a message with NUL', success([commit([], { message: 'a\0b' })])],
    ['a lone surrogate', success([commit([], { message: 'a\ud800b' })])],
  ])('rejects %s', (_, value, expect_ = expectation) => {
    expect(() => validate(value, expect_)).toThrow('Invalid sandbox result');
  });

  const change = (c: object) => success([commit([c])]);

  it.each([
    ['a bad mode', { path: 'a', mode: '100777', content: '' }],
    ['a gitlink', { path: 'a', mode: '160000', content: '' }],
    ['a tree', { path: 'a', mode: '040000', content: '' }],
    ['a numeric mode', { path: 'a', mode: 100644, content: '' }],
    ['invalid base64', { path: 'a', mode: '100644', content: 'not base64!' }],
    ['unpadded base64', { path: 'a', mode: '100644', content: 'YQ' }],
    ['deleted: false', { path: 'a', deleted: false }],
    ['deleted with content', { path: 'a', deleted: true, content: '' }],
    ['an empty symlink', { path: 'a', mode: '120000', content: '' }],
    ['a symlink with NUL', { path: 'a', mode: '120000', content: b64('a\0b') }],
    [
      'a symlink that is not UTF-8',
      { path: 'a', mode: '120000', content: b64(Buffer.from([0xff, 0xfe])) },
    ],
    [
      'a symlinked .gitmodules',
      { path: '.gitmodules', mode: '120000', content: b64('/etc/passwd') },
    ],
    [
      'a symlinked nested .gitattributes',
      { path: 'a/.GitAttributes', mode: '120000', content: b64('x') },
    ],
    [
      'an oversized file',
      {
        path: 'a',
        mode: '100644',
        content: b64(Buffer.alloc(LIMITS.fileBytes + 1)),
      },
    ],
  ])('rejects a change with %s', (_, c) => {
    expect(() => validate(change(c))).toThrow('Invalid sandbox result');
  });

  it('rejects duplicate paths in a commit', () => {
    expect(() =>
      validate(
        success([
          commit([
            { path: 'a', deleted: true },
            { path: 'a', mode: '100644', content: '' },
          ]),
        ]),
      ),
    ).toThrow('duplicate path');
  });

  it('caps the total content of a result', () => {
    const big = b64(Buffer.alloc(LIMITS.fileBytes));
    const files = Array.from(
      { length: Math.ceil(LIMITS.totalContentBytes / LIMITS.fileBytes) + 1 },
      (_, i) => ({ path: `f${i}`, mode: '100644', content: big }),
    );
    expect(() => validate(success([commit(files)]))).toThrow(
      'bytes of content',
    );
  });

  it('caps the number of changes', () => {
    const files = Array.from(
      { length: LIMITS.changesPerCommit + 1 },
      (_, i) => ({
        path: `f${i}`,
        deleted: true,
      }),
    );
    expect(() => validate(success([commit(files)]))).toThrow('changes');
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
  ])('accepts %s', (p) => {
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
    'a\\b',
    'a\0b',
    'a\nb',
    'x'.repeat(LIMITS.pathBytes + 1),
    42,
    null,
  ])('rejects %j', (p) => {
    expect(() => validateRepoPath('path', p)).toThrow('Invalid sandbox result');
  });
});

describe('patchPaths()', () => {
  const patch = [
    'From 0123 Mon Sep 17 00:00:00 2001',
    'Subject: [PATCH] fix: things',
    '',
    '---',
    'diff --git a/src/file.ts b/src/file.ts',
    'index 1111111..2222222 100644',
    '--- a/src/file.ts',
    '+++ b/src/file.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/dir with space/x.txt b/dir with space/x.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/dir with space/x.txt',
    'diff --git a/old.txt b/new.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to new.txt',
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    'deleted file mode 100644',
    'diff --git a/img.png b/img.png',
    'GIT binary patch',
  ].join('\n');

  it('names every path the diff headers touch', () => {
    expect([...patchPaths(patch)].sort()).toEqual(
      [
        'café.txt',
        'dir with space/x.txt',
        'img.png',
        'new.txt',
        'old.txt',
        'src/file.ts',
      ].sort(),
    );
  });

  it('unquotes git C-style paths', () => {
    expect(unquoteGitPath('"a\\tb\\"c\\\\"')).toBe('a\tb"c\\');
    expect(unquoteGitPath('plain')).toBe('plain');
    expect(unquoteGitPath('"broken')).toBeNull();
    expect(unquoteGitPath('"bad\\q"')).toBeNull();
  });
});

describe('assertChangesMatchPatches()', () => {
  const patch =
    'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n';

  it('allows changes to the files a patch touches', () => {
    expect(() =>
      assertChangesMatchPatches([patch], [
        commit([{ path: 'src/a.ts', mode: '100644', content: '' }]),
      ] as never),
    ).not.toThrow();
  });

  it('refuses a change to any other file', () => {
    expect(() =>
      assertChangesMatchPatches([patch], [
        commit([
          { path: 'src/a.ts', mode: '100644', content: '' },
          { path: '.github/workflows/evil.yml', mode: '100644', content: '' },
        ]),
      ] as never),
    ).toThrow('.github/workflows/evil.yml');
  });

  it('checks each commit against its own patch', () => {
    const other = 'diff --git a/b.txt b/b.txt\n';
    expect(() =>
      assertChangesMatchPatches([patch, other], [
        null,
        commit([{ path: 'src/a.ts', deleted: true }]),
      ] as never),
    ).toThrow('patch 2');
  });
});
