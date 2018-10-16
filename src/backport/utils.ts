import { Application, Context } from 'probot';
import * as GitHub from '@octokit/rest';
import fetch from 'node-fetch';
import * as fs from 'fs-extra';
import { IQueue } from 'queue';
import * as simpleGit from 'simple-git/promise';

import * as commands from './commands';
import { Label, PullRequest, TropConfig } from './Probot';
import queue from './Queue';
import { runCommand } from './runner';
import { CHECK_PREFIX } from './constants';

const makeQueue: IQueue = require('queue');
const { parse: parseDiff } = require('what-the-diff');

const TARGET_LABEL_PREFIX = 'target/';
const MERGED_LABEL_PREFIX = 'merged/';

export const labelToTargetBranch = (label: Label, prefix: string) => {
  return label.name.replace(prefix, '');
};

const getGitHub = () => {
  const g = new GitHub();
  g.authenticate({
    type: 'token',
    token: process.env.GITHUB_FORK_USER_TOKEN!,
  });
  return g;
};

const createBackportComment = (pr: PullRequest) => {
  let body = `Backport of #${pr.number}\n\nSee that PR for details.`;

  // tslint:disable-next-line
  const issueFixInfo = new RegExp(`(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) (${pr.base.repo.html_url}/issues/\\d+)`, 'i');
  const issueMatch = pr.body.match(issueFixInfo);

  // attach information about issues resolved, if any
  if (Array.isArray(issueMatch) && issueMatch.length > 1) {
    body += `\n\n${issueMatch[0]}`;
  }

  const onelineMatch = /(?:(?:\r?\n)|^)notes: (.+?)(?:(?:\r?\n)|$)/gi.exec(pr.body);
  const multilineMatch =
      /(?:(?:\r?\n)Notes:(?:\r?\n)((?:\*.+(?:(?:\r?\n)|$))+))/gi.exec(pr.body);

  // attach release notes to backport PR body
  if (onelineMatch && onelineMatch[1]) {
    body += `\n\n${onelineMatch[1]}`;
  } else if (multilineMatch && multilineMatch[1]) {
    body += `\n\n${multilineMatch[1]}`;
  } else {
    body += '\n\nNotes: no-notes';
  }

  return body;
};

export enum BackportPurpose {
  ExecuteBackport,
  Check,
}

