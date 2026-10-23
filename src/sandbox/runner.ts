import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LogLevel } from '../enums';
import { BUILD_TOOLS_DIR } from '../utils/build-tools';
import { log } from '../utils/log-util';
import { SandboxResult } from './protocol';

/** What a runner needs to start one sandbox job. */
export interface SandboxJobSpec {
  id: string;
  /** The job's endpoint base URL and bearer token: its only inputs. */
  url: string;
  token: string;
  /** Settles when the job posts its (validated) result. */
  result: Promise<SandboxResult>;
}

export interface SandboxRunner {
  readonly kind: 'kubernetes' | 'local';
  /** The address the job server must bind so that jobs (and only they) reach it. */
  readonly listenHost: string;
  /**
   * Runs the sandbox entrypoint for `spec` and resolves with its result.
   * Rejects if the workload cannot be started, ends without a valid result
   * or runs out of time. Always tears the workload down before settling.
   */
  run(spec: SandboxJobSpec): Promise<SandboxResult>;
}

/**
 * From starting a job to its result, including up to 15 minutes waiting for
 * a node: a few minutes is typical, and a job that hangs only holds a queue
 * slot this long (it is not retried).
 */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * An internal failure, as opposed to a conflict or an invalid result: the
 * sandbox machinery (a Job that can't start, dies or runs out of time; the
 * job server; a job reporting an error of its own) or GitHub not answering.
 * Reported as an internal error rather than as a backport that needs to be
 * done by hand. Only `retryable` ones, which a new job may well not hit
 * again, are retried.
 */
export class SandboxInfraError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'SandboxInfraError';
  }
}

/**
 * Settles with the job's result, or rejects when `ended` (the workload
 * terminating) settles first, or when time is up.
 */
export const raceResult = async (
  spec: SandboxJobSpec,
  ended: Promise<string>,
  timeoutMs: number,
): Promise<SandboxResult> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        // Not retried: a patch that hangs git would hang again.
        reject(
          new SandboxInfraError(`Sandbox job ${spec.id} timed out`, false),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      spec.result,
      ended.then((reason) => {
        throw new SandboxInfraError(
          `Sandbox job ${spec.id} ended without a result: ${reason}`,
        );
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Runs the sandbox entrypoint as a local child process, for development and
 * specs. It is not a sandbox: it refuses to run in production or wherever the
 * Kubernetes runner is configured, so that trop never silently falls back to
 * applying untrusted patches unsandboxed.
 */
export class LocalProcessRunner implements SandboxRunner {
  readonly kind = 'local';
  readonly listenHost = '127.0.0.1';

  static assertAllowed() {
    if (isProduction()) {
      throw new Error('The local sandbox runner is not allowed in production');
    }
    if (process.env.TROP_SANDBOX_RUNNER === 'kubernetes') {
      throw new Error(
        'The local sandbox runner is not allowed when the Kubernetes runner is configured',
      );
    }
  }

  constructor(
    private readonly timeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
    private readonly command = LocalProcessRunner.defaultCommand(),
  ) {
    LocalProcessRunner.assertAllowed();
  }

  /** The compiled entrypoint, or (in specs) its source run by Node directly. */
  static defaultCommand() {
    const compiled = path.join(__dirname, 'entrypoint.js');
    if (fs.existsSync(compiled)) return [process.execPath, compiled];
    return [
      process.execPath,
      ...(process.features.typescript ? [] : ['--experimental-strip-types']),
      '--disable-warning=ExperimentalWarning',
      path.join(__dirname, 'entrypoint.ts'),
    ];
  }

  async run(spec: SandboxJobSpec) {
    LocalProcessRunner.assertAllowed();
    const workDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'trop-sandbox-'),
    );
    // Deliberately not the server's environment, which holds its secrets.
    const child = spawn(this.command[0], this.command.slice(1), {
      env: {
        PATH: process.env.PATH,
        TMPDIR: os.tmpdir(),
        TROP_SANDBOX_URL: spec.url,
        TROP_SANDBOX_TOKEN: spec.token,
        TROP_SANDBOX_WORKDIR: workDir,
        TROP_BUILD_TOOLS_DIR: BUILD_TOOLS_DIR,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const exited = new Promise<string>((resolve) => {
      child.on('error', (error) => resolve(error.message));
      child.on('close', (code, signal) =>
        resolve(`exited with ${signal ?? code}`),
      );
    });

    try {
      return await raceResult(spec, exited, this.timeoutMs);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
      await fs.promises
        .rm(workDir, { recursive: true, force: true })
        .catch((error: unknown) =>
          log('LocalProcessRunner', LogLevel.WARN, 'Cleanup failed', error),
        );
    }
  }
}
