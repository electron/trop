import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import * as simpleGit from 'simple-git/promise';
import * as commands from './commands';

const PATCH_NAME = 'current.patch';

const baseDir = path.resolve(os.tmpdir(), 'trop-working');
const getGit = (slug: string) => simpleGit(path.resolve(baseDir, slug));

const TROP_NAME = 'Electron Bot';
const TROP_EMAIL = 'electron@github.com';

const initRepo = async (details: { owner: string, repo: string }) => {
  const slug = `${details.owner}/${details.repo}`;
  const dir = path.resolve(baseDir, slug);
  await fs.mkdirp(dir);
  await fs.remove(dir);
  await fs.mkdirp(dir);
  const git = getGit(slug);
  await git.clone(
    `https://github.com/${slug}.git`,
    '.'
  );

  // Clean up scraps
  try { await (git as any).raw(['cherry-pick', '--abort']); } catch (e) {}
  try { await (git as any).raw(['am', '--abort']); } catch (e) {}
  await (git as any).reset('hard');
  const status = await git.status();
  for (const file of status.not_added) {
    await fs.remove(path.resolve(dir, file));
  }
  await git.checkout('master');
  await git.pull();
  await git.addConfig('user.email', TROP_EMAIL);
  await git.addConfig('user.name', TROP_NAME);
  await git.addConfig('commit.gpgsign', 'false');
  return { success: true };
}

const setUpRemotes = async (details: { slug: string, remotes: { name: string, value: string }[] }) => {
  const git = getGit(details.slug);

  // Add remotes
  for (const remote of details.remotes) {
    await git.addRemote(remote.name, remote.value);
  }

  // Fetch remotes
  for (const remote of details.remotes) {
    await (git as any).raw(['fetch', remote.name]);
  }
  return { success: true };
}

const backportCommitsToBranch = async (details: { slug: string, targetRemote: string, targetBranch: string, tempRemote: string, tempBranch: string, patches: string[] }) => {
  const git = getGit(details.slug);
  // Create branch
  await git.checkout(`target_repo/${details.targetBranch}`);
  await git.pull('target_repo', details.targetBranch);
  await git.checkoutBranch(details.tempBranch, `target_repo/${details.targetBranch}`);

  // Cherry pick
  const patchPath = path.resolve(baseDir, details.slug, PATCH_NAME);
  for (const patch of details.patches) {
    await fs.writeFile(patchPath, patch, 'utf8');
    await (git as any).raw(['am', PATCH_NAME]);
    await fs.remove(patchPath);
  }

  // Push
  await git.push(details.tempRemote, details.tempBranch, {
    '--set-upstream': true,
  });
  return { success: true };
}

export default async (options) => {
  console.info(`Instruction: ${options.what}`);
  switch (options.what) {
    case commands.INIT_REPO:
      return await initRepo(options.payload);
    case commands.SET_UP_REMOTES:
      return await setUpRemotes(options.payload);
    case commands.BACKPORT:
      return await backportCommitsToBranch(options.payload);
    default:
      throw new Error('wut u doin\' kiddo');
  }
}
