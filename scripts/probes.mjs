import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { requireOwnedCluster, runKubectl } from "./lab.mjs";

const appName = "reliability-api";
const replicaCount = 3;
const selector = `-l=app.kubernetes.io/name=${appName}`;
const pollIntervalMs = 250;
const readinessTimeoutMs = 30_000;
const startupTimeoutMs = 30_000;
const livenessTimeoutMs = 60_000;
const recoveryTimeoutMs = 45_000;
const readinessMarker = "/tmp/kubernetes-reliability-lab-readiness-failure";
const livenessMarker = "/tmp/kubernetes-reliability-lab-liveness-failure";

async function main() {
  const state = await requireOwnedCluster();
  const [pods, endpoints] = await Promise.all([getPods(), getEndpointState()]);
  assertReadyPods(pods);
  const podNames = new Set(pods.items.map((pod) => pod.metadata.name));
  if (
    endpoints.readyPodNames.size !== replicaCount ||
    [...podNames].some((name) => !endpoints.readyPodNames.has(name))
  ) {
    throw new Error(
      "The probe experiment requires three ready Service endpoints",
    );
  }

  const target = pods.items[0];
  const targetName = target.metadata.name;
  const targetUid = target.metadata.uid;
  const initialRestartCount = getRestartCount(target);
  let result;
  let failure;

  try {
    const readiness = await demonstrateReadiness(
      targetName,
      initialRestartCount,
    );
    const liveness = await demonstrateLiveness(targetName, targetUid);
    result = {
      endpoint: `http://127.0.0.1:${state.hostPort}`,
      pod: { name: targetName, uid: targetUid },
      readiness,
      liveness,
    };
  } catch (error) {
    failure = error;
    await reportDiagnostics(targetName);
  }

  const cleanupErrors = await removeFailureMarkers(targetName);
  try {
    await waitForRecovery(targetName, targetUid, initialRestartCount);
  } catch (error) {
    cleanupErrors.push(error.message);
    await reportDiagnostics(targetName);
  }

  if (failure) {
    if (cleanupErrors.length > 0) {
      const message =
        failure instanceof Error ? failure.message : String(failure);
      throw new Error(
        `${message}; cleanup also failed: ${cleanupErrors.join("; ")}`,
        { cause: failure },
      );
    }
    throw failure;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(
      `Probe experiment cleanup failed: ${cleanupErrors.join("; ")}`,
    );
  }

  console.log(JSON.stringify(result, null, 2));
}

async function demonstrateReadiness(podName, initialRestartCount) {
  await writeFailureMarker(podName, readinessMarker);
  const degraded = await waitFor(
    "the Pod to become unready and leave ready Service endpoints",
    async (deadline) => {
      const [pod, endpoints] = await Promise.all([
        getPod(podName, deadline),
        getEndpointState(deadline),
      ]);
      const ready = isPodReady(pod);
      const restartCount = getRestartCount(pod);
      if (
        pod.status.phase === "Running" &&
        !ready &&
        restartCount === initialRestartCount &&
        endpoints.readyPodNames.size === replicaCount - 1 &&
        !endpoints.readyPodNames.has(podName)
      ) {
        return { pod, endpoints };
      }
      return null;
    },
    readinessTimeoutMs,
  );

  const [readinessProbe, livenessProbe] = await Promise.all([
    requestProbe(podName, "ready"),
    requestProbe(podName, "live"),
  ]);
  if (
    readinessProbe.status !== 503 ||
    livenessProbe.status !== 200 ||
    getRestartCount(degraded.pod) !== initialRestartCount
  ) {
    throw new Error("Readiness failure affected the wrong health signal");
  }

  await removeFailureMarker(podName, readinessMarker);
  const recovered = await waitForReady(podName, readinessTimeoutMs);
  if (getRestartCount(recovered.pod) !== initialRestartCount) {
    throw new Error("The Pod restarted during the readiness experiment");
  }

  return {
    probeStatusWithMarker: readinessProbe.status,
    livenessStatusAtTheSameTime: livenessProbe.status,
    podReadyWithMarker: false,
    readyServiceEndpointsWithMarker: degraded.endpoints.readyPodNames.size,
    restartCountBeforeAndAfter: initialRestartCount,
    readyServiceEndpointsAfterRecovery: recovered.endpoints.readyPodNames.size,
  };
}

