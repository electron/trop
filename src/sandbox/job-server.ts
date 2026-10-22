import { ChildProcess, spawn } from 'child_process';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Transform, TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import * as zlib from 'zlib';

import { LogLevel } from '../enums';
import { log } from '../utils/log-util';
import { serverGitEnv } from './git';
import {
  LIMITS,
  ResultExpectation,
  SandboxInputs,
  SandboxResult,
  SandboxResultError,
  validateSandboxResult,
} from './protocol';

// The server side of a sandbox job: an internal HTTP listener, separate from
// the webhook port, through which a job with the right bearer token can
//   GET  /jobs/<id>/inputs                                 its inputs,
//   GET  /jobs/<id>/repo.git/info/refs?service=git-upload-pack
//   POST /jobs/<id>/repo.git/git-upload-pack               read-only git
//        fetches from its repository's cache (protocol v2), and
//   POST /jobs/<id>/result                                 its result, once.
// Nothing else is served; in particular there is no receive-pack.

// Per job, and over all jobs: pack generation is the server's most expensive
// work a job can ask for.
const MAX_CONCURRENT_UPLOAD_PACKS = 2;
const MAX_TOTAL_UPLOAD_PACKS = 8;
const MAX_REQUESTS_PER_JOB = 2000;
const UPLOAD_PACK_INACTIVITY_TIMEOUT_S = 120;

export interface JobRegistration {
  /** The bare repository cache the job may fetch from. */
  cacheDir: string;
  /** The single ref advertised to the job. */
  ref: string;
  inputs: SandboxInputs;
  expectation: ResultExpectation;
}

export interface RegisteredJob {
  id: string;
  /** Bearer token; only ever handed to the job itself. */
  token: string;
  /** Base URL of the job's endpoints. */
  url: string;
  /** Settles once with the validated result, or rejects if it was invalid. */
  result: Promise<SandboxResult>;
  /** Revokes the job's token. Idempotent. */
  unregister: () => void;
}

