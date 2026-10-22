// The sandbox job: applies a backport's patches with git and reports the
// result to the trop server. It runs in an ephemeral pod (or, for local
// development and specs, a child process) that has no credentials, no
// service-account token, no DNS and no network peer other than the server's
// internal port, and it treats everything it handles as untrusted.
//
// Kept free of runtime imports from the rest of trop (types only) so that it
// runs both compiled and, in specs, straight from source.

import { isUtf8 } from 'buffer';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type {
  SandboxCommit,
  SandboxFileChange,
  SandboxInputs,
  SandboxResult,
} from './protocol';

const GIT_TIMEOUT_MS = 10 * 60 * 1000;

// Used only until the inputs (which carry the server's limits) are read.
const FALLBACK_ERROR_CHARS = 1000;
const PREFETCH_BATCH = 1000;

/** git's NUL-separated output as strings; paths must be UTF-8 for GitHub. */
const nulSeparated = (output: Buffer) => {
  if (!isUtf8(output)) throw new Error('git output is not UTF-8');
  return output.toString('utf8').split('\0').filter(Boolean);
};

interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

const main = async () => {
  const serverUrl = process.env.TROP_SANDBOX_URL;
  const token = process.env.TROP_SANDBOX_TOKEN;
  if (!serverUrl || !token) throw new Error('missing sandbox job settings');
  // Nothing the job spawns needs to see these.
  delete process.env.TROP_SANDBOX_URL;
  delete process.env.TROP_SANDBOX_TOKEN;

  if (
    !/^http:\/\/[0-9a-fA-F.:[\]]+(?::\d+)?\/jobs\/[0-9a-f]{32}$/.test(serverUrl)
  ) {
    throw new Error('unexpected sandbox server URL');
  }
  const repoUrl = `${serverUrl}/repo.git`;
  const authorization = `Bearer ${token}`;

  const workRoot = process.env.TROP_SANDBOX_WORKDIR ?? '/work';
  const buildToolsDir = process.env.TROP_BUILD_TOOLS_DIR ?? '/app/.build-tools';
  const work = await fs.promises.mkdtemp(path.join(workRoot, 'job-'));
  const home = path.join(work, 'home');
  const repo = path.join(work, 'repo');
  const patchDir = path.join(work, 'patches');
  for (const dir of [home, repo, patchDir]) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  const post = async (result: SandboxResult) => {
    const response = await fetch(`${serverUrl}/result`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(result),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(
        `server rejected the result: ${response.status} ${await response.text()}`,
      );
    }
  };

  let errorChars = FALLBACK_ERROR_CHARS;
  try {
    const inputsResponse = await fetch(`${serverUrl}/inputs`, {
      headers: { authorization },
      redirect: 'error',
    });
    if (!inputsResponse.ok) {
      throw new Error(`fetching inputs failed: ${inputsResponse.status}`);
    }
    const inputs = (await inputsResponse.json()) as SandboxInputs;
    if (inputs.version !== 1) throw new Error('unsupported inputs version');
    errorChars = inputs.limits.errorChars;

    // Hardened configuration for every git process, passed through the
    // environment: nothing from system or global config, no hooks, no
    // credential helpers, no submodules, and the only allowed transport is
    // http to the server (with the job token scoped to the job's URL).
    const config: [string, string][] = [
      ['protocol.allow', 'never'],
      ['protocol.http.allow', 'always'],
      ['protocol.version', '2'],
      [`http.${repoUrl}.extraHeader`, `Authorization: ${authorization}`],
      ['http.followRedirects', 'false'],
      ['credential.helper', ''],
      ['core.hooksPath', '/dev/null'],
      ['core.fsmonitor', 'false'],
      ['submodule.recurse', 'false'],
      ['fetch.recurseSubmodules', 'false'],
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      ['user.name', inputs.committer.name],
      ['user.email', inputs.committer.email],
    ];
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: home,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_COUNT: String(config.length),
      ...Object.fromEntries(
        config.flatMap(([key, value], i) => [
          [`GIT_CONFIG_KEY_${i}`, key],
          [`GIT_CONFIG_VALUE_${i}`, value],
        ]),
      ),
    };

    const run = (
      command: string,
      args: string[],
      input?: string | Buffer,
      cwd = repo,
    ) =>
      new Promise<GitResult>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: GIT_TIMEOUT_MS,
        });
        const stdout: Buffer[] = [];
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => stdout.push(d));
        child.stderr.on('data', (d: Buffer) => {
          if (stderr.length < 64 * 1024) stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) =>
          resolve({ code, stdout: Buffer.concat(stdout), stderr }),
        );
        child.stdin.end(input);
      });
    const git = async (args: string[], input?: string | Buffer) => {
      const result = await run('git', args, input);
      if (result.code !== 0) {
        throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
      }
      return result.stdout;
    };

    const { baseSha } = inputs;
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(baseSha)) {
      throw new Error('invalid base commit');
    }

    // A shallow, blob-less fetch of just the base commit; checking it out
    // fetches the blobs it needs.
    await git(['init', '--quiet', '--template=', '.']);
    await git(['remote', 'add', 'origin', repoUrl]);
    await git([
      'fetch',
      '--quiet',
      '--no-tags',
      '--depth=1',
      '--filter=blob:none',
      'origin',
      baseSha,
    ]);
    await git(['checkout', '--quiet', '--detach', baseSha]);

    // The pre-image blobs `git am -3` looks up by abbreviated id.
    const blobs = inputs.preimageBlobs.filter((oid) =>
      /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid),
    );
    for (let i = 0; i < blobs.length; i += PREFETCH_BATCH) {
      await git(
        [
          '-c',
          'fetch.negotiationAlgorithm=noop',
          'fetch',
          '--quiet',
          'origin',
          '--no-tags',
          '--no-write-fetch-head',
          '--recurse-submodules=no',
          '--filter=blob:none',
          '--stdin',
        ],
        blobs.slice(i, i + PREFETCH_BATCH).join('\n') + '\n',
      );
    }

    // build-tools' list-aware merge driver for patches/**/.patches, as trop
    // has always registered it on the clone it backports in.
    const register = await run(
      process.execPath,
      [
        path.join(buildToolsDir, 'dist', 'e-register-patches-merge-driver.js'),
        repo,
      ],
      undefined,
      work,
    );
    if (register.code !== 0) {
      throw new Error(
        `registering the .patches merge driver failed: ${register.stderr.trim()}`,
      );
    }

    const head = async () =>
      (await git(['rev-parse', 'HEAD'])).toString('utf8').trim();

    let lastDiff = '';
    for (const [attemptIndex, attempt] of inputs.attempts.entries()) {
      await run('git', ['am', '--abort']);
      await git(['reset', '--quiet', '--hard', baseSha]);
      await git(['clean', '--quiet', '-ffdx']);

      // The commit each patch made, or null for a patch that turned out to
      // be on the target already (`git am` then makes no commit).
      const made: (string | null)[] = [];
      let applied = true;
      for (const [i, patch] of attempt.patches.entries()) {
        const patchPath = path.join(patchDir, `${attemptIndex}-${i}.patch`);
        await fs.promises.writeFile(patchPath, patch, 'utf8');
        const before = await head();
        const am = await run('git', ['am', '-3', '--keep-cr', patchPath]);
        if (am.code !== 0) {
          applied = false;
          break;
        }
        const after = await head();
        if (after === before) {
          made.push(null);
          continue;
        }
        // One patch, one commit: an mbox that git splits into several
        // messages is not a patch GitHub would have served for a commit.
        const parent = (await git(['rev-parse', `${after}^`]))
          .toString('utf8')
          .trim();
        if (parent !== before) {
          throw new Error(`patch ${i} made more than one commit`);
        }
        made.push(after);
      }

      if (!applied) {
        const diff = (await git(['diff'])).toString('utf8');
        lastDiff = diff.slice(0, inputs.limits.diffChars);
        continue;
      }

      const commits: (SandboxCommit | null)[] = [];
      for (const hash of made) {
        commits.push(
          hash ? await describeCommit(git, hash, inputs.includeChanges) : null,
        );
      }
      await post({ outcome: 'success', attempt: attemptIndex, commits });
      return;
    }

    await post({ outcome: 'conflict', diff: lastDiff });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await post({ outcome: 'error', message: message.slice(0, errorChars) });
  }
};

