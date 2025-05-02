import { promises as fs } from 'fs';
import { posix as path } from 'path';
import { execSync } from 'child_process';

import nock from 'nock';
import { Probot, ProbotOctokit } from 'probot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKPORT_APPROVED_LABEL,
  BACKPORT_REQUESTED_LABEL,
  SKIP_CHECK_LABEL,
} from '../src/constants';
import { CheckRunStatus, PRChange } from '../src/enums';
import { default as trop } from '../src/index';
import {
  backportToBranch,
  backportToLabel,
} from '../src/operations/backport-to-location';
import { updateManualBackport } from '../src/operations/update-manual-backport';

import { labelClosedPR, getPRNumbersFromPRBody } from '../src/utils';
import * as checkUtils from '../src/utils/checks-util';

// event fixtures
const prClosedEvent = require('./fixtures/pull_request.closed.json');
const issueCommentBackportCreatedEvent = require('./fixtures/issue_comment_backport.created.json');
const issueCommentBackportToCreatedEvent = require('./fixtures/issue_comment_backport_to.created.json');
const issueCommentBackportToMultipleCreatedEvent = require('./fixtures/issue_comment_backport_to_multiple.created.json');
const issueCommentBackportToMultipleCreatedSpacesEvent = require('./fixtures/issue_comment_backport_to_multiple_spaces.created.json');

const backportPRMergedBotEvent = require('./fixtures/backport_pull_request.merged.bot.json');
const backportPRClosedBotEvent = require('./fixtures/backport_pull_request.closed.bot.json');
const backportPRMergedEvent = require('./fixtures/backport_pull_request.merged.json');
const backportPRClosedEvent = require('./fixtures/backport_pull_request.closed.json');
const backportPROpenedEvent = require('./fixtures/backport_pull_request.opened.json');

const newPROpenedEventPath = path.join(
  __dirname,
  'fixtures',
  'pull_request.opened.json',
);

const newPRBackportOpenedEventPath = path.join(
  __dirname,
  'fixtures',
  'backport_pull_request.opened.json',
);

const backportPRLabeledEventPath = path.join(
  __dirname,
  'fixtures',
  'backport_pull_request.labeled.json',
);

const backportPRUnlabeledEventPath = path.join(
  __dirname,
  'fixtures',
  'backport_pull_request.unlabeled.json',
);

const noBackportLabel = {
  name: 'no-backport',
  color: '000',
};

const targetLabel = {
  name: 'target/12-x-y',
  color: 'fff',
};

const backportApprovedLabel = {
  name: BACKPORT_APPROVED_LABEL,
  color: 'fff',
};

const backportRequestedLabel = {
  name: BACKPORT_REQUESTED_LABEL,
  color: 'fff',
};

vi.mock('../src/utils', () => ({
  labelClosedPR: vi.fn(),
  isAuthorizedUser: vi.fn().mockResolvedValue([true]),
  getPRNumbersFromPRBody: vi.fn().mockReturnValue([12345]),
}));

vi.mock('../src/utils/env-util', () => ({
  getEnvVar: vi.fn(),
}));

vi.mock('../src/operations/update-manual-backport', () => ({
  updateManualBackport: vi.fn(),
}));

vi.mock('../src/operations/backport-to-location', () => ({
  backportToBranch: vi.fn(),
  backportToLabel: vi.fn(),
}));

vi.mock('../src/utils/checks-util', () => ({
  updateBackportValidityCheck: vi.fn(),
  getBackportInformationCheck: vi.fn().mockResolvedValue({ status: 'thing' }),
  updateBackportInformationCheck: vi.fn().mockResolvedValue(undefined),
  queueBackportInformationCheck: vi.fn().mockResolvedValue(undefined),
  getBackportApprovalCheck: vi.fn().mockResolvedValue(undefined),
  updateBackportApprovalCheck: vi.fn().mockResolvedValue(undefined),
  queueBackportApprovalCheck: vi.fn().mockResolvedValue(undefined),
}));

