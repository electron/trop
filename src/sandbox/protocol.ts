// The data exchanged between the trop server and a sandbox job.
//
// Trust model: the server is trusted (it holds the GitHub App key and
// installation tokens). A sandbox job applies untrusted patches with git and is
// treated as fully attacker-controlled: everything it sends back is validated
// here before the server acts on it, and the server never runs git over
// anything the sandbox produced. The sandbox entrypoint only imports types from
// this module.

import { isUtf8 } from 'buffer';

/** Bump when the shape of SandboxInputs or SandboxResult changes. */
export const SANDBOX_PROTOCOL_VERSION = 1;

/** A set of patches to apply, in order, on top of the base commit. */
export interface SandboxAttempt {
  /** All commits of the PRs, or their squash-merge commits. */
  kind: 'all' | 'squash';
  /** `git format-patch` style mbox text, as GitHub's .patch endpoint serves. */
  patches: string[];
}

/** GET /jobs/<id>/inputs */
export interface SandboxInputs {
  version: typeof SANDBOX_PROTOCOL_VERSION;
  /** The only ref the job's git endpoint advertises; it points at baseSha. */
  ref: string;
  /** The target branch tip, resolved by the server from GitHub. */
  baseSha: string;
  /** Tried in order; the first attempt that applies cleanly wins. */
  attempts: SandboxAttempt[];
  /**
   * Full ids of the blobs the patches' `index` lines name as pre-images, so
   * the job can fetch them before `git am -3` (which resolves the abbreviated
   * ids locally and cannot lazily fetch by prefix).
   */
  preimageBlobs: string[];
  /** Whether to send back file contents (only needed to push a backport). */
  includeChanges: boolean;
  /** Committer identity for `git am`; the pushed commits are rebuilt anyway. */
  committer: { name: string; email: string };
  /** The server's limits the job has to stay within (see LIMITS). */
  limits: { diffChars: number; errorChars: number };
}

export type SandboxFileChange =
  | {
      path: string;
      mode: '100644' | '100755' | '120000';
      /** Base64 of the blob (for a symlink, of its target). */
      content: string;
    }
  | { path: string; deleted: true };

export interface SandboxCommit {
  message: string;
  author: { name: string; email: string; date: string };
  /** Present if and only if the inputs asked for changes. */
  changes?: SandboxFileChange[];
}

/** POST /jobs/<id>/result */
export type SandboxResult =
  | {
      outcome: 'success';
      attempt: number;
      /**
       * One entry per patch of the attempt, in order: the commit it made, or
       * null if it made none because its changes were on the target already.
       */
      commits: (SandboxCommit | null)[];
    }
  | { outcome: 'conflict'; diff: string }
  | { outcome: 'error'; message: string };

/** What a validated success result is checked against. */
export interface ResultExpectation {
  /** Number of patches of each attempt, in order. */
  patchCounts: number[];
  includeChanges: boolean;
}

export const LIMITS = {
  /** Request body of a result POST. */
  resultBytes: 64 * 1024 * 1024,
  /** Decoded content of one file. */
  fileBytes: 16 * 1024 * 1024,
  /** Decoded content of all files of a result. */
  totalContentBytes: 48 * 1024 * 1024,
  /** File changes in one commit, and in a whole result. */
  changesPerCommit: 10_000,
  totalChanges: 20_000,
  /** A conflict diff; GitHub truncates check-run text far below this. */
  diffChars: 8 * 1024 * 1024,
  messageChars: 128 * 1024,
  identChars: 256,
  errorChars: 4096,
  pathBytes: 4096,
  symlinkTargetBytes: 4096,
  /** Pre-image blob ids handed to a job. */
  preimageBlobs: 50_000,
  /** Request body of one git upload-pack request (after gunzip). */
  uploadPackRequestBytes: 16 * 1024 * 1024,
} as const;

export class SandboxResultError extends Error {
  constructor(message: string) {
    super(`Invalid sandbox result: ${message}`);
    this.name = 'SandboxResultError';
  }
}

