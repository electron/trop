jest.mock('request');
import { Application } from 'probot';

import { labelClosedPR } from '../src/utils';
import {
  backportToBranch,
  backportToLabel,
} from '../src/operations/backport-to-location';
import { updateManualBackport } from '../src/operations/update-manual-backport';
import { ProbotHandler } from '../src/index';
import { PRChange } from '../src/enums';

const trop: ProbotHandler = require('../src/index');

// event fixtures
const prClosedEvent = require('./fixtures/pull_request.closed.json');
const issueCommentBackportCreatedEvent = require('./fixtures/issue_comment_backport.created.json');
const issueCommentBackportToCreatedEvent = require('./fixtures/issue_comment_backport_to.created.json');
const issueCommentBackportToMultipleCreatedEvent = require('./fixtures/issue_comment_backport_to_multiple.created.json');

const backportPRMergedBotEvent = require('./fixtures/backport_pull_request.merged.bot.json');
const backportPRClosedBotEvent = require('./fixtures/backport_pull_request.closed.bot.json');
const backportPRMergedEvent = require('./fixtures/backport_pull_request.merged.json');
const backportPRClosedEvent = require('./fixtures/backport_pull_request.closed.json');
const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');

jest.mock('../src/utils', () => ({
  labelClosedPR: jest.fn(),
}));

jest.mock('../src/operations/update-manual-backport', () => ({
  updateManualBackport: jest.fn(),
}));

jest.mock('../src/operations/backport-to-location', () => ({
  backportToBranch: jest.fn(),
  backportToLabel: jest.fn(),
}));

