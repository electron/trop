import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSandboxRunner } from '../src/sandbox';
import {
  assertSafeJobTemplate,
  KubeClient,
  KubernetesJobRunner,
} from '../src/sandbox/kubernetes';
import { SandboxResult } from '../src/sandbox/protocol';
import {
  LocalProcessRunner,
  SandboxInfraError,
  SandboxJobSpec,
} from '../src/sandbox/runner';

// The Job template exactly as deploy/base ships it.
const templateYaml: string = parse(
  fs
    .readFileSync(
      path.join(__dirname, '..', 'deploy', 'base', 'sandbox.yaml'),
      'utf8',
    )
    .split('\n---\n')[1],
).data['sandbox-job.yaml'];

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

describe('assertSafeJobTemplate()', () => {
  const template = () => parse(templateYaml);

  it('accepts the shipped template', () => {
    expect(() => assertSafeJobTemplate(template())).not.toThrow();
  });

  it.each<[string, (job: any) => void]>([
    [
      'a mounted SA token',
      (j) => (j.spec.template.spec.automountServiceAccountToken = true),
    ],
    ['service links', (j) => delete j.spec.template.spec.enableServiceLinks],
    ['host networking', (j) => (j.spec.template.spec.hostNetwork = true)],
    ['cluster DNS', (j) => (j.spec.template.spec.dnsPolicy = 'ClusterFirst')],
    ['retries', (j) => (j.spec.backoffLimit = 3)],
    ['no deadline', (j) => delete j.spec.activeDeadlineSeconds],
    [
      'root',
      (j) => (j.spec.template.spec.securityContext.runAsNonRoot = false),
    ],
    [
      'a writable root filesystem',
      (j) =>
        (j.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem =
          false),
    ],
    [
      'privilege escalation',
      (j) =>
        (j.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation =
          true),
    ],
    [
      'kept capabilities',
      (j) =>
        (j.spec.template.spec.containers[0].securityContext.capabilities.drop =
          []),
    ],
    [
      'envFrom a secret',
      (j) =>
        (j.spec.template.spec.containers[0].envFrom = [
          { secretRef: { name: 'server-secrets' } },
        ]),
    ],
    [
      'env from a secret',
      (j) =>
        j.spec.template.spec.containers[0].env.push({
          name: 'X',
          valueFrom: { secretKeyRef: { name: 's', key: 'k' } },
        }),
    ],
    [
      'a secret volume',
      (j) =>
        j.spec.template.spec.volumes.push({
          name: 's',
          secret: { secretName: 'server-secrets' },
        }),
    ],
    [
      'a hostPath volume',
      (j) =>
        j.spec.template.spec.volumes.push({
          name: 'h',
          hostPath: { path: '/' },
        }),
    ],
    [
      'a second container',
      (j) => j.spec.template.spec.containers.push({ name: 'x' }),
    ],
    [
      'an init container',
      (j) => (j.spec.template.spec.initContainers = [{ name: 'x' }]),
    ],
    [
      'workload identity',
      (j) =>
        (j.spec.template.metadata.labels['azure.workload.identity/use'] =
          'true'),
    ],
    [
      'another service account',
      (j) => (j.spec.template.spec.serviceAccountName = 'server'),
    ],
    [
      'a host port',
      (j) =>
        (j.spec.template.spec.containers[0].ports = [
          { containerPort: 1, hostPort: 1 },
        ]),
    ],
    [
      'added capabilities',
      (j) =>
        (j.spec.template.spec.containers[0].securityContext.capabilities.add = [
          'NET_RAW',
        ]),
    ],
    [
      'privileged',
      (j) =>
        (j.spec.template.spec.containers[0].securityContext.privileged = true),
    ],
    ['host PID', (j) => (j.spec.template.spec.hostPID = true)],
    ['host IPC', (j) => (j.spec.template.spec.hostIPC = true)],
    [
      'a shared process namespace',
      (j) => (j.spec.template.spec.shareProcessNamespace = true),
    ],
    [
      'a projected volume',
      (j) =>
        j.spec.template.spec.volumes.push({
          name: 'p',
          projected: { sources: [] },
        }),
    ],
    [
      'a mount of an undefined volume',
      (j) =>
        j.spec.template.spec.containers[0].volumeMounts.push({
          name: 'nope',
          mountPath: '/x',
        }),
    ],
    ['no TTL', (j) => delete j.spec.ttlSecondsAfterFinished],
    ['a day-long deadline', (j) => (j.spec.activeDeadlineSeconds = 86_400)],
    ['parallel pods', (j) => (j.spec.parallelism = 2)],
    [
      'another node pool',
      (j) =>
        (j.spec.template.spec.nodeSelector = { 'electronjs.org/pool': 'apps' }),
    ],
    [
      'tolerating everything',
      (j) => j.spec.template.spec.tolerations.push({ operator: 'Exists' }),
    ],
    [
      'node affinity',
      (j) => (j.spec.template.spec.affinity = { nodeAffinity: {} }),
    ],
    ['a node name', (j) => (j.spec.template.spec.nodeName = 'node-1')],
    [
      'a priority class',
      (j) => (j.spec.template.spec.priorityClassName = 'system-node-critical'),
    ],
    [
      'another runtime',
      (j) => (j.spec.template.spec.runtimeClassName = 'runc'),
    ],
    [
      'no seccomp profile',
      (j) => delete j.spec.template.spec.securityContext.seccompProfile,
    ],
    [
      'an unconfined AppArmor profile',
      (j) =>
        (j.spec.template.spec.securityContext.appArmorProfile = {
          type: 'Unconfined',
        }),
    ],
    [
      'sysctls',
      (j) =>
        (j.spec.template.spec.securityContext.sysctls = [
          { name: 'net.ipv4.ip_unprivileged_port_start', value: '0' },
        ]),
    ],
    [
      'an unconfined container',
      (j) =>
        (j.spec.template.spec.containers[0].securityContext.seccompProfile = {
          type: 'Unconfined',
        }),
    ],
    [
      'a container running as root',
      (j) => (j.spec.template.spec.containers[0].securityContext.runAsUser = 0),
    ],
    [
      'no memory limit',
      (j) => delete j.spec.template.spec.containers[0].resources.limits.memory,
    ],
    [
      'an unmasked /proc',
      (j) =>
        (j.spec.template.spec.containers[0].securityContext.procMount =
          'Unmasked'),
    ],
    [
      'missing policy labels',
      (j) =>
        delete j.spec.template.metadata.labels['app.kubernetes.io/component'],
    ],
  ])('refuses a template with %s', (_, mutate) => {
    const job = template();
    mutate(job);
    expect(() => assertSafeJobTemplate(job)).toThrow(
      'Unsafe sandbox Job template',
    );
  });
});

