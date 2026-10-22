import { spawnSync } from 'child_process';
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
import { runSandboxedBackport, Sandbox } from '../src/sandbox';
import { createBackportCommits } from '../src/sandbox/commits';
import { SandboxJobServer } from '../src/sandbox/job-server';
import {
  SandboxAttempt,
  SandboxCommit,
  SandboxFileChange,
} from '../src/sandbox/protocol';
import { RepoCache } from '../src/sandbox/repo-cache';
import { LocalProcessRunner } from '../src/sandbox/runner';
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
        if (content === null) {
          await fs.promises.rm(path.join(dir, file));
        } else if (Buffer.isBuffer(content)) {
          await fs.promises.writeFile(path.join(dir, file), content);
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
      // Further attempts after the patches above, e.g. a squash commit.
      extraAttempts?: SandboxAttempt[];
      includeChanges?: boolean;
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

      const patches: string[] = [];
      for (const [i, changes] of [
        opts.changes,
        ...(opts.stackedChanges ?? []),
      ].entries()) {
        await applyChanges(sourceDir, changes);
        commitAll(
          sourceDir,
          i === 0 ? 'change' : 'stacked change',
          Object.keys(changes),
        );
        patches.push(
          runGit(sourceDir, ['format-patch', '-1', '--stdout', 'HEAD']),
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
          attempts: [{ kind: 'all', patches }, ...(opts.extraAttempts ?? [])],
          includeChanges: opts.includeChanges ?? true,
        },
        { sandbox, cache },
      );
      const targetTip = runGit(remoteDir, ['rev-parse', '42-x-y']);
      return { outcome, targetTip, cacheDir, patches };
    };

    const changeFor = (commit: SandboxCommit, file: string) =>
      commit.changes?.find((c) => c.path === file);

    const contentOf = (change: SandboxFileChange | undefined) => {
      if (!change || 'deleted' in change) return undefined;
      return Buffer.from(change.content, 'base64').toString('utf8');
    };

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
        extraAttempts: [{ kind: 'squash', patches: [] }],
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
      const change = changeFor(outcome.commits[0], 'big.bin');
      expect(change && 'content' in change).toBe(true);
      if (!change || !('content' in change)) return;
      expect(Buffer.from(change.content, 'base64').equals(big)).toBe(true);
      expect(contentOf(changeFor(outcome.commits[0], 'small.txt'))).toBe(
        'small\n',
      );
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
            attempts: [{ kind: 'all', patches: [] }],
            includeChanges: true,
          },
          { sandbox, cache },
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
