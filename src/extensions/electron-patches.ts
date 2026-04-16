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

  for (const patchesPath of getChangedPatchesFiles(patchContents)) {
    const patchDir = path.posix.dirname(patchesPath);
    const absPath = path.resolve(repoDir, patchesPath);
    const current = fs.existsSync(absPath)
      ? await fs.promises.readFile(absPath, 'utf8')
      : '';

    const isPatchFile = (f: string): boolean =>
      !f.startsWith('#') && f.endsWith('.patch');
    const newline = current.includes(crlf) ? crlf : lf;
    const newContent = current
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !isPatchFile(trimmed) ||
          fs.existsSync(path.resolve(repoDir, patchDir, trimmed))
        );
      })
      .join(newline);

    if (newContent === current) continue;

    log(
      'backportCommitsToBranch',
      LogLevel.INFO,
      `Applying .patches changes to ${patchesPath}`,
    );

    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, newContent, 'utf8');
    await git.add(patchesPath);
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
