import { Mutex } from 'async-mutex';
import { Probot } from 'probot';

import { BATCH_BACKPORT_LABEL, BATCH_BACKPORT_MAX_WAIT_MS } from '../constants';
import { LogLevel, PRStatus } from '../enums';
import { SimpleWebHookRepoContext, WebHookPR } from '../types';
import { labelToTargetBranch } from '../utils/label-utils';
import { log } from '../utils/log-util';
import { isStackedPR, isTopOfStack } from '../utils/stack-util';
import { backportBatchToBranch } from './backport-to-location';

// Batch backports: merged PRs labeled `batch-backport` wait until no open PR
// has the label any more (or until BATCH_BACKPORT_MAX_WAIT_MS after the
// oldest of them merged), then they are backported together, as one PR per
// target branch.
//
// The queue itself lives in GitHub: a merged PR with the label whose
// `target/*` labels have not been consumed yet is queued. trop only keeps a
// timer for the deadline, which it re-arms from GitHub when it starts.

type Labeled = { labels?: (string | { name?: string })[] };

const labelNames = (item: Labeled) =>
  (item.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));

export const hasBatchLabel = (item: Labeled) =>
  labelNames(item).includes(BATCH_BACKPORT_LABEL);

const getTargetBranches = (item: Labeled) =>
  labelNames(item)
    .filter((name) => name.startsWith(PRStatus.TARGET))
    .map((name) => labelToTargetBranch({ name }, PRStatus.TARGET));

/**
 * Resolves the PRs a merged PR is backported with: its whole stack (bottom
 * to top) for the top of a stack, otherwise the PR itself; null if they
 * could not be resolved (after flagging the PR for manual backports).
 */
export type ResolveBackportPRs = (
  context: SimpleWebHookRepoContext,
  pr: WebHookPR,
) => Promise<WebHookPR[] | null>;

interface EvaluateOptions {
  /** The PR whose merge is being handled. */
  merged?: WebHookPR;
  /** The open PR that just left the batch. */
  left?: number;
  /** Backport the batch now, whatever is still open. */
  force?: boolean;
  /** Backport the PRs whose last batch backport failed, to those branches
   *  only. */
  retry?: boolean;
}

interface QueuedPR {
  pr: WebHookPR;
  /** The target branches it is queued for and not being backported to. */
  branches: string[];
}

// How soon to try again when handling a batch failed.
const RETRY_MS = 5 * 60 * 1000;

// How many times in a row a batch an internal error stopped is retried on
// its own; after that it waits for the next event (or a restart).
const MAX_RETRIES = 3;

// Marks trop's comment that a PR waits in a batch, so it is posted once.
const QUEUED_COMMENT_MARKER = '<!-- trop:batch-backport-queued -->';

