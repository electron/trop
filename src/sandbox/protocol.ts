// The data exchanged between the trop server and a sandbox job.
//
// Trust model: the server is trusted (it holds the GitHub App key and
// installation tokens). A sandbox job applies untrusted patches with git and is
// treated as fully attacker-controlled: everything it sends back is validated
// here before the server acts on it, and the server never runs git over
// anything the sandbox produced. The sandbox entrypoint only imports types from
// this module.

/** Bump when the shape of SandboxInputs or SandboxResult changes. */
export const SANDBOX_PROTOCOL_VERSION = 1;

/** A set of patches to apply, in order, on top of the base commit. */
export interface SandboxAttempt {
  /** All commits of the PRs, or their squash-merge commits. */
  kind: 'all' | 'squash';
  /**
   * One mbox per commit, built by the server around the commit's diff alone
   * (see patches.ts): no commit message ever reaches the job's git.
   */
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
  /** Identity for `git am`; the pushed commits are rebuilt by the server. */
  committer: { name: string; email: string };
  /** The server's limits the job has to stay within (see LIMITS). */
  limits: { diffChars: number; errorChars: number };
}

export type SandboxFileChange =
  | {
      path: string;
      mode: '100644' | '100755' | '120000';
      /**
       * SHA-256 of the file's contents (for a symlink, of its target), which
       * the job uploads separately (PUT /jobs/<id>/blobs/<sha256>).
       */
      blob: string;
    }
  | { path: string; deleted: true };

/** What applying one patch produced. */
export interface SandboxApplied {
  /** The files the patch's commit changed; only if the inputs asked. */
  changes?: SandboxFileChange[];
}

/** POST /jobs/<id>/result */
export type SandboxResult =
  | {
      outcome: 'success';
      attempt: number;
      /**
       * One entry per patch of the attempt, in order: what its commit
       * changed, or null if `git am` made no commit because the patch's
       * changes were on the target already.
       */
      applied: (SandboxApplied | null)[];
    }
  | { outcome: 'conflict'; diff: string }
  | { outcome: 'error'; message: string };

/** What a validated success result is checked against. */
export interface ResultExpectation {
  /** Number of patches of each attempt, in order. */
  patchCounts: number[];
  includeChanges: boolean;
}

// Generous on purpose: no real backport should come near these. They only
// bound what a misbehaving job can make the server hold or upload.
export const LIMITS = {
  /** Request body of a result POST (metadata only; contents are blobs). */
  resultBytes: 64 * 1024 * 1024,
  /** One uploaded file: GitHub's own limit for a blob. */
  fileBytes: 100 * 1024 * 1024,
  /**
   * All files uploaded by one job (identical contents are stored once): the
   * full contents of every file the backport changes, which for a real
   * backport is kilobytes to a few megabytes. Five times GitHub's limit for
   * one file.
   */
  totalContentBytes: 512 * 1024 * 1024,
  /**
   * All files the server holds for its jobs at once: the queue runs up to
   * five. Below the size of the volume they are stored on (sandbox-blobs in
   * deploy/base/server-sandbox-patch.yaml), so that is never exceeded.
   */
  serverContentBytes: 2560 * 1024 * 1024,
  /** File changes in one commit, and in a whole result. */
  changesPerCommit: 100_000,
  totalChanges: 500_000,
  /** A conflict diff; GitHub truncates check-run text far below this. */
  diffChars: 32 * 1024 * 1024,
  errorChars: 4096,
  pathBytes: 4096,
  symlinkTargetBytes: 4096,
  /** Pre-image blob ids handed to a job. */
  preimageBlobs: 50_000,
  /** Request body of one git upload-pack request (after gunzip). */
  uploadPackRequestBytes: 16 * 1024 * 1024,
  /** All a job may fetch from the server (a full electron checkout is ~1GB). */
  uploadPackBytes: 20 * 1024 * 1024 * 1024,
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
  for (const component of p.split('/')) {
    if (component === '' || component === '.' || component === '..') {
      fail(`${where}: path is not normalized`);
    }
    if (isDotGit(component)) fail(`${where}: path has a .git component`);
  }
  return p;
};

