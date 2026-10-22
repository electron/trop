import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RegisteredJob, SandboxJobServer } from '../src/sandbox/job-server';
import { SandboxInputs } from '../src/sandbox/protocol';
import { CacheLease, RepoCache } from '../src/sandbox/repo-cache';

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr,
  };
};

// For git talking to the server in this process: spawnSync would block the
// event loop the server needs to answer.
const gitAsync = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout: stdout.trim() }));
  });

// git configuration of a client using a job's endpoint, as the sandbox
// entrypoint sets it up.
const clientEnv = (job: RegisteredJob): NodeJS.ProcessEnv => ({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: `http.${job.url}/repo.git.extraHeader`,
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${job.token}`,
  GIT_CONFIG_KEY_1: 'protocol.version',
  GIT_CONFIG_VALUE_1: '2',
  GIT_CONFIG_KEY_2: 'credential.helper',
  GIT_CONFIG_VALUE_2: '',
});

const validCommit = (changes: unknown[]) => ({
  message: 'fix: something\n',
  author: {
    name: 'Someone',
    email: 'someone@example.com',
    date: '2026-10-22T12:00:00-07:00',
  },
  changes,
});

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('SandboxJobServer', { timeout: 30_000 }, () => {
  console.error = vi.fn();
  console.warn = vi.fn();

  let tmp: string;
  let server: SandboxJobServer;
  let lease: CacheLease;
  let otherLease: CacheLease;
  let remoteSha: string;

  const makeRemote = (name: string) => {
    const work = path.join(tmp, `${name}-work`);
    const remote = path.join(tmp, `${name}.git`);
    fs.mkdirSync(work);
    git(work, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(work, 'file.txt'), `${name}\n`);
    git(work, ['add', '.']);
    git(work, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-m',
      'initial',
    ]);
    git(work, ['branch', '42-x-y']);
    git(tmp, ['clone', '--bare', '--quiet', work, remote]);
    return { remote, sha: git(work, ['rev-parse', 'HEAD']).stdout };
  };

  beforeAll(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trop-server-'));
    const trop = makeRemote('trop');
    const other = makeRemote('other');
    remoteSha = trop.sha;
    lease = await new RepoCache('electron/trop', {
      dir: path.join(tmp, 'cache-trop'),
      remoteUrl: trop.remote,
    }).acquire('', '42-x-y');
    otherLease = await new RepoCache('electron/other', {
      dir: path.join(tmp, 'cache-other'),
      remoteUrl: other.remote,
    }).acquire('', '42-x-y');
    server = new SandboxJobServer('127.0.0.1', 0);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    await lease.release();
    await otherLease.release();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  const inputs = (l: CacheLease): SandboxInputs => ({
    version: 1,
    ref: l.ref,
    baseSha: l.baseSha,
    attempts: [{ kind: 'all', patches: ['patch'] }],
    preimageBlobs: [],
    includeChanges: true,
    committer: { name: 'trop', email: 'trop@example.com' },
  });

  const newJob = (l = lease) => {
    const job = server.register({
      cacheDir: l.dir,
      ref: l.ref,
      inputs: inputs(l),
      expectation: { patchCounts: [1], includeChanges: true },
    });
    return job;
  };

  const request = (
    job: RegisteredJob,
    endpoint: string,
    init: RequestInit & { token?: string } = {},
  ) =>
    fetch(`${job.url}/${endpoint}`, {
      ...init,
      headers: {
        authorization: `Bearer ${init.token ?? job.token}`,
        ...(init.headers as Record<string, string>),
      },
    });

  const postResult = (job: RegisteredJob, body: unknown) =>
    request(job, 'result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('serves a job its inputs', async () => {
    const job = newJob();
    const response = await request(job, 'inputs');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      baseSha: remoteSha,
      ref: lease.ref,
    });
    job.unregister();
  });

  it('requires the job token', async () => {
    const job = newJob();
    expect((await fetch(`${job.url}/inputs`)).status).toBe(401);
    expect(
      (await request(job, 'inputs', { token: 'A'.repeat(43) })).status,
    ).toBe(401);
    expect(
      (await request(job, 'inputs', { token: `${job.token}x` })).status,
    ).toBe(401);
    job.unregister();
  });

  it("refuses one job's token for another job (and its repository)", async () => {
    const job = newJob();
    const other = newJob(otherLease);
    expect((await request(job, 'inputs', { token: other.token })).status).toBe(
      401,
    );
    expect(
      (
        await request(job, 'repo.git/info/refs?service=git-upload-pack', {
          token: other.token,
          headers: { 'git-protocol': 'version=2' },
        })
      ).status,
    ).toBe(401);
    // And git with the other job's credentials cannot read this one.
    const env = clientEnv(other);
    env.GIT_CONFIG_KEY_0 = `http.${job.url}/repo.git.extraHeader`;
    expect(
      (await gitAsync(tmp, ['ls-remote', `${job.url}/repo.git`], env)).status,
    ).not.toBe(0);
    job.unregister();
    other.unregister();
  });

  it('revokes the token when the job is unregistered', async () => {
    const job = newJob();
    job.unregister();
    expect((await request(job, 'inputs')).status).toBe(401);
    await expect(job.result).rejects.toThrow('without a result');
  });

  it('serves nothing but its routes', async () => {
    const job = newJob();
    for (const endpoint of [
      '../../../etc/passwd',
      'repo.git/HEAD',
      'repo.git/objects/info/packs',
      'repo.git/info/refs',
      'repo.git/config',
      'inputs/',
      'inputs?x=1',
    ]) {
      expect((await request(job, endpoint)).status).toBe(404);
    }
    const raw = await new Promise<number>((resolve, reject) => {
      const url = new URL(job.url);
      http
        .get(
          {
            host: url.hostname,
            port: url.port,
            path: `${url.pathname}/../../jobs/${job.id}/inputs`,
            headers: { authorization: `Bearer ${job.token}` },
          },
          (res) => resolve(res.statusCode ?? 0),
        )
        .on('error', reject);
    });
    expect(raw).toBe(404);
    job.unregister();
  });

  it('advertises only the job ref', async () => {
    const job = newJob();
    const result = await gitAsync(
      tmp,
      ['ls-remote', `${job.url}/repo.git`],
      clientEnv(job),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${lease.baseSha}\t${lease.ref}`);
    job.unregister();
  });

  it('requires git protocol v2', async () => {
    const job = newJob();
    const response = await request(
      job,
      'repo.git/info/refs?service=git-upload-pack',
    );
    expect(response.status).toBe(400);
    job.unregister();
  });

  it('refuses pushes', async () => {
    const job = newJob();
    expect(
      (await request(job, 'repo.git/info/refs?service=git-receive-pack'))
        .status,
    ).toBe(403);
    expect(
      (
        await request(job, 'repo.git/git-receive-pack', {
          method: 'POST',
          headers: { 'content-type': 'application/x-git-receive-pack-request' },
          body: '0000',
        })
      ).status,
    ).toBe(403);

    const work = path.join(tmp, 'push-work');
    await gitAsync(
      tmp,
      ['clone', '--quiet', `${job.url}/repo.git`, work],
      clientEnv(job),
    );
    git(work, ['checkout', '--quiet', '-b', 'evil', lease.baseSha]);
    fs.writeFileSync(path.join(work, 'evil.txt'), 'evil\n');
    git(work, ['add', '.']);
    git(work, [
      '-c',
      'user.name=e',
      '-c',
      'user.email=e@example.com',
      'commit',
      '-qm',
      'evil',
    ]);
    const evil = git(work, ['rev-parse', 'HEAD']).stdout;
    const push = await gitAsync(
      work,
      ['push', `${job.url}/repo.git`, `HEAD:${lease.ref}`],
      clientEnv(job),
    );
    expect(push.status).not.toBe(0);
    // Nothing reached the cache.
    expect(
      git(tmp, [`--git-dir=${lease.dir}`, 'rev-parse', lease.ref]).stdout,
    ).toBe(lease.baseSha);
    expect(
      git(tmp, [`--git-dir=${lease.dir}`, 'cat-file', '-e', evil]).status,
    ).not.toBe(0);
    job.unregister();
  });

  it('accepts a valid result exactly once', async () => {
    const job = newJob();
    const body = {
      outcome: 'success',
      attempt: 0,
      commits: [
        validCommit([
          { path: 'file.txt', mode: '100644', content: b64('new\n') },
          { path: 'old.txt', deleted: true },
          { path: 'link', mode: '120000', content: b64('/etc/passwd') },
        ]),
      ],
    };
    expect((await postResult(job, body)).status).toBe(200);
    await expect(job.result).resolves.toMatchObject({ outcome: 'success' });

    // A second POST, or any other request, is refused.
    expect((await postResult(job, body)).status).toBe(409);
    expect((await request(job, 'inputs')).status).toBe(409);
    job.unregister();
  });

  const rejected: [string, unknown][] = [
    [
      'a path traversal',
      validCommit([{ path: '../../etc/x', mode: '100644', content: '' }]),
    ],
    [
      'an absolute path',
      validCommit([{ path: '/etc/x', mode: '100644', content: '' }]),
    ],
    [
      'a .git path',
      validCommit([
        { path: '.git/hooks/post-checkout', mode: '100755', content: '' },
      ]),
    ],
    [
      'a nested .GIT path',
      validCommit([{ path: 'a/.GIT/config', mode: '100644', content: '' }]),
    ],
    ['a bad mode', validCommit([{ path: 'a', mode: '100777', content: '' }])],
    ['a submodule', validCommit([{ path: 'a', mode: '160000', content: '' }])],
  ];

  it.each(rejected)('rejects a result with %s', async (_, commit) => {
    const job = newJob();
    const response = await postResult(job, {
      outcome: 'success',
      attempt: 0,
      commits: [commit],
    });
    expect(response.status).toBe(400);
    await expect(job.result).rejects.toThrow('Invalid sandbox result');
    // ...and the job is over: no second try.
    expect(
      (
        await postResult(job, {
          outcome: 'success',
          attempt: 0,
          commits: [validCommit([])],
        })
      ).status,
    ).toBe(409);
    job.unregister();
  });

  it('rejects the wrong number of commits', async () => {
    const job = newJob();
    const response = await postResult(job, {
      outcome: 'success',
      attempt: 0,
      commits: [validCommit([]), validCommit([])],
    });
    expect(response.status).toBe(400);
    await expect(job.result).rejects.toThrow('2 commits for 1 patches');
    job.unregister();
  });

  it('rejects malformed JSON and other content types', async () => {
    const job = newJob();
    expect(
      (
        await request(job, 'result', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"outcome":',
        })
      ).status,
    ).toBe(400);
    await expect(job.result).rejects.toThrow('invalid JSON');
    job.unregister();

    const textJob = newJob();
    expect(
      (
        await request(textJob, 'result', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    await expect(textJob.result).rejects.toThrow('expected application/json');
    textJob.unregister();
  });

  it('rejects an oversized result without buffering it', async () => {
    const job = newJob();
    const url = new URL(`${job.url}/result`);
    // Streamed without a content-length, so the server has to count.
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            authorization: `Bearer ${job.token}`,
            'content-type': 'application/json',
          },
        },
        (res) => {
          expect(res.statusCode).toBe(413);
          res.resume();
          resolve();
        },
      );
      req.on('error', () => resolve());
      const chunk = Buffer.alloc(1024 * 1024, 'a');
      let sent = 0;
      const write = () => {
        while (sent < 70) {
          sent += 1;
          if (!req.write(chunk)) {
            req.once('drain', write);
            return;
          }
        }
        req.end();
      };
      write();
    });
    await expect(job.result).rejects.toThrow('too large');
    job.unregister();
  });
});