describe('KubernetesJobRunner', () => {
  let tmp: string;
  let templatePath: string;
  let requests: { method: string; path: string; body?: any }[];
  let jobStatus: object;
  let createStatus: number;
  let pod: any;

  const kube = {
    request: vi.fn(async (method: string, p: string, body?: any) => {
      requests.push({ method, path: p, body });
      if (method === 'POST') return { status: createStatus, body: {} };
      if (method === 'GET' && p.startsWith('/api/v1/')) {
        return { status: 200, body: { items: pod ? [pod] : [] } };
      }
      if (method === 'GET' && p.includes('labelSelector')) {
        return {
          status: 200,
          body: {
            items: [
              {
                metadata: {
                  name: 'old',
                  labels: {
                    'trop.electronjs.org/server-pod-uid':
                      '11111111-2222-3333-4444-555555555555',
                  },
                },
              },
            ],
          },
        };
      }
      if (method === 'GET') return { status: 200, body: { status: jobStatus } };
      return { status: 200, body: {} };
    }),
  } as unknown as KubeClient;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trop-kube-'));
    templatePath = path.join(tmp, 'sandbox-job.yaml');
    await fs.promises.writeFile(templatePath, templateYaml);
    requests = [];
    jobStatus = { active: 1 };
    createStatus = 201;
    pod = { status: { phase: 'Pending' } };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  const runner = (timeoutMs = 60_000) =>
    new KubernetesJobRunner(
      {
        namespace: 'trop',
        image: 'electronionicplatform.azurecr.io/trop-sandbox:abc123',
        templatePath,
        podIp: '10.244.0.7',
        podName: 'server-abc-123',
        podUid: '11111111-2222-3333-4444-555555555555',
        timeoutMs,
        schedulingTimeoutMs: 20_000,
      },
      kube,
    );

  const spec = (result: Promise<SandboxResult>): SandboxJobSpec => ({
    id: '0123456789abcdef0123456789abcdef',
    url: 'http://10.244.0.7:8081/jobs/0123456789abcdef0123456789abcdef',
    token: 't'.repeat(43),
    result,
  });

  it('refuses an unsafe template at startup', async () => {
    const job = parse(templateYaml);
    job.spec.template.spec.automountServiceAccountToken = true;
    await fs.promises.writeFile(templatePath, JSON.stringify(job));
    expect(() => runner()).toThrow('Unsafe sandbox Job template');
  });

  it('builds Jobs that the restricted Pod Security Standard admits', () => {
    const job = runner().buildJob(spec(deferred<SandboxResult>().promise));
    const pod = job.spec.template.spec;
    const containers = [
      ...pod.containers,
      ...(pod.initContainers ?? []),
      ...(pod.ephemeralContainers ?? []),
    ];
    // Baseline.
    expect(pod.hostNetwork || pod.hostPID || pod.hostIPC).toBeFalsy();
    for (const c of containers) {
      expect(c.securityContext?.privileged).toBeFalsy();
      expect(c.securityContext?.procMount ?? 'Default').toBe('Default');
      for (const p of c.ports ?? []) expect(p.hostPort).toBeUndefined();
    }
    expect(pod.securityContext?.sysctls).toBeUndefined();
    // Restricted.
    const allowedVolumes = [
      'configMap',
      'csi',
      'downwardAPI',
      'emptyDir',
      'ephemeral',
      'persistentVolumeClaim',
      'projected',
      'secret',
    ];
    for (const v of pod.volumes) {
      for (const key of Object.keys(v).filter((k) => k !== 'name')) {
        expect(allowedVolumes).toContain(key);
      }
    }
    for (const c of containers) {
      const sc = c.securityContext;
      expect(sc.allowPrivilegeEscalation).toBe(false);
      expect(sc.runAsNonRoot ?? pod.securityContext.runAsNonRoot).toBe(true);
      expect(sc.runAsUser ?? pod.securityContext.runAsUser).not.toBe(0);
      expect(['RuntimeDefault', 'Localhost']).toContain(
        (sc.seccompProfile ?? pod.securityContext.seccompProfile).type,
      );
      expect(sc.capabilities.drop).toContain('ALL');
      expect(sc.capabilities.add ?? []).toEqual([]);
    }
  });

  it("builds Jobs within the cluster's admission policy for sandbox Jobs", () => {
    // electron/infra's ValidatingAdmissionPolicy for Jobs the server creates.
    const job = runner().buildJob(spec(deferred<SandboxResult>().promise));
    const meta = job.spec.template.metadata;
    const pod = job.spec.template.spec;
    expect(meta.labels).toMatchObject({
      'app.kubernetes.io/part-of': 'trop',
      'app.kubernetes.io/component': 'sandbox',
    });
    expect(meta.labels['azure.workload.identity/use']).toBeUndefined();
    expect(pod.serviceAccountName).toBe('sandbox');
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.nodeSelector?.['electronjs.org/pool']).toBe('sandbox');
    expect(pod.nodeName).toBeUndefined();
    for (const t of pod.tolerations)
      expect(t.key).toBe('electronjs.org/sandbox');
    expect(pod.hostNetwork || pod.hostPID || pod.hostIPC).toBeFalsy();
    for (const v of pod.volumes) {
      expect(Object.keys(v).sort()).toEqual(['emptyDir', 'name']);
    }
    for (const c of [
      ...pod.containers,
      ...(pod.initContainers ?? []),
      ...(pod.ephemeralContainers ?? []),
    ]) {
      expect(c.image).toMatch(
        /^electronionicplatform\.azurecr\.io\/trop-sandbox[:@]/,
      );
      expect(c.securityContext.privileged).toBeFalsy();
      expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
      expect(c.securityContext.capabilities?.add).toBeUndefined();
      expect(c.envFrom).toBeUndefined();
      for (const e of c.env ?? []) expect(e.valueFrom).toBeUndefined();
      for (const p of c.ports ?? []) {
        expect(p.hostPort).toBeUndefined();
        expect(p.hostIP).toBeUndefined();
      }
    }
  });

  it('creates the Job, returns the result and deletes the Job', async () => {
    const result = deferred<SandboxResult>();
    const run = runner().run(spec(result.promise));
    await vi.advanceTimersByTimeAsync(10);
    result.resolve({ outcome: 'conflict', diff: '' });
    await expect(run).resolves.toEqual({ outcome: 'conflict', diff: '' });

    const create = requests.find((r) => r.method === 'POST')!;
    expect(create.path).toBe('/apis/batch/v1/namespaces/trop/jobs');
    const job = create.body;
    expect(job.metadata.name).toBe('trop-sandbox-0123456789abcdef');
    expect(job.metadata.namespace).toBe('trop');
    const pod = job.spec.template;
    expect(pod.metadata.labels).toMatchObject({
      'app.kubernetes.io/part-of': 'trop',
      'app.kubernetes.io/component': 'sandbox',
      'trop.electronjs.org/sandbox-job': '0123456789abcdef0123456789abcdef',
    });
    expect(pod.spec.containers[0].image).toBe(
      'electronionicplatform.azurecr.io/trop-sandbox:abc123',
    );
    expect(pod.spec.containers[0].env).toEqual(
      expect.arrayContaining([
        { name: 'TROP_SANDBOX_URL', value: spec(result.promise).url },
        { name: 'TROP_SANDBOX_TOKEN', value: 't'.repeat(43) },
      ]),
    );
    expect(job.metadata.ownerReferences).toEqual([
      {
        apiVersion: 'v1',
        kind: 'Pod',
        name: 'server-abc-123',
        uid: '11111111-2222-3333-4444-555555555555',
      },
    ]);
    expect(job.metadata.labels['trop.electronjs.org/server-pod-uid']).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
    expect(requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/apis/batch/v1/namespaces/trop/jobs/trop-sandbox-0123456789abcdef?propagationPolicy=Background',
    });
  });

  it('fails when the Job cannot be created, and deletes it anyway', async () => {
    createStatus = 500;
    await expect(
      runner().run(spec(deferred<SandboxResult>().promise)),
    ).rejects.toThrow(SandboxInfraError);
    expect(requests.at(-1)?.method).toBe('DELETE');
  });

  it('fails at once when the pod cannot pull its image', async () => {
    pod = {
      status: {
        phase: 'Pending',
        containerStatuses: [
          { state: { waiting: { reason: 'ImagePullBackOff', message: 'no' } } },
        ],
      },
    };
    const run = runner().run(spec(deferred<SandboxResult>().promise));
    const failed = run.then(
      () => new Error('resolved'),
      (e: Error) => e,
    );
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await failed).toBeInstanceOf(SandboxInfraError);
    expect((await failed).message).toContain('ImagePullBackOff');
    expect(requests.at(-1)?.method).toBe('DELETE');
  });

  it('fails when the pod is not scheduled in time', async () => {
    pod = {
      status: {
        phase: 'Pending',
        conditions: [
          { type: 'PodScheduled', status: 'False', reason: 'Unschedulable' },
        ],
      },
    };
    const run = runner().run(spec(deferred<SandboxResult>().promise));
    const failed = run.then(
      () => new Error('resolved'),
      (e: Error) => e,
    );
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await failed).toBeInstanceOf(SandboxInfraError);
    expect((await failed).message).toContain('Unschedulable');
  });

  it('keeps waiting for a running pod past the scheduling deadline', async () => {
    pod = { status: { phase: 'Running' } };
    const result = deferred<SandboxResult>();
    const run = runner().run(spec(result.promise));
    await vi.advanceTimersByTimeAsync(25_000);
    result.resolve({ outcome: 'conflict', diff: '' });
    await expect(run).resolves.toEqual({ outcome: 'conflict', diff: '' });
  });

  it('fails when the Job fails without a result', async () => {
    jobStatus = { failed: 1 };
    const run = runner().run(spec(deferred<SandboxResult>().promise));
    const failed = run.then(
      () => new Error('resolved'),
      (e: Error) => e,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await failed).toBeInstanceOf(SandboxInfraError);
    expect((await failed).message).toContain('ended without a result');
    expect(requests.at(-1)?.method).toBe('DELETE');
  });

  it('fails and deletes the Job when it runs out of time', async () => {
    pod = { status: { phase: 'Running' } };
    const run = runner(30_000).run(spec(deferred<SandboxResult>().promise));
    const timedOut = run.then(
      () => new Error('resolved'),
      (e: Error) => e,
    );
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await timedOut).toBeInstanceOf(SandboxInfraError);
    expect((await timedOut).message).toContain('timed out');
    // A patch that hangs git would hang a new job too.
    expect((await timedOut) as SandboxInfraError).toMatchObject({
      retryable: false,
    });
    expect(requests.at(-1)?.method).toBe('DELETE');
  });

  it('fails when the result is invalid', async () => {
    const result = deferred<SandboxResult>();
    const run = runner().run(spec(result.promise));
    result.reject(new Error('Invalid sandbox result: nope'));
    await expect(run).rejects.toThrow('Invalid sandbox result');
    // Not an infrastructure failure: it is not retried.
    await expect(run).rejects.not.toBeInstanceOf(SandboxInfraError);
    expect(requests.at(-1)?.method).toBe('DELETE');
  });

  it("deletes only the Jobs this pod's previous process left behind", async () => {
    await runner().deleteOrphanedJobs();
    expect(requests[0].path).toContain(
      `labelSelector=${encodeURIComponent('app.kubernetes.io/part-of=trop,app.kubernetes.io/component=sandbox,trop.electronjs.org/server-pod-uid=11111111-2222-3333-4444-555555555555')}`,
    );
    expect(requests[1]).toMatchObject({ method: 'DELETE' });
    expect(requests[1].path).toContain('/jobs/old?');
  });
});

