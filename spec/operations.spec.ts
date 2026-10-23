import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { PRChange } from '../src/enums';
import { updateManualBackport } from '../src/operations/update-manual-backport';
import {
  BackportAttempt,
  BackportCommit,
  BackportResultCommit,
  runSandboxedBackport,
  Sandbox,
  SandboxDeps,
} from '../src/sandbox';
import { BackstopError, OriginalFile } from '../src/sandbox/backstop';
import { createBackportCommits } from '../src/sandbox/commits';
import { SandboxJobServer } from '../src/sandbox/job-server';
import { commitMessage, splitPatch } from '../src/sandbox/patches';
import { SandboxFileChange, SandboxResult } from '../src/sandbox/protocol';
import { RepoCache } from '../src/sandbox/repo-cache';
import {
  LocalProcessRunner,
  SandboxInfraError,
  SandboxJobSpec,
  SandboxRunner,
} from '../src/sandbox/runner';
import { getPRApprovers, tagBackportReviewers } from '../src/utils';
import { addLabels, removeLabel } from '../src/utils/label-utils';

const backportPRClosedEvent = require('./fixtures/backport_pull_request.closed.json');
const backportPRMergedEvent = require('./fixtures/backport_pull_request.merged.json');
const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');

const runGit = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `git ${args.join(' ')} failed`,
    );
  }

  return result.stdout.trimEnd();
};

const initTestGitRepo = (dir: string) => {
  runGit(dir, ['init']);
  runGit(dir, ['config', 'gc.autoDetach', 'false']);
  runGit(dir, ['config', 'maintenance.autoDetach', 'false']);
  runGit(dir, ['checkout', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'Trop Test']);
  runGit(dir, ['config', 'user.email', 'trop@example.com']);
};

const writeRepoFile = async (
  repoDir: string,
  filePath: string,
  contents: string,
) => {
  const fullPath = path.join(repoDir, filePath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, contents);
};

const buildPatchList = (...entries: string[]) => entries.join('\n');

/**
 * What the server learns about a commit from GitHub (fetchBackportCommit in
 * src/utils.ts), from a local repository instead: the `.patch` is
 * format-patch output, the `.diff` the same diff without binary data, and
 * the file list diff-tree's.
 */
const localBackportCommit = (
  dir: string,
  sha: string,
  editPatch: (patch: string) => string = (p) => p,
): BackportCommit => {
  const patch = `${runGit(dir, ['format-patch', '-1', '--stdout', sha])}\n`;
  const diff = runGit(dir, ['show', '--format=', sha]);
  const { head, diff: own } = splitPatch(editPatch(patch), diff);
  const { message, author } = commitMessage(head);
  const files: OriginalFile[] = [];
  const raw = runGit(dir, [
    'diff-tree',
    '-r',
    '-M',
    '--no-commit-id',
    '--no-abbrev',
    '-z',
    sha,
  ])
    .split('\0')
    .filter(Boolean);
  for (let i = 0; i < raw.length; ) {
    const [, , , , newSha, status] = raw[i].split(/[ :]/);
    const renamed = /^[RC]/.test(status);
    const file: OriginalFile = {
      filename: renamed ? raw[i + 2] : raw[i + 1],
      status: status.startsWith('R')
        ? 'renamed'
        : status === 'D'
          ? 'removed'
          : status === 'A'
            ? 'added'
            : 'modified',
      sha: status === 'D' ? null : newSha,
    };
    if (renamed) file.previousFilename = raw[i + 1];
    files.push(file);
    i += renamed ? 3 : 2;
  }
  return { diff: own, message, author: author!, files };
};

vi.mock('../src/utils', () => ({
  getPRApprovers: vi.fn().mockResolvedValue([]),
  tagBackportReviewers: vi.fn().mockResolvedValue(undefined),
  shouldRequestBackportApproval: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/utils/label-utils', () => ({
  labelExistsOnPR: vi.fn().mockResolvedValue(true),
  getSemverLabel: vi.fn().mockResolvedValue(false),
  addLabels: vi.fn(),
  removeLabel: vi.fn(),
}));

