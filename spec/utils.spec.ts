import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as logUtils from '../src/utils/log-util';
import { LogLevel } from '../src/enums';
import { tagBackportReviewers, updatePRBranch } from '../src/utils';
import type { WebHookPR } from '../src/types';

const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');
const updateBranchIssueCommentEvent = require('./fixtures/issue_comment_update_branch.created.json');

vi.mock('../src/constants', async () => ({
  ...(await vi.importActual('../src/constants')),
  DEFAULT_BACKPORT_REVIEW_TEAM: 'electron/wg-releases',
}));

describe('utils', () => {
  describe('tagBackportReviewers()', () => {
    const octokit = {
      pulls: {
        requestReviewers: vi.fn(),
      },
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: {
            permission: 'admin',
          },
        }),
      },
    };

    const context = {
      octokit,
      repo: vi.fn((obj) => obj),
      ...backportPROpenedEvent,
    };

    beforeEach(() => vi.clearAllMocks());

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
      context.octokit.pulls.requestReviewers = vi.fn().mockRejectedValue(error);

      const logSpy = vi.spyOn(logUtils, 'log');
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

  describe('updatePRBranch()', () => {
    const pr = {
      number: 1234,
      node_id: 'PR_kwABC',
      head: { sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e' },
      base: { ref: 'main' },
    } as WebHookPR;

    const octokit = {
      graphql: vi.fn(),
      issues: {
        createComment: vi.fn(),
      },
    };

    const context = {
      octokit,
      repo: vi.fn((obj) => obj),
      ...updateBranchIssueCommentEvent,
    };

    beforeEach(() => vi.clearAllMocks());

    it('merges the base branch in via a MERGE updatePullRequestBranch mutation', async () => {
      context.octokit.graphql.mockResolvedValue({});

      await updatePRBranch(context, pr);

      expect(context.octokit.graphql).toHaveBeenCalledTimes(1);

      const [query, variables] = context.octokit.graphql.mock.calls[0];
      expect(query).toContain('updatePullRequestBranch');
      expect(query).toContain('updateMethod: MERGE');
      expect(variables).toEqual({
        pullRequestId: 'PR_kwABC',
        expectedHeadOid: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
      });

      expect(context.octokit.issues.createComment).toHaveBeenCalledWith({
        issue_number: 1234,
        body: 'This branch has been updated with the latest changes from `main`.',
      });
    });

    it('comments about a merge conflict when the mutation reports one', async () => {
      const error = new Error(
        'merge conflict between base and head (updatePullRequestBranch)',
      );
      context.octokit.graphql.mockRejectedValue(error);

      await updatePRBranch(context, pr);

      expect(context.octokit.issues.createComment).toHaveBeenCalledWith({
        issue_number: 1234,
        body: 'This branch could not be updated because there is a merge conflict with `main`. Please resolve the conflict manually.',
      });
    });

    it('comments with a generic failure message on other errors', async () => {
      context.octokit.graphql.mockRejectedValue(new Error('boom'));

      await updatePRBranch(context, pr);

      expect(context.octokit.issues.createComment).toHaveBeenCalledWith({
        issue_number: 1234,
        body: 'I was unable to update this branch with the latest changes from `main`. Please update it manually.',
      });
    });
  });
});
