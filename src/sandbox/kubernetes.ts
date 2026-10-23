import * as fs from 'fs';
import * as https from 'https';

import { parse as parseYaml } from 'yaml';

import { LogLevel } from '../enums';
import { log } from '../utils/log-util';
import {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  raceResult,
  SandboxInfraError,
  SandboxJobSpec,
  SandboxRunner,
} from './runner';

// Spawns sandbox jobs as Kubernetes Jobs. This talks to the API server with a
// few plain HTTPS calls (create, read, list and delete Jobs; list pods)
// instead of
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
const SERVER_POD_LABEL = 'trop.electronjs.org/server-pod-uid';
const SANDBOX_SERVICE_ACCOUNT = 'sandbox';

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
 * with credentials, host access or network access.
 */
export const assertSafeJobTemplate = (job: Json) => {
  if (job?.apiVersion !== 'batch/v1' || job?.kind !== 'Job') fail('not a Job');
  const spec = job.spec ?? fail('no spec');
  if (spec.backoffLimit !== 0) fail('backoffLimit must be 0');
  if (
    typeof spec.activeDeadlineSeconds !== 'number' ||
    spec.activeDeadlineSeconds > 4 * 60 * 60
  ) {
    fail('activeDeadlineSeconds must be set (at most 4 hours)');
  }
  if (typeof spec.ttlSecondsAfterFinished !== 'number') {
    fail('ttlSecondsAfterFinished must be set');
  }
  if ((spec.parallelism ?? 1) !== 1 || (spec.completions ?? 1) !== 1) {
    fail('parallelism and completions must be 1');
  }
  const pod = spec.template?.spec ?? fail('no pod spec');
  const labels = spec.template?.metadata?.labels ?? {};
  for (const [key, value] of Object.entries(SANDBOX_LABELS)) {
    if (labels[key] !== value) fail(`pod label ${key} must be ${value}`);
  }
  if (labels['azure.workload.identity/use'] !== undefined) {
    fail('pod must not use workload identity');
  }
  if (pod.serviceAccountName !== SANDBOX_SERVICE_ACCOUNT) {
    fail(`serviceAccountName must be ${SANDBOX_SERVICE_ACCOUNT}`);
  }
  if (pod.automountServiceAccountToken !== false) {
    fail('automountServiceAccountToken must be false');
  }
  if (pod.enableServiceLinks !== false) {
    fail('enableServiceLinks must be false');
  }
  if (pod.hostNetwork || pod.hostPID || pod.hostIPC || pod.hostUsers === true) {
    fail('host namespaces are not allowed');
  }
  if (pod.shareProcessNamespace) fail('shareProcessNamespace is not allowed');
  if (pod.restartPolicy !== 'Never') fail('restartPolicy must be Never');
  // On the tainted sandbox pool and nowhere else.
  if (
    JSON.stringify(pod.nodeSelector) !==
    JSON.stringify({ 'electronjs.org/pool': 'sandbox' })
  ) {
    fail('nodeSelector must be exactly electronjs.org/pool=sandbox');
  }
  if (
    JSON.stringify(pod.tolerations) !==
    JSON.stringify([
      {
        key: 'electronjs.org/sandbox',
        operator: 'Equal',
        value: 'true',
        effect: 'NoSchedule',
      },
    ])
  ) {
    fail('tolerations must be exactly the sandbox pool taint');
  }
  if (pod.affinity || pod.nodeName || pod.priorityClassName) {
    fail('affinity, nodeName and priorityClassName are not allowed');
  }
  if (
    pod.runtimeClassName !== undefined &&
    pod.runtimeClassName !== 'kata-vm-isolation'
  ) {
    fail('runtimeClassName may only be kata-vm-isolation');
  }
  if (pod.dnsPolicy !== 'None') fail('dnsPolicy must be None');
  const podSc = pod.securityContext ?? {};
  if (podSc.runAsNonRoot !== true) fail('runAsNonRoot must be true');
  if (podSc.runAsUser === 0 || podSc.runAsGroup === 0) {
    fail('must not run as root');
  }
  if (podSc.seccompProfile?.type !== 'RuntimeDefault') {
    fail('seccompProfile must be RuntimeDefault');
  }
  if (podSc.appArmorProfile?.type === 'Unconfined') {
    fail('appArmorProfile must not be Unconfined');
  }
  if (podSc.sysctls?.length) fail('sysctls are not allowed');
  if (pod.initContainers?.length || pod.ephemeralContainers?.length) {
    fail('only a single container is allowed');
  }
  if (!Array.isArray(pod.containers) || pod.containers.length !== 1) {
    fail('exactly one container is required');
  }
  const volumes = new Set<string>();
  for (const volume of pod.volumes ?? []) {
    if (Object.keys(volume).some((k) => k !== 'name' && k !== 'emptyDir')) {
      fail(`volume ${volume.name} is not an emptyDir`);
    }
    volumes.add(volume.name);
  }
  const container = pod.containers[0];
  if (container.envFrom?.length) fail('envFrom is not allowed');
  for (const env of container.env ?? []) {
    if (env.valueFrom) fail(`env ${env.name} must not use valueFrom`);
  }
  for (const port of container.ports ?? []) {
    if (port.hostPort !== undefined || port.hostIP !== undefined) {
      fail('host ports are not allowed');
    }
  }
  for (const mount of container.volumeMounts ?? []) {
    if (!volumes.has(mount.name)) fail(`volume ${mount.name} is not defined`);
  }
  if (container.volumeDevices?.length) fail('volumeDevices are not allowed');
  const sc = container.securityContext ?? fail('no container securityContext');
  if (sc.allowPrivilegeEscalation !== false) {
    fail('allowPrivilegeEscalation must be false');
  }
  if (sc.privileged) fail('privileged is not allowed');
  if (sc.readOnlyRootFilesystem !== true) {
    fail('readOnlyRootFilesystem must be true');
  }
  if (!sc.capabilities?.drop?.includes('ALL')) {
    fail('capabilities must drop ALL');
  }
  if (sc.capabilities?.add?.length) fail('capabilities must not be added');
  if (sc.runAsNonRoot === false || sc.runAsUser === 0 || sc.runAsGroup === 0) {
    fail('the container must not run as root');
  }
  if (
    sc.seccompProfile?.type === 'Unconfined' ||
    sc.appArmorProfile?.type === 'Unconfined'
  ) {
    fail('the container must not be Unconfined');
  }
  if (
    !container.resources?.limits?.cpu ||
    !container.resources?.limits?.memory
  ) {
    fail('cpu and memory limits are required');
  }
  if (sc.procMount !== undefined && sc.procMount !== 'Default') {
    fail('procMount must be Default');
  }
};