type Git = (args: string[], input?: string | Buffer) => Promise<Buffer>;

/** A commit `git am` made, with its changed files if asked for. */
const describeCommit = async (
  git: Git,
  hash: string,
  includeChanges: boolean,
): Promise<SandboxCommit> => {
  const [name, email, date, message] = (
    await git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%B', hash])
  )
    .toString('utf8')
    .split('\0');
  const commit: SandboxCommit = {
    message: message ?? '',
    author: { name: name.trim(), email: email.trim(), date: date.trim() },
  };
  if (includeChanges) commit.changes = await collectChanges(git, hash);
  return commit;
};

/**
 * The files a commit changed, read from the commit's own tree (never from
 * the working tree, so a symlink is reported as a link and never followed).
 */
const collectChanges = async (
  git: Git,
  hash: string,
): Promise<SandboxFileChange[]> => {
  // `:oldmode newmode oldoid newoid status` NUL path NUL, for each file.
  const raw = nulSeparated(
    await git([
      'diff-tree',
      '--no-commit-id',
      '--no-renames',
      '--no-abbrev',
      '-r',
      '-z',
      '--raw',
      hash,
    ]),
  );
  const entries: { path: string; mode: string; oid: string }[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const match = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/.exec(
      raw[i],
    );
    if (!match) throw new Error(`unexpected diff-tree output: ${raw[i]}`);
    entries.push({ path: raw[i + 1], mode: match[1], oid: match[2] });
  }

  const files = entries.filter(
    (e) => e.mode === '100644' || e.mode === '100755' || e.mode === '120000',
  );
  const blobs = await readBlobs(
    git,
    files.map((f) => f.oid),
  );

  return entries.map((entry): SandboxFileChange => {
    // Deleted (mode 000000) - or a submodule (gitlink), which trop has
    // always backported as a deletion: its checkout is an empty directory,
    // not a file.
    if (entry.mode === '000000' || entry.mode === '160000') {
      return { path: entry.path, deleted: true };
    }
    if (
      entry.mode !== '100644' &&
      entry.mode !== '100755' &&
      entry.mode !== '120000'
    ) {
      throw new Error(`unexpected mode ${entry.mode} for ${entry.path}`);
    }
    return {
      path: entry.path,
      mode: entry.mode,
      content: blobs.get(entry.oid)!.toString('base64'),
    };
  });
};

/** The contents of `oids`, read with a single `git cat-file --batch`. */
const readBlobs = async (git: Git, oids: string[]) => {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) return blobs;
  const out = await git(['cat-file', '--batch'], oids.join('\n') + '\n');
  let offset = 0;
  for (const oid of oids) {
    const newline = out.indexOf(0x0a, offset);
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(
      out.subarray(offset, newline).toString('utf8'),
    );
    if (newline < 0 || !match || match[1] !== oid) {
      throw new Error(`could not read blob ${oid}`);
    }
    const start = newline + 1;
    const end = start + Number(match[2]);
    blobs.set(oid, out.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
};

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('trop sandbox job failed:', error);
    process.exit(1);
  },
);