describe('trop', () => {
  let robot: Application;
  let github: any;
  process.env = { BOT_USER_NAME: 'trop[bot]' };

  beforeEach(() => {
    robot = new Application();
    robot.load(trop);

    github = {
      repos: {
        getContents: jest.fn().mockReturnValue(
          Promise.resolve({
            data: {
              content: Buffer.from(
                'watchedProject:\n  name: Radar\nauthorizedUsers:\n  - codebytere',
              ).toString('base64'),
            },
          }),
        ),
        getBranch: jest.fn().mockReturnValue(Promise.resolve()),
        listBranches: jest.fn().mockReturnValue(
          Promise.resolve({
            data: [{ name: '8-x-y' }, { name: '7-1-x' }],
          }),
        ),
      },
      git: {
        deleteRef: jest.fn().mockReturnValue(Promise.resolve()),
      },
      pulls: {
        get: jest.fn().mockReturnValue(
          Promise.resolve({
            data: {
              merged: true,
              head: {
                sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
              },
              labels: [
                {
                  url: 'my_cool_url',
                  name: 'target/X-X-X',
                  color: 'fc2929',
                },
              ],
            },
          }),
        ),
      },
      issues: {
        addLabels: jest.fn().mockReturnValue(Promise.resolve({})),
        removeLabel: jest.fn().mockReturnValue(Promise.resolve({})),
        createLabel: jest.fn().mockReturnValue(Promise.resolve({})),
        createComment: jest.fn().mockReturnValue(Promise.resolve({})),
        listLabelsOnIssue: jest.fn().mockReturnValue(
          Promise.resolve({
            data: [
              {
                id: 208045946,
                url:
                  'https://api.github.com/repos/octocat/Hello-World/labels/bug',
                name: 'bug',
                description: 'Something isn\'t working',
                color: 'f29513',
              },
            ],
          }),
        ),
      },
      checks: {
        listForRef: jest
          .fn()
          .mockReturnValue(Promise.resolve({ data: { check_runs: [] } })),
      },
    };

    robot.auth = () => Promise.resolve(github);
  });

  describe('config', () => {
    it('fetches config', async () => {
      await robot.receive(issueCommentBackportCreatedEvent);

      expect(github.repos.getContents).toHaveBeenCalled();
    });
  });

  describe('issue_comment.created event', () => {
    it('manually triggers the backport on comment', async () => {
      await robot.receive(issueCommentBackportCreatedEvent);

      expect(github.pulls.get).toHaveBeenCalled();
      expect(github.issues.createComment).toHaveBeenCalled();
      expect(backportToLabel).toHaveBeenCalled();
    });

    it('does not trigger the backport on comment if the PR is not merged', async () => {
      github.pulls.get = jest
        .fn()
        .mockReturnValue(Promise.resolve({ data: { merged: false } }));

      await robot.receive(issueCommentBackportCreatedEvent);

      expect(github.pulls.get).toHaveBeenCalled();
      expect(github.issues.createComment).toHaveBeenCalled();
      expect(backportToLabel).not.toHaveBeenCalled();
    });

    it('triggers the backport on comment to a targeted branch', async () => {
      await robot.receive(issueCommentBackportToCreatedEvent);

      expect(github.pulls.get).toHaveBeenCalled();
      expect(github.issues.createComment).toHaveBeenCalled();
      expect(backportToBranch).toHaveBeenCalled();
    });

    it('allows for multiple PRs to be triggered in the same comment', async () => {
      await robot.receive(issueCommentBackportToMultipleCreatedEvent);

      expect(github.pulls.get).toHaveBeenCalledTimes(3);
      expect(github.issues.createComment).toHaveBeenCalledTimes(2);
      expect(backportToBranch).toHaveBeenCalledTimes(2);
    });

    it('does not trigger the backport on comment to a targeted branch if the branch does not exist', async () => {
      github.repos.getBranch = jest
        .fn()
        .mockReturnValue(Promise.reject(new Error('404')));
      await robot.receive(issueCommentBackportToCreatedEvent);

      expect(github.pulls.get).toHaveBeenCalled();
      expect(github.issues.createComment).toHaveBeenCalled();
      expect(backportToBranch).toHaveBeenCalledTimes(0);
    });
  });

  describe('pull_request.opened event', () => {
    it('labels the original PR when a manual backport PR has been opened', async () => {
      await robot.receive(backportPROpenedEvent);

      expect(updateManualBackport).toHaveBeenCalled();
    });
  });

  describe('pull_request.closed event', () => {
    it('begins the backporting process if the PR was merged', async () => {
      await robot.receive(prClosedEvent);

      expect(backportToLabel).toHaveBeenCalled();
    });

    it('updates labels on the original PR when a bot backport PR has been closed with unmerged commits', async () => {
      await robot.receive(backportPRClosedBotEvent);

      const pr = {
        body: `Backport of #14
See that PR for details.
Notes: <!-- One-line Change Summary Here-->`,
        created_at: '2018-11-01T17:29:51Z',
        head: {
          ref: '123456789iuytdxcvbnjhfdriuyfedfgy54escghjnbg'
        },
        labels: [
          {
            color: 'ededed',
            name: '5-0-x'
          },
          {
            name: 'backport',
            color: 'ededed'
          }
        ],
        merged: false,
        merged_at: '2018-11-01T17:30:11Z',
        state: 'closed',
        title: 'mirror', 
        user: {
          login: 'trop[bot]'
        }
      }

      expect((labelClosedPR as any).mock.calls[0][1]).toEqual(pr);
      expect((labelClosedPR as any).mock.calls[0][2]).toBe('5-0-x');
      expect((labelClosedPR as any).mock.calls[0][3]).toBe(PRChange.CLOSE);
    });

    it('updates labels on the original PR when a bot backport PR has been merged', async () => {
      await robot.receive(backportPRMergedBotEvent);

      const pr = {
        body: `Backport of #14
See that PR for details.
Notes: <!-- One-line Change Summary Here-->`,
        created_at: '2018-11-01T17:29:51Z',
        head: {
          ref: '123456789iuytdxcvbnjhfdriuyfedfgy54escghjnbg'
        },
        labels: [
          {
            color: 'ededed',
            name: '4-0-x'
          },
          {
            name: 'backport',
            color: 'ededed'
          }
        ],
        merged: true,
        merged_at: '2018-11-01T17:30:11Z',
        state: 'closed',
        title: 'mirror', 
        user: {
          login: 'trop[bot]'
        }
      }

      expect((labelClosedPR as any).mock.calls[0][1]).toEqual(pr);
      expect((labelClosedPR as any).mock.calls[0][2]).toBe('4-0-x');
      expect((labelClosedPR as any).mock.calls[0][3]).toBe(PRChange.MERGE);
    });

    it('updates labels on the original PR when a manual backport PR has been closed with unmerged commits', async () => {
      await robot.receive(backportPRClosedEvent);

      const pr = {
        body: `Backport of #14
See that PR for details.
Notes: <!-- One-line Change Summary Here-->`,
        created_at: '2018-11-01T17:29:51Z',
        head: {
          ref: '123456789iuytdxcvbnjhfdriuyfedfgy54escghjnbg'
        },
        labels: [
          {
            color: 'ededed',
            name: '4-0-x'
          },
          {
            name: 'backport',
            color: 'ededed'
          }
        ],
        merged: false,
        merged_at: '2018-11-01T17:30:11Z',
        state: 'closed',
        title: 'mirror', 
        user: {
          login: 'codebytere'
        }
      }

      expect(updateManualBackport).toHaveBeenCalled();

      expect((labelClosedPR as any).mock.calls[0][1]).toEqual(pr);
      expect((labelClosedPR as any).mock.calls[0][2]).toBe('4-0-x');
      expect((labelClosedPR as any).mock.calls[0][3]).toBe(PRChange.CLOSE);
    });

    it('updates labels on the original PR when a manual backport PR has been merged', async () => {
      await robot.receive(backportPRMergedEvent);

      const pr = {
        body: `Backport of #14
See that PR for details.
Notes: <!-- One-line Change Summary Here-->`,
        created_at: '2018-11-01T17:29:51Z',
        head: {
          ref: '123456789iuytdxcvbnjhfdriuyfedfgy54escghjnbg'
        },
        labels: [
          {
            color: 'ededed',
            name: '4-0-x'
          },
          {
            name: 'backport',
            color: 'ededed'
          }
        ],
        merged: true,
        merged_at: '2018-11-01T17:30:11Z',
        state: 'closed',
        title: 'mirror', 
        user: {
          login: 'codebytere'
        }
      }

      expect(updateManualBackport).toHaveBeenCalled();

      expect((labelClosedPR as any).mock.calls[0][1]).toEqual(pr);
      expect((labelClosedPR as any).mock.calls[0][2]).toBe('4-0-x');
      expect((labelClosedPR as any).mock.calls[0][3]).toBe(PRChange.MERGE);
    });
  });
});
