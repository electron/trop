import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as net from 'net';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RegisteredJob, SandboxJobServer } from '../src/sandbox/job-server';
import { SandboxInputs } from '../src/sandbox/protocol';
import { CacheLease, RepoCache } from '../src/sandbox/repo-cache';

const git = (
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
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

const sha256 = (s: string | Buffer) =>
  createHash('sha256').update(s).digest('hex');

const applied = (changes: unknown[]) => ({ changes });

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
    limits: { diffChars: 1000, errorChars: 1000 },
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

  const putBlob = (
    job: RegisteredJob,
    contents: string | Buffer,
    sha?: string,
  ) =>
    request(job, `blobs/${sha ?? sha256(contents)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: contents,
    });

  it('accepts a valid result exactly once', async () => {
    const job = newJob();
    for (const c of ['new\n', '/etc/passwd']) {
      expect((await putBlob(job, c)).ok).toBe(true);
    }
    const body = {
      outcome: 'success',
      attempt: 0,
      applied: [
        applied([
          { path: 'file.txt', mode: '100644', blob: sha256('new\n') },
          { path: 'old.txt', deleted: true },
          { path: 'link', mode: '120000', blob: sha256('/etc/passwd') },
          {
            path: 'dir\\with\\backslashes\tand tab',
            mode: '100755',
            blob: sha256('new\n'),
          },
        ]),
      ],
    };
    expect((await postResult(job, body)).status).toBe(200);
    await expect(job.result).resolves.toMatchObject({ outcome: 'success' });
    expect(job.blobs.read(sha256('new\n')).toString()).toBe('new\n');
    expect(job.blobs.gitId(sha256('new\n'))).toBe(
      git(tmp, ['hash-object', '--stdin'], {}, 'new\n').stdout,
    );

    // A second POST, or any other request, is refused.
    expect((await postResult(job, body)).status).toBe(409);
    expect((await request(job, 'inputs')).status).toBe(409);
    job.unregister();
  });

  it('accepts a patch that made no commit', async () => {
    const job = newJob();
    expect(
      (
        await postResult(job, {
          outcome: 'success',
          attempt: 0,
          applied: [null],
        })
      ).status,
    ).toBe(200);
    await expect(job.result).resolves.toEqual({
      outcome: 'success',
      attempt: 0,
      applied: [null],
    });
    job.unregister();
  });

  const content = sha256('x\n');
  const rejected: [string, unknown][] = [
    [
      'a path traversal',
      applied([{ path: '../../etc/x', mode: '100644', blob: content }]),
    ],
    [
      'an absolute path',
      applied([{ path: '/etc/x', mode: '100644', blob: content }]),
    ],
    [
      'a .git path',
      applied([
        { path: '.git/hooks/post-checkout', mode: '100755', blob: content },
      ]),
    ],
    [
      'a nested .GIT path',
      applied([{ path: 'a/.GIT/config', mode: '100644', blob: content }]),
    ],
    [
      'an NTFS .git alias',
      applied([{ path: 'a/git~1/config', mode: '100644', blob: content }]),
    ],
    ['a bad mode', applied([{ path: 'a', mode: '100777', blob: content }])],
    ['a submodule', applied([{ path: 'a', mode: '160000', blob: content }])],
    [
      'a blob that was never uploaded',
      applied([{ path: 'a', mode: '100644', blob: sha256('other') }]),
    ],
    [
      'a symlinked .gitmodules',
      applied([{ path: '.gitmodules', mode: '120000', blob: content }]),
    ],
    [
      'inline contents',
      applied([{ path: 'a', mode: '100644', content: 'eA==' }]),
    ],
    [
      'a duplicate path',
      applied([
        { path: 'a', mode: '100644', blob: content },
        { path: 'a', deleted: true },
      ]),
    ],
  ];

  it.each(rejected)('rejects a result with %s', async (_, entry) => {
    const job = newJob();
    expect((await putBlob(job, 'x\n')).ok).toBe(true);
    const response = await postResult(job, {
      outcome: 'success',
      attempt: 0,
      applied: [entry],
    });
    expect(response.status).toBe(400);
    await expect(job.result).rejects.toThrow('Invalid sandbox result');
    // ...and the job is over: no second try.
    expect(
      (
        await postResult(job, {
          outcome: 'success',
          attempt: 0,
          applied: [null],
        })
      ).status,
    ).toBe(409);
    job.unregister();
  });

  it('rejects the wrong number of applied patches', async () => {
    const job = newJob();
    const response = await postResult(job, {
      outcome: 'success',
      attempt: 0,
      applied: [null, null],
    });
    expect(response.status).toBe(400);
    await expect(job.result).rejects.toThrow(
      'results for 2 patches, expected 1',
    );
    job.unregister();
  });

  it('rejects a commit message or author from the job', async () => {
    const job = newJob();
    const response = await postResult(job, {
      outcome: 'success',
      attempt: 0,
      applied: [{ changes: [], message: 'mine', author: 'me' }],
    });
    expect(response.status).toBe(400);
    await expect(job.result).rejects.toThrow('unexpected key "message"');
    job.unregister();
  });

  it('stores only blobs whose SHA-256 matches', async () => {
    const job = newJob();
    expect((await putBlob(job, 'x\n', sha256('y\n'))).status).toBe(400);
    expect(job.blobs.size(sha256('y\n'))).toBeUndefined();
    expect((await putBlob(job, 'y\n')).ok).toBe(true);
    expect(job.blobs.size(sha256('y\n'))).toBe(2);
    // Another job never sees them.
    const other = newJob();
    expect(other.blobs.size(sha256('y\n'))).toBeUndefined();
    job.unregister();
    other.unregister();
    await job.blobs.dispose();
    await other.blobs.dispose();
  });

  it('refuses a GET with a body at once', async () => {
    const job = newJob();
    const url = new URL(job.url);
    const response = await new Promise<string>((resolve) => {
      const socket = net.connect(Number(url.port), url.hostname);
      let data = '';
      socket.on('data', (d) => (data += d.toString()));
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data));
      socket.write(
        `GET ${url.pathname}/inputs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${job.token}\r\nContent-Length: 100000000\r\n\r\n`,
      );
    });
    expect(response).toMatch(/^HTTP\/1\.1 400/);
    job.unregister();
  });

  it('keeps answering other jobs while one job floods it (security review PoC)', async () => {
    const evil = newJob();
    const victim = newJob();
    const url = new URL(evil.url);
    const sockets: net.Socket[] = [];
    for (let i = 0; i < 64; i++) {
      const socket = net.connect(Number(url.port), '127.0.0.1');
      socket.on('error', () => {});
      socket.write(
        `GET ${url.pathname}/inputs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${evil.token}\r\nContent-Length: 100000000\r\n\r\n`,
      );
      sockets.push(socket);
    }
    const trickle = setInterval(
      () => sockets.forEach((s) => s.write('a')),
      200,
    );
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const response = await fetch(`${victim.url}/inputs`, {
        headers: { authorization: `Bearer ${victim.token}` },
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
    } finally {
      clearInterval(trickle);
      sockets.forEach((s) => s.destroy());
      evil.unregister();
      victim.unregister();
    }
  });

  it('serves only blob:none partial clones', async () => {
    const job = newJob();
    const client = path.join(tmp, `filter-${Date.now()}`);
    git(tmp, ['init', '--quiet', client]);
    const fetchWith = (filter: string) =>
      gitAsync(
        client,
        [
          'fetch',
          '--quiet',
          '--depth=1',
          `--filter=${filter}`,
          `${job.url}/repo.git`,
          lease.baseSha,
        ],
        clientEnv(job),
      );
    expect((await fetchWith('tree:0')).status).not.toBe(0);
    expect((await fetchWith('blob:none')).status).toBe(0);
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