export const backportImpl = async (robot: Application,
                                   context: Context,
                                   targetBranch: string,
                                   purpose: BackportPurpose,
                                   labelToRemove?: string,
                                   labelToAdd?: string) => {
  const base = context.payload.pull_request.base;
  const slug = `${base.repo.owner.login}/${base.repo.name}`;
  const bp = `backport from PR #${context.payload.pull_request.number} to "${targetBranch}"`;
  robot.log(`Queuing ${bp} for "${slug}"`);

  const log = (...args: string[]) => robot.log(slug, ...args);

  const getCheckRun = async () => {
    const allChecks = await context.github.checks.listForRef(context.repo({
      ref: context.payload.pull_request.head.sha,
      per_page: 100,
    }));
    return allChecks.data.check_runs.find(run => run.name === `${CHECK_PREFIX}${targetBranch}`);
  };

  let createdDir: string | null = null;

  queue.enterQueue(
    `backport-${context.payload.pull_request.head.sha}-${targetBranch}-${purpose}`,
    async () => {
      log(`Executing ${bp} for "${slug}"`);
      if (purpose === BackportPurpose.Check) {
        const checkRun = await getCheckRun();
        if (checkRun) {
          await context.github.checks.update(context.repo({
            check_run_id: `${checkRun.id}`,
            name: checkRun.name,
            status: 'in_progress' as 'in_progress',
          }));
        }
      }

      const pr = context.payload.pull_request as any as PullRequest;
      // Set up empty repo on master
      log('Setting up local repository');
      const { dir } = await runCommand({
        what: commands.INIT_REPO,
        payload: {
          owner: base.repo.owner.login,
          repo: base.repo.name,
        },
      });
      createdDir = dir;
      log(`Working directory cleaned: ${dir}`);

      // Fork repository to trop
      log('forking base repo');
      const gh = getGitHub();
      const fork = (await gh.repos.fork({
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
            repo: fork.name!,
          });
          forkReady = data.length > 0;
        } catch (err) {
          // Ignore
        }
        attempt += 1;
        if (!forkReady) await new Promise<void>(resolve => setTimeout(resolve, 5000));
      }
      if (attempt >= 20) {
        log('fork wasn\'t ready fast enough, giving up');
        throw new Error('Not ready in time');
      }
      log('fork ready');

      // Set up remotes
      log('setting up remotes');
      await runCommand({
        what: commands.SET_UP_REMOTES,
        payload: {
          dir,
          slug,
          remotes: [{
            name: 'target_repo',
            value: `https://github.com/${slug}.git`,
          }, {
            name: 'fork',
            // tslint:disable-next-line
            value: `https://${fork.owner.login}:${process.env.GITHUB_FORK_USER_TOKEN}@github.com/${fork.owner.login}/${fork.name}.git`,
          }],
        },
      });

      // Get list of commits
      log(`Getting rev list from: ${pr.base.sha}..${pr.head.sha}`);
      const commits: string[] = (await context.github.pullRequests.getCommits(context.repo({
        number: pr.number,
      }))).data.map(commit => commit.sha!);

      // No commits == WTF
      if (commits.length === 0) {
        log('Found no commits to backport, aborting');
        return;
      }

      if (commits.length >= 240) {
        // Over 240 commits is probably the limit from github so let's not bother
        log(`Way to many commits (${commits.length})... Giving up`);
        await context.github.issues.createComment(context.repo({
          number: pr.number,
          body: 'This PR has wayyyy too many commits to automatically backport, \
  please do this manually',
        }) as any);

        return;
      }

      log(`Found ${commits.length} commits to backport, requesting details now`);
      const patches: string[] = (new Array(commits.length)).fill('');
      const q = makeQueue({
        concurrency: 5,
      });
      q.stop();

      for (const [i, commit] of commits.entries()) {
        q.push(async () => {
          const patchUrl = `https://github.com/${slug}/pull/${pr.number}/commits/${commit}.patch`;
          const patchBody = await fetch(patchUrl);
          patches[i] = await patchBody.text();
          log(`Got patch (${i + 1}/${commits.length})`);
        });
      }

      await new Promise(r => q.start(r));
      log('Got all commit info');

      // Temp branch on the fork
      const sanitizedTitle = pr.title
        .replace(/ /g, '-')
        .replace(/\:/g, '-')
        .replace(/\[/g, '-')
        .replace(/\]/g, '-').toLowerCase();
      const tempBranch = `${targetBranch}-bp-${sanitizedTitle}-${Date.now()}`;

      log(`Checking out target: "target_repo/${targetBranch}" to temp: "${tempBranch}"`);
      log('Will start backporting now');

      await runCommand({
        what: commands.BACKPORT,
        payload: {
          dir,
          slug,
          targetBranch,
          tempBranch,
          patches,
          targetRemote: 'target_repo',
          tempRemote: 'fork',
        },
      });

      log('Cherry pick success, pushed up to fork');

      if (purpose === BackportPurpose.ExecuteBackport) {
        log('Creating Pull Request');
        const newPr = (await context.github.pullRequests.create(context.repo({
          head: `${fork.owner.login}:${tempBranch}`,
          base: targetBranch,
          title: `${pr.title} (backport: ${targetBranch})`,
          body: createBackportComment(pr),
          maintainer_can_modify: false,
        }))).data;

        log('Adding breadcrumb comment');
        await context.github.issues.createComment(context.repo({
          number: pr.number,
          body: `We have automatically backported this PR to "${targetBranch}", \
    please check out #${newPr.number}`,
        }) as any);

        if (labelToRemove) {
          log(`Removing label '${labelToRemove}'`);
          await context.github.issues.removeLabel(context.repo({
            number: pr.number,
            name: labelToRemove,
          }));
        }

        if (labelToAdd) {
          log(`Adding label '${labelToAdd}'`);
          await context.github.issues.addLabels(context.repo({
            number: pr.number,
            labels: [labelToAdd],
          }));
        }

        await context.github.issues.addLabels(context.repo({
          number: newPr.number!,
          labels: ['backport'],
        }));

        log('Backport complete');
      }

      if (purpose === BackportPurpose.Check) {
        const checkRun = await getCheckRun();
        if (checkRun) {
          context.github.checks.update(context.repo({
            check_run_id: `${checkRun.id}`,
            name: checkRun.name,
            conclusion: 'success' as 'success',
            completed_at: (new Date()).toISOString(),
            details_url: `https://github.com/electron/electron/compare/master...${fork.owner.login}:${tempBranch}`,
            output: {
              title: 'Can Backport',
              summary: `This PR was checked and can be backported to "${targetBranch}" cleanly`,
            },
          }));
        }
      }

      await fs.remove(createdDir);
    },
    async () => {
      let annotations: any[] | null = null;
      let diff;
      let rawDiff;
      if (createdDir) {
        const git = simpleGit(createdDir);
        rawDiff = await git.diff();
        diff = parseDiff(rawDiff);

        annotations = [];
        for (const file of diff) {
          if (file.binary) continue;

          for (const hunk of (file.hunks || [])) {
            const startOffset = hunk.lines.findIndex((line: string) => line.includes('<<<<<<<'));
            const endOffset = hunk.lines.findIndex((line: string) => line.includes('=======')) - 2;
            const finalOffset = hunk.lines.findIndex((line: string) => line.includes('>>>>>>>'));
            annotations.push({
              path: file.filePath,
              start_line: hunk.theirStartLine + Math.max(0, startOffset),
              end_line: hunk.theirStartLine + Math.max(0, endOffset),
              annotation_level: 'failure',
              message: 'Patch Conflict',
              raw_details: hunk.lines.filter((_: any, i: number) => i >= startOffset && i <= finalOffset).join('\n'),
            });
          }
        }

        await fs.remove(createdDir);
      }

      if (purpose === BackportPurpose.Check) {
        const checkRun = await getCheckRun();
        if (checkRun) {
          const mdSep = '``````````````````````````````';
          context.github.checks.update(context.repo({
            check_run_id: `${checkRun.id}`,
            name: checkRun.name,
            conclusion: 'failure' as 'failure',
            completed_at: (new Date()).toISOString(),
            output: {
              title: 'Backport Failed',
              summary: `This PR was checked and could not be automatically backported to "${targetBranch}" cleanly`,
              text: diff ? `Failed Diff:\n\n${mdSep}diff\n${rawDiff}\n${mdSep}` : undefined,
              annotations: annotations ? annotations : undefined,
            },
          }));
        }
      }
    },
  );
};

