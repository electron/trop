import * as fs from 'fs';
import * as https from 'https';

import { parse as parseYaml } from 'yaml';

import { LogLevel } from '../enums';
import { log } from '../utils/log-util';
import {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  raceResult,
  SandboxJobSpec,
  SandboxRunner,
} from './runner';

// Spawns sandbox jobs as Kubernetes Jobs. This talks to the API server with a
// few plain HTTPS calls (create, read, list and delete Jobs) instead of
// @kubernetes/client-node, which is ESM-only and would bring a large
// dependency tree into the process that holds the GitHub App key.

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const POLL_INTERVAL_MS = 3000;

/** Labels every sandbox Job (and its pod) carries; the NetworkPolicies key on them. */
export const SANDBOX_LABELS = {
  'app.kubernetes.io/part-of': 'trop',
  'app.kubernetes.io/component': 'sandbox',
} as const;
const JOB_ID_LABEL = 'trop.electronjs.org/sandbox-job';

type Json = Record<string, any>;

export class KubeClient {
  constructor(
    private readonly host = process.env.KUBERNETES_SERVICE_HOST,
    private readonly port = process.env.KUBERNETES_SERVICE_PORT ?? '443',
    private readonly tokenPath = `${SA_DIR}/token`,
    private readonly caPath = `${SA_DIR}/ca.crt`,
  ) {
    if (!host) throw new Error('KUBERNETES_SERVICE_HOST is not set');
  }

  async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Json,
  ): Promise<{ status: number; body: Json }> {
    // Re-read on every call: the projected token is rotated by the kubelet.
    const token = (await fs.promises.readFile(this.tokenPath, 'utf8')).trim();
    const ca = await fs.promises.readFile(this.caPath);
    const payload = body ? JSON.stringify(body) : undefined;

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.host,
          port: this.port,
          method,
          path,
          ca,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(payload
              ? {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }
              : {}),
          },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: Json = {};
            try {
              json = text ? (JSON.parse(text) as Json) : {};
            } catch {
              json = { message: text.slice(0, 500) };
            }
            resolve({ status: res.statusCode ?? 0, body: json });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('Kubernetes API timeout')));
      req.on('error', reject);
      req.end(payload);
    });
  }
}

const fail = (message: string): never => {
  throw new Error(`Unsafe sandbox Job template: ${message}`);
};

/**
 * Refuses a Job template that would weaken the sandbox, so that a mistaken
 * edit of the ConfigMap fails closed instead of running untrusted patches
 * with credentials or network access.
 */
export const assertSafeJobTemplate = (job: Json) => {
  if (job?.apiVersion !== 'batch/v1' || job?.kind !== 'Job') fail('not a Job');
  const spec = job.spec ?? fail('no spec');
  if (spec.backoffLimit !== 0) fail('backoffLimit must be 0');
  if (typeof spec.activeDeadlineSeconds !== 'number') {
    fail('activeDeadlineSeconds must be set');
  }
  const pod = spec.template?.spec ?? fail('no pod spec');
  const labels = spec.template?.metadata?.labels ?? {};
  for (const [key, value] of Object.entries(SANDBOX_LABELS)) {
    if (labels[key] !== value) fail(`pod label ${key} must be ${value}`);
  }
  if (labels['azure.workload.identity/use'] !== undefined) {
    fail('pod must not use workload identity');
  }
  if (pod.automountServiceAccountToken !== false) {
    fail('automountServiceAccountToken must be false');
  }
  if (pod.enableServiceLinks !== false)
    fail('enableServiceLinks must be false');
  if (pod.hostNetwork || pod.hostPID || pod.hostIPC) {
    fail('host namespaces are not allowed');
  }
  if (pod.restartPolicy !== 'Never') fail('restartPolicy must be Never');
  if (pod.dnsPolicy !== 'None') fail('dnsPolicy must be None');
  if (pod.securityContext?.runAsNonRoot !== true) {
    fail('runAsNonRoot must be true');
  }
  if (pod.initContainers?.length || pod.ephemeralContainers?.length) {
    fail('only a single container is allowed');
  }
  if (!Array.isArray(pod.containers) || pod.containers.length !== 1) {
    fail('exactly one container is required');
  }
  for (const volume of pod.volumes ?? []) {
    if (Object.keys(volume).some((k) => k !== 'name' && k !== 'emptyDir')) {
      fail(`volume ${volume.name} is not an emptyDir`);
    }
  }
  const container = pod.containers[0];
  if (container.envFrom?.length) fail('envFrom is not allowed');
  for (const env of container.env ?? []) {
    if (env.valueFrom) fail(`env ${env.name} must not use valueFrom`);
  }
  const sc = container.securityContext ?? fail('no container securityContext');
  if (sc.allowPrivilegeEscalation !== false) {
    fail('allowPrivilegeEscalation must be false');
  }
  if (sc.privileged) fail('privileged is not allowed');
  if (sc.readOnlyRootFilesystem !== true) {
    fail('readOnlyRootFilesystem must be true');
  }
  if (!sc.capabilities?.drop?.includes('ALL'))
    fail('capabilities must drop ALL');
};

