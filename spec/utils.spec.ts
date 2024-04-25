import { LogLevel } from '../src/enums';
import {
  tagBackportReviewers,
  isValidManualBackportReleaseNotes,
} from '../src/utils';
import * as utils from '../src/utils';
import * as logUtils from '../src/utils/log-util';

const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');
const backportPRMergedEvent = require('./fixtures/backport_pull_request.merged.json');
const PROpenedEvent = require('./fixtures/pull_request.opened.json');
const PRClosedEvent = require('./fixtures/pull_request.closed.json');

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

  describe('isValidManualBackportReleaseNotes', () => {
    const backportPRMissingReleaseNotes = backportPROpenedEvent;
    const backportPRWithReleaseNotes = backportPRMergedEvent;
    const originalPRWithReleaseNotes = PROpenedEvent.payload.pull_request;
    const originalPRMissingReleaseNotes = PRClosedEvent.payload.pull_request;
    const originalPRWithReleaseNotes2 =
      backportPRMergedEvent.payload.pull_request;

    it('should return valid if release notes match original PR for single PR', async () => {
      const context = { ...backportPRWithReleaseNotes };
      expect(
        await isValidManualBackportReleaseNotes(context, [
          originalPRWithReleaseNotes,
        ]),
      ).toBe(true);
    });

    it('should return valid if release notes match original PR for multiple PR', async () => {
      const context = { ...backportPRWithReleaseNotes };
      expect(
        await isValidManualBackportReleaseNotes(context, [
          originalPRWithReleaseNotes,
          originalPRMissingReleaseNotes,
        ]),
      ).toBe(true);
    });

    it('should return not valid if release notes do not match original PR for single PR', async () => {
      const context = { ...backportPRMissingReleaseNotes };
      expect(
        await isValidManualBackportReleaseNotes(context, [
          originalPRWithReleaseNotes,
        ]),
      ).toBe(false);
    });

    it('should return not valid if release notes do not match original PR for multiple PR', async () => {
      const context = { ...backportPRMissingReleaseNotes };
      expect(
        await isValidManualBackportReleaseNotes(context, [
          originalPRWithReleaseNotes,
          originalPRWithReleaseNotes2,
        ]),
      ).toBe(false);
    });
  });
});
