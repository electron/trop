jest.mock('request');
const { Application } = require('probot');

import * as utils from '../utils';
import { ProbotHandler } from '../../index';

const trop: ProbotHandler = require('../../index');

// event fixtures
const prClosedEvent = require('./fixtures/pull_request.closed.json');
const backportPRClosedBotEvent = require('./fixtures/backport_pull_request.closed.bot.json');
const backportPRClosedEvent = require('./fixtures/backport_pull_request.closed.json');
const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');
const issueCommentBackportCreatedEvent = require('./fixtures/issue_comment_backport.created.json');
const issueCommentBackportToCreatedEvent = require('./fixtures/issue_comment_backport_to.created.json');
const issueCommentBackportToMultipleCreatedEvent = require('./fixtures/issue_comment_backport_to_multiple.created.json');

describe('trop', () => {
  let robot: any;
  let github: any;

  beforeEach(async () => {
    robot = new Application();
    await trop(robot);

    github = {
      repos: {
        getContent: jest.fn().mockReturnValue(Promise.resolve({
          data: { content: Buffer.from('watchedProject:\n  name: Radar\nauthorizedUsers:\n  - codebytere').toString('base64') },
        })),
        getBranch: jest.fn().mockReturnValue(Promise.resolve()),
      },
      pullRequests: {
        get: jest.fn().mockReturnValue(Promise.resolve({
          data: {
            merged: true,
            base: {
              repo: {
                name: 'test',
                owner: {
                  login: 'codebytere',
                },
              },
            },
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
        })),
      },
      issues: {
        addLabels: jest.fn().mockReturnValue(Promise.resolve({})),
        removeLabel: jest.fn().mockReturnValue(Promise.resolve({})),
        createLabel: jest.fn().mockReturnValue(Promise.resolve({})),
        createComment: jest.fn().mockReturnValue(Promise.resolve({})),
        listLabelsOnIssue: jest.fn().mockReturnValue(Promise.resolve({
          data: [
            {
              id: 208045946,
              url: 'https://api.github.com/repos/octocat/Hello-World/labels/bug',
              name: 'bug',
              description: 'Something isn\'t working',
              color: 'f29513',
            },
          ],
        })),
      },
      checks: {
        listForRef: jest.fn().mockReturnValue(Promise.resolve({ data: { check_runs: [] } })),
      },
    };

    robot.auth = () => Promise.resolve(github);
  });

  describe('config', () => {
    it('fetches config', async () => {
      Object.defineProperty(utils, 'backportToLabel', { value: jest.fn() });
      await robot.receive(issueCommentBackportCreatedEvent);

      expect(github.repos.getContent).toHaveBeenCalled();
    });
  });

  describe('issue_comment.created event', () => {
    it('manually triggers the backport on comment', async () => {
      Object.defineProperty(utils, 'backportToLabel', { value: jest.fn() });
      await robot.receive(issueCommentBackportCreatedEvent);

      expect(github.pullRequests.get).toHaveBeenCalled();
      expect(github.issues.createComment).toHaveBeenCalled();
      expect(utils.backportToLabel).toHaveBeenCalled();
    });

    it('does not trigger the backport on comment if the PR is not merged', async () => {
      Object.defineProperty(utils, 'backportToLabel', { value: jest.fn() });
      github.pullRequests.get = jest.fn().mockReturnValue(Promise.resolve({ data: { merged: false } }));

      await robot.receive(issueCommentBackportCreatedEvent);

      expect(github.pullRequests.get).toHaveBeenCalled();
      expect(github.issues.createComment).toHaveBeenCalled();
      expect(utils.backportToLabel).not.toHaveBeenCalled();
    });

    it('triggers the backport on comment to a targeted branch', async () => {
      Object.defineProperty(utils, 'backportToBranch', { value: jest.fn() });
      await robot.receive(issueCommentBackportToCreatedEvent);

      expect(github.pullRequests.get).toHaveBeenCalled();
      expect(github.issues.createComment).toHaveBeenCalled();
      expect(utils.backportToBranch).toHaveBeenCalled();
    });

    it('allows for multiple PRs to be triggered in the same comment', async () => {
      Object.defineProperty(utils, 'backportToBranch', { value: jest.fn() });
      await robot.receive(issueCommentBackportToMultipleCreatedEvent);

      expect(github.pullRequests.get).toHaveBeenCalledTimes(3);
      expect(github.issues.createComment).toHaveBeenCalledTimes(2);
      expect(utils.backportToBranch).toHaveBeenCalledTimes(2);
    });

    it('does not trigger the backport on comment to a targeted branch if the branch does not exist', async () => {
      Object.defineProperty(utils, 'backportToBranch', { value: jest.fn() });
      github.repos.getBranch = jest.fn().mockReturnValue(Promise.reject(new Error('404')));
      await robot.receive(issueCommentBackportToCreatedEvent);

      expect(github.pullRequests.get).toHaveBeenCalled();
      expect(github.issues.createComment).toHaveBeenCalled();
      expect(utils.backportToBranch).toHaveBeenCalledTimes(0);
    });
  });

  describe('pull_request.opened event', () => {
    it('labels the original PR when a manual backport PR has been opened', async () => {
      Object.defineProperty(utils, 'updateManualBackport', { value: jest.fn() });
      await robot.receive(backportPROpenedEvent);

      expect(utils.updateManualBackport).toHaveBeenCalled();
    });
  });

  describe('pull_request.closed event', () => {
    it('begins the backporting process if the PR was merged', async () => {
      Object.defineProperty(utils, 'backportToLabel', { value: jest.fn() });
      await robot.receive(prClosedEvent);

      expect(utils.backportToLabel).toHaveBeenCalled();
    });

    it('adds a label when a backport PR has been merged', async () => {
      Object.defineProperty(utils, 'labelMergedPR', { value: jest.fn() });
      await robot.receive(backportPRClosedBotEvent);

      expect(utils.labelMergedPR).toHaveBeenCalled();
    });

    it('labels the original PR when a manual backport PR has been merged', async () => {
      Object.defineProperty(utils, 'updateManualBackport', { value: jest.fn() });
      await robot.receive(backportPRClosedEvent);

      expect(utils.updateManualBackport).toHaveBeenCalled();
    });

    it('adds a label when a backport PR has been merged', async () => {
      Object.defineProperty(utils, 'labelMergedPR', { value: jest.fn() });
      await robot.receive(backportPRClosedEvent);

      expect(utils.updateManualBackport).toHaveBeenCalled();
    });
  });
});
