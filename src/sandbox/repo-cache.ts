import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Mutex } from 'async-mutex';

import { LogLevel } from '../enums';
import { gitAuthEnv, githubRemoteUrl } from '../utils/git-auth';
import { log } from '../utils/log-util';
import { assertValidBranchName, OBJECT_ID, runGit } from './git';
import { diffFiles, diffPaths } from './patches';
import { LIMITS, validateRepoPath } from './protocol';
import { SandboxInfraError } from './runner';

/**
 * Whether `p` is a valid repository path that `git cat-file --batch-check`
 * can be asked about (its input is one name per line).
 */
const batchable = (p: string) => {
  if (p.includes('\n')) return false;
  try {
    validateRepoPath('path', p);
    return true;
  } catch {
    return false;
  }
};

const baseDir =
  process.env.WORKING_DIR ?? path.resolve(os.tmpdir(), 'trop-working');

/** Where a job's base commit is pinned in the cache while the job runs. */
export const JOB_REF_PREFIX = 'refs/trop/jobs/';

/** A job's hold on a repo cache; release it when the job is over. */
export interface CacheLease {
  /** The bare cache, served (read-only) to the job. */
  dir: string;
  /** The target branch tip as fetched from GitHub. */
  baseSha: string;
  /** A ref pinning baseSha: the only ref the job's endpoint advertises. */
  ref: string;
  release: () => Promise<void>;
}

/**
 * A bare clone of one GitHub repository whose `refs/heads/*` mirror GitHub's
 * branches. It only ever receives objects from GitHub; sandbox jobs read from
 * it through a read-only upload-pack and never write to it.
 */
export class RepoCache {
  private static caches = new Map<string, RepoCache>();