async function demonstrateLiveness(podName, podUid) {
  const before = await getPod(podName);
  const restartCountBefore = getRestartCount(before);
  await writeFailureMarker(podName, livenessMarker);

  const failingProbe = await requestProbe(podName, "live");
  if (failingProbe.status !== 503) {
    throw new Error(
      `Expected the liveness route to fail with 503, received ${failingProbe.status}`,
    );
  }

  const startupPending = await waitFor(
    "the container restart and startup probe gate",
    async (deadline) => {
      const pod = await getPod(podName, deadline);
      assertSamePodUid(pod, podUid);
      const container = getApiContainerStatus(pod);
      if (
        getRestartCount(pod) === restartCountBefore + 1 &&
        container.state?.running &&
        container.started === false
      ) {
        return { pod, container };
      }
      if (getRestartCount(pod) > restartCountBefore + 1) {
        throw new Error("The liveness marker caused more than one restart");
      }
      return null;
    },
    livenessTimeoutMs,
  );

  const [startupProbe, liveProbe, markerPresent] = await Promise.all([
    requestProbe(podName, "startup"),
    requestProbe(podName, "live"),
    failureMarkerExists(podName, livenessMarker),
  ]);
  if (
    startupProbe.status !== 503 ||
    liveProbe.status !== 200 ||
    markerPresent
  ) {
    throw new Error(
      "The restarted container did not enter a clean startup-probe interval",
    );
  }

  const containerStartedAt = Date.parse(
    startupPending.container.state.running.startedAt,
  );
  const started = await waitFor(
    "the startup probe to succeed without another restart",
    async (deadline) => {
      const pod = await getPod(podName, deadline);
      assertSamePodUid(pod, podUid);
      const container = getApiContainerStatus(pod);
      if (getRestartCount(pod) !== restartCountBefore + 1) {
        throw new Error("The container restarted again during startup");
      }
      if (container.started === true) {
        return { pod, container };
      }
      if (container.started !== false) {
        throw new Error("Kubernetes did not report startup probe state");
      }
      return null;
    },
    startupTimeoutMs,
  );

  const startupStatus = await requestProbe(podName, "startup");
  if (startupStatus.status !== 200) {
    throw new Error("The startup probe passed before its HTTP route recovered");
  }

  const recovered = await waitForReady(podName, recoveryTimeoutMs);
  assertSamePodUid(recovered.pod, podUid);
  if (getRestartCount(recovered.pod) !== restartCountBefore + 1) {
    throw new Error(
      "The liveness experiment did not produce exactly one restart",
    );
  }

  return {
    probeStatusWithMarker: failingProbe.status,
    restartCountBefore: restartCountBefore,
    restartCountAfter: getRestartCount(recovered.pod),
    podUidPreserved: recovered.pod.metadata.uid === podUid,
    markerPresentAfterRestart: markerPresent,
    startupStatusDuringInitialization: startupProbe.status,
    livenessStatusDuringInitialization: liveProbe.status,
    startupProbeCompleted: started.container.started,
    startupIntervalMs: Math.max(0, Date.now() - containerStartedAt),
    readyServiceEndpointsAfterRecovery: recovered.endpoints.readyPodNames.size,
  };
}

async function waitForReady(podName, timeoutMs) {
  return waitFor(
    "the Pod and all Service endpoints to become ready",
    async (deadline) => {
      const [pod, endpoints] = await Promise.all([
        getPod(podName, deadline),
        getEndpointState(deadline),
      ]);
      if (
        isPodReady(pod) &&
        endpoints.readyPodNames.size === replicaCount &&
        endpoints.readyPodNames.has(podName)
      ) {
        return { pod, endpoints };
      }
      return null;
    },
    timeoutMs,
  );
}

async function waitForRecovery(podName, podUid, maximumRestartCount) {
  const recovered = await waitForReady(podName, recoveryTimeoutMs);
  assertSamePodUid(recovered.pod, podUid);
  if (getRestartCount(recovered.pod) > maximumRestartCount + 1) {
    throw new Error("The target container exceeded the expected restart count");
  }
}