describe('runner', () => {
  console.error = vi.fn();

  // The backport flow end to end: a local repository stands in for GitHub,
  // the server-side cache fetches from it, and the sandbox entrypoint runs
  // as a child process (LocalProcessRunner) against the job server.
  describe('runSandboxedBackport()', { timeout: 60_000 }, () => {
    let sandbox: Sandbox;
    let createdDirs: string[] = [];

    beforeAll(async () => {
      const server = new SandboxJobServer('127.0.0.1', 0);
      await server.start();
      sandbox = { runner: new LocalProcessRunner(50_000), server };
    });

    afterAll(async () => {
      await sandbox.server.stop();
    });

    const makeTempDir = async (prefix: string) => {
      const dir = await fs.promises.mkdtemp(path.resolve(os.tmpdir(), prefix));
      createdDirs.push(dir);
      return dir;
    };

    afterEach(async () => {
      await Promise.all(
        createdDirs.map((d) =>
          fs.promises.rm(d, { force: true, recursive: true }),
        ),
      );
      createdDirs = [];
    });

    const commitAll = (dir: string, message: string, files: string[]) => {
      runGit(dir, ['add', '-A', '--', ...files]);
      runGit(dir, [
        'commit',
        '--allow-empty',
        '--author=Trop Test <trop@example.com>',
        '-m',
        message,
      ]);
    };

    const applyChanges = async (
      dir: string,
      changes: Record<string, string | Buffer | null>,
    ) => {
      for (const [file, content] of Object.entries(changes)) {
        // Replace whatever is there, never write through a symlink.
        if (content !== null) {
          await fs.promises.rm(path.join(dir, file), { force: true });
        }
        if (content === null) {
          await fs.promises.rm(path.join(dir, file));
        } else if (Buffer.isBuffer(content)) {
          await fs.promises.writeFile(path.join(dir, file), content);
        } else if (content.startsWith('exec:')) {
          await writeRepoFile(dir, file, content.slice('exec:'.length));
          await fs.promises.chmod(path.join(dir, file), 0o755);
        } else if (content.startsWith('gitlink:')) {
          await fs.promises.mkdir(path.join(dir, file), { recursive: true });
          runGit(dir, [
            'update-index',
            '--add',
            '--cacheinfo',
            `160000,${content.slice('gitlink:'.length)},${file}`,
          ]);
        } else if (content.startsWith('symlink:')) {
          await fs.promises.mkdir(path.dirname(path.join(dir, file)), {
            recursive: true,
          });
          await fs.promises.symlink(
            content.slice('symlink:'.length),
            path.join(dir, file),
          );
        } else {
          await writeRepoFile(dir, file, content);
        }
      }
    };

    // Build two repos with identical initial files, commit `changes` (and
    // then each of `stackedChanges`) on the source and format-patch them,
    // publish the target as the stand-in for GitHub, and run the backport.
    const setupAndBackport = async (opts: {
      initial: Record<string, string>;
      // A null value deletes the file; "symlink:<target>" makes a symlink.
      changes: Record<string, string | Buffer | null>;
      // Changes committed on the target branch (42-x-y) before the backport,
      // so that the source and target diverge and `git am -3` has to fall
      // back to a three-way merge.
      targetChanges?: Record<string, string | null>;
      stackedChanges?: Record<string, string | Buffer | null>[];
      // Further attempts after the commits above, e.g. a squash commit.
      extraAttempts?: BackportAttempt[];
      includeChanges?: boolean;
      // Commit messages, by commit (default: "change", "stacked change").
      messages?: string[];
      deps?: Partial<SandboxDeps>;
    }) => {
      const remoteDir = await makeTempDir('trop-remote-');
      const targetDir = await makeTempDir('trop-target-');
      const sourceDir = await makeTempDir('trop-source-');
      const cacheDir = path.join(await makeTempDir('trop-cache-'), 'git-cache');

      runGit(remoteDir, ['init', '--bare']);

      for (const dir of [targetDir, sourceDir]) {
        initTestGitRepo(dir);
        await applyChanges(dir, opts.initial);
        commitAll(dir, 'initial', ['.']);
      }
      runGit(targetDir, ['branch', '42-x-y']);

      if (opts.targetChanges) {
        runGit(targetDir, ['checkout', '42-x-y']);
        await applyChanges(targetDir, opts.targetChanges);
        commitAll(targetDir, 'target change', Object.keys(opts.targetChanges));
        runGit(targetDir, ['checkout', 'main']);
      }

      const commits: BackportCommit[] = [];
      for (const [i, changes] of [
        opts.changes,
        ...(opts.stackedChanges ?? []),
      ].entries()) {
        await applyChanges(sourceDir, changes);
        commitAll(
          sourceDir,
          opts.messages?.[i] ?? (i === 0 ? 'change' : 'stacked change'),
          Object.keys(changes),
        );
        commits.push(
          localBackportCommit(
            sourceDir,
            runGit(sourceDir, ['rev-parse', 'HEAD']),
          ),
        );
      }

      runGit(targetDir, ['remote', 'add', 'origin', remoteDir]);
      runGit(targetDir, ['push', 'origin', 'main', '42-x-y']);
      runGit(remoteDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      const cache = new RepoCache('electron/trop', {
        dir: cacheDir,
        remoteUrl: remoteDir,
      });
      const outcome = await runSandboxedBackport(
        {
          slug: 'electron/trop',
          token: '',
          targetBranch: '42-x-y',
          attempts: [{ kind: 'all', commits }, ...(opts.extraAttempts ?? [])],
          includeChanges: opts.includeChanges ?? true,
          // The job's files go once the backport returns; keep them.
          onSuccess: async (success) => {
            for (const c of success.commits) {
              for (const change of c.changes ?? []) {
                if (!('deleted' in change)) {
                  uploaded.set(
                    change.blob,
                    await success.readBlob(change.blob),
                  );
                }
              }
            }
          },
        },
        { sandbox, cache, retryDelaysMs: [], ...opts.deps },
      );
      const targetTip = runGit(remoteDir, ['rev-parse', '42-x-y']);
      return { outcome, targetTip, cacheDir, commits, sourceDir, remoteDir };
    };

    // The files successful jobs uploaded, by SHA-256.
    const uploaded = new Map<string, Buffer>();
    const readBlob = async (sha: string) => uploaded.get(sha)!;

    const changeFor = (commit: BackportResultCommit, file: string) =>
      commit.changes?.find((c) => c.path === file);

    const bytesOf = (change: SandboxFileChange | undefined) => {
      if (!change || 'deleted' in change) return undefined;
      return uploaded.get(change.blob);
    };
    const contentOf = (change: SandboxFileChange | undefined) =>
      bytesOf(change)?.toString('utf8');

    const patchFiles = (
      dir: string,
      entries: string[],
    ): Record<string, string> =>
      Object.fromEntries(
        entries.map((e) => [dir ? `${dir}/${e}` : e, `${e}\n`]),
      );

    // electron/electron commits `merge=union` for its .patches lists; the
    // build-tools driver registered on every backport clone overrides it.
    const unionAttributes = 'patches/**/.patches merge=union\n';
    const chromium = 'patches/chromium';
    const chromiumPatches = `${chromium}/.patches`;
    const listWithNewline = (...entries: string[]) =>
      `${buildPatchList(...entries)}\n`;
    const baseEntries = ['a.patch', 'b.patch', 'c.patch'];

    it('backports cleanly onto the tip the server resolved', async () => {
      const { outcome, targetTip, cacheDir } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n', 'other.txt': 'other\n' },
        changes: {
          'feature.txt': 'changed\n',
          'other.txt': null,
          'bin/run.sh': '#!/bin/sh\n',
        },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      expect(outcome.attempt).toBe('all');
      expect(outcome.baseSha).toBe(targetTip);
      expect(outcome.commits).toHaveLength(1);
      const [commit] = outcome.commits;
      expect(commit.message.trim()).toBe('change');
      expect(commit.author).toMatchObject({
        name: 'Trop Test',
        email: 'trop@example.com',
      });
      expect(contentOf(changeFor(commit, 'feature.txt'))).toBe('changed\n');
      expect(changeFor(commit, 'other.txt')).toEqual({
        path: 'other.txt',
        deleted: true,
      });
      expect(changeFor(commit, 'bin/run.sh')).toMatchObject({
        mode: '100644',
      });
      // The job ref is gone again and the cache holds no sandbox objects.
      expect(runGit(cacheDir, ['for-each-ref', 'refs/trop/'])).toBe('');
      expect(() =>
        runGit(cacheDir, ['cat-file', '-e', `${outcome.baseSha}^{commit}`]),
      ).not.toThrow();
    });

    it('reports a conflict with the conflicting diff', async () => {
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        targetChanges: { 'feature.txt': 'target\n' },
        changes: { 'feature.txt': 'source\n' },
      });
      expect(outcome.kind).toBe('conflict');
      if (outcome.kind !== 'conflict') return;
      expect(outcome.diff).toContain('<<<<<<<');
      expect(outcome.diff).toContain('feature.txt');
    });

    it('falls back to the next attempt when the first conflicts', async () => {
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        targetChanges: { 'feature.txt': 'target\n' },
        changes: { 'feature.txt': 'source\n' },
        extraAttempts: [{ kind: 'squash', commits: [] }],
      });
      // An attempt with no patches trivially applies.
      expect(outcome).toMatchObject({ kind: 'success', attempt: 'squash' });
    });

    it('applies the patches of a stack in order, each on top of the one below', async () => {
      // Each commit rewrites the line the one below it introduced, so the
      // patches only apply in bottom-to-top order.
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        changes: { 'feature.txt': 'bottom\n' },
        stackedChanges: [
          { 'feature.txt': 'middle\n' },
          { 'feature.txt': 'top\n' },
        ],
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      expect(outcome.commits.map((c) => c.message.trim())).toEqual([
        'change',
        'stacked change',
        'stacked change',
      ]);
      expect(
        outcome.commits.map((c) => contentOf(changeFor(c, 'feature.txt'))),
      ).toEqual(['bottom\n', 'middle\n', 'top\n']);
    });

    it('sends no file contents for a check', async () => {
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        changes: { 'feature.txt': 'changed\n' },
        includeChanges: false,
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      expect(outcome.commits[0].changes).toBeUndefined();
    });

    // The target branch already carries x.patch (e.g. from a manual backport)
    // earlier in the list, and the backported commit appends the same patch.
    const duplicateAddition = {
      initial: {
        '.gitattributes': unionAttributes,
        [chromiumPatches]: listWithNewline(...baseEntries),
        ...patchFiles(chromium, baseEntries),
      },
      targetChanges: {
        [chromiumPatches]: listWithNewline(
          'a.patch',
          'b.patch',
          'x.patch',
          'c.patch',
        ),
        [`${chromium}/x.patch`]: 'x\n',
      },
      changes: {
        [chromiumPatches]: listWithNewline(...baseEntries, 'x.patch'),
        [`${chromium}/x.patch`]: 'x\n',
      },
    };

    it('merges a diverged .patches list with the build-tools merge driver', async () => {
      // `git am -3` has to fall back to a three-way merge here, which needs
      // the pre-image blob the server resolved for the job.
      const { outcome } = await setupAndBackport({
        ...duplicateAddition,
        changes: {
          [chromiumPatches]: listWithNewline(
            ...baseEntries,
            'x.patch',
            'y.patch',
          ),
          [`${chromium}/x.patch`]: 'x\n',
          [`${chromium}/y.patch`]: 'y\n',
        },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      const [commit] = outcome.commits;
      // Not a,b,x,c,x,y as the committed merge=union would make it.
      expect(contentOf(changeFor(commit, chromiumPatches))).toBe(
        listWithNewline('a.patch', 'b.patch', 'x.patch', 'y.patch', 'c.patch'),
      );
      expect(contentOf(changeFor(commit, `${chromium}/y.patch`))).toBe('y\n');
    });

    it('treats a patch whose changes are on the target already as applied', async () => {
      // With the list merged as a list, the backported commit is a no-op.
      const { outcome } = await setupAndBackport(duplicateAddition);
      expect(outcome).toMatchObject({ kind: 'success', commits: [] });
    });

    it('keeps an entry removed on the target branch out of the merged .patches list', async () => {
      const { outcome } = await setupAndBackport({
        initial: {
          '.gitattributes': unionAttributes,
          [chromiumPatches]: listWithNewline(...baseEntries),
          ...patchFiles(chromium, baseEntries),
        },
        targetChanges: {
          [chromiumPatches]: listWithNewline('a.patch', 'b.patch'),
          [`${chromium}/c.patch`]: null,
        },
        changes: {
          [chromiumPatches]: listWithNewline(...baseEntries, 'd.patch'),
          [`${chromium}/d.patch`]: 'd\n',
        },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      const [commit] = outcome.commits;
      expect(contentOf(changeFor(commit, chromiumPatches))).toBe(
        listWithNewline('a.patch', 'b.patch', 'd.patch'),
      );
      expect(contentOf(changeFor(commit, `${chromium}/d.patch`))).toBe('d\n');
    });

    it('reports symlinks as links and never follows them', async () => {
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        changes: {
          'leak-env': 'symlink:/proc/self/environ',
          'docs/link.md': 'symlink:../feature.txt',
        },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      const [commit] = outcome.commits;
      expect(changeFor(commit, 'leak-env')).toMatchObject({ mode: '120000' });
      expect(contentOf(changeFor(commit, 'leak-env'))).toBe(
        '/proc/self/environ',
      );
      expect(contentOf(changeFor(commit, 'docs/link.md'))).toBe(
        '../feature.txt',
      );

      // ...and are pushed as links, too.
      const github = mockGitHub();
      await createBackportCommits({
        github: github.octokit as never,
        context: { repo: (o: object) => o } as never,
        baseSha: outcome.baseSha,
        commits: outcome.commits,
        readBlob,
        tempBranch: 'trop/42-x-y-bp-test',
      });
      expect(github.trees[0]).toEqual(
        expect.arrayContaining([
          {
            path: 'leak-env',
            mode: '120000',
            type: 'blob',
            content: '/proc/self/environ',
          },
        ]),
      );
    });

    const mockGitHub = () => {
      const trees: unknown[][] = [];
      const commits: { parents: string[]; tree: string; message: string }[] =
        [];
      const refs: { ref: string; sha: string }[] = [];
      const blobs: string[] = [];
      const octokit = {
        git: {
          getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({
            data: { sha: commit_sha },
          })),
          createTree: vi.fn(async ({ tree }: { tree: unknown[] }) => {
            trees.push(tree);
            return { data: { sha: `tree-${trees.length}` } };
          }),
          createBlob: vi.fn(async ({ content }: { content: string }) => {
            blobs.push(content);
            return { data: { sha: `blob-${blobs.length}` } };
          }),
          createCommit: vi.fn(
            async (c: { parents: string[]; tree: string; message: string }) => {
              commits.push(c);
              return { data: { sha: `commit-${commits.length}` } };
            },
          ),
          createRef: vi.fn(async (r: { ref: string; sha: string }) => {
            refs.push(r);
            return { data: {} };
          }),
        },
      };
      return { octokit, trees, commits, refs, blobs };
    };

    it('recreates the commits through the REST API on the resolved base', async () => {
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n', 'gone.txt': 'gone\n' },
        changes: {
          'feature.txt': 'bottom\n',
          'gone.txt': null,
          'image.bin': Buffer.from([0x00, 0xff, 0xfe, 0x80]),
        },
        stackedChanges: [{ 'feature.txt': 'top\n' }],
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;

      const github = mockGitHub();
      await createBackportCommits({
        github: github.octokit as never,
        context: { repo: (o: object) => o } as never,
        baseSha: outcome.baseSha,
        commits: outcome.commits,
        readBlob,
        tempBranch: 'trop/42-x-y-bp-test',
      });

      expect(github.octokit.git.getCommit).toHaveBeenCalledWith({
        commit_sha: outcome.baseSha,
      });
      expect(github.trees[0]).toEqual(
        expect.arrayContaining([
          {
            path: 'feature.txt',
            mode: '100644',
            type: 'blob',
            content: 'bottom\n',
          },
          { path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
          { path: 'image.bin', mode: '100644', type: 'blob', sha: 'blob-1' },
        ]),
      );
      expect(github.commits).toEqual([
        {
          parents: [outcome.baseSha],
          tree: 'tree-1',
          message: 'change\n\nCo-authored-by: Trop Test <trop@example.com>',
        },
        {
          parents: ['commit-1'],
          tree: 'tree-2',
          message:
            'stacked change\n\nCo-authored-by: Trop Test <trop@example.com>',
        },
      ]);
      expect(github.refs).toEqual([
        { ref: 'refs/heads/trop/42-x-y-bp-test', sha: 'commit-2' },
      ]);
    });

    it('carries large and binary files through intact', async () => {
      const big = Buffer.alloc(3 * 1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251;
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        changes: { 'big.bin': big, 'small.txt': 'small\n' },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      expect(bytesOf(changeFor(outcome.commits[0], 'big.bin'))).toEqual(big);
      expect(contentOf(changeFor(outcome.commits[0], 'small.txt'))).toBe(
        'small\n',
      );
    });

    // The commits as `git am` itself makes them from the original `.patch`
    // files, as trop used to push them: message (trimmed) and author.
    const amCommits = async (sourceDir: string, count: number) => {
      const dir = path.join(await makeTempDir('trop-am-'), 'wt');
      runGit(sourceDir, ['worktree', 'add', '--detach', dir, `HEAD~${count}`]);
      for (let i = count - 1; i >= 0; i--) {
        const patchPath = `${dir}.patch`;
        await fs.promises.writeFile(
          patchPath,
          `${runGit(sourceDir, ['format-patch', '-1', '--stdout', `HEAD~${i}`])}\n`,
        );
        runGit(dir, ['am', '-3', '--keep-cr', patchPath]);
      }
      return runGit(dir, [
        'log',
        `-${count}`,
        '--reverse',
        '--format=%B%x01%an%x01%ae%x02',
      ])
        .split('\x02')
        .filter((e) => e.trim())
        .map((e) => {
          const [message, name, email] = e.replace(/^\n/, '').split('\x01');
          return { message: message.trim(), author: { name, email } };
        });
    };

    it('gives each commit the message and author `git am` gave it', async () => {
      const messages = [
        '[PATCH] fix: something [ci skip]\n\nbody\n\n---\nafter a scissors-ish line',
        'Re: [tag] chore: a subject long enough that format-patch has to fold it across more than one header line, surely\n\nbody',
        'fix: café ✓ 漢字\n\nnon-ASCII body ü\n\n\n\ntrailing   \n',
        'feat: in-body header\n\nFrom: Someone Else <else@example.com>\n\nthe real body\n\nSigned-off-by: A <a@example.com>',
        'subject: with: colons',
      ];
      const { outcome, sourceDir } = await setupAndBackport({
        initial: { 'f.txt': '0\n' },
        changes: { 'f.txt': '1\n' },
        stackedChanges: messages
          .slice(1)
          .map((_, i) => ({ 'f.txt': `${i + 2}\n` })),
        messages,
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      const expected = await amCommits(sourceDir, messages.length);
      expect(outcome.commits.map((c) => c.message)).toEqual(
        expected.map((c) => c.message),
      );
      // The author is always the commit's own; `git am` would credit the
      // in-body From: line instead.
      expect(outcome.commits.map((c) => c.author)).toEqual(
        expected.map(() => ({ name: 'Trop Test', email: 'trop@example.com' })),
      );
      expect(expected[3].author.email).toBe('else@example.com');
    });

    it('never applies a diff written into a commit message', async () => {
      // The PoC from the security review: the message carries a diff of a
      // workflow file the commit doesn't touch. trop used to apply it (git
      // am reads the message as part of the patch); now only the commit's
      // own diff reaches git, even with the backstop off.
      const { outcome } = await setupAndBackport({
        initial: {
          '.github/workflows/ci.yml': 'name: ci\n',
          README: 'hello\n',
        },
        changes: { README: 'hello\nworld\n' },
        messages: [
          [
            'Update README',
            '',
            'Context:',
            '',
            'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
            '--- a/.github/workflows/ci.yml',
            '+++ b/.github/workflows/ci.yml',
            '@@ -1 +1,2 @@',
            ' name: ci',
            '+on: push # injected',
            // A copy of the real diff's header, too (the re-review's PoC).
            'diff --git a/README b/README',
            '--- a/README',
            '+++ b/README',
            '@@ -1 +1,2 @@',
            ' hello',
            '+evil',
          ].join('\n'),
        ],
        deps: { backstop: false },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      const [commit] = outcome.commits;
      expect(commit.changes!.map((c) => c.path)).toEqual(['README']);
      // The message is still cut where `git am` would have cut it.
      expect(commit.message).toBe('Update README\n\nContext:');
    });

    it('follows a file the target branch renamed', async () => {
      const content = 'one\ntwo\nthree\nfour\nfive\nsix\n';
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': content },
        targetChanges: { 'feature.txt': null, 'renamed.txt': content },
        changes: { 'feature.txt': content.replace('three', 'THREE') },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      const [commit] = outcome.commits;
      expect(commit.changes!.map((c) => c.path)).toEqual(['renamed.txt']);
      expect(contentOf(changeFor(commit, 'renamed.txt'))).toBe(
        content.replace('three', 'THREE'),
      );
    });

    it('follows a directory the target branch renamed', async () => {
      const a = 'a1\na2\na3\na4\na5\n';
      const b = 'b1\nb2\nb3\nb4\nb5\n';
      const { outcome } = await setupAndBackport({
        initial: { 'lib/a.txt': a, 'lib/b.txt': b },
        targetChanges: {
          'lib/a.txt': null,
          'lib/b.txt': null,
          'src/a.txt': a,
          'src/b.txt': b,
        },
        changes: {
          'lib/a.txt': a.replace('a3', 'A3'),
          'lib/b.txt': b.replace('b3', 'B3'),
          'lib/new.txt': 'new\n',
        },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      const [commit] = outcome.commits;
      expect(commit.changes!.map((c) => c.path).sort()).toEqual([
        // A new file isn't merged, so it stays where the commit put it,
        // as it always has with `git am -3`.
        'lib/new.txt',
        'src/a.txt',
        'src/b.txt',
      ]);
      expect(contentOf(changeFor(commit, 'src/a.txt'))).toBe(
        a.replace('a3', 'A3'),
      );
    });

    it('skips a commit that is on the target already', async () => {
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        targetChanges: { 'feature.txt': 'changed\n' },
        changes: { 'feature.txt': 'changed\n' },
        stackedChanges: [{ 'other.txt': 'other\n' }],
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      expect(outcome.commits.map((c) => c.message)).toEqual(['stacked change']);
    });

    it('fails an attempt with an empty commit, as `git am` always has', async () => {
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        changes: {},
        extraAttempts: [{ kind: 'squash', commits: [] }],
      });
      expect(outcome).toMatchObject({ kind: 'success', attempt: 'squash' });
    });

    it('carries modes, CRLF line endings and submodules as before', async () => {
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n', 'crlf.txt': 'a\r\nb\r\n' },
        changes: {
          'bin/run.sh': 'exec:#!/bin/sh\n',
          'crlf.txt': 'a\r\nB\r\n',
          'third_party/sub': `gitlink:${'1'.repeat(40)}`,
        },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      const [commit] = outcome.commits;
      expect(changeFor(commit, 'bin/run.sh')).toMatchObject({
        mode: '100755',
      });
      expect(contentOf(changeFor(commit, 'crlf.txt'))).toBe('a\r\nB\r\n');
      // Submodules have always been pushed as deletions.
      expect(changeFor(commit, 'third_party/sub')).toEqual({
        path: 'third_party/sub',
        deleted: true,
      });
    });

    // A job that skips git and posts whatever it likes, as a compromised one
    // could.
    const maliciousRunner = (files: Record<string, string>): SandboxRunner => ({
      kind: 'local',
      listenHost: '127.0.0.1',
      run: async (spec: SandboxJobSpec) => {
        const authorization = `Bearer ${spec.token}`;
        const changes: SandboxFileChange[] = [];
        for (const [file, content] of Object.entries(files)) {
          const sha = createHash('sha256').update(content).digest('hex');
          await fetch(`${spec.url}/blobs/${sha}`, {
            method: 'PUT',
            headers: { authorization },
            body: content,
          });
          changes.push({ path: file, mode: '100644', blob: sha });
        }
        const result: SandboxResult = {
          outcome: 'success',
          attempt: 0,
          applied: [{ changes }],
        };
        await fetch(`${spec.url}/result`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify(result),
        });
        return spec.result;
      },
    });

    const withRunner = (runner: SandboxRunner, backstop = true) => ({
      sandbox: { runner, server: sandbox.server },
      backstop,
    });

    it('refuses a job result that changes a file no commit touches', async () => {
      const files = {
        'feature.txt': 'changed\n',
        '.github/workflows/evil.yml': 'on: push\n',
      };
      await expect(
        setupAndBackport({
          initial: { 'feature.txt': 'initial\n' },
          changes: { 'feature.txt': 'changed\n' },
          deps: withRunner(maliciousRunner(files)),
        }),
      ).rejects.toThrow(BackstopError);
      // It is the backstop that catches it.
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        changes: { 'feature.txt': 'changed\n' },
        deps: withRunner(maliciousRunner(files), false),
      });
      expect(outcome.kind).toBe('success');
    });

    it('refuses a job result whose contents differ from the original commit where they must not', async () => {
      await expect(
        setupAndBackport({
          initial: { 'feature.txt': 'initial\n' },
          changes: { 'feature.txt': 'changed\n' },
          deps: withRunner(maliciousRunner({ 'feature.txt': 'evil\n' })),
        }),
      ).rejects.toThrow(BackstopError);
    });

    it('retries a job that failed for want of infrastructure', async () => {
      const local = new LocalProcessRunner(50_000);
      let runs = 0;
      const flaky: SandboxRunner = {
        kind: 'local',
        listenHost: '127.0.0.1',
        run: async (spec) => {
          runs += 1;
          if (runs <= 2) throw new SandboxInfraError('no node came up');
          return local.run(spec);
        },
      };
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        changes: { 'feature.txt': 'changed\n' },
        deps: {
          sandbox: { runner: flaky, server: sandbox.server },
          retryDelaysMs: [0, 0],
        },
      });
      expect(runs).toBe(3);
      expect(outcome.kind).toBe('success');
    });

    it.each([
      [
        'an error the job reports itself',
        async (spec: SandboxJobSpec) => {
          await fetch(`${spec.url}/result`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${spec.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ outcome: 'error', message: 'git died' }),
          });
          return spec.result;
        },
      ],
      [
        'a timeout',
        async () => {
          throw new SandboxInfraError('Sandbox job timed out', false);
        },
      ],
    ])('does not retry %s', async (_, run) => {
      let runs = 0;
      const failing: SandboxRunner = {
        kind: 'local',
        listenHost: '127.0.0.1',
        run: async (spec) => {
          runs += 1;
          return run(spec);
        },
      };
      await expect(
        setupAndBackport({
          initial: { 'feature.txt': 'initial\n' },
          changes: { 'feature.txt': 'changed\n' },
          deps: {
            sandbox: { runner: failing, server: sandbox.server },
            retryDelaysMs: [0, 0],
          },
        }),
      ).rejects.toBeInstanceOf(SandboxInfraError);
      expect(runs).toBe(1);
    });

    it('refuses uploads from a job that pushes nothing', async () => {
      let status = 0;
      const uploader: SandboxRunner = {
        kind: 'local',
        listenHost: '127.0.0.1',
        run: async (spec) => {
          const content = 'x'.repeat(1024);
          const sha = createHash('sha256').update(content).digest('hex');
          status = (
            await fetch(`${spec.url}/blobs/${sha}`, {
              method: 'PUT',
              headers: { authorization: `Bearer ${spec.token}` },
              body: content,
            })
          ).status;
          return new LocalProcessRunner(50_000).run(spec);
        },
      };
      const { outcome } = await setupAndBackport({
        initial: { 'feature.txt': 'initial\n' },
        changes: { 'feature.txt': 'changed\n' },
        includeChanges: false,
        deps: { sandbox: { runner: uploader, server: sandbox.server } },
      });
      expect(status).toBe(403);
      expect(outcome.kind).toBe('success');
    });

    it('carries a change of mode or type through the backstop', async () => {
      const { outcome } = await setupAndBackport({
        initial: {
          'tool.sh': '#!/bin/sh\n',
          link: 'symlink:tool.sh',
          'file.txt': 'file\n',
        },
        changes: {
          'tool.sh': 'exec:#!/bin/sh\n',
          link: 'now a file\n',
          'file.txt': 'symlink:tool.sh',
        },
      });
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') return;
      const [commit] = outcome.commits;
      expect(changeFor(commit, 'tool.sh')).toMatchObject({ mode: '100755' });
      expect(contentOf(changeFor(commit, 'tool.sh'))).toBe('#!/bin/sh\n');
      expect(changeFor(commit, 'link')).toMatchObject({ mode: '100644' });
      expect(changeFor(commit, 'file.txt')).toMatchObject({ mode: '120000' });
    });

    it('gives up after its retries with an infrastructure error', async () => {
      let runs = 0;
      const broken: SandboxRunner = {
        kind: 'local',
        listenHost: '127.0.0.1',
        run: async () => {
          runs += 1;
          throw new SandboxInfraError('no node came up');
        },
      };
      await expect(
        setupAndBackport({
          initial: { 'feature.txt': 'initial\n' },
          changes: { 'feature.txt': 'changed\n' },
          deps: {
            sandbox: { runner: broken, server: sandbox.server },
            retryDelaysMs: [0, 0],
          },
        }),
      ).rejects.toBeInstanceOf(SandboxInfraError);
      expect(runs).toBe(3);
    });

    it('cuts a long conflict diff without splitting a character', async () => {
      const conflict = {
        initial: { 'feature.txt': 'initial\n' },
        targetChanges: { 'feature.txt': 'target \u{1F600}\n' },
        changes: { 'feature.txt': 'source \u{1F600}\n' },
      };
      const full = await setupAndBackport(conflict);
      if (full.outcome.kind !== 'conflict') throw new Error('no conflict');
      const at = full.outcome.diff.indexOf('\u{1F600}');
      expect(at).toBeGreaterThan(0);
      // A limit that falls between the emoji's two UTF-16 code units.
      const { outcome } = await setupAndBackport({
        ...conflict,
        deps: { inputLimits: { diffChars: at + 1, errorChars: 1000 } },
      });
      expect(outcome.kind).toBe('conflict');
      if (outcome.kind !== 'conflict') return;
      expect(outcome.diff).toBe(full.outcome.diff.slice(0, at));
      expect(outcome.diff.isWellFormed()).toBe(true);
    });

    it('retries, then reports a cache that cannot fetch as an internal error', async () => {
      const cache = new RepoCache('electron/trop', {
        dir: path.join(await makeTempDir('trop-cache-'), 'git-cache'),
        remoteUrl: path.join(await makeTempDir('trop-gone-'), 'missing.git'),
      });
      const error = await runSandboxedBackport(
        {
          slug: 'electron/trop',
          token: '',
          targetBranch: '42-x-y',
          attempts: [{ kind: 'all', commits: [] }],
          includeChanges: true,
        },
        { sandbox, cache, retryDelaysMs: [0] },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxInfraError);
      expect(error).toMatchObject({ retryable: true });
    });

    it('fails when the target branch does not exist', async () => {
      const remoteDir = await makeTempDir('trop-remote-');
      runGit(remoteDir, ['init', '--bare']);
      const cache = new RepoCache('electron/trop', {
        dir: path.join(await makeTempDir('trop-cache-'), 'git-cache'),
        remoteUrl: remoteDir,
      });
      await expect(
        runSandboxedBackport(
          {
            slug: 'electron/trop',
            token: '',
            targetBranch: '42-x-y',
            attempts: [{ kind: 'all', commits: [] }],
            includeChanges: true,
          },
          { sandbox, cache, retryDelaysMs: [] },
        ),
      ).rejects.toThrow('42-x-y');
    });

    it('refuses a branch name git could read as an option', async () => {
      const cache = new RepoCache('electron/trop', {
        dir: path.join(await makeTempDir('trop-cache-'), 'git-cache'),
        remoteUrl: '/nonexistent',
      });
      await expect(
        cache.acquire('', '--upload-pack=touch /tmp/x'),
      ).rejects.toThrow('Refusing');
    });
  });

  describe('updateManualBackport()', { timeout: 30_000 }, () => {
    const octokit = {
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: { user: { login: 'original-author' } },
        }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
      },
    };

    const withBaseRef = (event: any, ref: string) => ({
      ...event,
      payload: {
        ...event.payload,
        pull_request: {
          ...event.payload.pull_request,
          base: { ...event.payload.pull_request.base, ref },
        },
      },
    });

    it('tags reviewers and requests review from the original author on manual backport creation', async () => {
      const context = {
        ...backportPROpenedEvent,
        octokit,
        repo: vi.fn(),
      };
      await updateManualBackport(context, PRChange.OPEN, 1234);
      expect(tagBackportReviewers).toHaveBeenCalled();
      expect(tagBackportReviewers).toHaveBeenCalledWith({
        context,
        targetPrNumber: 7,
        users: ['original-author'],
      });
      expect(getPRApprovers).not.toHaveBeenCalled();
    });

    it("requests review from the original PR's approvers if Claude opened it", async () => {
      vi.mocked(getPRApprovers).mockResolvedValueOnce([
        'alice',
        // The author of the manual backport PR in the fixture.
        'codebytere',
        'bob',
      ]);
      const context = {
        ...backportPROpenedEvent,
        octokit: {
          ...octokit,
          pulls: {
            get: vi.fn().mockResolvedValue({
              data: { user: { login: 'claude[bot]' } },
            }),
          },
        },
        repo: vi.fn(),
      };
      await updateManualBackport(context, PRChange.OPEN, 1234);
      expect(getPRApprovers).toHaveBeenCalledWith(context, 1234);
      expect(tagBackportReviewers).toHaveBeenCalledWith({
        context,
        targetPrNumber: 7,
        users: ['alice', 'bob'],
      });
    });

    it('does not request review from the original author if they opened the manual backport', async () => {
      const context = {
        ...backportPROpenedEvent,
        octokit: {
          ...octokit,
          pulls: {
            // The author of the manual backport PR in the fixture.
            get: vi.fn().mockResolvedValue({
              data: { user: { login: 'codebytere' } },
            }),
          },
        },
        repo: vi.fn(),
      };
      await updateManualBackport(context, PRChange.OPEN, 1234);
      expect(tagBackportReviewers).toHaveBeenCalled();
      expect(tagBackportReviewers).toHaveBeenCalledWith({
        context,
        targetPrNumber: 7,
        users: [],
      });
    });

    it('does not tag reviewers on merged PRs', async () => {
      const context = {
        ...backportPRMergedEvent,
        octokit,
        repo: vi.fn(),
      };
      await updateManualBackport(context, PRChange.MERGE, 1234);
      expect(tagBackportReviewers).not.toHaveBeenCalled();
    });

    it('does not tag reviewers on closed PRs', async () => {
      const context = {
        ...backportPRClosedEvent,
        octokit,
        repo: vi.fn(),
      };
      await updateManualBackport(context, PRChange.CLOSE, 1234);
      expect(tagBackportReviewers).not.toHaveBeenCalled();
    });

    it('labels the backport and the original PR for a supported release branch', async () => {
      const context = {
        ...backportPROpenedEvent,
        octokit,
        repo: vi.fn(),
      };
      await updateManualBackport(context, PRChange.OPEN, 1234);
      expect(addLabels).toHaveBeenCalledWith(
        context,
        7,
        expect.arrayContaining(['36-x-y']),
      );
      expect(addLabels).toHaveBeenCalledWith(context, 1234, [
        'in-flight/36-x-y',
      ]);
      expect(removeLabel).toHaveBeenCalledWith(
        context,
        1234,
        'needs-manual-bp/36-x-y',
      );
    });

    // electron/electron#54337: a manual backport stacked on another backport
    // targets that backport's branch instead of a release branch.
    it.each([
      ['a stacked backport branch', 'bp/36-x-y/native-prototypes-53962'],
      ['a feature branch', 'some-feature'],
    ])(
      'does not add branch labels when the backport targets %s',
      async (_, ref) => {
        const context = {
          ...withBaseRef(backportPROpenedEvent, ref),
          octokit,
          repo: vi.fn(),
        };
        await updateManualBackport(context, PRChange.OPEN, 1234);

        const labelsAdded = vi
          .mocked(addLabels)
          .mock.calls.flatMap(([, , labels]) => labels);
        expect(labelsAdded.some((label) => label?.includes(ref))).toBe(false);
        expect(addLabels).not.toHaveBeenCalledWith(
          context,
          1234,
          expect.anything(),
        );
        expect(removeLabel).not.toHaveBeenCalledWith(
          context,
          1234,
          expect.anything(),
        );

        // The original PR is still pointed at the backport.
        expect(octokit.issues.createComment).toHaveBeenCalled();
        expect(tagBackportReviewers).toHaveBeenCalled();
      },
    );

    it.each([
      ['a stacked backport branch', 'bp/36-x-y/native-prototypes-53962'],
      ['a feature branch', 'some-feature'],
    ])(
      'does not add a merged label when a backport to %s merges',
      async (_, ref) => {
        const context = {
          ...withBaseRef(backportPRMergedEvent, ref),
          octokit,
          repo: vi.fn(),
        };
        await updateManualBackport(context, PRChange.MERGE, 1234);

        expect(addLabels).not.toHaveBeenCalled();
        // A stale in-flight label is still cleaned up.
        expect(removeLabel).toHaveBeenCalledWith(
          context,
          1234,
          `in-flight/${ref}`,
        );
      },
    );

    it('adds a merged label when a backport to a supported release branch merges', async () => {
      const context = {
        ...backportPRMergedEvent,
        octokit,
        repo: vi.fn(),
      };
      await updateManualBackport(context, PRChange.MERGE, 1234);

      expect(addLabels).toHaveBeenCalledWith(context, 15, ['36-x-y']);
      expect(addLabels).toHaveBeenCalledWith(context, 1234, ['merged/36-x-y']);
      expect(removeLabel).toHaveBeenCalledWith(
        context,
        1234,
        'in-flight/36-x-y',
      );
    });
  });
});
