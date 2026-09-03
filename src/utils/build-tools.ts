import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { LogLevel } from '../enums';
import { log } from './log-util';

const execFileAsync = promisify(execFile);

// trop's repository root: this module lives at src/utils/ (tests) or
// lib/utils/ (build output), both two levels below it.
const tropRoot = path.resolve(__dirname, '..', '..');

// electron/build-tools is vendored into `.build-tools/` by
// scripts/ensure-build-tools.js (trop's postinstall) at the commit pinned in
// package.json, which is the single source of truth for the pin.
export const BUILD_TOOLS_DIR = path.join(tropRoot, '.build-tools');
export const BUILD_TOOLS_SHA: string = JSON.parse(
  fs.readFileSync(path.join(tropRoot, 'package.json'), 'utf8'),
).buildTools.sha;

// The compiled `e register-patches-merge-driver` subcommand. It is invoked
// directly, the same way the `e` dispatcher spawns its subcommands, so that
// neither the self-updater nor the Python prerequisite check of `e` itself
// runs on the bot.
const registerScript = path.join(
  BUILD_TOOLS_DIR,
  'dist',
  'e-register-patches-merge-driver.js',
);

/**
 * Registers build-tools' list-aware merge driver for `patches/**\/.patches`
 * files in the git checkout at `dir`: repo-local `merge.patches-list.*`
 * config plus a `merge=patches-list` attribute in `.git/info/attributes`
 * that overrides the `merge=union` electron commits in `.gitattributes`.
 *
 * `git am -3` honours the driver when it falls back to a three-way merge, so
 * a backported commit whose `.patches` list diverged from the target branch
 * gets a merged list without resurrected deletions or duplicate entries.
 *
 * Throws if registration fails: without the driver a backport could land a
 * broken `.patches` file, so the caller must not proceed.
 *
 * @param dir - the git checkout to register the driver in
 */
export const registerPatchesMergeDriver = async (dir: string) => {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [registerScript, dir],
      { timeout: 60_000 },
    );
    log(
      'registerPatchesMergeDriver',
      LogLevel.INFO,
      `Registered build-tools' .patches merge driver in ${dir}: ${stdout.trim()}`,
    );
  } catch (error) {
    // execFile errors already carry the child's stderr in their message.
    const reason = error instanceof Error ? error.message : String(error);
    const message =
      `Failed to register build-tools' .patches merge driver in ${dir} ` +
      `(build-tools ${BUILD_TOOLS_SHA} at ${BUILD_TOOLS_DIR}; ` +
      `run \`yarn install\` to (re)build it): ${reason}`;
    log('registerPatchesMergeDriver', LogLevel.ERROR, message);
    throw new Error(message);
  }
};