async function waitFor(description, readState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  while (Date.now() < deadline) {
    lastState = await readState(deadline);
    if (lastState) {
      return lastState;
    }
    await delay(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for ${description}; last state: ${JSON.stringify(lastState)}`,
  );
}

async function getPods() {
  return getResource("pods", selector);
}

async function getPod(name, deadline) {
  return getResource("pod", name, deadline);
}

async function getEndpointState(deadline) {
  const slices = await getResource(
    "endpointslices.discovery.k8s.io",
    `-l=kubernetes.io/service-name=${appName}`,
    deadline,
  );
  const endpoints = slices.items.flatMap((slice) => slice.endpoints ?? []);
  const readyEndpoints = endpoints.filter(
    (endpoint) => endpoint.conditions?.ready === true,
  );
  return {
    readyPodNames: new Set(
      readyEndpoints
        .map((endpoint) => endpoint.targetRef?.name)
        .filter((name) => typeof name === "string"),
    ),
  };
}

async function getResource(resource, nameOrSelector, deadline) {
  const output = await runKubectl(
    ["get", resource, nameOrSelector, "-o", "json"],
    { capture: true, deadline },
  );
  return JSON.parse(output);
}

async function writeFailureMarker(podName, markerPath) {
  const source = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "active");`;
  await runNodeInPod(podName, source);
}

async function removeFailureMarker(podName, markerPath) {
  const source = `import { rmSync } from "node:fs"; rmSync(${JSON.stringify(markerPath)}, { force: true });`;
  await runNodeInPod(podName, source);
}

async function failureMarkerExists(podName, markerPath) {
  const source = `import { existsSync } from "node:fs"; console.log(JSON.stringify(existsSync(${JSON.stringify(markerPath)})));`;
  const output = await runNodeInPod(podName, source);
  return JSON.parse(output);
}

async function requestProbe(podName, probe) {
  const route = {
    startup: "/health/startup",
    ready: "/health/ready",
    live: "/health/live",
  }[probe];
  const source = `const response = await fetch("http://127.0.0.1:8080${route}", { signal: AbortSignal.timeout(3000) }); console.log(JSON.stringify({ status: response.status, body: await response.json() }));`;
  const output = await runNodeInPod(podName, source);
  return JSON.parse(output);
}

async function runNodeInPod(podName, source) {
  return runKubectl(
    ["exec", podName, "--", "node", "--input-type=module", "-e", source],
    { capture: true },
  );
}

async function removeFailureMarkers(podName) {
  const errors = [];
  for (const marker of [readinessMarker, livenessMarker]) {
    try {
      await removeFailureMarker(podName, marker);
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

async function reportDiagnostics(podName) {
  const commands = [
    ["describe", "pod", podName],
    [
      "get",
      "endpointslices.discovery.k8s.io",
      `-l=kubernetes.io/service-name=${appName}`,
      "-o",
      "yaml",
    ],
    ["get", "events", "-o", "yaml"],
    ["logs", podName, "-c", "api", "--tail=40"],
  ];
  const diagnostics = await Promise.all(
    commands.map(async (args) => {
      try {
        return await runKubectl(args, { capture: true });
      } catch (error) {
        return error.message;
      }
    }),
  );
  console.error(
    JSON.stringify(
      Object.fromEntries(
        commands.map((args, index) => [args.join(" "), diagnostics[index]]),
      ),
      null,
      2,
    ),
  );
}

function assertReadyPods(pods) {
  if (
    pods.items.length !== replicaCount ||
    pods.items.some((pod) => !isPodReady(pod))
  ) {
    throw new Error(`Expected ${replicaCount} Running and Ready API Pods`);
  }
}

function isPodReady(pod) {
  const ready = pod.status.conditions?.some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  );
  return pod.status.phase === "Running" && ready;
}

function getApiContainerStatus(pod) {
  const container = pod.status.containerStatuses?.find(
    (item) => item.name === "api",
  );
  if (!container) {
    throw new Error(`Pod ${pod.metadata.name} has no API container status`);
  }
  return container;
}

function getRestartCount(pod) {
  return getApiContainerStatus(pod).restartCount;
}

function assertSamePodUid(pod, expectedUid) {
  if (pod.metadata.uid !== expectedUid) {
    throw new Error(
      `Pod ${pod.metadata.name} was replaced during the probe experiment`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
