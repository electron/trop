import * as fs from 'fs';
import { isIP } from 'net';

import { parse } from 'yaml';

import { LogLevel } from '../enums';
import { log } from '../utils/log-util';
import { SandboxJobServer } from './job-server';
import { KubernetesJobRunner } from './kubernetes';
import { SandboxAttempt, SandboxCommit } from './protocol';
import { RepoCache } from './repo-cache';
import {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  LocalProcessRunner,
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
      timeoutMs,
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

export interface SandboxedBackportOptions {
  slug: string;
  /** Installation token; only used by the server to fetch from GitHub. */
  token: string;
  targetBranch: string;
  /** Tried in order until one applies cleanly. */
  attempts: SandboxAttempt[];
  /** Whether the commits' file contents are needed (to push them). */
  includeChanges: boolean;
}

export type SandboxedBackportOutcome =
  | {
      kind: 'success';
      attempt: SandboxAttempt['kind'];
      /** The target branch tip the server resolved: the new commits' base. */
      baseSha: string;
      /** The commits to push, oldest first. */
      commits: SandboxCommit[];
    }
  | { kind: 'conflict'; diff: string };

/**
 * Applies a backport's patches in a sandbox job: the server fetches the
 * target branch from GitHub into its cache and resolves its tip, and the job
 * applies the patches on top of that tip with `git am -3`. Throws if the job
 * fails or its result is invalid.
 */
export const runSandboxedBackport = async (
  opts: SandboxedBackportOptions,
  deps: { sandbox?: Sandbox; cache?: RepoCache } = {},
): Promise<SandboxedBackportOutcome> => {
  const { runner, server } = deps.sandbox ?? (await getSandbox());
  const cache = deps.cache ?? RepoCache.for(opts.slug);

  const lease = await cache.acquire(opts.token, opts.targetBranch);
  try {
    const preimageBlobs = await cache.resolvePreimageBlobs(
      opts.attempts.flatMap((a) => a.patches),
    );
    const job = server.register({
      cacheDir: lease.dir,
      ref: lease.ref,
      inputs: {
        version: 1,
        ref: lease.ref,
        baseSha: lease.baseSha,
        attempts: opts.attempts,
        preimageBlobs,
        includeChanges: opts.includeChanges,
        committer: getCommitter(),
      },
      expectation: {
        patchCounts: opts.attempts.map((a) => a.patches.length),
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
        case 'success':
          return {
            kind: 'success',
            attempt: opts.attempts[result.attempt].kind,
            baseSha: lease.baseSha,
            // Patches already on the target made no commit (as before the
            // sandbox, when only the commits git made were pushed).
            commits: result.commits.filter(
              (c): c is SandboxCommit => c !== null,
            ),
          };
        case 'conflict':
          return { kind: 'conflict', diff: result.diff };
        case 'error':
          throw new Error(`Sandbox job ${job.id} failed: ${result.message}`);
      }
    } finally {
      job.unregister();
    }
  } finally {
    await lease.release();
  }
};
