import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRChange } from '../src/enums';
import { backportCommitsToBranch } from '../src/operations/backport-commits';
import { initRepo } from '../src/operations/init-repo';
import { setupRemotes } from '../src/operations/setup-remotes';
import { updateManualBackport } from '../src/operations/update-manual-backport';
import { tagBackportReviewers } from '../src/utils';

let dirObject: { dir?: string } | null = null;

const saveDir = (o: { dir: string }) => {
  dirObject = o;
  return o.dir;
};

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
  tagBackportReviewers: vi.fn().mockResolvedValue(undefined),
  isSemverMinorPR: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/utils/label-utils', () => ({
  labelExistsOnPR: vi.fn().mockResolvedValue(true),
  getSemverLabel: vi.fn().mockResolvedValue(false),
  addLabels: vi.fn(),
  removeLabel: vi.fn(),
}));

describe('runner', () => {
  console.error = vi.fn();

  afterEach(async () => {
    if (dirObject && dirObject.dir) {
      await fs.promises.rm(dirObject.dir, { force: true, recursive: true });
    }
  });

  describe('initRepo()', () => {
    it('should clone a github repository', async () => {
      const dir = saveDir(
        await initRepo({
          slug: 'electron/trop',
          accessToken: '',
        }),
      );
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.resolve(dir, '.git'))).toBe(true);
    });

    it('should fail if the github repository does not exist', async () => {
      await expect(
        initRepo({
          slug: 'electron/this-is-not-trop',
          accessToken: '',
        }),
      ).rejects.toBeTruthy();
    });
  });

  describe('setUpRemotes()', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.promises.mkdtemp(path.resolve(os.tmpdir(), 'trop-spec-'));
      await fs.promises.mkdir(dir, { recursive: true });
      spawnSync('git', ['init'], { cwd: dir });
    });

    afterEach(async () => {
      if (fs.existsSync(dir)) {
        await fs.promises.rm(dir, { force: true, recursive: true });
      }
    });

    it('should set new remotes correctly', async () => {
      await setupRemotes({
        dir,
        remotes: [
          {
            name: 'origin',
            value: 'https://github.com/electron/clerk.git',
          },
          {
            name: 'secondary',
            value: 'https://github.com/electron/trop.git',
          },
        ],
      });
      const git = simpleGit(dir);
      const remotes = await git.raw(['remote', '-v']);
      const parsedRemotes = remotes
        .trim()
        .replace(/ +/g, ' ')
        .replace(/\t/g, ' ')
        .replace(/ \(fetch\)/g, '')
        .replace(/ \(push\)/g, '')
        .split(/\r?\n/g)
        .map((line) => line.trim().split(' '));

      expect(parsedRemotes.length).toBe(4);
      for (const remote of parsedRemotes) {
        expect(remote.length).toBe(2);
        expect(['origin', 'secondary']).toContain(remote[0]);
        if (remote[0] === 'origin') {
          expect(
            remote[1].endsWith('github.com/electron/clerk.git'),
          ).toBeTruthy();
        } else {
          expect(
            remote[1].endsWith('github.com/electron/trop.git'),
          ).toBeTruthy();
        }
      }
    });
  });

  describe('backportCommitsToBranch()', { timeout: 30_000 }, () => {
    let createdDirs: string[] = [];

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

    // Build two repos with identical initial files, apply changes to the
    // source, format-patch, publish, clone, and run the backport.
    // Returns the work directory for assertions.
    const setupAndBackport = async (opts: {
      initial: Record<string, string>;
      changes: Record<string, string>;
    }): Promise<string> => {
      const remoteDir = await makeTempDir('trop-remote-');
      const targetDir = await makeTempDir('trop-target-');
      const sourceDir = await makeTempDir('trop-source-');
      const workDir = await makeTempDir('trop-work-');

      runGit(remoteDir, ['init', '--bare']);

      for (const dir of [targetDir, sourceDir]) {
        initTestGitRepo(dir);
        for (const [file, content] of Object.entries(opts.initial)) {
          await writeRepoFile(dir, file, content);
        }
        runGit(dir, ['add', '.']);
        runGit(dir, ['commit', '-m', 'initial']);
      }
      runGit(targetDir, ['branch', '42-x-y']);

      for (const [file, content] of Object.entries(opts.changes)) {
        await writeRepoFile(sourceDir, file, content);
      }
      runGit(sourceDir, ['add', ...Object.keys(opts.changes)]);
      runGit(sourceDir, ['commit', '-m', 'change']);
      const patch = runGit(sourceDir, [
        'format-patch',
        '-1',
        '--stdout',
        'HEAD',
      ]);

      runGit(targetDir, ['remote', 'add', 'origin', remoteDir]);
      runGit(targetDir, ['push', 'origin', 'main', '42-x-y']);
      runGit(remoteDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      runGit(workDir, ['clone', remoteDir, '.']);
      runGit(workDir, ['config', 'user.name', 'Trop Test']);
      runGit(workDir, ['config', 'user.email', 'trop@example.com']);
      runGit(workDir, ['remote', 'add', 'target_repo', remoteDir]);
      runGit(workDir, ['fetch', 'target_repo']);

      const result = await backportCommitsToBranch({
        context: {} as never,
        dir: workDir,
        github: {} as never,
        patches: [patch],
        shouldPush: false,
        slug: 'electron/trop',
        targetBranch: '42-x-y',
        targetRemote: 'target_repo',
        tempBranch: 'backport-to-42-x-y',
      });
      expect(result).toEqual({ dir: workDir });

      return workDir;
    };

    const patchFiles = (
      dir: string,
      entries: string[],
    ): Record<string, string> =>
      Object.fromEntries(
        entries.map((e) => [dir ? `${dir}/${e}` : e, `${e}\n`]),
      );

    const readFile = (workDir: string, file: string) =>
      fs.promises.readFile(path.join(workDir, file), 'utf8');

    const sharedEntries = ['shared1.patch', 'shared2.patch', 'shared3.patch'];
    const sharedPatches = buildPatchList(...sharedEntries);
    const shearedSourcePatches = buildPatchList(
      ...sharedEntries,
      'no-backport.patch',
      'backport.patch',
    );
    const expectedShearedPatches = buildPatchList(
      ...sharedEntries,
      'backport.patch',
    );
    const patchBackportContents = 'patch backport\n';

    it('removes sheared entries from .patches', async () => {
      const workDir = await setupAndBackport({
        initial: {
          '.patches': sharedPatches,
          ...patchFiles('', sharedEntries),
        },
        changes: {
          '.patches': shearedSourcePatches,
          'backport.patch': patchBackportContents,
        },
      });
      expect(await readFile(workDir, '.patches')).toBe(expectedShearedPatches);
      expect(await readFile(workDir, 'backport.patch')).toBe(
        patchBackportContents,
      );
      expect(fs.existsSync(path.join(workDir, 'no-backport.patch'))).toBe(
        false,
      );
    });

    it('handles multiple changed .patches directories', async () => {
      const crEntries = ['shared1.patch', 'shared2.patch', 'shared3.patch'];
      const v8Entries = ['alpha.patch', 'beta.patch', 'gamma.patch'];

      const workDir = await setupAndBackport({
        initial: {
          'electron/patches/chromium/.patches': buildPatchList(...crEntries),
          ...patchFiles('electron/patches/chromium', crEntries),
          'electron/patches/v8/.patches': buildPatchList(...v8Entries),
          ...patchFiles('electron/patches/v8', v8Entries),
        },
        changes: {
          'electron/patches/chromium/.patches': buildPatchList(
            ...crEntries,
            'no-backport.patch',
            'backport.patch',
          ),
          'electron/patches/chromium/backport.patch':
            'chromium patch backport\n',
          'electron/patches/v8/.patches': buildPatchList(
            ...v8Entries,
            'not-for-backport.patch',
            'v8-backport.patch',
          ),
          'electron/patches/v8/v8-backport.patch': 'v8 patch backport\n',
        },
      });
      expect(
        await readFile(workDir, 'electron/patches/chromium/.patches'),
      ).toBe(buildPatchList(...crEntries, 'backport.patch'));
      expect(await readFile(workDir, 'electron/patches/v8/.patches')).toBe(
        buildPatchList(...v8Entries, 'v8-backport.patch'),
      );
      expect(
        await readFile(workDir, 'electron/patches/chromium/backport.patch'),
      ).toBe('chromium patch backport\n');
      expect(
        await readFile(workDir, 'electron/patches/v8/v8-backport.patch'),
      ).toBe('v8 patch backport\n');
      expect(
        fs.existsSync(
          path.join(workDir, 'electron/patches/chromium/no-backport.patch'),
        ),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(workDir, 'electron/patches/v8/not-for-backport.patch'),
        ),
      ).toBe(false);
    });

    it('preserves .patches-only additions for existing patch files', async () => {
      const entries = ['shared1.patch', 'shared2.patch'];
      const expected = buildPatchList(...entries, 'already-present.patch');

      const workDir = await setupAndBackport({
        initial: {
          '.patches': buildPatchList(...entries),
          ...patchFiles('', entries),
          'already-present.patch': 'already here\n',
        },
        changes: { '.patches': expected },
      });
      expect(await readFile(workDir, '.patches')).toBe(expected);
    });

    it('keeps .patches empty when the backported commit removes the last entry', async () => {
      const workDir = await setupAndBackport({
        initial: {
          '.patches': 'obsolete.patch\n',
          'obsolete.patch': 'obsolete\n',
        },
        changes: { '.patches': '' },
      });
      expect(await readFile(workDir, '.patches')).toBe('');
    });

    it('applies correct .patches when source and target are in sync (no shear)', async () => {
      const entries = ['shared1.patch', 'shared2.patch'];
      const updated = buildPatchList(...entries, 'new-backport.patch');

      const workDir = await setupAndBackport({
        initial: {
          '.patches': buildPatchList(...entries),
          ...patchFiles('', entries),
        },
        changes: { '.patches': updated, 'new-backport.patch': 'new patch\n' },
      });
      expect(await readFile(workDir, '.patches')).toBe(updated);
      expect(await readFile(workDir, 'new-backport.patch')).toBe('new patch\n');
    });

    it('handles .patches files with trailing newlines correctly', async () => {
      const workDir = await setupAndBackport({
        initial: {
          '.patches': `${sharedPatches}\n`,
          ...patchFiles('', sharedEntries),
        },
        changes: {
          '.patches': `${shearedSourcePatches}\n`,
          'backport.patch': patchBackportContents,
        },
      });
      expect(await readFile(workDir, '.patches')).toBe(
        `${expectedShearedPatches}\n`,
      );
    });
  });

  describe('updateManualBackport()', { timeout: 30_000 }, () => {
    const octokit = {
      pulls: {
        get: vi.fn().mockResolvedValue({}),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
      },
    };

    it('tags reviewers on manual backport creation', async () => {
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
  });
});