// Why a pod can never start, from its container's waiting reason.
const FATAL_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImageNeverPull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
]);

export interface KubernetesRunnerConfig {
  namespace: string;
  image: string;
  templatePath: string;
  /** This pod's IP: the address jobs reach the job server at. */
  podIp: string;
  /** This pod's name and UID: every Job is owned by (and labelled with) it. */
  podName: string;
  podUid: string;
  /** How long the whole job may take, from creating it. */
  timeoutMs?: number;
  /**
   * How long its pod may take to start (the sandbox node pool scales up from
   * zero). A pod that can never start (bad image, bad config) fails at once.
   */
  schedulingTimeoutMs?: number;
}

export const DEFAULT_SCHEDULING_TIMEOUT_MS = 15 * 60 * 1000;

/** Runs each sandbox job as a Kubernetes Job built from a template. */
export class KubernetesJobRunner implements SandboxRunner {
  readonly kind = 'kubernetes';
  readonly listenHost: string;
  private readonly template: Json;
  private readonly timeoutMs: number;
  private readonly schedulingTimeoutMs: number;

  constructor(
    private readonly config: KubernetesRunnerConfig,
    private readonly kube = new KubeClient(),
  ) {
    if (!/^[0-9a-f-]{36}$/.test(config.podUid)) {
      throw new Error('POD_UID is not a pod UID');
    }
    this.listenHost = config.podIp;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
    this.schedulingTimeoutMs =
      config.schedulingTimeoutMs ?? DEFAULT_SCHEDULING_TIMEOUT_MS;
    this.template = parseYaml(
      fs.readFileSync(config.templatePath, 'utf8'),
    ) as Json;
    assertSafeJobTemplate(this.template);
  }

  private get namespacePath() {
    return `/namespaces/${encodeURIComponent(this.config.namespace)}`;
  }

