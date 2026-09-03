#!/usr/bin/env node
// Vendors electron/build-tools into `.build-tools/` at the commit pinned in
// package.json (`buildTools.sha`) and builds it, so that trop can register
// build-tools' `.patches` list merge driver on every backport clone (see
// src/utils/build-tools.ts).
//
// Runs as trop's `postinstall`. The npm package `@electron/build-tools` is an
// installer whose `preinstall` clones the repo into $HOME; yarn 4 never runs
// dependency lifecycle scripts here (`enableScripts: false`), so the checkout
// is made explicitly instead. Idempotent: a checkout that already matches the
// pin and has a built driver is left alone.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { repository, sha } = require('../package.json').buildTools;
const buildToolsDir = path.join(root, '.build-tools');
const stampFile = path.join(buildToolsDir, '.trop-build-tools-sha');
const driverScript = path.join(buildToolsDir, 'dist', 'e-patch-merge-driver.js');

const run = (command, args, cwd) => {
  const env = { ...process.env };
  // Do not leak the parent yarn's package-scoped environment into the nested
  // yarn that installs build-tools' own dependencies.
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_')) delete env[key];
  }
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `"${[path.basename(command), ...args].join(' ')}" exited with ${result.status}`,
    );
  }
};

const isUpToDate = () =>
  fs.existsSync(stampFile) &&
  fs.readFileSync(stampFile, 'utf8').trim() === sha &&
  fs.existsSync(driverScript);

const main = () => {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`package.json buildTools.sha must be a full commit SHA, got "${sha}"`);
  }
  if (isUpToDate()) {
    console.log(`build-tools ${sha} is already built in ${buildToolsDir}`);
    return;
  }

  console.log(`Fetching build-tools ${sha} into ${buildToolsDir}`);
  fs.rmSync(buildToolsDir, { recursive: true, force: true });
  fs.mkdirSync(buildToolsDir, { recursive: true });
  run('git', ['init', '-q'], buildToolsDir);
  run('git', ['fetch', '-q', '--depth', '1', repository, sha], buildToolsDir);
  run(
    'git',
    ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', 'FETCH_HEAD'],
    buildToolsDir,
  );

  // build-tools pins its own yarn release; use it rather than whatever is on PATH.
  const releases = path.join(buildToolsDir, '.yarn', 'releases');
  const yarnRelease = fs.readdirSync(releases).find((f) => /^yarn-.*\.c?js$/.test(f));
  if (!yarnRelease) {
    throw new Error(`No yarn release found in ${releases}`);
  }
  const yarn = path.join(releases, yarnRelease);

  console.log('Installing and building build-tools');
  run(process.execPath, [yarn, 'install', '--immutable'], buildToolsDir);
  run(process.execPath, [yarn, 'run', 'build'], buildToolsDir);

  if (!fs.existsSync(driverScript)) {
    throw new Error(`build-tools build did not produce ${driverScript}`);
  }
  fs.writeFileSync(stampFile, `${sha}\n`);
  console.log(`build-tools ${sha} is ready in ${buildToolsDir}`);
};

try {
  main();
} catch (error) {
  console.error(
    `Failed to vendor electron/build-tools at ${sha}: ${error.message}\n` +
      'trop needs build-tools to register its .patches merge driver on backport clones; ' +
      'git and network access to github.com are required at install time.',
  );
  process.exit(1);
}
