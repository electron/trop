import * as fs from 'fs';
import { isIP } from 'net';

import { parse } from 'yaml';

import { LogLevel } from '../enums';
import { log } from '../utils/log-util';
import { SandboxJobServer } from './job-server';
import { KubernetesJobRunner } from './kubernetes';
import { LIMITS, SandboxAttempt, SandboxFileChange } from './protocol';
import { checkBackstop, OriginalFile } from './backstop';
import { backportMbox } from './patches';
import { RepoCache } from './repo-cache';
import {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  LocalProcessRunner,
  SandboxInfraError,
  SandboxRunner,
} from './runner';

const DEFAULT_PORT = 8081;

export interface Sandbox {
  runner: SandboxRunner;
  server: SandboxJobServer;
}

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the sandbox runner`);
  return value;
};

/**
 * The sandbox runner the environment configures. Production
 * (NODE_ENV=production) only ever gets the Kubernetes runner; a missing or
 * broken configuration throws rather than falling back to anything else.
 */
export const loadSandboxRunner = (): SandboxRunner => {
  const kind =
    process.env.TROP_SANDBOX_RUNNER ??
    (process.env.NODE_ENV === 'production' ? 'kubernetes' : 'local');
  const timeoutMs =
    Number(process.env.TROP_SANDBOX_TIMEOUT_MS) || DEFAULT_SANDBOX_TIMEOUT_MS;

  if (kind === 'kubernetes') {
    const podIp = required('POD_IP');
    if (!isIP(podIp)) throw new Error('POD_IP is not an IP address');
    return new KubernetesJobRunner({
      namespace:
        process.env.TROP_SANDBOX_NAMESPACE ??
        fs
          .readFileSync(
            '/var/run/secrets/kubernetes.io/serviceaccount/namespace',
            'utf8',
          )
          .trim(),
      image: required('TROP_SANDBOX_IMAGE'),
      templatePath: required('TROP_SANDBOX_JOB_TEMPLATE'),
      podIp,
      podName: required('POD_NAME'),
      podUid: required('POD_UID'),
      timeoutMs,
      schedulingTimeoutMs:
        Number(process.env.TROP_SANDBOX_SCHEDULING_TIMEOUT_MS) || undefined,
    });
  }
  if (kind === 'local') return new LocalProcessRunner(timeoutMs);
  throw new Error(`Unknown TROP_SANDBOX_RUNNER "${kind}"`);
};

let sandbox: Promise<Sandbox> | null = null;

/** The process-wide sandbox runner and job server, started on first use. */
export const getSandbox = () => {
  sandbox ??= (async () => {
    const runner = loadSandboxRunner();
    const port = Number(process.env.TROP_SANDBOX_PORT ?? DEFAULT_PORT);
    const server = new SandboxJobServer(runner.listenHost, port);
    await server.start();
    if (runner instanceof KubernetesJobRunner) {
      await runner.deleteOrphanedJobs().catch((error: unknown) => {
        log('getSandbox', LogLevel.WARN, 'Orphaned Job cleanup failed', error);
      });
    }
    return { runner, server };
  })().catch((error: unknown) => {
    // Try again on the next backport rather than caching the failure.
    sandbox = null;
    throw error;
  });
  return sandbox;
};

let committer: { name: string; email: string } | null = null;
const getCommitter = () => {
  if (!committer) {
    const { tropEmail, tropName } = parse(
      fs.readFileSync('./config.yml', 'utf8'),
    );
    committer = {
      name: tropName || 'Trop Bot',
      email: tropEmail || 'trop@example.com',
    };
  }
  return committer;
};

/** One original commit to backport, as the server knows it from GitHub. */
export interface BackportCommit {
  /** The commit's diff, cut from its `.patch` (patches.ts splitPatch). */
  diff: string;
  /** The message `git am` would have given it (patches.ts commitMessage). */
  message: string;
  /** Its author, credited with a Co-authored-by trailer. */
  author: { name: string; email: string };
  /** GitHub's list of its files (for the backstop). */
  files: OriginalFile[];
}

export interface BackportAttempt {
  kind: SandboxAttempt['kind'];
  commits: BackportCommit[];
}

/** A commit to create on the backport branch. */
export interface BackportResultCommit {
  message: string;
  author: { name: string; email: string };
  /** The files it changes; only when the contents were asked for. */
  changes?: SandboxFileChange[];
}

/** A successful sandbox job, for the caller to push before its files go. */
export interface SandboxSuccess {
  attempt: SandboxAttempt['kind'];
  /** The target branch tip the server resolved: the new commits' base. */
  baseSha: string;
  /** The commits to create, oldest first (patches already on the target
   *  make none). */
  commits: BackportResultCommit[];
  /** Reads a file the job uploaded (SandboxFileChange.blob). */
  readBlob: (sha256: string) => Promise<Buffer>;
}

export interface SandboxedBackportOptions {
  slug: string;
  /** Installation token; only used by the server to fetch from GitHub. */
  token: string;
  targetBranch: string;
  /** Tried in order until one applies cleanly. */
  attempts: BackportAttempt[];
  /** Whether the commits' file contents are needed (to push them). */
  includeChanges: boolean;
  /** Runs (e.g. pushes) while the job's files are still available. */
  onSuccess?: (success: SandboxSuccess) => Promise<void>;
}

export type SandboxedBackportOutcome =
  | ({ kind: 'success' } & Omit<SandboxSuccess, 'readBlob'>)
  | { kind: 'conflict'; diff: string };

export interface SandboxDeps {
  sandbox?: Sandbox;
  cache?: RepoCache;
  /** Waits before retrying after an infrastructure failure. */
  retryDelaysMs?: number[];
  /** Set false to run without the backstop (backstop.ts). */
  backstop?: boolean;
  /** For specs: smaller limits for what the job reports. */
  inputLimits?: { diffChars: number; errorChars: number };
}

const DEFAULT_RETRY_DELAYS_MS = [30_000, 120_000];

/**
 * Applies a backport's commits in a sandbox job: the server fetches the
 * target branch from GitHub into its cache and resolves its tip, and the job
 * applies each commit's diff on top of that tip with `git am -3`. The
 * commits to push get their messages and authors from the server's own data.
 * Infrastructure failures are retried; one that persists, a job's invalid
 * result or a backstop violation throws.
 */
export const runSandboxedBackport = async (
  opts: SandboxedBackportOptions,
  deps: SandboxDeps = {},
): Promise<SandboxedBackportOutcome> => {
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(opts, deps);
    } catch (error) {
      if (
        !(error instanceof SandboxInfraError) ||
        !error.retryable ||
        attempt >= delays.length
      ) {
        throw error;
      }
      log(
        'runSandboxedBackport',
        LogLevel.WARN,
        `Retrying after a sandbox failure: ${error.message}`,
      );
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
};

/**
 * Runs a step of the server's own git work on its cache, whose failure (git
 * failing on the cache's own objects) is an internal one, to be retried.
 */
const cacheStep = async <T>(step: () => Promise<T>): Promise<T> => {
  try {
    return await step();
  } catch (error) {
    throw new SandboxInfraError(
      `The repository cache failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const runOnce = async (
  opts: SandboxedBackportOptions,
  deps: SandboxDeps,
): Promise<SandboxedBackportOutcome> => {
  let sandbox: Sandbox;
  try {
    sandbox = deps.sandbox ?? (await getSandbox());
  } catch (error) {
    throw new SandboxInfraError(
      `The sandbox is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { runner, server } = sandbox;
  const cache = deps.cache ?? RepoCache.for(opts.slug);

  const lease = await cache.acquire(opts.token, opts.targetBranch);
  try {
    const diffs = opts.attempts.flatMap((a) => a.commits.map((c) => c.diff));
    const preimageBlobs = await cacheStep(() =>
      cache.resolvePreimageBlobs(diffs),
    );
    const job = server.register({
      cacheDir: lease.dir,
      ref: lease.ref,
      inputs: {
        version: 1,
        ref: lease.ref,
        baseSha: lease.baseSha,
        attempts: opts.attempts.map((a) => ({
          kind: a.kind,
          patches: a.commits.map((c) => backportMbox(c.diff)),
        })),
        preimageBlobs,
        includeChanges: opts.includeChanges,
        committer: getCommitter(),
        limits: deps.inputLimits ?? {
          diffChars: LIMITS.diffChars,
          errorChars: LIMITS.errorChars,
        },
      },
      expectation: {
        patchCounts: opts.attempts.map((a) => a.commits.length),
        includeChanges: opts.includeChanges,
      },
    });

    try {
      log(
        'runSandboxedBackport',
        LogLevel.INFO,
        `Running sandbox job ${job.id} (${runner.kind}) for ${opts.slug} on ${opts.targetBranch} at ${lease.baseSha}`,
      );
      const result = await runner.run({
        id: job.id,
        url: job.url,
        token: job.token,
        result: job.result,
      });
      switch (result.outcome) {
        case 'success': {
          const attempt = opts.attempts[result.attempt];
          if (deps.backstop ?? true) {
            await checkBackstop({
              commits: attempt.commits,
              applied: result.applied,
              renamedOnTarget: () =>
                cacheStep(() =>
                  cache.renamedOnTarget(
                    lease.baseSha,
                    attempt.commits.map((c) => c.diff),
                  ),
                ),
              targetFiles: (paths) =>
                cacheStep(() => cache.filesAt(lease.baseSha, paths)),
              gitBlobId: (sha) => job.blobs.gitId(sha),
            });
          }
          const commits = attempt.commits.flatMap((c, i) => {
            const applied = result.applied[i];
            return applied
              ? [
                  {
                    message: c.message,
                    author: c.author,
                    changes: applied.changes,
                  },
                ]
              : [];
          });
          const success: SandboxSuccess = {
            attempt: attempt.kind,
            baseSha: lease.baseSha,
            commits,
            readBlob: (sha) => job.blobs.readAsync(sha),
          };
          await opts.onSuccess?.(success);
          return {
            kind: 'success',
            attempt: success.attempt,
            baseSha: success.baseSha,
            commits,
          };
        }
        case 'conflict':
          return { kind: 'conflict', diff: result.diff };
        case 'error':
          // What the job reports itself (git failing on these patches, a
          // refused upload) would happen again: not retried.
          throw new SandboxInfraError(
            `Sandbox job ${job.id} failed: ${result.message}`,
            false,
          );
      }
    } finally {
      job.unregister();
      await job.blobs.dispose();
    }
  } finally {
    await lease.release();
  }
};