const formatDeadline = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export class BatchBackportQueue {
  private readonly locks = new Map<string, Mutex>();
  private readonly timers = new Map<
    string,
    { deadline: number; timer: NodeJS.Timeout }
  >();
  /** `<owner>/<repo>#<number>:<branch>` for every batch backport running. */
  private readonly inFlight = new Set<string>();
  /**
   * `<owner>/<repo>#<number>:<branch>` for every PR and target branch whose
   * last batch backport an internal error stopped, with the number of times
   * in a row. They are retried on their own timer, so they don't set the
   * deadline of the PRs that waited since.
   */
  private readonly failed = new Map<string, number>();

  constructor(
    private readonly robot: Probot,
    private readonly resolvePRs: ResolveBackportPRs,
    private readonly maxWaitMs = BATCH_BACKPORT_MAX_WAIT_MS,
  ) {}

  /**
   * A PR with the label was merged: it waits for the other labeled PRs, or
   * the batch goes out if none is open any more.
   */
  onMerged = (context: SimpleWebHookRepoContext, pr: WebHookPR) =>
    this.evaluateOrRetry(context, { merged: pr });

  /**
   * An open PR left the batch (closed unmerged, or the label was removed):
   * the batch goes out if it was the last open one.
   */
  onLeft = (context: SimpleWebHookRepoContext, pr: WebHookPR) =>
    this.evaluateOrRetry(context, { left: pr.number });

  /**
   * `/trop run backport` on a queued PR: the batch goes out now. Resolves
   * to whether there was anything to backport.
   */
  flushNow = (context: SimpleWebHookRepoContext) =>
    this.evaluate(context, { force: true });

  /**
   * Finds the batches waiting in every repository trop is installed on,
   * after a restart: overdue ones go out, the others get their timer back.
   */
  rescan = async () => {
    const app = await this.robot.auth();
    const installations = await app.paginate(app.apps.listInstallations, {
      per_page: 100,
    });
    for (const installation of installations) {
      try {
        await this.rescanInstallation(installation);
      } catch (error) {
        log(
          'batchBackport',
          LogLevel.ERROR,
          `Failed to rescan the batch backport queues of installation ${installation.id}`,
          error,
        );
      }
    }
  };

  private async rescanInstallation(installation: {
    id: number;
    account: unknown;
  }) {
    const account = installation.account as {
      login: string;
      type?: string;
    } | null;
    if (!account) return;
    const octokit = await this.robot.auth(installation.id);
    // One search per installation for the repositories with merged PRs that
    // may still be waiting, rather than a look at every repository. The
    // most recently updated first: a PR still waiting was updated when it
    // merged, and search returns 1000 results at most.
    const merged = await octokit.paginate(
      octokit.search.issuesAndPullRequests,
      {
        q: `${account.type === 'Organization' ? 'org' : 'user'}:${account.login} is:pr is:merged label:"${BATCH_BACKPORT_LABEL}"`,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
      },
    );
    const repositories = new Set(
      merged
        .filter((item) => getTargetBranches(item).length > 0)
        .map((item) => item.repository_url),
    );
    for (const url of repositories) {
      const [owner, repo] = url.split('/').slice(-2);
      try {
        const { data: repository } = await octokit.repos.get({ owner, repo });
        await this.evaluate(
          this.createContext(octokit, installation.id, repository),
          {},
        );
      } catch (error) {
        log(
          'batchBackport',
          LogLevel.ERROR,
          `Failed to rescan the batch backport queue of ${owner}/${repo}`,
          error,
        );
      }
    }
  }

  /** Stops the timers (for specs). */
  dispose = () => {
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  };

  private createContext(
    octokit: SimpleWebHookRepoContext['octokit'],
    installationId: number | undefined,
    repository: { name: string; owner: { login: string } },
  ) {
    return {
      octokit,
      repo: <T>(o?: T) => ({
        owner: repository.owner.login,
        repo: repository.name,
        ...o,
      }),
      payload: {
        repository,
        ...(installationId !== undefined && {
          installation: { id: installationId },
        }),
      },
    } as unknown as SimpleWebHookRepoContext;
  }

  private repoKey(context: SimpleWebHookRepoContext) {
    const { owner, repo } = context.repo();
    return `${owner}/${repo}`;
  }

  /**
   * Decides, under the repository's lock, whether its queued PRs keep
   * waiting or go out now: they go out once no open PR has the label, once
   * the oldest of them has waited `maxWaitMs`, or when `force`d. Resolves
   * to whether any went out.
   */
  private evaluate(
    context: SimpleWebHookRepoContext,
    { merged, left, force = false, retry = false }: EvaluateOptions,
  ): Promise<boolean> {
    const key = this.repoKey(context);
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }

    return lock.runExclusive(async () => {
      const queued = await this.listQueued(context, key, merged);
      const failedId = (q: QueuedPR, branch: string) =>
        `${key}#${q.pr.number}:${branch}`;
      // Each queued PR with its branches being retried, or the others.
      const split = (failed: boolean) =>
        queued
          .map((q) => ({
            ...q,
            branches: q.branches.filter(
              (b) => this.failed.has(failedId(q, b)) === failed,
            ),
          }))
          .filter((q) => q.branches.length > 0);

      // A retry backports the failed PRs again, to the failed branches only.
      if (retry) {
        const due = split(true);
        return due.length > 0 && this.flush(context, key, due);
      }

      // Forget failures of branches no longer queued (nor running).
      const queuedIds = new Set(
        queued.flatMap((q) => q.branches.map((b) => failedId(q, b))),
      );
      for (const id of this.failed.keys()) {
        if (
          id.startsWith(`${key}#`) &&
          !queuedIds.has(id) &&
          !this.inFlight.has(id)
        ) {
          this.failed.delete(id);
        }
      }

      if (queued.length === 0) {
        this.clearTimer(key);
        return false;
      }

      // The branches being retried don't make the others overdue.
      const waiting = split(false);
      const deadline =
        waiting.length > 0
          ? Date.parse(waiting[0].pr.merged_at!) + this.maxWaitMs
          : Infinity;
      if (!force && Date.now() < deadline) {
        // GitHub's lists can lag a moment behind the event being handled.
        const open = (await this.listOpen(context)).filter(
          (n) => n !== merged?.number && n !== left,
        );
        if (open.length > 0) {
          log(
            'batchBackport',
            LogLevel.INFO,
            `${key}: holding the batch of ${queued
              .map((q) => `#${q.pr.number}`)
              .join(', ')} for ${open.map((n) => `#${n}`).join(', ')}`,
          );
          if (deadline !== Infinity) this.armTimer(context, key, deadline);
          const mergedEntry = queued.find(
            (q) => q.pr.number === merged?.number,
          );
          if (mergedEntry)
            await this.commentQueued(context, mergedEntry, open, deadline);
          return false;
        }
      }

      this.clearTimer(key);
      return this.flush(context, key, queued);
    });
  }

  /**
   * Evaluates the batch for a webhook event; if that fails (GitHub not
   * answering, say), evaluates it again a little later rather than leave a
   * merged PR without a deadline.
   */
  private async evaluateOrRetry(
    context: SimpleWebHookRepoContext,
    options: EvaluateOptions,
  ) {
    try {
      return await this.evaluate(context, options);
    } catch (error) {
      this.armTimer(context, this.repoKey(context), Date.now() + RETRY_MS);
      throw error;
    }
  }

  /** Tells a merged PR that it waits in the batch, once. */
  private async commentQueued(
    context: SimpleWebHookRepoContext,
    { pr, branches }: QueuedPR,
    open: number[],
    deadline: number,
  ) {
    const comments = await context.octokit.paginate(
      context.octokit.issues.listComments,
      context.repo({ issue_number: pr.number, per_page: 100 }),
    );
    if (comments.some((c) => c.body?.includes(QUEUED_COMMENT_MARKER))) return;

    await context.octokit.issues.createComment(
      context.repo({
        issue_number: pr.number,
        body: `${QUEUED_COMMENT_MARKER}
This PR is queued for a batch backport to ${branches.map((b) => `"${b}"`).join(', ')}. \
It will be backported together with the other merged \`${BATCH_BACKPORT_LABEL}\` PRs \
once ${open.map((n) => `#${n}`).join(', ')} ${open.length > 1 ? 'are' : 'is'} merged or closed (or no longer labeled \`${BATCH_BACKPORT_LABEL}\`), \
or at ${formatDeadline(deadline)} at the latest. Comment \`/trop run backport\` to backport the batch now.`,
      }),
    );
  }

  /**
   * The repository's queued PRs, oldest merge first, without the target
   * branches they are being backported to already.
   */
  private async listQueued(
    context: SimpleWebHookRepoContext,
    key: string,
    merged?: WebHookPR,
  ): Promise<QueuedPR[]> {
    const closed = await context.octokit.paginate(
      context.octokit.issues.listForRepo,
      context.repo({
        state: 'closed' as const,
        labels: BATCH_BACKPORT_LABEL,
        per_page: 100,
      }),
    );
    // PRs closed without merging, and those whose `target/*` labels a
    // backport consumed, are never queued again: no need to fetch them.
    const numbers = new Set(
      closed
        .filter(
          (issue) =>
            issue.pull_request?.merged_at &&
            getTargetBranches(issue).length > 0,
        )
        .map((issue) => issue.number),
    );
    // The PR whose merge is being handled may not be listed yet.
    if (merged) numbers.add(merged.number);

    const prs = await Promise.all(
      [...numbers].map(async (number) =>
        number === merged?.number
          ? merged
          : ((
              await context.octokit.pulls.get(
                context.repo({ pull_number: number }),
              )
            ).data as WebHookPR),
      ),
    );
    const queued: QueuedPR[] = [];
    for (const pr of prs) {
      // A stack is queued by its top PR, which brings the rest with it.
      if (!pr.merged || !hasBatchLabel(pr)) continue;
      if (isStackedPR(pr) && !isTopOfStack(pr)) continue;
      const branches = getTargetBranches(pr).filter(
        (branch) => !this.inFlight.has(`${key}#${pr.number}:${branch}`),
      );
      if (branches.length > 0) queued.push({ pr, branches });
    }

    return queued.sort(
      (a, b) => Date.parse(a.pr.merged_at!) - Date.parse(b.pr.merged_at!),
    );
  }

  /** The numbers of the repository's open PRs with the label. */
  private async listOpen(context: SimpleWebHookRepoContext) {
    const open = await context.octokit.paginate(
      context.octokit.issues.listForRepo,
      context.repo({
        state: 'open' as const,
        labels: BATCH_BACKPORT_LABEL,
        per_page: 100,
      }),
    );
    return open.filter((issue) => issue.pull_request).map((i) => i.number);
  }

  /**
   * Backports the queued PRs, as one PR per target branch. Resolves to
   * whether there was anything to backport.
   */
  private async flush(
    context: SimpleWebHookRepoContext,
    key: string,
    queued: QueuedPR[],
  ) {
    const units: { prs: WebHookPR[]; branches: string[] }[] = [];
    for (const { pr, branches } of queued) {
      const prs = await this.resolvePRs(context, pr);
      if (prs) units.push({ prs, branches });
    }

    const branches = [...new Set(units.flatMap((u) => u.branches))];
    for (const branch of branches) {
      const members = units.filter((u) => u.branches.includes(branch));
      const ids = members.map(
        (u) => `${key}#${u.prs[u.prs.length - 1].number}:${branch}`,
      );
      // Until the backport is over, its PRs still look queued on GitHub.
      for (const id of ids) this.inFlight.add(id);
      const release = (retryable = false) => {
        for (const id of ids) this.inFlight.delete(id);
        this.settled(context, key, ids, retryable);
      };

      log(
        'batchBackport',
        LogLevel.INFO,
        `${key}: backporting the batch of ${members
          .map((u) => `#${u.prs[u.prs.length - 1].number}`)
          .join(', ')} to "${branch}"`,
      );
      backportBatchToBranch(
        this.robot,
        context,
        members.map((u) => u.prs),
        branch,
        release,
      ).catch((error: unknown) => {
        log(
          'batchBackport',
          LogLevel.ERROR,
          `${key}: the batch backport to "${branch}" failed`,
          error,
        );
        release(true);
      });
    }
    return branches.length > 0;
  }

  /**
   * Records how a batch backport ended for its PRs and branch (`ids`): one
   * an internal error stopped is retried on its own timer, a few times.
   */
  private settled(
    context: SimpleWebHookRepoContext,
    key: string,
    ids: string[],
    retryable: boolean,
  ) {
    let retry = false;
    for (const id of ids) {
      const failures = retryable ? (this.failed.get(id) ?? 0) + 1 : 0;
      if (failures === 0) {
        this.failed.delete(id);
      } else {
        this.failed.set(id, failures);
        retry ||= failures <= MAX_RETRIES;
      }
    }
    if (retry) {
      this.armTimer(context, key, Date.now() + RETRY_MS, { retry: true });
    }
  }

  /**
   * Evaluates the repository's batch at `deadline`, unless due earlier; or,
   * for a `retry`, backports the PRs that failed again then.
   */
  private armTimer(
    context: SimpleWebHookRepoContext,
    key: string,
    deadline: number,
    { retry = false }: { retry?: boolean } = {},
  ) {
    const slot = retry ? `${key}:retry` : key;
    const armed = this.timers.get(slot);
    if (armed && armed.deadline <= deadline) return;
    if (armed) clearTimeout(armed.timer);

    // Only what the timer needs, not the whole webhook context; and a fresh
    // client when it fires, as an installation token does not last as long
    // as a batch may wait.
    const installationId = context.payload.installation?.id;
    const { repository } = context.payload;
    const repoContext = this.createContext(
      context.octokit,
      installationId,
      repository,
    );
    const timer = setTimeout(
      () => {
        this.timers.delete(slot);
        const fired = async () =>
          this.evaluate(
            installationId === undefined
              ? repoContext
              : this.createContext(
                  await this.robot.auth(installationId),
                  installationId,
                  repository,
                ),
            { retry },
          );
        fired().catch((error: unknown) => {
          log(
            'batchBackport',
            LogLevel.ERROR,
            `${key}: failed to run the batch backport at its deadline - retrying`,
            error,
          );
          this.armTimer(repoContext, key, Date.now() + RETRY_MS, { retry });
        });
      },
      Math.max(0, deadline - Date.now()),
    );
    timer.unref();
    this.timers.set(slot, { deadline, timer });
  }

  private clearTimer(key: string) {
    const armed = this.timers.get(key);
    if (armed) clearTimeout(armed.timer);
    this.timers.delete(key);
  }
}