  static for(slug: string) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ||
      slug.includes('..')
    ) {
      throw new Error(`Refusing to cache "${slug}"`);
    }
    let cache = RepoCache.caches.get(slug);
    if (!cache) {
      cache = new RepoCache(slug);
      RepoCache.caches.set(slug, cache);
    }
    return cache;
  }

  readonly dir: string;
  private readonly remoteUrl: string;
  // Serializes fetches, job ref updates and gc. Jobs read the cache through
  // upload-pack concurrently with fetches (git keeps that safe), but gc only
  // runs while no job is reading.
  private readonly mutex = new Mutex();
  private activeJobs = 0;

  /**
   * Use RepoCache.for(slug) to get the cache trop shares between jobs; the
   * options exist for specs, which stand in a local repository for GitHub.
   */
  constructor(
    readonly slug: string,
    opts: { dir?: string; remoteUrl?: string } = {},
  ) {
    this.dir = opts.dir ?? path.resolve(baseDir, slug, 'git-cache');
    this.remoteUrl = opts.remoteUrl ?? githubRemoteUrl(slug);
  }

  private git(args: string[], env?: Record<string, string>, input?: string) {
    // --git-dir: never discover a repository in a parent directory.
    return runGit([`--git-dir=${this.dir}`, ...args], { env, input });
  }

  private async ensureRepo() {
    let isBare = false;
    try {
      isBare =
        (await this.git(['rev-parse', '--is-bare-repository'])).trim() ===
        'true';
    } catch {}

    if (!isBare) {
      // Never pull the cache out from under a job that is reading it.
      if (this.activeJobs > 0) {
        throw new Error(`${this.dir} is not usable while jobs read it`);
      }
      // Missing or somehow corrupt: start over.
      log(
        'RepoCache',
        LogLevel.INFO,
        `${this.dir} is not a git repo, creating`,
      );
      await fs.promises.rm(this.dir, { recursive: true, force: true });
      await fs.promises.mkdir(this.dir, { recursive: true });
      await this.git(['init', '--bare', '--quiet']);
      await this.git(['remote', 'add', 'origin', this.remoteUrl]);
    } else {
      // Also rewrites the token-bearing URL of caches made by older trop.
      await this.git(['remote', 'set-url', 'origin', this.remoteUrl]);
    }
  }

  /**
   * Fetches every branch from GitHub, resolves `branch` and pins it under a
   * fresh job ref. Every pre-image blob a patch of the job may need lives on
   * some branch (the PR's base), hence all branches rather than just the
   * target.
   */
  async acquire(token: string, branch: string): Promise<CacheLease> {
    await assertValidBranchName(branch);

    return this.mutex.runExclusive(async () => {
      // Failing to set up or fetch the cache (GitHub or the network not
      // answering) is an internal failure, retried; a branch that doesn't
      // exist, below, is not.
      try {
        await this.ensureRepo();
        await this.git(
          [
            // gc runs separately, never while a job reads the cache.
            '-c',
            'gc.auto=0',
            '-c',
            'maintenance.auto=false',
            'fetch',
            '--quiet',
            '--prune',
            '--no-tags',
            '--no-recurse-submodules',
            'origin',
            '+refs/heads/*:refs/heads/*',
          ],
          gitAuthEnv(token),
        );
      } catch (error) {
        throw new SandboxInfraError(
          `Fetching ${this.slug} from GitHub failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const baseSha = (
        await this.git([
          'rev-parse',
          '--verify',
          `refs/heads/${branch}^{commit}`,
        ])
      ).trim();
      if (!OBJECT_ID.test(baseSha)) {
        throw new Error(`Could not resolve ${branch} in ${this.slug}`);
      }

      const ref = `${JOB_REF_PREFIX}${randomBytes(16).toString('hex')}`;
      await this.git(['update-ref', ref, baseSha]);
      this.activeJobs += 1;

      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await this.mutex.runExclusive(async () => {
          this.activeJobs -= 1;
          try {
            await this.git(['update-ref', '-d', ref]);
            if (this.activeJobs === 0) {
              await this.git(['gc', '--auto', '--quiet']);
            }
          } catch (error) {
            log('RepoCache', LogLevel.WARN, `Cleanup of ${ref} failed`, error);
          }
        });
      };

      return { dir: this.dir, baseSha, ref, release };
    });
  }

  /**
   * Resolves abbreviated object ids to the full ids of the blobs in the cache
   * they could name: one for a unique prefix, every candidate blob for an
   * ambiguous one (as `git am -3` picks among blobs itself), none if the
   * cache has no such blob. Only validated hex strings ever reach git here.
   */
  private async resolveBlobPrefixes(
    prefixes: string[],
  ): Promise<Map<string, string[]>> {
    const resolved = new Map<string, string[]>();
    const valid = prefixes.filter((p) => /^[0-9a-f]{4,64}$/.test(p));
    if (valid.length === 0) return resolved;

    const typesOf = async (names: string[]) =>
      (
        await this.git(
          ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
          undefined,
          names.join('\n') + '\n',
        )
      )
        .split('\n')
        .slice(0, names.length);

    const ambiguous: string[] = [];
    for (const [i, line] of (await typesOf(valid)).entries()) {
      const [oid, type] = line.split(' ');
      if (type === 'blob' && OBJECT_ID.test(oid)) {
        resolved.set(valid[i], [oid]);
      } else if (type === 'ambiguous') {
        ambiguous.push(valid[i]);
      }
    }
    for (const prefix of ambiguous) {
      let candidates: string[] = [];
      try {
        candidates = (await this.git(['rev-parse', `--disambiguate=${prefix}`]))
          .split('\n')
          .filter((c) => OBJECT_ID.test(c));
      } catch {}
      if (candidates.length === 0) continue;
      const blobs = (await typesOf(candidates))
        .map((line) => line.split(' '))
        .filter(([oid, type]) => type === 'blob' && OBJECT_ID.test(oid))
        .map(([oid]) => oid);
      if (blobs.length > 0) resolved.set(prefix, blobs);
    }
    return resolved;
  }

  /**
   * Resolves the abbreviated pre-image blob ids in the patches' `index` lines
   * to full ids, for the blobs the cache has.
   *
   * `git am -3` falls back to a three-way merge by looking these blobs up
   * locally by their abbreviated id, which a partial clone cannot fetch on
   * demand. The job therefore fetches them by full id up front.
   */
  async resolvePreimageBlobs(diffs: string[]): Promise<string[]> {
    const prefixes = new Set<string>();
    for (const diff of diffs) {
      for (const file of diffFiles(diff)) {
        if (prefixes.size >= LIMITS.preimageBlobs) break;
        if (file.oldPath && file.preimage) prefixes.add(file.preimage);
      }
    }
    const resolved = await this.resolveBlobPrefixes([...prefixes]);
    return [...new Set([...resolved.values()].flat())];
  }

  /**
   * Where the files the patches modify, rename away from or delete live on
   * the target branch at `baseSha`, if it renamed them: the paths `git am -3`
   * may legitimately write besides the patches' own.
   *
   * Recomputes what `git am -3` does, from the cache's own objects only: a
   * merge base made of the patches' pre-image blobs at their paths, and the
   * target tree. A pre-image path missing on the target is a rename source,
   * matched against the target's files with the same rename detection a
   * merge uses (50% similarity). The patches' paths below a directory the
   * target renamed are mapped too, should git follow the directory rename.
   */
  async renamedOnTarget(baseSha: string, diffs: string[]) {
    const targets = new Set<string>();
    if (!OBJECT_ID.test(baseSha)) return targets;

    const files = diffs
      .flatMap((d) => diffFiles(d))
      .flatMap((f) =>
        f.oldPath && f.preimage
          ? [
              {
                oldPath: f.oldPath,
                preimage: f.preimage,
                mode: f.oldMode ?? '100644',
              },
            ]
          : [],
      )
      .filter((f) => {
        if (!/^(100644|100755|120000)$/.test(f.mode)) return false;
        return batchable(f.oldPath);
      });
    if (files.length === 0) return targets;

    // Which of them the target does not have at that path.
    const presence = (
      await this.git(
        ['cat-file', '--batch-check=%(objecttype)'],
        undefined,
        files.map((f) => `${baseSha}:${f.oldPath}`).join('\n') + '\n',
      )
    ).split('\n');
    const missing = files.filter((_, i) => presence[i]?.endsWith(' missing'));
    if (missing.length === 0) return targets;

    const resolved = await this.resolveBlobPrefixes(
      missing.map((f) => f.preimage),
    );
    const base = missing
      .map((f) => ({ ...f, oid: resolved.get(f.preimage)?.[0] }))
      .filter((f): f is typeof f & { oid: string } => !!f.oid);
    if (base.length === 0) return targets;

    // The fake merge base goes into a scratch object directory (reading the
    // cache's objects through alternates), never into the cache itself.
    const scratch = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'trop-renames-'),
    );
    try {
      const env = {
        GIT_OBJECT_DIRECTORY: path.join(scratch, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(this.dir, 'objects'),
        GIT_INDEX_FILE: path.join(scratch, 'index'),
      };
      await fs.promises.mkdir(env.GIT_OBJECT_DIRECTORY);
      // A path git refuses for an index (and hence a tree) can't be renamed.
      await this.git(
        ['update-index', '-z', '--index-info'],
        env,
        base.map((f) => `${f.mode} ${f.oid}\t${f.oldPath}\0`).join(''),
      );
      const tree = (await this.git(['write-tree'], env)).trim();
      if (!OBJECT_ID.test(tree)) return targets;

      const renames = (
        await this.git(
          [
            'diff-tree',
            '-r',
            '-z',
            '--find-renames=50%',
            '-l0',
            '--diff-filter=R',
            '--name-status',
            tree,
            baseSha,
          ],
          env,
        )
      ).split('\0');
      // `R<score>` NUL old NUL new NUL, for each rename.
      const dirMoves = new Map<string, string>();
      for (let i = 0; i + 2 < renames.length; i += 3) {
        if (!renames[i].startsWith('R')) continue;
        const [from, to] = [renames[i + 1], renames[i + 2]];
        targets.add(to);
        const fromParts = from.split('/');
        const toParts = to.split('/');
        while (
          fromParts.length > 1 &&
          toParts.length > 1 &&
          fromParts[fromParts.length - 1] === toParts[toParts.length - 1]
        ) {
          fromParts.pop();
          toParts.pop();
        }
        const fromDir = fromParts.slice(0, -1).join('/');
        const toDir = toParts.slice(0, -1).join('/');
        if (fromDir !== toDir) dirMoves.set(fromDir, toDir);
      }
      for (const diff of diffs) {
        for (const p of diffPaths(diff)) {
          for (const [fromDir, toDir] of dirMoves) {
            const prefix = fromDir ? `${fromDir}/` : '';
            if (p.startsWith(prefix)) {
              targets.add(
                `${toDir ? `${toDir}/` : ''}${p.slice(prefix.length)}`,
              );
            }
          }
        }
      }
      return targets;
    } finally {
      await fs.promises.rm(scratch, { recursive: true, force: true });
    }
  }

  /** The files (mode and object id) at `paths` in `commit`, where any. */
  async filesAt(commit: string, paths: string[]) {
    const files = new Map<string, { mode: string; id: string }>();
    if (!OBJECT_ID.test(commit)) throw new Error(`not a commit id: ${commit}`);
    const wanted = new Set(paths);
    if (wanted.size === 0) return files;
    // The whole tree, rather than pathspecs: no quoting or length limits.
    const entries = (
      await this.git(['ls-tree', '-r', '-z', '--full-tree', commit])
    ).split('\0');
    for (const entry of entries) {
      const m = /^(\d{6}) (?:blob|commit) ([0-9a-f]+)\t([^]*)$/.exec(entry);
      if (m && wanted.has(m[3]) && OBJECT_ID.test(m[2])) {
        files.set(m[3], { mode: m[1], id: m[2] });
      }
    }
    return files;
  }
}
