import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  backportMbox,
  commitMessage,
  diffFiles,
  diffPaths,
  PatchError,
  splitPatch,
  unquoteGitPath,
} from '../src/sandbox/patches';

const git = (cwd: string, args: string[], input?: string) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

let tmp: string;
beforeAll(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trop-patches-'));
  git(tmp, ['init', '--quiet', '-b', 'main']);
  git(tmp, ['config', 'user.name', 'Trop Test']);
  git(tmp, ['config', 'user.email', 'trop@example.com']);
  fs.writeFileSync(path.join(tmp, 'README'), 'hello\n');
  git(tmp, ['add', '.']);
  git(tmp, ['commit', '--quiet', '-m', 'initial']);
});

afterAll(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/** Commits `files` with `message`; returns its `.patch` and `.diff`. */
const commit = (message: string, files: Record<string, string | Buffer>) => {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
    fs.writeFileSync(path.join(tmp, file), content);
  }
  git(tmp, ['add', '.']);
  git(tmp, ['commit', '--quiet', '-F', '-'], message);
  return {
    patch: git(tmp, ['format-patch', '-1', '--stdout', 'HEAD']),
    // GitHub's `.diff`: the same diff, without binary data.
    diff: git(tmp, ['show', '--format=', 'HEAD']),
  };
};

describe('splitPatch()', () => {
  it('drops a diff written into the commit message', () => {
    const { patch, diff } = commit(
      [
        'Update README',
        '',
        'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
        '--- a/.github/workflows/ci.yml',
        '+++ b/.github/workflows/ci.yml',
        '@@ -1 +1,2 @@',
        ' name: ci',
        '+on: push # injected',
      ].join('\n'),
      { README: 'hello\nworld\n' },
    );
    const split = splitPatch(patch, diff);
    expect([...diffPaths(split.diff)]).toEqual(['README']);
    expect(split.diff).not.toContain('injected');
    expect(split.diff.startsWith('diff --git a/README b/README\n')).toBe(true);
    expect(split.head.join('\n')).toContain('injected');
  });

  it('keeps the binary data only the `.patch` has', () => {
    const { patch, diff } = commit('add an image', {
      'image.bin': Buffer.from([0, 1, 2, 255, 254, 0, 9]),
    });
    expect(diff).not.toContain('GIT binary patch');
    expect(splitPatch(patch, diff).diff).toContain('GIT binary patch');
  });

  it('returns an empty diff for a commit without changes', () => {
    git(tmp, ['commit', '--quiet', '--allow-empty', '-m', 'empty']);
    const patch = git(tmp, ['format-patch', '-1', '--stdout', 'HEAD']);
    expect(splitPatch(patch, '')).toMatchObject({ diff: '' });
  });

  it('refuses a patch that does not match its diff', () => {
    const { patch } = commit('one', { 'a.txt': 'a\n' });
    const { diff } = commit('two', { 'b.txt': 'b\n' });
    expect(() => splitPatch(patch, diff)).toThrow(PatchError);
    expect(() => splitPatch('{"message":"Not Found"}', diff)).toThrow(
      PatchError,
    );
  });

  it('wraps the diff alone in an mbox `git am` applies', () => {
    const { patch, diff } = commit('change\n\ndiff -u in the message', {
      'c.txt': 'c\r\nd\r\n',
    });
    const mbox = backportMbox(splitPatch(patch, diff).diff);
    expect(mbox).toContain('Subject: [PATCH] backport\n\n---\ndiff --git');
    expect(mbox).not.toContain('in the message');
    // The CRs make it through.
    expect(mbox).toContain('+c\r\n');
  });
});