  private get jobsPath() {
    return `/apis/batch/v1${this.namespacePath}/jobs`;
  }

  buildJob(spec: SandboxJobSpec): Json {
    const job = structuredClone(this.template);
    const name = `trop-sandbox-${spec.id.slice(0, 16)}`;
    const labels = {
      ...SANDBOX_LABELS,
      [JOB_ID_LABEL]: spec.id,
      [SERVER_POD_LABEL]: this.config.podUid,
    };
    job.metadata = {
      ...job.metadata,
      name,
      namespace: this.config.namespace,
      labels: { ...job.metadata?.labels, ...labels },
      // Owned by this server pod: when the pod goes away (a deploy, a
      // crash), Kubernetes garbage-collects its Jobs, whose results nobody
      // could receive any more.
      ownerReferences: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          name: this.config.podName,
          uid: this.config.podUid,
        },
      ],
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
    try {
      const created = await this.kube.request('POST', this.jobsPath, job);
      if (created.status !== 201) {
        throw new Error(`${created.status} ${created.body.message ?? ''}`);
      }
    } catch (error) {
      // The API server may have created it even though the call failed.
      await this.delete(name);
      throw new SandboxInfraError(
        `Creating sandbox Job ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    log('KubernetesJobRunner', LogLevel.INFO, `Created sandbox Job ${name}`);

    const stop = { stopped: false };
    try {
      return await raceResult(
        spec,
        this.watch(name, spec.id, stop),
        this.timeoutMs,
      );
    } finally {
      stop.stopped = true;
      await this.delete(name);
    }
  }

  /** Resolves with a reason once the Job has finished or cannot run. */
  private async watch(name: string, id: string, stop: { stopped: boolean }) {
    const created = Date.now();
    let started = false;
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

        if (!started) {
          const pod = await this.readPod(id);
          const waiting = pod?.status?.containerStatuses?.[0]?.state?.waiting;
          if (waiting && FATAL_WAITING_REASONS.has(waiting.reason)) {
            return `its pod cannot start: ${waiting.reason} ${waiting.message ?? ''}`;
          }
          if (pod?.status?.phase && pod.status.phase !== 'Pending') {
            started = true;
          } else if (Date.now() - created > this.schedulingTimeoutMs) {
            const scheduled = (pod?.status?.conditions ?? []).find(
              (c: Json) => c.type === 'PodScheduled',
            );
            return `its pod did not start within ${this.schedulingTimeoutMs / 1000}s: ${scheduled?.reason ?? 'pending'} ${scheduled?.message ?? ''}`;
          }
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

  private async readPod(id: string): Promise<Json | undefined> {
    const selector = `${JOB_ID_LABEL}=${id}`;
    const { status, body } = await this.kube.request(
      'GET',
      `/api/v1${this.namespacePath}/pods?labelSelector=${encodeURIComponent(selector)}`,
    );
    if (status !== 200) throw new Error(`Listing pods failed: ${status}`);
    return body.items?.[0];
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
      // Garbage collection (the Job is owned by this pod),
      // ttlSecondsAfterFinished and activeDeadlineSeconds clean up regardless.
      log(
        'KubernetesJobRunner',
        LogLevel.WARN,
        `Deleting ${name} failed`,
        error,
      );
    }
  }

  /**
   * Deletes sandbox Jobs an earlier process in this same pod left behind (the
   * container restarted). Jobs of other server pods are never touched: during
   * a rolling deploy the old pod is still waiting on its own, and once it is
   * gone Kubernetes garbage-collects them through their owner reference.
   */
  async deleteOrphanedJobs() {
    const selector = [
      ...Object.entries(SANDBOX_LABELS).map(([k, v]) => `${k}=${v}`),
      `${SERVER_POD_LABEL}=${this.config.podUid}`,
    ].join(',');
    const { status, body } = await this.kube.request(
      'GET',
      `${this.jobsPath}?labelSelector=${encodeURIComponent(selector)}`,
    );
    if (status !== 200) {
      throw new Error(`Listing sandbox Jobs failed: ${status}`);
    }
    for (const item of body.items ?? []) {
      if (
        typeof item?.metadata?.name === 'string' &&
        item.metadata.labels?.[SERVER_POD_LABEL] === this.config.podUid
      ) {
        await this.delete(item.metadata.name);
      }
    }
  }
}