const fail = (message: string): never => {
  throw new SandboxResultError(message);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Rejects keys other than `allowed`, so unexpected data is never ignored. */
const checkKeys = (
  where: string,
  value: Record<string, unknown>,
  allowed: string[],
) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where}: unexpected key "${key}"`);
  }
};

const str = (where: string, value: unknown, maxChars: number): string => {
  if (typeof value !== 'string') return fail(`${where}: expected a string`);
  if (value.length > maxChars) return fail(`${where}: longer than ${maxChars}`);
  // Lone surrogates cannot be encoded as UTF-8 for the GitHub API.
  if (!value.isWellFormed()) return fail(`${where}: not well-formed Unicode`);
  if (value.includes('\0')) return fail(`${where}: contains NUL`);
  return value;
};

// Names and emails end up in a `Co-authored-by: name <email>` trailer: no
// control characters (which could start another trailer) and no angle
// brackets, as git itself strips them from identities.
const hasControlChar = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};
const ident = (where: string, value: unknown): string => {
  const s = str(where, value, LIMITS.identChars).trim();
  if (hasControlChar(s) || /[<>]/.test(s)) {
    fail(`${where}: forbidden character`);
  }
  return s;
};

// Code points HFS+ ignores when comparing names, so `.g‌it` is `.git`
// there (git's is_hfs_dotgit()).
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/**
 * Whether a path component names a `.git` directory on some filesystem:
 * case-insensitively, with trailing dots and spaces (NTFS), as the 8.3 short
 * name `git~1`, or with HFS+-ignorable code points.
 */
const isDotGit = (component: string) => {
  const c = component
    .replace(HFS_IGNORABLE, '')
    .toLowerCase()
    .replace(/[. ]+$/, '');
  return c === '.git' || c === 'git~1';
};

// Files git refuses to follow symlinks for (its fsck rejects them as links).
const NO_SYMLINK_BASENAMES = new Set([
  '.gitmodules',
  '.gitattributes',
  '.gitignore',
  '.mailmap',
]);

/**
 * A repository path as git stores it in a tree: relative, `/`-separated,
 * normalized (no empty, `.` or `..` components), with no `.git` component.
 */
export const validateRepoPath = (where: string, value: unknown): string => {
  const p = str(where, value, LIMITS.pathBytes);
  if (p.length === 0) fail(`${where}: empty path`);
  if (Buffer.byteLength(p) > LIMITS.pathBytes) fail(`${where}: path too long`);
  if (hasControlChar(p) || p.includes('\\')) {
    fail(`${where}: control character or backslash in path`);
  }
  for (const component of p.split('/')) {
    if (component === '' || component === '.' || component === '..') {
      fail(`${where}: path is not normalized`);
    }
    if (isDotGit(component)) fail(`${where}: path has a .git component`);
  }
  return p;
};

// Linear-time: a nested quantifier would overflow the regexp stack on large
// files.
const isBase64 = (s: string) =>
  s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);

/** Decoded size of a validated base64 string. */
const base64Bytes = (b64: string) =>
  (b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

const validateChange = (
  where: string,
  value: unknown,
  budget: { contentBytes: number },
): SandboxFileChange => {
  if (!isRecord(value)) return fail(`${where}: expected an object`);
  const path = validateRepoPath(`${where}.path`, value.path);

  if ('deleted' in value) {
    checkKeys(where, value, ['path', 'deleted']);
    if (value.deleted !== true) fail(`${where}.deleted: expected true`);
    return { path, deleted: true };
  }

  checkKeys(where, value, ['path', 'mode', 'content']);
  const { mode, content } = value;
  if (mode !== '100644' && mode !== '100755' && mode !== '120000') {
    return fail(`${where}.mode: not an allowed file mode`);
  }
  if (typeof content !== 'string') return fail(`${where}.content: not base64`);
  // Check the encoded length first so an oversized string is never decoded.
  if (content.length > Math.ceil(LIMITS.fileBytes / 3) * 4) {
    fail(`${where}: file larger than ${LIMITS.fileBytes} bytes`);
  }
  if (!isBase64(content)) fail(`${where}.content: not base64`);
  const bytes = base64Bytes(content);
  if (bytes > LIMITS.fileBytes) {
    fail(`${where}: file larger than ${LIMITS.fileBytes} bytes`);
  }
  budget.contentBytes += bytes;
  if (budget.contentBytes > LIMITS.totalContentBytes) {
    fail(`result has more than ${LIMITS.totalContentBytes} bytes of content`);
  }

  if (mode === '120000') {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    if (NO_SYMLINK_BASENAMES.has(basename.toLowerCase())) {
      fail(`${where}: ${basename} must not be a symlink`);
    }
    const target = Buffer.from(content, 'base64');
    if (
      target.length === 0 ||
      target.length > LIMITS.symlinkTargetBytes ||
      target.includes(0)
    ) {
      fail(`${where}: invalid symlink target`);
    }
    if (!isUtf8(target)) {
      fail(`${where}: symlink target is not UTF-8`);
    }
  }

  return { path, mode, content };
};

const validateCommit = (
  where: string,
  value: unknown,
  includeChanges: boolean,
  budget: { contentBytes: number; changes: number },
): SandboxCommit => {
  if (!isRecord(value)) return fail(`${where}: expected an object`);
  checkKeys(
    where,
    value,
    includeChanges ? ['message', 'author', 'changes'] : ['message', 'author'],
  );
  const message = str(`${where}.message`, value.message, LIMITS.messageChars);
  if (!isRecord(value.author)) return fail(`${where}.author: expected object`);
  checkKeys(`${where}.author`, value.author, ['name', 'email', 'date']);
  const author = {
    name: ident(`${where}.author.name`, value.author.name),
    email: ident(`${where}.author.email`, value.author.email),
    date: str(`${where}.author.date`, value.author.date, 64),
  };
  if (Number.isNaN(Date.parse(author.date))) {
    fail(`${where}.author.date: not a date`);
  }

  if (!includeChanges) return { message, author };

  if (!Array.isArray(value.changes)) {
    return fail(`${where}.changes: expected an array`);
  }
  if (value.changes.length > LIMITS.changesPerCommit) {
    fail(`${where}: more than ${LIMITS.changesPerCommit} changes`);
  }
  budget.changes += value.changes.length;
  if (budget.changes > LIMITS.totalChanges) {
    fail(`result has more than ${LIMITS.totalChanges} changes`);
  }
  const seen = new Set<string>();
  const changes = value.changes.map((c: unknown, i) => {
    const change = validateChange(`${where}.changes[${i}]`, c, budget);
    if (seen.has(change.path)) fail(`${where}: duplicate path ${change.path}`);
    seen.add(change.path);
    return change;
  });
  return { message, author, changes };
};

/**
 * Validates a sandbox job's result against what the server asked for. Throws
 * SandboxResultError for anything unexpected; the returned value contains
 * only validated data.
 */
export const validateSandboxResult = (
  value: unknown,
  expect: ResultExpectation,
): SandboxResult => {
  if (!isRecord(value)) return fail('expected an object');

  switch (value.outcome) {
    case 'success': {
      checkKeys('result', value, ['outcome', 'attempt', 'commits']);
      const { attempt } = value;
      if (
        typeof attempt !== 'number' ||
        !Number.isInteger(attempt) ||
        attempt < 0 ||
        attempt >= expect.patchCounts.length
      ) {
        return fail('attempt: not one of the attempts');
      }
      if (!Array.isArray(value.commits)) return fail('commits: not an array');
      if (value.commits.length !== expect.patchCounts[attempt]) {
        fail(
          `${value.commits.length} commits for ${expect.patchCounts[attempt]} patches`,
        );
      }
      const budget = { contentBytes: 0, changes: 0 };
      const commits = value.commits.map((c: unknown, i) =>
        c === null
          ? null
          : validateCommit(`commits[${i}]`, c, expect.includeChanges, budget),
      );
      return { outcome: 'success', attempt, commits };
    }
    case 'conflict':
      checkKeys('result', value, ['outcome', 'diff']);
      return {
        outcome: 'conflict',
        diff: str('diff', value.diff, LIMITS.diffChars),
      };
    case 'error':
      checkKeys('result', value, ['outcome', 'message']);
      return {
        outcome: 'error',
        message: str('message', value.message, LIMITS.errorChars),
      };
    default:
      return fail('unknown outcome');
  }
};
