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
import { registerPatchesMergeDriver } from '../src/utils/build-tools';

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

    it('registers the build-tools .patches merge driver in the clone', async () => {
      const dir = saveDir(
        await initRepo({
          slug: 'electron/trop',
          accessToken: '',
        }),
      );
      expect(
        runGit(dir, ['config', '--get', 'merge.patches-list.driver']),
      ).toContain('e-patch-merge-driver.js');
      expect(
        runGit(dir, ['check-attr', 'merge', 'patches/chromium/.patches']),
      ).toBe('patches/chromium/.patches: merge: patches-list');
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

  describe('registerPatchesMergeDriver()', () => {
    it('fails loudly when the directory is not a git checkout', async () => {
      const dir = await fs.promises.mkdtemp(
        path.resolve(os.tmpdir(), 'trop-not-a-repo-'),
      );
      saveDir({ dir });
      await expect(registerPatchesMergeDriver(dir)).rejects.toThrow(
        `Failed to register build-tools' .patches merge driver in ${dir}`,
      );
    });
  });

  describe('setUpRemotes()', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.promises.mkdtemp(path.resolve(os.tmpdir(), 'trop-spec-'));
      await fs.promises.mkdir(dir, { recursive: true });
      runGit(dir, ['init']);
      runGit(dir, ['config', 'gc.autoDetach', 'false']);
      runGit(dir, ['config', 'maintenance.autoDetach', 'false']);
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
      // Changes committed on the target branch (42-x-y) before the backport,
      // so that the source and target diverge and `git am -3` has to fall
      // back to a three-way merge. A `null` value deletes the file.
      targetChanges?: Record<string, string | null>;
      // Register build-tools' .patches merge driver in the work clone, as
      // initRepo does in production. Set to false to observe `merge=union`.
      registerMergeDriver?: boolean;
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

      if (opts.targetChanges) {
        runGit(targetDir, ['checkout', '42-x-y']);
        for (const [file, content] of Object.entries(opts.targetChanges)) {
          if (content === null) {
            await fs.promises.rm(path.join(targetDir, file));
          } else {
            await writeRepoFile(targetDir, file, content);
          }
        }
        runGit(targetDir, ['add', '-A', ...Object.keys(opts.targetChanges)]);
        runGit(targetDir, ['commit', '-m', 'target change']);
        runGit(targetDir, ['checkout', 'main']);
      }

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
      if (opts.registerMergeDriver ?? true) {
        await registerPatchesMergeDriver(workDir);
      }

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

    // electron/electron commits `merge=union` for its .patches lists; the
    // build-tools driver registered on every backport clone overrides it.
    const unionAttributes = 'patches/**/.patches merge=union\n';
    const chromium = 'patches/chromium';
    const chromiumPatches = `${chromium}/.patches`;
    const listWithNewline = (...entries: string[]) =>
      `${buildPatchList(...entries)}\n`;
    const baseEntries = ['a.patch', 'b.patch', 'c.patch'];

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

    it('merges a diverged .patches list as a list instead of with union', async () => {
      const workDir = await setupAndBackport(duplicateAddition);
      expect(await readFile(workDir, chromiumPatches)).toBe(
        listWithNewline('a.patch', 'b.patch', 'x.patch', 'c.patch'),
      );
      expect(await readFile(workDir, `${chromium}/x.patch`)).toBe('x\n');
      expect(runGit(workDir, ['status', '--porcelain'])).toBe('');
    });

    it('would duplicate the entry with the committed union driver', async () => {
      // Control: the same fixture without build-tools' driver reproduces the
      // `merge=union` behaviour the driver exists to replace.
      const workDir = await setupAndBackport({
        ...duplicateAddition,
        registerMergeDriver: false,
      });
      expect(await readFile(workDir, chromiumPatches)).toBe(
        listWithNewline('a.patch', 'b.patch', 'x.patch', 'c.patch', 'x.patch'),
      );
    });

    it('keeps an entry removed on the target branch out of the merged .patches list', async () => {
      const workDir = await setupAndBackport({
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
      expect(await readFile(workDir, chromiumPatches)).toBe(
        listWithNewline('a.patch', 'b.patch', 'd.patch'),
      );
      expect(fs.existsSync(path.join(workDir, chromium, 'c.patch'))).toBe(
        false,
      );
      expect(await readFile(workDir, `${chromium}/d.patch`)).toBe('d\n');
    });

    it('applies only non-merge-commit patches when merge commits are filtered', async () => {
      const remoteDir = await makeTempDir('trop-remote-');
      const sourceDir = await makeTempDir('trop-source-');
      const targetDir = await makeTempDir('trop-target-');
      const workDir = await makeTempDir('trop-work-');

      runGit(remoteDir, ['init', '--bare']);

      // Shared initial state: a file that both the target branch and the
      // feature branch start from.
      for (const dir of [sourceDir, targetDir]) {
        initTestGitRepo(dir);
        await writeRepoFile(dir, 'feature.txt', 'initial\n');
        runGit(dir, ['add', '.']);
        runGit(dir, ['commit', '-m', 'initial']);
      }
      runGit(targetDir, ['branch', '42-x-y']);

      // Feature branch: one real commit (single parent).
      runGit(sourceDir, ['checkout', '-b', 'feature']);
      await writeRepoFile(sourceDir, 'feature.txt', 'feature-change\n');
      runGit(sourceDir, ['add', 'feature.txt']);
      runGit(sourceDir, ['commit', '-m', 'feat: change feature file']);
      const featurePatch = runGit(sourceDir, [
        'format-patch',
        '-1',
        '--stdout',
        'HEAD',
      ]);

      // Main branch advances with an unrelated commit.
      runGit(sourceDir, ['checkout', 'main']);
      await writeRepoFile(
        sourceDir,
        'unrelated.txt',
        'unrelated-main-change\n',
      );
      runGit(sourceDir, ['add', 'unrelated.txt']);
      runGit(sourceDir, ['commit', '-m', 'chore: unrelated main change']);

      // Merge main back into feature — this is the merge commit (two parents)
      // that tryBackportAllCommits now filters out.
      runGit(sourceDir, ['checkout', 'feature']);
      runGit(sourceDir, ['merge', 'main', '--no-edit', '--no-ff']);

      // Set up remote / work / target for the backport operation.
      runGit(targetDir, ['remote', 'add', 'origin', remoteDir]);
      runGit(targetDir, ['push', 'origin', 'main', '42-x-y']);
      runGit(remoteDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      runGit(workDir, ['clone', remoteDir, '.']);
      runGit(workDir, ['config', 'user.name', 'Trop Test']);
      runGit(workDir, ['config', 'user.email', 'trop@example.com']);
      runGit(workDir, ['remote', 'add', 'target_repo', remoteDir]);
      runGit(workDir, ['fetch', 'target_repo']);

      // Pass only the single-parent (non-merge) patch — mirroring what
      // tryBackportAllCommits does after filtering out merge commits.
      const result = await backportCommitsToBranch({
        context: {} as never,
        dir: workDir,
        github: {} as never,
        patches: [featurePatch],
        shouldPush: false,
        slug: 'electron/trop',
        targetBranch: '42-x-y',
        targetRemote: 'target_repo',
        tempBranch: 'backport-to-42-x-y',
      });
      expect(result).toEqual({ dir: workDir });

      // The feature commit's change must be present.
      expect(
        await fs.promises.readFile(path.join(workDir, 'feature.txt'), 'utf8'),
      ).toBe('feature-change\n');

      // The unrelated change introduced by the main-branch commit (which was
      // only reachable via the merge commit) must NOT be present.
      expect(fs.existsSync(path.join(workDir, 'unrelated.txt'))).toBe(false);
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
        user: 'original-author',
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
        user: undefined,
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