describe('trop', () => {
  let robot: Probot;
  let octokit: any;
  process.env = { ...process.env, BOT_USER_NAME: 'trop[bot]' };

  beforeEach(() => {
    nock.disableNetConnect();
    octokit = {
      repos: {
        getBranch: vi.fn().mockResolvedValue(undefined),
        listBranches: vi.fn().mockResolvedValue({
          data: [{ name: '8-x-y' }, { name: '7-1-x' }],
        }),
      },
      git: {
        deleteRef: vi.fn().mockResolvedValue(undefined),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            merged: true,
            head: {
              sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
            },
            base: {
              ref: 'main',
              repo: {
                default_branch: 'main',
              },
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
      },
      issues: {
        addLabels: vi.fn().mockResolvedValue({}),
        removeLabel: vi.fn().mockResolvedValue({}),
        createLabel: vi.fn().mockResolvedValue({}),
        createComment: vi.fn().mockResolvedValue({}),
        listLabelsOnIssue: vi.fn().mockResolvedValue({
          data: [
            {
              id: 208045946,
              url: 'https://api.github.com/repos/octocat/Hello-World/labels/bug',
              name: 'bug',
              description: "Something isn't working",
              color: 'f29513',
            },
          ],
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
        create: vi.fn().mockResolvedValue({ data: vi.fn() }),
      },
    };

    robot = new Probot({
      githubToken: 'test',
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    robot['state'].octokit.auth = () => Promise.resolve(octokit);
    robot.auth = () => Promise.resolve(octokit);
    robot.load(trop);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe('issue_comment.created event', () => {
    it('manually triggers the backport on comment', async () => {
      await robot.receive(issueCommentBackportCreatedEvent);

      expect(octokit.pulls.get).toHaveBeenCalled();
      expect(octokit.issues.createComment).toHaveBeenCalled();
      expect(backportToLabel).toHaveBeenCalled();
    });

    it('does not trigger the backport on comment if the PR is not merged', async () => {
      octokit.pulls.get = vi
        .fn()
        .mockResolvedValue({ data: { merged: false } });

      await robot.receive(issueCommentBackportCreatedEvent);

      expect(octokit.pulls.get).toHaveBeenCalled();
      expect(octokit.issues.createComment).toHaveBeenCalled();
      expect(backportToLabel).not.toHaveBeenCalled();
    });

    it('triggers the backport on comment to a targeted branch', async () => {
      await robot.receive(issueCommentBackportToCreatedEvent);

      expect(octokit.pulls.get).toHaveBeenCalled();
      expect(octokit.issues.createComment).toHaveBeenCalled();
      expect(backportToBranch).toHaveBeenCalled();
    });

    it('allows for multiple PRs to be triggered in the same comment', async () => {
      await robot.receive(issueCommentBackportToMultipleCreatedEvent);

      expect(octokit.pulls.get).toHaveBeenCalledTimes(3);
      expect(octokit.issues.createComment).toHaveBeenCalledTimes(2);
      expect(backportToBranch).toHaveBeenCalledTimes(2);
    });

    it('allows for multiple PRs to be triggered in the same comment with space-separated branches', async () => {
      await robot.receive(issueCommentBackportToMultipleCreatedSpacesEvent);

      expect(octokit.pulls.get).toHaveBeenCalledTimes(4);
      expect(octokit.issues.createComment).toHaveBeenCalledTimes(3);
      expect(backportToBranch).toHaveBeenCalledTimes(3);
    });

    it('does not trigger the backport on comment to a targeted branch if the branch does not exist', async () => {
      octokit.repos.getBranch = vi
        .fn()
        .mockReturnValue(Promise.reject(new Error('404')));
      await robot.receive(issueCommentBackportToCreatedEvent);

      expect(octokit.pulls.get).toHaveBeenCalled();
      expect(octokit.issues.createComment).toHaveBeenCalled();
      expect(backportToBranch).toHaveBeenCalledTimes(0);
    });
  });

  describe('pull_request.opened event', () => {
    it('labels the original PR when a manual backport PR has been opened', async () => {
      await robot.receive(backportPROpenedEvent);

      expect(updateManualBackport).toHaveBeenCalled();
    });

    it('queues the check if there is no backport information for a new PR', async () => {
      const event = JSON.parse(
        await fs.readFile(newPROpenedEventPath, 'utf-8'),
      );

      event.payload.pull_request.labels = [];

      await robot.receive(event);

      expect(checkUtils.queueBackportInformationCheck).toHaveBeenCalledTimes(1);
    });

    it('fails the check if there is conflicting backport information in a new PR', async () => {
      vi.mocked(getPRNumbersFromPRBody).mockReturnValueOnce([]);

      const event = JSON.parse(
        await fs.readFile(newPROpenedEventPath, 'utf-8'),
      );

      event.payload.pull_request.labels = [noBackportLabel, targetLabel];

      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportInformationCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Conflicting Backport Information',
        summary:
          'The PR has a "no-backport" and at least one "target/<branch>" label. Impossible to determine backport action.',
        conclusion: CheckRunStatus.FAILURE,
      });
    });

    it('passes the check if there is a "no-backport" label and no "target/" label in a new PR', async () => {
      vi.mocked(getPRNumbersFromPRBody).mockReturnValueOnce([]);

      const event = JSON.parse(
        await fs.readFile(newPROpenedEventPath, 'utf-8'),
      );

      event.payload.pull_request.labels = [noBackportLabel];

      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportInformationCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Backport Information Provided',
        summary: 'This PR contains the required  backport information.',
        conclusion: CheckRunStatus.SUCCESS,
      });
    });

    it('passes the check if there is no "no-backport" label and a "target/" label in a new PR', async () => {
      vi.mocked(getPRNumbersFromPRBody).mockReturnValueOnce([]);

      const event = JSON.parse(
        await fs.readFile(newPROpenedEventPath, 'utf-8'),
      );

      event.payload.pull_request.labels = [targetLabel];

      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportInformationCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Backport Information Provided',
        summary: 'This PR contains the required  backport information.',
        conclusion: CheckRunStatus.SUCCESS,
      });
    });

    it('passes the backport approval check if there is no "backport/requested" label in a new PR', async () => {
      const event = JSON.parse(
        await fs.readFile(newPROpenedEventPath, 'utf-8'),
      );

      event.payload.pull_request.labels = [];

      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportApprovalCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Backport Approval Not Required',
        summary: 'This PR does not need backport approval.',
        conclusion: CheckRunStatus.SUCCESS,
      });
    });

    it('queues the backport approval check if there is the "backport/requested" label in a new PR', async () => {
      const event = JSON.parse(
        await fs.readFile(newPROpenedEventPath, 'utf-8'),
      );

      event.payload.pull_request.labels = [backportRequestedLabel];

      await robot.receive(event);

      expect(checkUtils.queueBackportApprovalCheck).toHaveBeenCalledTimes(1);
    });

    it('passes the backport approval check if there is the "backport/approved" label in a new PR', async () => {
      const event = JSON.parse(
        await fs.readFile(newPROpenedEventPath, 'utf-8'),
      );

      event.payload.pull_request.labels = [backportApprovedLabel];

      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportApprovalCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Backport Approved',
        summary: 'This PR has been approved for backporting.',
        conclusion: CheckRunStatus.SUCCESS,
      });
    });
  });

  describe('pull_request.labeled event', () => {
    it('queues the backport approval check if the "backport/requested" label is added', async () => {
      const event = JSON.parse(
        await fs.readFile(backportPRLabeledEventPath, 'utf-8'),
      );

      event.payload.label = backportApprovedLabel;
      event.payload.pull_request.labels = [backportRequestedLabel];

      await robot.receive(event);

      expect(checkUtils.queueBackportApprovalCheck).toHaveBeenCalledTimes(1);
    });

    it('passes the backport approval check if the "backport/approved" label is added', async () => {
      const event = JSON.parse(
        await fs.readFile(backportPRLabeledEventPath, 'utf-8'),
      );

      event.payload.label = backportApprovedLabel;
      event.payload.pull_request.labels = [backportApprovedLabel];

      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportApprovalCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Backport Approved',
        summary: 'This PR has been approved for backporting.',
        conclusion: CheckRunStatus.SUCCESS,
      });
    });
  });

  describe('pull_request.unlabeled event', () => {
    it('passes the backport approval check if all "backport/*" labels are removed', async () => {
      const event = JSON.parse(
        await fs.readFile(backportPRUnlabeledEventPath, 'utf-8'),
      );

      event.payload.label = backportRequestedLabel;
      event.payload.pull_request.labels = [];

      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportApprovalCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Backport Approval Not Required',
        summary: 'This PR does not need backport approval.',
        conclusion: CheckRunStatus.SUCCESS,
      });
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
        number: 15,
        body: `Backport of #14
See that PR for details.
Notes: <!-- One-line Change Summary Here-->`,
        created_at: '2018-11-01T17:29:51Z',
        head: {
          ref: '123456789iuytdxcvbnjhfdriuyfedfgy54escghjnbg',
        },
        base: {
          ref: '36-x-y',
          repo: {
            default_branch: 'main',
          },
        },
        labels: [
          {
            color: 'ededed',
            name: '5-0-x',
          },
          {
            name: 'backport',
            color: 'ededed',
          },
        ],
        merged: false,
        merged_at: '2018-11-01T17:30:11Z',
        state: 'closed',
        title: 'mirror',
        user: {
          login: 'trop[bot]',
        },
      };

      expect(vi.mocked(labelClosedPR)).toHaveBeenCalledWith(
        expect.anything(),
        pr,
        '5-0-x',
        PRChange.CLOSE,
      );
    });

    it('updates labels on the original PR when a bot backport PR has been merged', async () => {
      await robot.receive(backportPRMergedBotEvent);

      const pr = {
        number: 15,
        body: `Backport of #14
See that PR for details.
Notes: <!-- One-line Change Summary Here-->`,
        created_at: '2018-11-01T17:29:51Z',
        head: {
          ref: '123456789iuytdxcvbnjhfdriuyfedfgy54escghjnbg',
        },
        base: {
          ref: '36-x-y',
          repo: {
            default_branch: 'main',
          },
        },
        labels: [
          {
            color: 'ededed',
            name: '4-0-x',
          },
          {
            name: 'backport',
            color: 'ededed',
          },
        ],
        merged: true,
        merged_at: '2018-11-01T17:30:11Z',
        state: 'closed',
        title: 'mirror',
        user: {
          login: 'trop[bot]',
        },
      };

      expect(vi.mocked(labelClosedPR)).toHaveBeenCalledWith(
        expect.anything(),
        pr,
        '4-0-x',
        PRChange.MERGE,
      );
    });

    it('updates labels on the original PR when a manual backport PR has been closed with unmerged commits', async () => {
      await robot.receive(backportPRClosedEvent);

      const pr = {
        number: 15,
        body: `Backport of #14
See that PR for details.
Notes: <!-- One-line Change Summary Here-->`,
        created_at: '2018-11-01T17:29:51Z',
        head: {
          ref: '123456789iuytdxcvbnjhfdriuyfedfgy54escghjnbg',
        },
        base: {
          ref: '36-x-y',
          repo: {
            default_branch: 'main',
          },
        },
        labels: [
          {
            color: 'ededed',
            name: '4-0-x',
          },
          {
            name: 'backport',
            color: 'ededed',
          },
        ],
        merged: false,
        merged_at: '2018-11-01T17:30:11Z',
        state: 'closed',
        title: 'mirror',
        user: {
          login: 'codebytere',
        },
      };

      expect(updateManualBackport).toHaveBeenCalled();

      expect(vi.mocked(labelClosedPR)).toHaveBeenCalledWith(
        expect.anything(),
        pr,
        '4-0-x',
        PRChange.CLOSE,
      );
    });

    it('updates labels on the original PR when a manual backport PR has been merged', async () => {
      await robot.receive(backportPRMergedEvent);

      const pr = {
        number: 15,
        body: `Backport of #14
See that PR for details.
Notes: <!-- One-line Change Summary Here-->`,
        created_at: '2018-11-01T17:29:51Z',
        head: {
          ref: '123456789iuytdxcvbnjhfdriuyfedfgy54escghjnbg',
        },
        base: {
          ref: '36-x-y',
          repo: {
            default_branch: 'main',
          },
        },
        labels: [
          {
            color: 'ededed',
            name: '4-0-x',
          },
          {
            name: 'backport',
            color: 'ededed',
          },
        ],
        merged: true,
        merged_at: '2018-11-01T17:30:11Z',
        state: 'closed',
        title: 'mirror',
        user: {
          login: 'codebytere',
        },
      };

      expect(updateManualBackport).toHaveBeenCalled();

      expect(vi.mocked(labelClosedPR)).toHaveBeenCalledWith(
        expect.anything(),
        pr,
        '4-0-x',
        PRChange.MERGE,
      );
    });
  });

  describe('updateBackportValidityCheck from pull_request events', () => {
    it('skips the backport validity check if there is skip check label in a new PR', async () => {
      vi.mocked(getPRNumbersFromPRBody).mockReturnValueOnce([]);
      octokit.issues.listLabelsOnIssue.mockResolvedValue({
        data: [
          {
            name: SKIP_CHECK_LABEL,
          },
        ],
      });
      const event = JSON.parse(
        await fs.readFile(newPRBackportOpenedEventPath, 'utf-8'),
      );
      event.payload.action = 'synchronize';
      event.payload.pull_request.base.ref = '30-x-y';
      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportValidityCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Backport Check Skipped',
        summary: 'This PR is not a backport - skip backport validation check',
        conclusion: CheckRunStatus.NEUTRAL,
      });
    });

    it('cancels the backport validity check if branch is targeting main', async () => {
      vi.mocked(getPRNumbersFromPRBody).mockReturnValueOnce([]);

      const event = JSON.parse(
        await fs.readFile(newPROpenedEventPath, 'utf-8'),
      );

      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportValidityCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Cancelled',
        summary: "This PR is targeting 'main' and is not a backport",
        conclusion: CheckRunStatus.NEUTRAL,
      });
    });

    it('fails the backport validity check if old PR was not merged to a supported release branch', async () => {
      vi.mocked(getPRNumbersFromPRBody).mockReturnValueOnce([1234]);
      octokit.pulls.get.mockResolvedValueOnce({
        data: {
          merged: true,
          base: {
            ref: 'not-supported-branch',
          },
        },
      });
      const event = JSON.parse(
        await fs.readFile(newPRBackportOpenedEventPath, 'utf-8'),
      );
      event.payload.pull_request.base.ref = '30-x-y';
      event.payload.action = 'synchronize';
      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportValidityCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Invalid Backport',
        summary:
          'This PR is targeting a branch that is not main but the PR that it is backporting was not targeting the default branch.',
        conclusion: CheckRunStatus.FAILURE,
      });
    });

    it('fails the backport validity check if old PR has not been merged yet', async () => {
      vi.mocked(getPRNumbersFromPRBody).mockReturnValueOnce([1234]);
      octokit.pulls.get.mockResolvedValueOnce({
        data: {
          merged: false,
          base: {
            ref: 'main',
          },
        },
      });
      const event = JSON.parse(
        await fs.readFile(newPRBackportOpenedEventPath, 'utf-8'),
      );
      event.payload.pull_request.base.ref = '30-x-y';
      event.payload.action = 'synchronize';
      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportValidityCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Invalid Backport',
        summary:
          'This PR is targeting a branch that is not main but the PR that this is backporting has not been merged yet.',
        conclusion: CheckRunStatus.FAILURE,
      });
    });

    it('succeeds the backport validity check if all checks pass', async () => {
      vi.mocked(getPRNumbersFromPRBody).mockReturnValueOnce([1234]);
      octokit.pulls.get.mockResolvedValueOnce({
        data: {
          merged: true,
          base: {
            ref: 'main',
          },
        },
      });
      const event = JSON.parse(
        await fs.readFile(newPRBackportOpenedEventPath, 'utf-8'),
      );
      event.payload.pull_request.base.ref = '30-x-y';
      event.payload.action = 'synchronize';
      await robot.receive(event);

      const updatePayload = vi.mocked(checkUtils.updateBackportValidityCheck)
        .mock.calls[0][2];

      expect(updatePayload).toMatchObject({
        title: 'Valid Backport',
        summary:
          'This PR is declared as backporting "#1234" which is a valid PR that has been merged into main',
        conclusion: CheckRunStatus.SUCCESS,
      });
    });
  });
});