export const getLabelPrefixes = async (context: Context) => {
  const config = await context.config<TropConfig>('config.yml') || {};
  const target = config.targetLabelPrefix || TARGET_LABEL_PREFIX;
  const merged = config.mergedLabelPrefix || MERGED_LABEL_PREFIX;
  return { target, merged };
};

export const backportToLabel = async (
  robot: Application,
  context: Context,
  label: Label,
) => {
  const labelPrefixes = await getLabelPrefixes(context);
  if (!label.name.startsWith(labelPrefixes.target)) {
    robot.log(`Label '${label.name}' does not begin with '${labelPrefixes.target}'`);
    return;
  }

  const targetBranch = labelToTargetBranch(label, labelPrefixes.target);
  if (!targetBranch) {
    robot.log('Nothing to do');
    return;
  }

  const labelToRemove = label.name;
  const labelToAdd = label.name.replace(labelPrefixes.target, labelPrefixes.merged);
  await backportImpl(
    robot, context, targetBranch, BackportPurpose.ExecuteBackport, labelToRemove, labelToAdd,
  );
};

export const backportToBranch = async (
  robot: Application,
  context: Context,
  targetBranch: string,
) => {
  const labelPrefixes = await getLabelPrefixes(context);

  const labelToRemove = undefined;
  const labelToAdd = labelPrefixes.merged + targetBranch;
  await backportImpl(
    robot, context, targetBranch, BackportPurpose.ExecuteBackport, labelToRemove, labelToAdd,
  );
};