export interface KubernetesRunnerConfig {
  namespace: string;
  image: string;
  templatePath: string;
  /** This pod's IP: the address jobs reach the job server at. */
  podIp: string;
  timeoutMs?: number;
}

/** Runs each sandbox job as a Kubernetes Job built from a template. */
export class KubernetesJobRunner implements SandboxRunner {
  readonly kind = 'kubernetes';
  readonly listenHost: string;
  private readonly template: Json;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: KubernetesRunnerConfig,
    private readonly kube = new KubeClient(),
  ) {
    this.listenHost = config.podIp;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
    this.template = parseYaml(
      fs.readFileSync(config.templatePath, 'utf8'),
    ) as Json;
    assertSafeJobTemplate(this.template);
  }

  private get jobsPath() {
    return `/apis/batch/v1/namespaces/${encodeURIComponent(this.config.namespace)}/jobs`;
  }

  buildJob(spec: SandboxJobSpec): Json {
    const job = structuredClone(this.template);
    const name = `trop-sandbox-${spec.id.slice(0, 16)}`;
    const labels = { ...SANDBOX_LABELS, [JOB_ID_LABEL]: spec.id };
    job.metadata = {
      ...job.metadata,
      name,
      namespace: this.config.namespace,
      labels: { ...job.metadata?.labels, ...labels },
    };
    job.spec.template.metadata.labels = {
      ...job.spec.template.metadata.labels,
      ...labels,
    };
    const container = job.spec.template.spec.containers[0];
    container.image = this.config.image;
    container.env = [
      ...(container.env ?? []).filter(
        (e: Json) =>
          !['TROP_SANDBOX_URL', 'TROP_SANDBOX_TOKEN'].includes(e.name),
      ),
      { name: 'TROP_SANDBOX_URL', value: spec.url },
      { name: 'TROP_SANDBOX_TOKEN', value: spec.token },
    ];
    // Checked again after filling in, in case the template changed underfoot.
    assertSafeJobTemplate(job);
    return job;
  }

  async run(spec: SandboxJobSpec) {
    const job = this.buildJob(spec);
    const name: string = job.metadata.name;
    const created = await this.kube.request('POST', this.jobsPath, job);
    if (created.status !== 201) {
      throw new Error(
        `Creating sandbox Job ${name} failed: ${created.status} ${created.body.message ?? ''}`,
      );
    }
    log('KubernetesJobRunner', LogLevel.INFO, `Created sandbox Job ${name}`);

    const stop = { stopped: false };
    try {
      return await raceResult(spec, this.watch(name, stop), this.timeoutMs);
    } finally {
      stop.stopped = true;
      await this.delete(name);
    }
  }

  /** Resolves with a reason once the Job has finished (or disappeared). */
  private async watch(name: string, stop: { stopped: boolean }) {
    while (!stop.stopped) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (stop.stopped) break;
      try {
        const { status, body } = await this.kube.request(
          'GET',
          `${this.jobsPath}/${name}`,
        );
        if (status === 404) return 'the Job was deleted';
        const jobStatus = body.status ?? {};
        if (jobStatus.failed > 0) return 'the Job failed';
        const failed = (jobStatus.conditions ?? []).find(
          (c: Json) => c.type === 'Failed' && c.status === 'True',
        );
        if (failed) return `the Job failed: ${failed.reason ?? ''}`;
        if (jobStatus.succeeded > 0) {
          // The pod exits after its result was accepted; give the result a
          // moment to win the race before reporting a missing one.
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          return 'the Job completed';
        }
      } catch (error) {
        log(
          'KubernetesJobRunner',
          LogLevel.WARN,
          `Reading ${name} failed`,
          error,
        );
      }
    }
    return 'stopped';
  }

  private async delete(name: string) {
    try {
      const { status } = await this.kube.request(
        'DELETE',
        `${this.jobsPath}/${name}?propagationPolicy=Background`,
      );
      if (status !== 200 && status !== 202 && status !== 404) {
        throw new Error(`status ${status}`);
      }
    } catch (error) {
      // ttlSecondsAfterFinished and activeDeadlineSeconds clean up regardless.
      log(
        'KubernetesJobRunner',
        LogLevel.WARN,
        `Deleting ${name} failed`,
        error,
      );
    }
  }

  /** Deletes sandbox Jobs left behind by a previous server process. */
  async deleteOrphanedJobs() {
    const selector = Object.entries(SANDBOX_LABELS)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const { status, body } = await this.kube.request(
      'GET',
      `${this.jobsPath}?labelSelector=${encodeURIComponent(selector)}`,
    );
    if (status !== 200)
      throw new Error(`Listing sandbox Jobs failed: ${status}`);
    for (const item of body.items ?? []) {
      if (typeof item?.metadata?.name === 'string') {
        await this.delete(item.metadata.name);
      }
    }
  }
}
