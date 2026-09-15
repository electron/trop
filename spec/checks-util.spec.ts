import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKPORT_APPROVAL_CHECK, CHECK_PREFIX } from '../src/constants';
import {
  CHECK_RUN_OUTPUT_TEXT_LIMIT,
  buildFailedDiffText,
  getOrCreateCheckRun,
  markBackportCheckFailed,
  queueBackportApprovalCheck,
} from '../src/utils/checks-util';

const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');

describe('checks-util', () => {
  describe('queueBackportApprovalCheck', () => {
    const octokit = {
      checks: {
        listForRef: vi.fn(),
        create: vi.fn().mockResolvedValue({ data: {} }),
        update: vi.fn().mockResolvedValue({ data: {} }),
      },
    };

    const context = {
      ...backportPROpenedEvent,
      octokit,
      repo: vi.fn((obj) => obj),
    };

    beforeEach(() => vi.clearAllMocks());

    it('creates a new queued check run when none exists', async () => {
      octokit.checks.listForRef.mockResolvedValue({
        data: { check_runs: [] },
      });

      await queueBackportApprovalCheck(context);

      expect(octokit.checks.create).toHaveBeenCalledTimes(1);
      expect(octokit.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: BACKPORT_APPROVAL_CHECK,
          status: 'queued',
        }),
      );
      expect(octokit.checks.update).not.toHaveBeenCalled();
    });

    it.each(['queued', 'in_progress'])(
      'resets an existing %s check run to queued instead of creating a duplicate',
      async (status) => {
        octokit.checks.listForRef.mockResolvedValue({
          data: {
            check_runs: [
              {
                id: 12345,
                name: BACKPORT_APPROVAL_CHECK,
                status,
                conclusion: null,
              },
            ],
          },
        });

        await queueBackportApprovalCheck(context);

        expect(octokit.checks.create).not.toHaveBeenCalled();
        expect(octokit.checks.update).toHaveBeenCalledTimes(1);
        expect(octokit.checks.update).toHaveBeenCalledWith(
          expect.objectContaining({
            check_run_id: 12345,
            status: 'queued',
          }),
        );
      },
    );

    it('supersedes a completed check run with a fresh queued run instead of updating it', async () => {
      // Regression test for electron/electron#53035: the Checks API treats
      // a completed run as terminal, so a PATCH back to 'queued' silently
      // keeps status=completed/conclusion=success and only rewrites the
      // output - leaving a green check that reads "Needs Backport
      // Approval". A fresh queued run must be created instead, which
      // supersedes the completed one for branch protection.
      octokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [
            {
              id: 12345,
              name: BACKPORT_APPROVAL_CHECK,
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      });

      await queueBackportApprovalCheck(context);

      expect(octokit.checks.update).not.toHaveBeenCalled();
      expect(octokit.checks.create).toHaveBeenCalledTimes(1);
      expect(octokit.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: BACKPORT_APPROVAL_CHECK,
          status: 'queued',
        }),
      );
    });

    it('leaves a completed check run alone when superseding is not permitted', async () => {
      // Regression test for electron/electron#53332: a caller that only
      // wants a pending run to exist must not turn a verdict that a
      // concurrent delivery already settled back into a queued run that no
      // follow-up event would complete.
      octokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [
            {
              id: 12345,
              name: BACKPORT_APPROVAL_CHECK,
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      });

      await queueBackportApprovalCheck(context, { supersedeCompleted: false });

      expect(octokit.checks.update).not.toHaveBeenCalled();
      expect(octokit.checks.create).not.toHaveBeenCalled();
    });

    it('still creates a queued check run when none exists and superseding is not permitted', async () => {
      octokit.checks.listForRef.mockResolvedValue({
        data: { check_runs: [] },
      });

      await queueBackportApprovalCheck(context, { supersedeCompleted: false });

      expect(octokit.checks.create).toHaveBeenCalledTimes(1);
      expect(octokit.checks.update).not.toHaveBeenCalled();
    });

    it('still resets a pending check run when superseding is not permitted', async () => {
      octokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [
            {
              id: 12345,
              name: BACKPORT_APPROVAL_CHECK,
              status: 'queued',
              conclusion: null,
            },
          ],
        },
      });

      await queueBackportApprovalCheck(context, { supersedeCompleted: false });

      expect(octokit.checks.create).not.toHaveBeenCalled();
      expect(octokit.checks.update).toHaveBeenCalledTimes(1);
      expect(octokit.checks.update).toHaveBeenCalledWith(
        expect.objectContaining({ check_run_id: 12345, status: 'queued' }),
      );
    });
  });

  describe('getOrCreateCheckRun', () => {
    const octokit = {
      checks: {
        listForRef: vi.fn(),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ data: {} }),
      },
    };

    const context = {
      ...backportPROpenedEvent,
      octokit,
      repo: vi.fn((obj) => obj),
    };
    const pr = backportPROpenedEvent.payload.pull_request;
    const checkName = `${CHECK_PREFIX}30-x-y`;

    beforeEach(() => {
      vi.clearAllMocks();
      octokit.checks.create.mockResolvedValue({
        data: { id: 999, name: checkName, status: 'queued' },
      });
    });

    it('creates a new queued check run when none exists', async () => {
      octokit.checks.listForRef.mockResolvedValue({
        data: { check_runs: [] },
      });

      const checkRun = await getOrCreateCheckRun(context, pr, '30-x-y');

      expect(octokit.checks.create).toHaveBeenCalledTimes(1);
      expect(octokit.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: checkName,
          head_sha: pr.head.sha,
          status: 'queued',
        }),
      );
      expect(checkRun).toEqual({ id: 999, name: checkName, status: 'queued' });
    });

    it.each(['queued', 'in_progress'])(
      'reuses an existing %s check run',
      async (status) => {
        const existing = {
          id: 12345,
          name: checkName,
          status,
          conclusion: null,
        };
        octokit.checks.listForRef.mockResolvedValue({
          data: {
            check_runs: [
              { id: 1, name: `${CHECK_PREFIX}29-x-y`, status: 'in_progress' },
              existing,
            ],
          },
        });

        const checkRun = await getOrCreateCheckRun(context, pr, '30-x-y');

        expect(octokit.checks.create).not.toHaveBeenCalled();
        expect(checkRun).toBe(existing);
      },
    );

    it('creates a fresh check run instead of reusing a completed one', async () => {
      // Regression test for electron/electron#53925: after a target label is
      // removed the check run is concluded as 'Cancelled', and the Checks API
      // silently ignores a PATCH back to 'in_progress' on a completed run.
      // Re-adding the label must therefore create a fresh run rather than
      // leave the stale 'Cancelled' run in place.
      octokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [
            {
              id: 12345,
              name: checkName,
              status: 'completed',
              conclusion: 'neutral',
            },
          ],
        },
      });

      const checkRun = await getOrCreateCheckRun(context, pr, '30-x-y');

      expect(octokit.checks.update).not.toHaveBeenCalled();
      expect(octokit.checks.create).toHaveBeenCalledTimes(1);
      expect(octokit.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: checkName,
          head_sha: pr.head.sha,
          status: 'queued',
        }),
      );
      expect(checkRun.id).toBe(999);
    });

    it('prefers a pending check run over a completed one with the same name', async () => {
      const pending = {
        id: 67890,
        name: checkName,
        status: 'in_progress',
        conclusion: null,
      };
      octokit.checks.listForRef.mockResolvedValue({
        data: {
          check_runs: [
            {
              id: 12345,
              name: checkName,
              status: 'completed',
              conclusion: 'neutral',
            },
            pending,
          ],
        },
      });

      const checkRun = await getOrCreateCheckRun(context, pr, '30-x-y');

      expect(octokit.checks.create).not.toHaveBeenCalled();
      expect(checkRun).toBe(pending);
    });
  });

  describe('buildFailedDiffText', () => {
    const fence = '``````````````````````````````';

    it('returns a short diff untouched', () => {
      const rawDiff = 'diff --git a/foo b/foo\n-a\n+b\n';

      expect(buildFailedDiffText(rawDiff)).toBe(
        `Failed Diff:\n\n${fence}diff\n${rawDiff}\n${fence}`,
      );
    });

    it('truncates an oversized diff to fit the check run output limit', () => {
      // electron/electron#53925: a 120,926 character conflict diff made
      // checks.update fail with "Only 65535 characters are allowed".
      const line = `+${'x'.repeat(78)}\n`;
      const rawDiff = line.repeat(Math.ceil(120926 / line.length));
      expect(rawDiff.length).toBeGreaterThan(CHECK_RUN_OUTPUT_TEXT_LIMIT);

      const text = buildFailedDiffText(rawDiff);

      expect(text.length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_LIMIT);
      expect(text.startsWith(`Failed Diff:\n\n${fence}diff\n`)).toBe(true);
      expect(text.endsWith(`\n${fence}`)).toBe(true);

      const match = text.match(
        /\n\.\.\. \((\d+) characters omitted, diff truncated to fit GitHub's 65535 character check run output limit\)\n/,
      );
      expect(match).not.toBeNull();
      const omitted = Number(match![1]);
      const kept =
        text.indexOf(match![0]) - `Failed Diff:\n\n${fence}diff\n`.length;
      expect(kept + omitted).toBe(rawDiff.length);
      expect(text).toContain(rawDiff.slice(0, kept));
      // Truncated at a line boundary.
      expect(rawDiff[kept]).toBe('\n');
    });
  });

  describe('markBackportCheckFailed', () => {
    const octokit = {
      checks: {
        update: vi.fn(),
      },
    };

    const context = {
      ...backportPROpenedEvent,
      octokit,
      repo: vi.fn((obj) => obj),
    };
    const checkRun = { id: 12345, name: `${CHECK_PREFIX}30-x-y` };
    const annotations = [{ path: 'foo', start_line: 1, end_line: 1 }];

    beforeEach(() => vi.clearAllMocks());

    it('concludes the check run with the diff and annotations', async () => {
      octokit.checks.update.mockResolvedValue({ data: {} });

      await markBackportCheckFailed(context, checkRun, '30-x-y', {
        rawDiff: '-a\n+b\n',
        annotations,
      });

      expect(octokit.checks.update).toHaveBeenCalledTimes(1);
      expect(octokit.checks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 12345,
          name: checkRun.name,
          conclusion: 'neutral',
          output: expect.objectContaining({
            title: 'Backport Failed',
            summary: expect.stringContaining('"30-x-y"'),
            text: buildFailedDiffText('-a\n+b\n'),
            annotations,
          }),
        }),
      );
    });

    it('retries without the diff and annotations when GitHub rejects the update', async () => {
      const error = Object.assign(
        new Error(
          'Invalid request.\n\nOnly 65535 characters are allowed; 120926 were supplied.',
        ),
        { status: 422 },
      );
      octokit.checks.update
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ data: {} });

      await markBackportCheckFailed(context, checkRun, '30-x-y', {
        rawDiff: '-a\n+b\n',
        annotations,
      });

      expect(octokit.checks.update).toHaveBeenCalledTimes(2);
      const retryOpts = octokit.checks.update.mock.calls[1][0];
      expect(retryOpts).toEqual(
        expect.objectContaining({
          check_run_id: 12345,
          conclusion: 'neutral',
        }),
      );
      expect(retryOpts.output.title).toBe('Backport Failed');
      expect(retryOpts.output.text).toBeUndefined();
      expect(retryOpts.output.annotations).toBeUndefined();
    });

    it('rethrows when the retry also fails', async () => {
      octokit.checks.update.mockRejectedValue(new Error('boom'));

      await expect(
        markBackportCheckFailed(context, checkRun, '30-x-y', {
          rawDiff: '-a\n+b\n',
        }),
      ).rejects.toThrow('boom');

      expect(octokit.checks.update).toHaveBeenCalledTimes(2);
    });
  });
});
