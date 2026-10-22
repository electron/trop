import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// git as the trusted server runs it. The server's git only ever reads and
// writes its own bare caches, which hold nothing but objects fetched from
// GitHub; it never runs over anything a sandbox job produced.

let emptyHome: string | null = null;

/** An empty directory for HOME, so no user-level git config is ever read. */
const getEmptyHome = () => {
  if (!emptyHome) {
    emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trop-git-home-'));
  }
  return emptyHome;
};

/**
 * The environment for every git process the server spawns: the server's own
 * environment without any GIT_* variables, no system or global config, and
 * no prompts. `extra` is added on top (e.g. gitAuthEnv for a fetch).
 */
export const serverGitEnv = (
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') || upper === 'SSH_ASKPASS') continue;
    env[key] = value;
  }
  const home = getEmptyHome();
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
};

export interface RunGitOptions {
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

/** Runs git (with serverGitEnv) and resolves with its stdout. */
export const runGit = (args: string[], opts: RunGitOptions = {}) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        env: serverGitEnv(opts.env),
        maxBuffer: 256 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 30 * 60 * 1000,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `git ${args.join(' ')} failed: ${stderr || error.message}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// A branch name trop is willing to hand to git: what release and feature
// branches look like, never starting with `-` (so it can't be read as an
// option) and further checked with `git check-ref-format`.
const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

export const assertValidBranchName = async (branch: string) => {
  if (!BRANCH_NAME.test(branch)) {
    throw new Error(`Refusing to use "${branch}" as a branch name`);
  }
  try {
    await runGit(['check-ref-format', `refs/heads/${branch}`]);
  } catch {
    throw new Error(`Refusing to use "${branch}" as a branch name`);
  }
};
