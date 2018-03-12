import * as GitHub from '@octokit/rest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as simpleGit from 'simple-git/promise';

import { Probot, ProbotContext, Label, PullRequestEvent, Repository } from './Probot';
import queue from './Queue';

const baseDir = path.resolve(__dirname, '..', '..', 'working');
const getGit = (slug: string) => simpleGit(path.resolve(baseDir, slug));

const TROP_NAME = 'Electron Bot';
const TROP_EMAIL = 'electron@github.com';

export const initRepo = async (owner: string, repo: string) => {
  const slug = `${owner}/${repo}`;
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
}

const TARGET_LABEL_PREFIX = 'target/';
const MERGED_LABEL_PREFIX = 'merged/';

const labelToTargetBranch = (label: Label, targetLabelPrefix: string) => {
  return label.name.replace(targetLabelPrefix, '');
}

const tokenFromContext = (robot: any, context: any) => {
  return robot.cache.get(`app:${context.payload.installation.id}:token`) as string;
}

const getGitHub = () => {
  const g = new GitHub();
  g.authenticate({
    type: 'token',
    token: process.env.GITHUB_FORK_USER_TOKEN,
  });
  return g;
}

export const backportPR = async (robot: Probot, context: ProbotContext<PullRequestEvent>, label: Label) => {
  const config = await context.config('config.yml');
  const targetLabelPrefix = config.targetLabelPrefix || TARGET_LABEL_PREFIX;
  const mergedLabelPrefix = config.mergedLabelPrefix || MERGED_LABEL_PREFIX;

  if (!label.name.startsWith(targetLabelPrefix)) return;
  const base = context.payload.pull_request.base;
  const head = context.payload.pull_request.base;
  const slug = `${base.repo.owner.login}/${base.repo.name}`;
  const targetBranch = labelToTargetBranch(label, targetLabelPrefix);  
  const bp = `backport from PR #${context.payload.pull_request.number} to "${targetBranch}"`;
  robot.log(`Queuing ${bp} for "${slug}"`);

  const log = (...args: string[]) => robot.log(slug, ...args);

  queue.enterQueue(async () => {
    log(`Executing ${bp} for "${slug}"`);
    const pr = context.payload.pull_request;
    // Set up empty repo on master
    log('Setting up local repository');
    await initRepo(base.repo.owner.login, base.repo.name);
    log('Working directory cleaned');
    const git = getGit(slug);

    // Fork repository to trop
    log('forking base repo');
    const gh = getGitHub();
    const fork: Repository = (await gh.repos.fork({
      owner: base.repo.owner.login,
      repo: base.repo.name,
    })).data;
    let forkReady = false;
    let attempt = 0;
    while (!forkReady && attempt < 20) {
      log(`testing fork - Attempt ${attempt + 1}/20`);
      try {
        const { data } = await gh.repos.getCommits({
          owner: fork.owner.login,
          repo: fork.name,
        });
        forkReady = data.length > 0;
      } catch (err) {
        // Ignore
      }
      attempt += 1;
      if (!forkReady) await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (attempt >= 20) {
      log('fork wasn\'t ready fast enough, giving up');
      throw new Error('Not ready in time');
    }
    log('fork ready');

    // Set up remotes
    log('setting up remotes');
    await git.addRemote('target_repo', `https://github.com/${slug}.git`);
    await git.addRemote('source_repo', `https://github.com/${head.repo.owner.login}/${head.repo.name}.git`);
    await git.addRemote('fork', `https://${fork.owner.login}:${process.env.GITHUB_FORK_USER_TOKEN}@github.com/${fork.owner.login}/${fork.name}.git`);

    // Fetch remotes
    log('fetching target remote');
    await (git as any).raw(['fetch', 'target_repo']);
    log('fetching source remote');
    await (git as any).raw(['fetch', 'source_repo']);
    log('fetching fork remote');
    await (git as any).raw(['fetch', 'fork']);

    // Get list of commits
    log(`Getting rev list from: ${pr.base.sha}..${pr.head.sha}`);
    const commits = (await context.github.pullRequests.getCommits(context.repo({
      number: pr.number,
    }))).data.map(commit => commit.sha);

    // No commits == WTF
    if (commits.length === 0) {
      log('Found no commits to backport, aborting');
      return;
    } else if (commits.length >= 240) {
      // Over 240 commits is probably the limit from github so let's not bother
      log(`Way to many commits (${commits.length})... Giving up`);
      await context.github.issues.createComment(context.repo({
        number: pr.number,
        body: `This PR has wayyyy too many commits to automatically backport, please do this manually`,
      }) as any);

      return;
    }
    log(`Found ${commits.length} commits to backport`);

    // Temp branch on the fork
    const tempBranch = `${targetBranch}-bp-${pr.title.replace(/ /g, '-').toLowerCase()}-${Date.now()}`;
    await git.checkout(`fork/${targetBranch}`);
    await git.pull('fork', targetBranch);
    await git.checkoutBranch(tempBranch, `fork/${targetBranch}`);
    log(`Checked out target: "fork/${targetBranch}" to temp: "${tempBranch}"`);

    log('Starting the cherry picking');
    await (git as any).raw(['cherry-pick', ...commits]);
    log('Cherry picking complete, pushing to fork');

    await git.push('fork', tempBranch, {
      '--set-upstream': true,
    });
    log('Pushed up to fork');

    log('Creating Pull Request');
    const newPr = await context.github.pullRequests.create(context.repo({
      head: `${fork.owner.login}:${tempBranch}`,
      base: targetBranch,
      title: `Backport - ${pr.title}`,
      body: `Backport of #${pr.number}\n\nSee that PR for details.`,
      maintainer_can_modify: false,
    }));

    log('Adding handy comment and updating labels')
    await context.github.issues.createComment(context.repo({
      number: pr.number,
      body: `We have automatically backported this PR to "${targetBranch}", please check out #${newPr.data.number}`,
    }) as any);

    await context.github.issues.removeLabel(context.repo({
      number: pr.number,
      name: label.name,
    }));

    await context.github.issues.addLabels(context.repo({
      number: pr.number,
      labels: [label.name.replace(targetLabelPrefix, mergedLabelPrefix)],
    }));
    log('Backport complete');
  }, async () => {
    const pr = context.payload.pull_request;

    await context.github.issues.createComment(context.repo({
      number: pr.number,
      body: `An error occurred while attempting to backport this PR to "${targetBranch}", you will need to perform this backport manually`,
    }) as any);
  });
}
