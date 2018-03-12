import * as fs from 'fs-extra';
import * as path from 'path';
import * as pify from 'pify';
import * as simpleGit from 'simple-git';

import { Probot, ProbotContext, Label, PullRequestEvent } from './Probot';
import queue from './Queue';

const dir = path.resolve(__dirname, '..', '..', 'working');
const getGit = () => simpleGit(dir);

export const ensureElectronUpToDate = async () => {
  await fs.mkdirp(dir);
  const git = getGit();
  if (!await fs.pathExists(path.resolve(dir, '.git'))) {
    await fs.remove(dir);
    await fs.mkdirp(dir);
    await pify(git.clone.bind(git))(
      'git@github.com:marshallofsound/electron.git',
      '.'
    );
  }
  try { await pify(git.raw.bind(git))(['cherry-pick', '--abort']); } catch (e) {}
  await pify(git.reset.bind(git))('hard');
  const status = await pify(git.status.bind(git))();
  for (const file of status.not_added) {
    await fs.remove(path.resolve(dir, file));
  }
  await pify(git.checkout.bind(git))('master');
  await pify(git.pull.bind(git))();
}

const TARGET_LABEL_PREFIX = 'target/';
const MERGED_LABEL_PREFIX = 'merged/';

const labelToTargetBranch = (label: Label) => {
  return label.name.replace(TARGET_LABEL_PREFIX, '');
}

const tokenFromContext = (robot: any, context: any) => {
  return robot.cache.get(`app:${context.payload.installation.id}:token`);
}

export const backportPR = (robot: Probot, context: ProbotContext<PullRequestEvent>, label: Label) => {
  const targetBranch = labelToTargetBranch(label);  
  const bp = `backport from PR #${context.payload.pull_request.number} to "${targetBranch}"`;
  robot.log(`Queuing ${bp}`)

  queue.enterQueue(async () => {
    robot.log(`Executing ${bp}`);
    const pr = context.payload.pull_request;
    await ensureElectronUpToDate();
    robot.log('Working directory cleaned')
    const git = getGit();

    robot.log(`Getting rev list from: ${pr.base.sha}..${pr.head.sha}`);
    const commits = (await pify(git.raw.bind(git))(['rev-list', '--ancestry-path', `${pr.base.sha}..${pr.head.sha}`]))
      .trim().split('\n');
    if (commits.length === 0) {
      robot.log('Found no commits to backport, aborting');
      return;
    }
    robot.log(`Found ${commits.length} commits to backport`);

    const tempBranch = `${targetBranch}-bp-${pr.title.replace(/ /g, '-').toLowerCase()}-${Date.now()}`;
    await pify(git.checkout.bind(git))(targetBranch);
    await pify(git.pull.bind(git))();
    await pify(git.checkoutBranch.bind(git))(tempBranch, targetBranch);
    robot.log(`Checked out target: "${targetBranch}" to temp: "${tempBranch}"`);

    const raw = pify(git.raw.bind(git));
    let i = 1;
    robot.log('Starting the cherry picking');
    for (const commit of commits) {
      console.log(await raw(['cherry-pick', commit]));
      await raw(['commit', '--amend', '--no-edit', '--author', 'Electron Bot <electron@github.com>']);
      robot.log(`Cherry picked: ${commit} (${i}/${commits.length})`);
      i++;
    }
    robot.log('Cherry picking complete, pushing to remote');

    await pify(git.push.bind(git))('origin', tempBranch, {
      '--set-upstream': true,
    });
    robot.log('Pushed up to remote');

    robot.log('Creating Pull Request');
    const newPr = await context.github.pullRequests.create(context.repo({
      head: (await pify(git.status.bind(git))()).current,
      base: targetBranch,
      title: `Backport - ${pr.title}`,
      body: `Backport of #${pr.number}\n\nSee that PR for details.`
    }));
    robot.log('Backport complete');
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
      labels: [label.name.replace(TARGET_LABEL_PREFIX, MERGED_LABEL_PREFIX)],
    }));
  }, async () => {
    const pr = context.payload.pull_request;
    await context.github.issues.createComment(context.repo({
      number: pr.number,
      body: `An error occurred while attempting to backport this PR to "${targetBranch}", you will need to perform this backport manually`,
    }) as any);
  });
}
