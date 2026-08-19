import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKPORT_APPROVAL_CHECK } from '../src/constants';
import { queueBackportApprovalCheck } from '../src/utils/checks-util';

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

    it('resets the existing check run to queued instead of creating a duplicate', async () => {
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

      expect(octokit.checks.create).not.toHaveBeenCalled();
      expect(octokit.checks.update).toHaveBeenCalledTimes(1);
      expect(octokit.checks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: 12345,
          status: 'queued',
        }),
      );
    });
  });
});
