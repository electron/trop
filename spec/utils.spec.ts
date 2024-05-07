import { LogLevel } from '../src/enums';
import {
  needsSemverMinorBackportLabel,
  tagBackportReviewers,
} from '../src/utils';
import * as utils from '../src/utils';
import * as labelUtils from '../src/utils/label-utils';
import * as logUtils from '../src/utils/log-util';

const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');
const backportPRClosedEvent = require('./fixtures/backport_pull_request.closed.json');

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

  describe('needsSemverMinorBackportLabel()', () => {
    const context = {
      octokit: {},
      repo: {},
      ...backportPROpenedEvent,
    };
    const pr = context.payload.pull_request;

    it('should should return true if PR is semver minor and not already approved', async () => {
      jest.spyOn(labelUtils, 'labelExistsOnPR').mockResolvedValue(false);
      jest.spyOn(utils, 'isSemverMinorPR').mockResolvedValue(true);

      expect(await needsSemverMinorBackportLabel(context, pr)).toBe(true);
    });

    it('should return false if PR is not semver minor', async () => {
      jest.spyOn(utils, 'isSemverMinorPR').mockResolvedValue(false);

      expect(await needsSemverMinorBackportLabel(context, pr)).toBe(false);
    });

    it('should return false if PR is already approved', async () => {
      jest.spyOn(utils, 'isSemverMinorPR').mockResolvedValue(true);

      // Mocking labelExistsOnPR to return true (indicating backport is already approved)
      jest.spyOn(labelUtils, 'labelExistsOnPR').mockResolvedValue(true);

      expect(await needsSemverMinorBackportLabel(context, pr)).toBe(false);
    });

    it('should return false if PR is merged', async () => {
      const closedPr = backportPRClosedEvent.payload.pull_request;

      expect(await needsSemverMinorBackportLabel(context, closedPr)).toBe(
        false,
      );
    });
  });
});
