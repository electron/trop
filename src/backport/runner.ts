import * as express from 'express';
import * as fs from 'fs-extra';
import * as bodyParser from 'body-parser';
import * as path from 'path';
import * as simpleGit from 'simple-git/promise';

import * as commands from './commands';

const app = express();
app.use(bodyParser.json());

const baseDir = path.resolve(__dirname, '..', '..', 'working');
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
  await (git as any).reset('hard');
  const status = await git.status();
  for (const file of status.not_added) {
    await fs.remove(path.resolve(dir, file));
  }
  await git.checkout('master');
  await git.pull();
  await git.addConfig('user.email', TROP_EMAIL);
  await git.addConfig('user.name', TROP_NAME);
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

const backportCommitsToBranch = async (details: { slug: string, targetRemote: string, targetBranch: string, tempRemote: string, tempBranch: string, commits: string[] }) => {
  const git = getGit(details.slug);
  // Create branch
  await git.checkout(`target_repo/${details.targetBranch}`);
  await git.pull('target_repo', details.targetBranch);
  await git.checkoutBranch(details.tempBranch, `target_repo/${details.targetBranch}`);

  // Cherry pick
  await (git as any).raw(['cherry-pick', ...details.commits]);

  // Push
  await git.push(details.tempRemote, details.tempBranch, {
    '--set-upstream': true,
  });
  return { success: true };
}

app.get('/up', (req, res) => res.send('OK'));

app.post('/', async (req, res) => {
  try {
    console.info(`Instruction: ${req.body.what}`);
    switch (req.body.what) {
      case commands.INIT_REPO:
        return res.json(await initRepo(req.body.payload));
      case commands.SET_UP_REMOTES:
        return res.json(await setUpRemotes(req.body.payload));
      case commands.BACKPORT:
        return res.json(await backportCommitsToBranch(req.body.payload));
      case commands.FRESH:
        res.json({});
        console.info('Self killing');
        process.exit(1);
        return;
      default:
        res.status(404).json({ error: 'wut u doin\' kiddo' });
    }
  } catch (err) {
    res.status(500).json({ message: err.message, stack: err.stack });
  }
});

app.listen(4141, () => {
  console.log('Listening on port 4141');
});