describe('sandbox runner selection', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('uses the local runner outside production', () => {
    delete process.env.TROP_SANDBOX_RUNNER;
    process.env.NODE_ENV = 'test';
    expect(loadSandboxRunner().kind).toBe('local');
  });

  it('never falls back to the local runner in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TROP_SANDBOX_RUNNER;
    expect(() => loadSandboxRunner()).toThrow('must be set');

    process.env.TROP_SANDBOX_RUNNER = 'local';
    expect(() => loadSandboxRunner()).toThrow('not allowed in production');
    expect(() => new LocalProcessRunner()).toThrow('not allowed in production');
  });

  it('refuses the local runner where the Kubernetes runner is configured', () => {
    process.env.NODE_ENV = 'development';
    process.env.TROP_SANDBOX_RUNNER = 'kubernetes';
    expect(() => new LocalProcessRunner()).toThrow('not allowed');
    expect(() => LocalProcessRunner.assertAllowed()).toThrow('not allowed');
  });

  it('refuses an unknown runner', () => {
    process.env.NODE_ENV = 'test';
    process.env.TROP_SANDBOX_RUNNER = 'docker';
    expect(() => loadSandboxRunner()).toThrow('Unknown TROP_SANDBOX_RUNNER');
  });

  it('requires the pod identity for the Kubernetes runner', () => {
    process.env.NODE_ENV = 'production';
    process.env.TROP_SANDBOX_RUNNER = 'kubernetes';
    process.env.POD_IP = '10.244.0.7';
    process.env.TROP_SANDBOX_IMAGE = 'x';
    process.env.TROP_SANDBOX_JOB_TEMPLATE = '/nonexistent';
    process.env.TROP_SANDBOX_NAMESPACE = 'trop';
    delete process.env.POD_NAME;
    expect(() => loadSandboxRunner()).toThrow('POD_NAME');
  });

  it('refuses a pod IP that is not an IP', () => {
    process.env.NODE_ENV = 'production';
    process.env.TROP_SANDBOX_RUNNER = 'kubernetes';
    process.env.POD_IP = 'evil.example.com';
    expect(() => loadSandboxRunner()).toThrow('POD_IP');
  });
});
