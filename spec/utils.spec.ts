import * as logUtils from '../src/utils/log-util';
import { LogLevel } from '../src/enums';
import { tagBackportReviewers } from '../src/utils';

const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');

jest.mock('../src/constants', () => ({
  ...jest.requireActual('../src/constants'),
  DEFAULT_BACKPORT_REVIEW_TEAM: 'electron/wg-releases',
}));

describe('utils', () => {
  describe('tagBackportReviewers()', () => {
    const octokit = {
      pulls: {
        requestReviewers: jest.fn(),
      },
      repos: {
        getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({
          data: {
            permission: 'admin',
          },
        }),
      },
    };

    const context = {
      octokit,
      repo: jest.fn((obj) => obj),
      ...backportPROpenedEvent,
    };

    beforeEach(() => jest.clearAllMocks());

    it('correctly tags team reviewers when user is undefined', async () => {
      await tagBackportReviewers({ context, targetPrNumber: 1234 });
      expect(octokit.pulls.requestReviewers).toHaveBeenCalled();
      expect(octokit.pulls.requestReviewers).toHaveBeenCalledWith({
        pull_number: 1234,
        team_reviewers: ['wg-releases'],
        reviewers: [],
      });
    });

    it('correctly tags team reviewers and reviewers when user is defined', async () => {
      const user = 'abc';
      await tagBackportReviewers({ context, targetPrNumber: 1234, user });
      expect(octokit.pulls.requestReviewers).toHaveBeenCalled();
      expect(octokit.pulls.requestReviewers).toHaveBeenCalledWith({
        pull_number: 1234,
        team_reviewers: ['wg-releases'],
        reviewers: [user],
      });
    });

    it('logs an error if requestReviewers throws an error', async () => {
      const error = new Error('Request failed');
      context.octokit.pulls.requestReviewers = jest
        .fn()
        .mockRejectedValue(error);

      const logSpy = jest.spyOn(logUtils, 'log');
      await tagBackportReviewers({ context, targetPrNumber: 1234 });

      expect(octokit.pulls.requestReviewers).toHaveBeenCalled();

      expect(logSpy).toHaveBeenCalledWith(
        'tagBackportReviewers',
        LogLevel.ERROR,
        `Failed to request reviewers for PR #1234`,
        error,
      );
    });
  });
});