interface JobState extends JobRegistration {
  tokenDigest: Buffer;
  inputsJson: Buffer;
  resultReceived: boolean;
  requests: number;
  uploadPacks: Set<ChildProcess>;
  resolve: (r: SandboxResult) => void;
  reject: (e: Error) => void;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Passes data through until more than `limit` bytes have gone by. */
class ByteLimit extends Transform {
  private seen = 0;
  constructor(private readonly limit: number) {
    super();
  }
  _transform(chunk: Buffer, _: BufferEncoding, cb: TransformCallback) {
    this.seen += chunk.length;
    if (this.seen > this.limit) {
      cb(new HttpError(413, 'request body too large'));
    } else {
      cb(null, chunk);
    }
  }
}

const readBody = async (req: http.IncomingMessage, limit: number) => {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'request body too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const ROUTE =
  /^\/jobs\/([0-9a-f]{32})\/(inputs|result|repo\.git\/info\/refs\?service=git-(upload|receive)-pack|repo\.git\/git-(upload|receive)-pack)$/;

export class SandboxJobServer {
  private readonly jobs = new Map<string, JobState>();
  private totalUploadPacks = 0;
  private readonly server: http.Server;
  private address: AddressInfo | null = null;

  /**
   * @param listenHost - the address to bind: the pod IP in the cluster (never
   *   0.0.0.0), 127.0.0.1 locally
   * @param port - the internal port; 0 picks a free one
   */
  constructor(
    private readonly listenHost: string,
    private readonly port: number,
  ) {
    this.server = http.createServer(
      { maxHeaderSize: 8 * 1024, requestTimeout: 30 * 60 * 1000 },
      (req, res) => {
        this.handle(req, res).catch((error: unknown) => {
          const status = error instanceof HttpError ? error.status : 500;
          if (!(error instanceof HttpError)) {
            log('SandboxJobServer', LogLevel.ERROR, 'Request failed', error);
          }
          if (!res.headersSent) {
            res.writeHead(status, { 'content-type': 'text/plain' });
            res.end(error instanceof HttpError ? error.message : 'error');
          } else {
            res.destroy();
          }
        });
      },
    );
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxConnections = 64;
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.listenHost, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.address = this.server.address() as AddressInfo;
    log(
      'SandboxJobServer',
      LogLevel.INFO,
      `Listening for sandbox jobs on ${this.listenHost}:${this.address.port}`,
    );
  }

  async stop() {
    for (const job of this.jobs.values()) {
      for (const child of job.uploadPacks) child.kill('SIGKILL');
      job.reject(new Error('Sandbox job server stopped'));
    }
    this.jobs.clear();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  get baseUrl() {
    if (!this.address) throw new Error('Sandbox job server is not started');
    const host = this.listenHost.includes(':')
      ? `[${this.listenHost}]`
      : this.listenHost;
    return `http://${host}:${this.address.port}`;
  }

  register(registration: JobRegistration): RegisteredJob {
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    let resolve!: (r: SandboxResult) => void;
    let reject!: (e: Error) => void;
    const result = new Promise<SandboxResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers always await it; this keeps an early rejection from being
    // reported as unhandled in the meantime.
    result.catch(() => {});

    this.jobs.set(id, {
      ...registration,
      tokenDigest: digest(token),
      inputsJson: Buffer.from(JSON.stringify(registration.inputs)),
      resultReceived: false,
      requests: 0,
      uploadPacks: new Set(),
      resolve,
      reject,
    });

    return {
      id,
      token,
      url: `${this.baseUrl}/jobs/${id}`,
      result,
      unregister: () => {
        const job = this.jobs.get(id);
        if (!job) return;
        this.jobs.delete(id);
        // Its fetches end with it.
        for (const child of job.uploadPacks) child.kill('SIGKILL');
        job.reject(new Error('Sandbox job ended without a result'));
      },
    };
  }

  private authenticate(req: http.IncomingMessage, id: string): JobState {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    const job = this.jobs.get(id);
    // Compare even for unknown jobs so timing says nothing about job ids.
    const expected = job?.tokenDigest ?? digest(randomBytes(32).toString());
    const ok = timingSafeEqual(digest(match?.[1] ?? ''), expected);
    if (!job || !match || !ok) throw new HttpError(401, 'unauthorized');
    return job;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const route = ROUTE.exec(req.url ?? '');
    if (!route) throw new HttpError(404, 'not found');
    const [, id, endpoint, infoRefsService, rpcService] = route;

    const job = this.authenticate(req, id);
    if (infoRefsService === 'receive' || rpcService === 'receive') {
      throw new HttpError(403, 'this repository is read-only');
    }
    if (job.resultReceived) throw new HttpError(409, 'job is finished');
    if (++job.requests > MAX_REQUESTS_PER_JOB) {
      throw new HttpError(429, 'too many requests');
    }

    if (endpoint === 'inputs') {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(job.inputsJson);
    } else if (endpoint === 'result') {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      await this.receiveResult(job, req, res);
    } else if (infoRefsService === 'upload') {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      await this.uploadPack(job, req, res, true);
    } else {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      await this.uploadPack(job, req, res, false);
    }
  }

  private async receiveResult(
    job: JobState,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    // Exactly once: whatever this request turns out to be, the job is over.
    job.resultReceived = true;
    try {
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
        throw new HttpError(415, 'expected application/json');
      }
      const body = await readBody(req, LIMITS.resultBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new HttpError(400, 'invalid JSON');
      }
      let result: SandboxResult;
      try {
        result = validateSandboxResult(parsed, job.expectation);
      } catch (error) {
        if (error instanceof SandboxResultError) {
          throw new HttpError(400, error.message);
        }
        throw error;
      }
      job.resolve(result);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } catch (error) {
      job.reject(
        new SandboxResultError(
          error instanceof Error ? error.message : String(error),
        ),
      );
      throw error;
    }
  }

  private async uploadPack(
    job: JobState,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    advertise: boolean,
  ) {
    // Only protocol v2: its ls-refs honours hideRefs and its fetch takes the
    // blob ids a partial clone asks for.
    if (!/(?:^|:)version=2(?:$|:)/.test(String(req.headers['git-protocol']))) {
      throw new HttpError(400, 'git protocol v2 required');
    }
    if (!advertise) {
      const type = req.headers['content-type'];
      if (type !== 'application/x-git-upload-pack-request') {
        throw new HttpError(415, 'unexpected content type');
      }
      const encoding = req.headers['content-encoding'];
      if (encoding !== undefined && encoding !== 'gzip') {
        throw new HttpError(415, 'unexpected content encoding');
      }
    }
    if (
      job.uploadPacks.size >= MAX_CONCURRENT_UPLOAD_PACKS ||
      this.totalUploadPacks >= MAX_TOTAL_UPLOAD_PACKS
    ) {
      throw new HttpError(429, 'too many concurrent fetches');
    }

    this.totalUploadPacks += 1;
    let child: ChildProcess | undefined;
    try {
      const proc = spawn(
        'git',
        [
          // Advertise only the job's ref, not HEAD or any branch.
          '-c',
          'uploadpack.hideRefs=refs/',
          '-c',
          'uploadpack.hideRefs=HEAD',
          '-c',
          `uploadpack.hideRefs=!${job.ref}`,
          // Lets the job do a blob-less clone and fetch blobs on demand.
          '-c',
          'uploadpack.allowFilter=true',
          // Bound what packing for a job can take from the server.
          '-c',
          'pack.threads=1',
          '-c',
          'pack.windowMemory=256m',
          'upload-pack',
          '--strict',
          '--stateless-rpc',
          `--timeout=${UPLOAD_PACK_INACTIVITY_TIMEOUT_S}`,
          ...(advertise ? ['--advertise-refs'] : []),
          job.cacheDir,
        ],
        {
          env: serverGitEnv({ GIT_PROTOCOL: 'version=2' }),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      child = proc;
      job.uploadPacks.add(proc);
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 4096) stderr += d.toString();
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', resolve);
      });
      res.on('close', () => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      });

      res.writeHead(200, {
        'content-type': `application/x-git-upload-pack-${advertise ? 'advertisement' : 'result'}`,
        'cache-control': 'no-cache',
      });

      const limit = new ByteLimit(LIMITS.uploadPackRequestBytes);
      const input = advertise
        ? (async () => proc.stdin.end())()
        : req.headers['content-encoding'] === 'gzip'
          ? pipeline(req, zlib.createGunzip(), limit, proc.stdin)
          : pipeline(req, limit, proc.stdin);
      const output = pipeline(proc.stdout, res);

      const [inputResult, outputResult, code] = await Promise.allSettled([
        input,
        output,
        exited,
      ]);
      if (
        inputResult.status === 'rejected' ||
        outputResult.status === 'rejected' ||
        code.status === 'rejected' ||
        code.value !== 0
      ) {
        log(
          'SandboxJobServer',
          LogLevel.WARN,
          `upload-pack for a sandbox job failed: ${stderr.trim()}`,
        );
        res.destroy();
      }
    } finally {
      if (child) job.uploadPacks.delete(child);
      this.totalUploadPacks -= 1;
    }
  }
}
