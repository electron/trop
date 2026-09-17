import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as logUtils from '../src/utils/log-util';
import { LogLevel } from '../src/enums';
import {
  createBackportComment,
  shouldRequestBackportApproval,
  tagBackportReviewers,
  updatePRBranch,
} from '../src/utils';
import { SEMVER_LABELS } from '../src/constants';
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

  describe('createBackportComment()', () => {
    const context = {
      octokit: { pulls: { get: vi.fn() } },
      repo: vi.fn((obj) => obj),
    } as any;

    const buildPR = (number: number, body: string | null) =>
      ({
        number,
        body,
        base: { repo: { owner: { login: 'electron' }, name: 'electron' } },
      }) as WebHookPR;

    it('references a single PR with its one-line notes', async () => {
      const body = await createBackportComment(context, [
        buildPR(10, 'Fixes the thing.\n\nNotes: Fixed the thing.'),
      ]);
      expect(body).toBe(
        'Backport of #10\n\nSee that PR for details.\n\n\nNotes: Fixed the thing.',
      );
    });

    it('references a single PR with its multi-line notes', async () => {
      const body = await createBackportComment(context, [
        buildPR(10, 'Fixes the thing.\n\nNotes:\n* Fixed A.\n* Fixed B.\n'),
      ]);
      expect(body).toBe(
        'Backport of #10\n\nSee that PR for details.\n\n\nNotes:\n* Fixed A.\n* Fixed B.\n',
      );
    });

    it('falls back to no-notes for a single PR without notes', async () => {
      const body = await createBackportComment(context, [
        buildPR(10, 'Fixes the thing.'),
      ]);
      expect(body).toBe(
        'Backport of #10\n\nSee that PR for details.\n\nNotes: no-notes',
      );
      expect(await createBackportComment(context, [buildPR(10, null)])).toBe(
        'Backport of #10\n\nSee that PR for details.\n\nNotes: no-notes',
      );
    });

    it('lists every PR of a stack bottom to top and combines their notes', async () => {
      const body = await createBackportComment(context, [
        buildPR(10, 'Plumbing.\n\nNotes: none'),
        buildPR(20, 'Perf.\n\nNotes: Made menus faster.'),
        buildPR(30, 'More perf.\n\nNotes:\n* Fixed A.\n* Fixed B.\n'),
      ]);
      expect(body).toBe(
        'Backport of #10\nBackport of #20\nBackport of #30\n\n' +
          'See those PRs for details.\n\n' +
          'Notes:\n* Made menus faster.\n* Fixed A.\n* Fixed B.\n',
      );
    });

    it('keeps the single set of notes found across a stack as-is', async () => {
      const body = await createBackportComment(context, [
        buildPR(10, 'Plumbing.\n\nNotes: none'),
        buildPR(20, 'Perf.\n\nNotes: Made menus faster.'),
        buildPR(30, 'No notes here.'),
      ]);
      expect(body).toBe(
        'Backport of #10\nBackport of #20\nBackport of #30\n\n' +
          'See those PRs for details.\n\n\nNotes: Made menus faster.',
      );
    });

    it('falls back to no-notes when no PR of a stack has notes', async () => {
      const body = await createBackportComment(context, [
        buildPR(10, 'Plumbing.\n\nNotes: none'),
        buildPR(20, 'Perf.\n\nNotes: no-notes'),
      ]);
      expect(body).toBe(
        'Backport of #10\nBackport of #20\n\nSee those PRs for details.\n\nNotes: no-notes',
      );
    });
  });

  describe('shouldRequestBackportApproval()', () => {
    const octokit = {
      issues: {
        listLabelsOnIssue: vi.fn(),
      },
    };

    const context = {
      octokit,
      repo: vi.fn((obj) => obj),
    } as any;

    const buildPR = (title: string) =>
      ({
        number: 1234,
        title,
      }) as WebHookPR;

    const mockLabels = (...labels: string[]) => {
      octokit.issues.listLabelsOnIssue.mockResolvedValue({
        data: labels.map((name) => ({ name })),
      });
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mockLabels();
    });

    it('returns true when the PR has the semver/major label', async () => {
      mockLabels(SEMVER_LABELS.MAJOR);
      await expect(
        shouldRequestBackportApproval(
          context,
          buildPR('refactor: major change'),
        ),
      ).resolves.toBe(true);
    });

    it('returns true when the PR has the semver/minor label', async () => {
      mockLabels(SEMVER_LABELS.MINOR);
      await expect(
        shouldRequestBackportApproval(
          context,
          buildPR('refactor: minor change'),
        ),
      ).resolves.toBe(true);
    });

    it('returns true when the PR title starts with feat:', async () => {
      await expect(
        shouldRequestBackportApproval(context, buildPR('feat: a new feature')),
      ).resolves.toBe(true);
    });

    it('returns true when the PR title starts with feat!:', async () => {
      await expect(
        shouldRequestBackportApproval(
          context,
          buildPR('feat!: a breaking new feature'),
        ),
      ).resolves.toBe(true);
    });

    it('returns false for a chore: PR with no semver label', async () => {
      mockLabels(SEMVER_LABELS.PATCH);
      await expect(
        shouldRequestBackportApproval(context, buildPR('chore: a small chore')),
      ).resolves.toBe(false);
    });
  });
});
