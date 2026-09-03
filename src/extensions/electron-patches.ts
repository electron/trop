import * as fs from 'fs';
import * as path from 'path';
import { SimpleGit } from 'simple-git';
import { log } from '../utils/log-util';
import { LogLevel } from '../enums';
import type { BackportExtension } from './types';

// patch content --> array of .patches files that the patch changed
const getChangedPatchesFiles = (patchContents: string): string[] => {
  const regex = /^diff --git a\/(.+) b\/(.+)$/gm; // diff --git a/src/foo.ts b/src/foo.ts
  return [...patchContents.matchAll(regex)]
    .map(([line, , file]) => file)
    .filter((file) => path.posix.basename(file) === '.patches')
    .filter((file, idx, arr) => arr.indexOf(file) === idx); // no dupes
};

// Is `child` the same as, or nested inside, `parent`? Purely lexical — both
// paths must already be resolved/absolute.
const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// `.patches` file paths come straight out of untrusted patch text, so a
// malicious commit can point them at a symlink (mode 120000) or use `..` to
// escape the working tree. Resolve the path defensively and confirm it is a
// regular file that lives inside the repo — following no symbolic links along
// the way — before we ever read or overwrite it. Returns the safe absolute
// path, or null if the path should be skipped.
const resolveSafePatchesPath = (
  repoRealDir: string,
  patchesPath: string,
): string | null => {
  const absPath = path.resolve(repoRealDir, patchesPath);

  // Reject anything that lexically escapes the working tree (e.g. via `..`).
  if (!isInside(repoRealDir, absPath)) {
    return null;
  }

  // Walk every path component and reject if any of them is a symbolic link.
  // This defeats both a symlinked `.patches` file and a symlinked parent
  // directory that would otherwise redirect the write outside the repo.
  let cursor = repoRealDir;
  const segments = path.relative(repoRealDir, absPath).split(path.sep);
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    cursor = path.join(cursor, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch {
      // Component does not exist yet (the `.patches` file or its parent dirs
      // may be created later) — nothing to follow, so this segment is safe.
      continue;
    }
    if (stats.isSymbolicLink()) {
      return null;
    }
  }

  // If the target already exists it must be a regular file, never a symlink,
  // FIFO, device, directory, etc.
  if (fs.existsSync(absPath) && !fs.lstatSync(absPath).isFile()) {
    return null;
  }

  return absPath;
};

// Read a file without following a symlink as its final component. Returns ''
// when the file does not exist, or null if the path is (or raced into being) a
// symbolic link. The O_NOFOLLOW flag closes the TOCTOU gap between the path
// validation above and the actual read.
const readFileNoFollow = async (absPath: string): Promise<string | null> => {
  let fd: fs.promises.FileHandle;
  try {
    fd = await fs.promises.open(
      absPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '';
    if (code === 'ELOOP') return null;
    throw err;
  }
  try {
    return await fd.readFile('utf8');
  } finally {
    await fd.close();
  }
};

// Write a file without following a symlink as its final component, returning
// false if the target is (or raced into being) a symbolic link.
const writeFileNoFollow = async (
  absPath: string,
  content: string,
): Promise<boolean> => {
  let fd: fs.promises.FileHandle;
  try {
    fd = await fs.promises.open(
      absPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        fs.constants.O_NOFOLLOW,
      0o644,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') return false;
    throw err;
  }
  try {
    await fd.writeFile(content, 'utf8');
    return true;
  } finally {
    await fd.close();
  }
};

// Handles a special case for Electron `.patches` files: `git am` can pull
// in extra context lines. But this breaks us because those extra lines
// are for .patch files that don't exist in the target branch.
// This function removes those lines.
const applyPatchesChanges = async (
  git: SimpleGit,
  repoDir: string,
  patchContents: string,
): Promise<void> => {
  const crlf = '\r\n';
  const lf = '\n';
  let shouldAmend = false;

  // Resolve the working tree once so symlinked path components can be compared
  // against its canonical location.
  const repoRealDir = fs.realpathSync(repoDir);

  for (const patchesPath of getChangedPatchesFiles(patchContents)) {
    const patchDir = path.posix.dirname(patchesPath);
    const absPath = resolveSafePatchesPath(repoRealDir, patchesPath);
    if (absPath === null) {
      log(
        'backportCommitsToBranch',
        LogLevel.WARN,
        `Refusing to process untrusted .patches path outside the working tree or via a symlink: ${patchesPath}`,
      );
      continue;
    }
    const current = await readFileNoFollow(absPath);
    if (current === null) {
      log(
        'backportCommitsToBranch',
        LogLevel.WARN,
        `Refusing to read .patches file through a symlink: ${patchesPath}`,
      );
      continue;
    }

    const isPatchFile = (f: string): boolean =>
      !f.startsWith('#') && f.endsWith('.patch');
    const newline = current.includes(crlf) ? crlf : lf;
    const newContent = current
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (!isPatchFile(trimmed)) return true;
        // `trimmed` is sibling-file content from the (untrusted) patch; only
        // probe paths that stay within the working tree.
        const candidate = path.resolve(repoRealDir, patchDir, trimmed);
        return isInside(repoRealDir, candidate) && fs.existsSync(candidate);
      })
      .join(newline);

    if (newContent === current) continue;

    log(
      'backportCommitsToBranch',
      LogLevel.INFO,
      `Applying .patches changes to ${patchesPath}`,
    );

    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    if (!(await writeFileNoFollow(absPath, newContent))) {
      log(
        'backportCommitsToBranch',
        LogLevel.WARN,
        `Refusing to write .patches file through a symlink: ${patchesPath}`,
      );
      continue;
    }
    // Stage via a raw invocation with an explicit end-of-options separator and
    // the validated absolute path. The untrusted patch-derived path may begin
    // with a dash (e.g. `--foo/.patches`); without `--`, git would parse it as
    // a command-line option rather than a pathspec (CWE-88 argument injection).
    await git.raw(['add', '--', absPath]);
    shouldAmend = true;
  }

  if (shouldAmend) await git.raw(['commit', '--amend', '--no-edit']);
};

export const electronPatchesExtension: BackportExtension = {
  name: 'electron-patches',

  async afterApply({ git, dir, patch }) {
    await applyPatchesChanges(git, dir, patch);
  },
};
