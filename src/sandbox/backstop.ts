// A backstop against a compromised sandbox job, on top of the sandbox
// itself. A job only ever applies commits' own diffs (never their messages)
// and its result is only data, but if git or the merge driver were ever
// subverted from inside a job, it could report arbitrary file contents. So
// before pushing, the server checks what the job reports against what it
// knows from GitHub:
//  - every changed file is one the original commits touched (by GitHub's
//    file list and the diff's own headers), or where the target branch
//    renamed one of them, which `git am -3` follows;
//  - where the target branch had a file exactly as the original commit
//    found it (same blob and mode), the result is exactly what the original
//    commit made of it: its blob (GitHub's file list, or the diff's
//    abbreviated id where the list falls short) and its mode, or the
//    target's content for a change of mode only. `git am` applies the diff
//    as is there; a three-way merge result, where the two differ, can't be
//    predicted and is not checked.
// It never rejects a legitimate backport. All of it lives here and runs from
// one call in index.ts, so it can be removed in one place.

import { diffFiles, diffPaths } from './patches';
import type { SandboxApplied } from './protocol';

export interface OriginalFile {
  filename: string;
  previousFilename?: string;
  status: string;
  /** The file's blob id after the commit (GitHub's `sha`). */
  sha?: string | null;
}

export interface BackstopCommit {
  /** The commit's diff, as cut from its `.patch`. */
  diff: string;
  /** GitHub's list of the commit's files (it lists up to 3000). */
  files: OriginalFile[];
}

/** A file in a tree. */
export interface TreeFile {
  mode: string;
  id: string;
}

export interface BackstopContext {
  commits: BackstopCommit[];
  /** What the job reported for each commit (null: nothing to commit). */
  applied: (SandboxApplied | null)[];
  /** Paths the target branch renamed the commits' files to. */
  renamedOnTarget: () => Promise<Set<string>>;
  /** The files at these paths on the target branch tip (absent: none). */
  targetFiles: (paths: string[]) => Promise<Map<string, TreeFile>>;
  /** The git blob id of an uploaded blob. */
  gitBlobId: (sha256: string) => string;
}

export class BackstopError extends Error {}

export const checkBackstop = async (ctx: BackstopContext) => {
  // 1. Paths.
  const allowed = new Set<string>();
  for (const commit of ctx.commits) {
    for (const p of diffPaths(commit.diff)) allowed.add(p);
    for (const f of commit.files ?? []) {
      allowed.add(f.filename);
      if (f.previousFilename) allowed.add(f.previousFilename);
    }
  }
  const changed = ctx.applied.flatMap((a) =>
    (a?.changes ?? []).map((c) => c.path),
  );
  let outside = changed.filter((p) => !allowed.has(p));
  if (outside.length > 0) {
    const renamed = await ctx.renamedOnTarget();
    outside = outside.filter((p) => !renamed.has(p));
  }
  if (outside.length > 0) {
    throw new BackstopError(
      `the backport changed ${outside.slice(0, 5).join(', ')}, which none of its commits touch`,
    );
  }

  // 2. Contents, where the target had the file as the original commit did.
  const touched = [
    ...new Set(
      ctx.commits.flatMap((c) =>
        diffFiles(c.diff).flatMap((f) => [f.oldPath, f.newPath]),
      ),
    ),
  ].filter((p): p is string => !!p);
  const state = new Map<string, TreeFile | null>(touched.map((p) => [p, null]));
  for (const [p, f] of await ctx.targetFiles(touched)) state.set(p, f);

  for (const [i, commit] of ctx.commits.entries()) {
    const applied = ctx.applied[i];
    if (!applied?.changes) continue;
    const result = new Map<string, TreeFile | null>();
    for (const change of applied.changes) {
      result.set(
        change.path,
        'deleted' in change
          ? null
          : { mode: change.mode, id: ctx.gitBlobId(change.blob) },
      );
    }

    const files = diffFiles(commit.diff);
    for (const file of files) {
      // Renames and copies move content around; only check files that
      // stay where they are (or are added or deleted).
      if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
        continue;
      }
      // Submodules have always been pushed as deletions (see the
      // entrypoint), so there is nothing to compare.
      if (file.oldMode === '160000' || file.newMode === '160000') continue;
      const path = (file.newPath ?? file.oldPath)!;
      // A change of type (say, from a symlink to a file) is a deletion and
      // an addition of the same path: checked as one, at the addition.
      const removal = files.find(
        (f) => f !== file && f.oldPath === path && !f.newPath,
      );
      if (
        !file.newPath &&
        files.some((f) => f !== file && f.newPath === path)
      ) {
        continue;
      }
      const from = file.oldPath ? file : removal;

      // Did the target have the file just as the original commit found it?
      const before = state.get(path) ?? null;
      const same = !from
        ? before === null
        : before !== null &&
          (from.oldMode === undefined || before.mode === from.oldMode) &&
          (from.preimage
            ? before.id.startsWith(from.preimage)
            : // A change of mode only has no index line.
              !file.postimage);
      if (!same) continue;

      const after = result.has(path) ? result.get(path)! : before;
      let ok: boolean;
      if (!file.newPath) {
        ok = after === null;
      } else if (!file.postimage) {
        // A change of mode only: the target's content, the new mode.
        ok =
          after !== null &&
          before !== null &&
          after.id === before.id &&
          after.mode === (file.newMode ?? before.mode);
      } else {
        const original = commit.files.find(
          (f) => f.filename === path && f.status !== 'removed' && f.sha,
        );
        ok =
          after !== null &&
          after.mode === (file.newMode ?? before?.mode ?? '100644') &&
          after.id.startsWith(file.postimage) &&
          (!original || after.id === original.sha);
      }
      if (!ok) {
        throw new BackstopError(
          `the backport's ${path} differs from the original commit's, although the target branch had the same file`,
        );
      }
    }

    for (const [path, entry] of result) state.set(path, entry);
  }
};
