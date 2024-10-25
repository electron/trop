import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';

import { PRChange } from '../src/enums';
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

jest.mock('../src/utils', () => ({
  tagBackportReviewers: jest.fn().mockResolvedValue(undefined),
  isSemverMinorPR: jest.fn().mockReturnValue(false),
}));

jest.mock('../src/utils/label-utils', () => ({
  labelExistsOnPR: jest.fn().mockResolvedValue(true),
  getSemverLabel: jest.fn().mockResolvedValue(false),
  addLabels: jest.fn(),
  removeLabel: jest.fn(),
}));

describe('runner', () => {
  jest.setTimeout(30000);
  console.error = jest.fn();

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

  describe('updateManualBackport()', () => {
    const octokit = {
      pulls: {
        get: jest.fn().mockResolvedValue({}),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
        listComments: jest.fn().mockResolvedValue({ data: [] }),
      },
    };

    it('tags reviewers on manual backport creation', async () => {
      const context = {
        ...backportPROpenedEvent,
        octokit,
        repo: jest.fn(),
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
        repo: jest.fn(),
      };
      await updateManualBackport(context, PRChange.MERGE, 1234);
      expect(tagBackportReviewers).not.toHaveBeenCalled();
    });

    it('does not tag reviewers on closed PRs', async () => {
      const context = {
        ...backportPRClosedEvent,
        octokit,
        repo: jest.fn(),
      };
      await updateManualBackport(context, PRChange.CLOSE, 1234);
      expect(tagBackportReviewers).not.toHaveBeenCalled();
    });
  });
});