describe('commitMessage()', () => {
  /** What `git am` makes of `mail`: git mailinfo, then stripspace. */
  const amMessage = (mail: string) => {
    const dir = fs.mkdtempSync(path.join(tmp, 'mailinfo-'));
    const info = git(
      tmp,
      ['mailinfo', path.join(dir, 'msg'), path.join(dir, 'patch')],
      mail,
    );
    const field = (name: string) =>
      new RegExp(`^${name}: (.*)$`, 'm').exec(info)?.[1] ?? '';
    const message = git(
      tmp,
      ['stripspace'],
      `${field('Subject')}\n\n${fs.readFileSync(path.join(dir, 'msg'), 'utf8')}`,
    ).trim();
    return {
      message,
      author: { name: field('Author'), email: field('Email') },
    };
  };

  const mail = (headers: string[], body: string[]) =>
    [
      'From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001',
      ...headers,
      '',
      ...body,
      '---',
      ' README | 1 +',
      '',
      'diff --git a/README b/README',
      'index ce01362..94954ab 100644',
      '--- a/README',
      '+++ b/README',
      '@@ -1 +1,2 @@',
      ' hello',
      '+world',
      '-- ',
      '2.43.0',
      '',
    ].join('\n');

  const from = 'From: Trop Test <trop@example.com>';
  const date = 'Date: Thu, 22 Oct 2026 12:00:00 -0700';

  it.each([
    [
      'a plain message',
      [from, date, 'Subject: [PATCH] fix: a thing'],
      ['', 'body'],
    ],
    [
      'bracketed prefixes and Re:',
      [from, 'Subject: Re: [PATCH v2 1/3] [ci skip]: re: fix'],
      ['body'],
    ],
    [
      'a folded subject',
      [
        from,
        'Subject: [PATCH] chore: a subject long enough that format-patch has to',
        ' fold it onto more than one line, surely',
      ],
      ['body'],
    ],
    [
      'encoded words',
      [
        'From: =?UTF-8?q?Andr=C3=A9=20M?= <andre@example.com>',
        'Subject: [PATCH] =?UTF-8?q?fix:=20caf=C3=A9=20=E2=9C=93?=',
        ' =?UTF-8?q?=20=E6=BC=A2=E5=AD=97?=',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
      ],
      ['body ü'],
    ],
    [
      'base64 encoded words',
      [from, 'Subject: [PATCH] =?UTF-8?B?Zml4OiDDqXTDqQ==?='],
      ['body'],
    ],
    [
      'a quoted author',
      ['From: "Doe, Jane \\"JD\\"" <jane@example.com>', 'Subject: [PATCH] x'],
      ['body'],
    ],
    [
      'in-body headers',
      [from, 'Subject: [PATCH] outer'],
      ['From: Someone Else <else@example.com>', 'Subject: inner', '', 'body'],
    ],
    [
      'a --- line in the message',
      [from, 'Subject: [PATCH] x'],
      ['before', '---', 'after'],
    ],
    [
      'a --- name line in the message',
      [from, 'Subject: [PATCH] x'],
      ['before', '--- foo', 'after'],
    ],
    [
      'a --- line with text after a blank',
      [from, 'Subject: [PATCH] x'],
      ['before', '---  ', 'after'],
    ],
    [
      'an Index: line in the message',
      [from, 'Subject: [PATCH] x'],
      ['before', 'Index: foo', 'after'],
    ],
    [
      'whitespace to clean up',
      [from, 'Subject: [PATCH]   spaced   '],
      ['', '', 'a   ', '', '', '', 'b', '', ''],
    ],
    ['a missing body', [from, 'Subject: [PATCH] only a subject'], []],
  ])('matches `git am` for %s', (_, headers, body) => {
    const text = mail(headers, body);
    const lines = text.split('\n');
    const head = lines.slice(
      0,
      lines.findIndex((l) => l.startsWith('diff --git')),
    );
    expect(commitMessage(head)).toEqual(amMessage(text));
  });
});

describe('diffFiles()', () => {
  it('reads paths, modes and ids from the extended headers only', () => {
    const files = diffFiles(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        'old mode 100644',
        'new mode 100755',
        'index 1111111..2222222',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,2 @@',
        // Hunk lines that look like headers change nothing.
        '--- a/.github/workflows/evil.yml',
        '+++ b/.github/workflows/evil.yml',
        '-rename to evil',
        'diff --git a/old.txt b/new.txt',
        'similarity index 90%',
        'rename from old.txt',
        'rename to new.txt',
        'index 3333333..4444444 100644',
        'diff --git a/gone b/gone',
        'deleted file mode 160000',
        'index 5555555..0000000',
        'diff --git "a/caf\\303\\251 x" "b/caf\\303\\251 x"',
        'new file mode 100644',
        'index 0000000..6666666',
        'Binary files /dev/null and "b/caf\\303\\251 x" differ',
      ].join('\n'),
    );
    expect(files).toEqual([
      {
        header: 'diff --git a/src/a.ts b/src/a.ts',
        oldPath: 'src/a.ts',
        newPath: 'src/a.ts',
        oldMode: '100644',
        newMode: '100755',
        preimage: '1111111',
        postimage: '2222222',
      },
      {
        header: 'diff --git a/old.txt b/new.txt',
        oldPath: 'old.txt',
        newPath: 'new.txt',
        oldMode: '100644',
        newMode: '100644',
        preimage: '3333333',
        postimage: '4444444',
      },
      {
        header: 'diff --git a/gone b/gone',
        oldPath: 'gone',
        newPath: undefined,
        oldMode: '160000',
        preimage: '5555555',
        postimage: undefined,
      },
      {
        header: 'diff --git "a/caf\\303\\251 x" "b/caf\\303\\251 x"',
        oldPath: undefined,
        newPath: 'café x',
        newMode: '100644',
        preimage: undefined,
        postimage: '6666666',
      },
    ]);
  });

  it('unquotes git C-style paths', () => {
    expect(unquoteGitPath('"a\\tb\\"c\\\\d\\303\\251"')).toBe('a\tb"c\\dé');
    expect(unquoteGitPath('plain')).toBe('plain');
    expect(unquoteGitPath('"bad\\q"')).toBeNull();
    expect(unquoteGitPath('"unterminated')).toBeNull();
  });
});
