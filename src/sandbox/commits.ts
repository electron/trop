import { isUtf8 } from 'buffer';

import { SimpleWebHookRepoContext, WebHookRepoContext } from '../types';
import { SandboxCommit } from './protocol';

export interface CreateBackportCommitsOptions {
  github: WebHookRepoContext['octokit'];
  context: SimpleWebHookRepoContext;
  /** The target branch tip the server itself resolved from GitHub. */
  baseSha: string;
  /** Validated commits from the sandbox, oldest first. */
  commits: SandboxCommit[];
  /** The branch to create for the backport PR. */
  tempBranch: string;
}

/**
 * Recreates the sandbox's commits on GitHub with the REST API (blobs, trees,
 * commits and finally the branch ref), parented on `baseSha`. The sandbox's
 * own commit objects are never used: only its validated file contents,
 * messages and authors.
 */
export const createBackportCommits = async ({
  github,
  context,
  baseSha,
  commits,
  tempBranch,
}: CreateBackportCommitsOptions) => {
  let baseCommitSha = baseSha;
  const baseTree = await github.git.getCommit(
    context.repo({ commit_sha: baseCommitSha }),
  );
  let baseTreeSha = baseTree.data.sha;

  for (const commit of commits) {
    if (!commit.changes) throw new Error('Commit has no changes to push');

    const newTree = await github.git.createTree(
      context.repo({
        base_tree: baseTreeSha,
        tree: await Promise.all(
          commit.changes.map(async (change) => {
            if ('deleted' in change) {
              return {
                path: change.path,
                mode: '100644' as const,
                type: 'blob' as const,
                sha: null,
              };
            }

            const contents = Buffer.from(change.content, 'base64');
            // A symlink is stored as a blob holding its target, which is
            // never resolved: the sandbox read it from the commit's tree.
            if (change.mode === '120000') {
              return {
                path: change.path,
                mode: change.mode,
                type: 'blob' as const,
                content: contents.toString('utf8'),
              };
            }

            if (isUtf8(contents)) {
              return {
                path: change.path,
                mode: change.mode,
                type: 'blob' as const,
                content: contents.toString('utf-8'),
              };
            }

            const blob = await github.git.createBlob(
              context.repo({
                content: change.content,
                encoding: 'base64',
              }),
            );
            return {
              path: change.path,
              mode: change.mode,
              type: 'blob' as const,
              sha: blob.data.sha,
            };
          }),
        ),
      }),
    );

    const newMessage = `${commit.message.trim()}\n\nCo-authored-by: ${commit.author.name} <${commit.author.email}>`;

    const newCommit = await github.git.createCommit(
      context.repo({
        parents: [baseCommitSha],
        tree: newTree.data.sha,
        message: newMessage,
      }),
    );

    baseTreeSha = newTree.data.sha;
    baseCommitSha = newCommit.data.sha;
  }

  await github.git.createRef(
    context.repo({
      sha: baseCommitSha,
      ref: `refs/heads/${tempBranch}`,
    }),
  );
};
