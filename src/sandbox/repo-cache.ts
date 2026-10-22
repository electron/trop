import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Mutex } from 'async-mutex';

import { LogLevel } from '../enums';
import { gitAuthEnv, githubRemoteUrl } from '../utils/git-auth';
import { log } from '../utils/log-util';
import { assertValidBranchName, OBJECT_ID, runGit } from './git';
import { LIMITS } from './protocol';

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
   * Resolves the abbreviated pre-image blob ids in the patches' `index` lines
   * to full ids, for the blobs the cache has.
   *
   * `git am -3` falls back to a three-way merge by looking these blobs up
   * locally by their abbreviated id, which a partial clone cannot fetch on
   * demand. The job therefore fetches them by full id up front. Only hex
   * strings extracted from the patch text ever reach git here.
   */
  async resolvePreimageBlobs(patches: string[]): Promise<string[]> {
    const prefixes = new Set<string>();
    for (const patch of patches) {
      for (const match of patch.matchAll(
        /^index ([0-9a-f]{7,64})\.\.[0-9a-f]{7,64}(?: [0-7]{6})?$/gm,
      )) {
        if (prefixes.size >= LIMITS.preimageBlobs) break;
        if (!/^0+$/.test(match[1])) prefixes.add(match[1]);
      }
    }
    if (prefixes.size === 0) return [];

    const output = await this.git(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      undefined,
      [...prefixes].join('\n') + '\n',
    );
    const blobs = new Set<string>();
    for (const line of output.split('\n')) {
      const [oid, type] = line.split(' ');
      if (type === 'blob' && OBJECT_ID.test(oid)) blobs.add(oid);
    }
    return [...blobs];
  }
}
