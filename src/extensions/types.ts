import type { SimpleGit } from 'simple-git';

export interface BackportExtension {
  name: string;
  /** Called after a successful `git am` apply. May amend the commit. */
  afterApply(opts: {
    git: SimpleGit;
    dir: string;
    patch: string;
  }): Promise<void>;
}