/** What the server knows about the blobs a job uploaded. */
export interface UploadedBlobs {
  /** The size of an uploaded blob, or undefined if it was not uploaded. */
  size(sha256: string): number | undefined;
  /** Reads a (small) uploaded blob. */
  read(sha256: string): Buffer;
}

const validateChange = (
  where: string,
  value: unknown,
  blobs: UploadedBlobs,
): SandboxFileChange => {
  if (!isRecord(value)) return fail(`${where}: expected an object`);
  const path = validateRepoPath(`${where}.path`, value.path);

  if ('deleted' in value) {
    checkKeys(where, value, ['path', 'deleted']);
    if (value.deleted !== true) fail(`${where}.deleted: expected true`);
    return { path, deleted: true };
  }

  checkKeys(where, value, ['path', 'mode', 'blob']);
  const { mode, blob } = value;
  if (mode !== '100644' && mode !== '100755' && mode !== '120000') {
    return fail(`${where}.mode: not an allowed file mode`);
  }
  if (typeof blob !== 'string' || !/^[0-9a-f]{64}$/.test(blob)) {
    return fail(`${where}.blob: not a SHA-256`);
  }
  const size = blobs.size(blob);
  if (size === undefined) return fail(`${where}.blob: was not uploaded`);

  if (mode === '120000') {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    if (NO_SYMLINK_BASENAMES.has(basename.toLowerCase())) {
      fail(`${where}: ${basename} must not be a symlink`);
    }
    if (size === 0 || size > LIMITS.symlinkTargetBytes) {
      fail(`${where}: invalid symlink target`);
    }
    if (blobs.read(blob).includes(0)) fail(`${where}: invalid symlink target`);
  }

  return { path, mode, blob };
};

const validateApplied = (
  where: string,
  value: unknown,
  includeChanges: boolean,
  blobs: UploadedBlobs,
  budget: { changes: number },
): SandboxApplied => {
  if (!isRecord(value)) return fail(`${where}: expected an object`);
  checkKeys(where, value, includeChanges ? ['changes'] : []);
  if (!includeChanges) return {};

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
    const change = validateChange(`${where}.changes[${i}]`, c, blobs);
    if (seen.has(change.path)) fail(`${where}: duplicate path ${change.path}`);
    seen.add(change.path);
    return change;
  });
  return { changes };
};

/**
 * Validates a sandbox job's result against what the server asked for. Throws
 * SandboxResultError for anything unexpected; the returned value contains
 * only validated data.
 */
export const validateSandboxResult = (
  value: unknown,
  expect: ResultExpectation,
  blobs: UploadedBlobs,
): SandboxResult => {
  if (!isRecord(value)) return fail('expected an object');

  switch (value.outcome) {
    case 'success': {
      checkKeys('result', value, ['outcome', 'attempt', 'applied']);
      const { attempt } = value;
      if (
        typeof attempt !== 'number' ||
        !Number.isInteger(attempt) ||
        attempt < 0 ||
        attempt >= expect.patchCounts.length
      ) {
        return fail('attempt: not one of the attempts');
      }
      if (!Array.isArray(value.applied)) return fail('applied: not an array');
      if (value.applied.length !== expect.patchCounts[attempt]) {
        fail(
          `results for ${value.applied.length} patches, expected ${expect.patchCounts[attempt]}`,
        );
      }
      const budget = { changes: 0 };
      const applied = value.applied.map((a: unknown, i) =>
        a === null
          ? null
          : validateApplied(
              `applied[${i}]`,
              a,
              expect.includeChanges,
              blobs,
              budget,
            ),
      );
      return { outcome: 'success', attempt, applied };
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
