import { LogLevel } from '../src/enums';
import {
  tagBackportReviewers,
  updateManualBackportReleaseNotes,
} from '../src/utils';
import * as utils from '../src/utils';
import * as logUtils from '../src/utils/log-util';

const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');
const backportPRMergedEvent = require('./fixtures/backport_pull_request.merged.json');
const PROpenedEvent = require('./fixtures/pull_request.opened.json');

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
        getCollaboratorPermissionLevel: jest.fn().mockReturnValue(
          Promise.resolve({
            data: {
              permission: 'admin',
            },
          }),
        ),
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

  describe('updateManualBackportReleaseNotes', () => {
    const octokit = {
      pulls: {
        update: jest.fn(),
        get: jest.fn(),
      },
    };

    const context = {
      octokit,
      repo: jest.fn((obj) => obj),
      ...backportPROpenedEvent,
    };

    const backportPRMissingReleaseNotes =
      backportPROpenedEvent.payload.pull_request;
    const backportPRWithReleaseNotes =
      backportPRMergedEvent.payload.pull_request;
    const originalPRWithReleaseNotes = PROpenedEvent.payload.pull_request;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should not update backport PR if release notes match original PR', async () => {
      await updateManualBackportReleaseNotes(
        context,
        backportPRWithReleaseNotes,
        originalPRWithReleaseNotes,
      );

      expect(context.octokit.pulls.update).not.toHaveBeenCalled();
    });

    it('should update backport PR if release notes do not match original PR', async () => {
      jest.spyOn(utils, 'getOriginalBackportNumber').mockResolvedValue(1234);
      await updateManualBackportReleaseNotes(
        context,
        backportPRMissingReleaseNotes,
        originalPRWithReleaseNotes,
      );

      expect(context.octokit.pulls.update).toHaveBeenCalledWith({
        pull_number: 7,
        body: 'Backport of #1234\n\nSee that PR for details.\n\n\nNotes: new cool stuff added',
      });
    });
  });
});
