import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleServiceTraffic } from "./traffic.mjs";
import {
  requireOwnedCluster,
  runClusterAcceptance,
  runKubectl,
} from "./lab.mjs";

const appName = "reliability-api";
const appSelector = `app.kubernetes.io/name=${appName}`;
const operationDurationMs = 10_000;
const shutdownTimeoutMs = 20_000;
const podGracePeriodSeconds = 30;

async function main() {
  const state = await requireOwnedCluster();
  await runClusterAcceptance();

  const initialPods = await getPods();
  const operationId = randomUUID();
  const logStream = startLogStream();
  const workRequests = [];
  const trafficController = new AbortController();
  let targetPod;
  let deletionRequested = false;
  let deploymentRecovered = false;
  let result;
  let failure;
  let activeStage = "starting termination experiment";

  try {
    activeStage = "connecting to Pod logs";
    await waitForLogOutput(logStream);

    activeStage = "starting bounded work through the Service";
    const endpoint = new URL(`http://127.0.0.1:${state.hostPort}`);
    const workRequest = sendWorkRequest(endpoint, operationId);
    workRequests.push(workRequest);
    const workStarted = await waitForLogEvent(
      logStream,
      (entry) =>
        entry.event === "work.started" && entry.operationId === operationId,
      "the work-started log entry",
    );
    targetPod = initialPods.items.find(
      (pod) => pod.metadata.name === workStarted.podName,
    );
    if (!targetPod || !isPodReady(targetPod)) {
      throw new Error(
        "The work request did not start on an initially ready Pod",
      );
    }

    activeStage = "deleting the Pod with a 30-second grace period";
    const deletionStartedAt = performance.now();
    const serviceTraffic = sampleServiceTraffic(
      endpoint,
      deletionStartedAt,
      trafficController.signal,
    );
    workRequests.push(serviceTraffic);
    deletionRequested = true;
    await runKubectl([
      "delete",
      `pod/${targetPod.metadata.name}`,
      `--grace-period=${podGracePeriodSeconds}`,
      "--wait=false",
    ]);

    const deleteAcknowledgedAtMs = round(performance.now() - deletionStartedAt);
    activeStage = "observing the terminating Pod and Service";
    const observations = await Promise.allSettled([
      waitForTerminatingEndpoint(targetPod.metadata.name),
      waitForLogEvent(
        logStream,
        (entry) =>
          entry.podName === targetPod.metadata.name &&
          entry.event === "server.shutdown_started",
        "the SIGTERM shutdown-started log entry",
      ),
      workRequest,
      waitForLogEvent(
        logStream,
        (entry) =>
          entry.podName === targetPod.metadata.name &&
          entry.event === "server.shutdown_completed",
        "the shutdown-completed log entry",
      ),
    ]);
    const failedObservation = observations.find(
      (observation) => observation.status === "rejected",
    );
    if (failedObservation?.status === "rejected") {
      throw failedObservation.reason;
    }

    const [terminatingState, shutdownStarted, work, shutdownCompleted] =
      observations.map((observation) => observation.value);
    const timeFromWorkStartToSignalMs =
      Date.parse(shutdownStarted.timestamp) - Date.parse(workStarted.timestamp);

    assertWorkCompleted(work, operationId, targetPod.metadata.name);
    assertGracefulShutdown(shutdownStarted, shutdownCompleted);
    if (
      !Number.isFinite(timeFromWorkStartToSignalMs) ||
      timeFromWorkStartToSignalMs < 0 ||
      timeFromWorkStartToSignalMs >= operationDurationMs
    ) {
      throw new Error(
        "SIGTERM was not observed while the work request was active",
      );
    }

    activeStage = "waiting for the replacement Pod";
    const replacementPods = await waitForReplacement(targetPod.metadata.uid);
    const replacementReadyAtMs = round(performance.now() - deletionStartedAt);
    trafficController.abort();
    const traffic = await serviceTraffic;
    const originalPodUids = new Set(
      initialPods.items.map((pod) => pod.metadata.uid),
    );
    const createdPods = replacementPods.filter(
      (pod) => !originalPodUids.has(pod.metadata.uid),
    );
    if (createdPods.length !== 1) {
      throw new Error(
        `Expected one replacement Pod, found ${createdPods.length}`,
      );
    }
    deploymentRecovered = true;

    result = {
      operation: {
        operationId,
        requestId: work.requestId,
        pod: targetPod.metadata.name,
        requestedDurationMs: operationDurationMs,
        completed: true,
        httpStatus: work.statusCode,
        latencyMs: work.latencyMs,
        timeFromStartToSignalMs: timeFromWorkStartToSignalMs,
      },
      termination: {
        signal: shutdownStarted.signal,
        graceful: shutdownCompleted.graceful,
        drainDurationMs: shutdownCompleted.drainDurationMs,
        appDrainLimitMs: shutdownTimeoutMs,
        podGracePeriodSeconds:
          terminatingState.pod.metadata.deletionGracePeriodSeconds,
        endpointReady: terminatingState.endpoint.conditions?.ready ?? null,
        endpointTerminating:
          terminatingState.endpoint.conditions?.terminating ?? null,
      },
      timeline: {
        deleteAcknowledgedAtMs,
        endpointTerminatingObservedAtMs: round(
          terminatingState.observedAt - deletionStartedAt,
        ),
        replacementReadyAtMs,
      },
      serviceTraffic: traffic,
      replacement: {
        originalPodUid: targetPod.metadata.uid,
        newPods: createdPods.map((pod) => ({
          name: pod.metadata.name,
          uid: pod.metadata.uid,
        })),
        readyReplicas: replacementPods.length,
        readyEndpoints: replacementPods.length,
      },
    };
  } catch (error) {
    trafficController.abort();
    const message = error instanceof Error ? error.message : String(error);
    failure = new Error(`${activeStage}: ${message}`, { cause: error });
    await reportFailureDiagnostics(logStream, targetPod?.metadata.name);
  } finally {
    await Promise.allSettled(workRequests);
    await logStream.stop();

    if (deletionRequested && !deploymentRecovered) {
      try {
        await waitForReplacement(targetPod?.metadata.uid);
        deploymentRecovered = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failure = failure
          ? new Error(`${failure.message}; recovery failed: ${message}`, {
              cause: failure,
            })
          : error;
      }
    }
  }

  if (failure) {
    throw failure;
  }

  console.log(JSON.stringify(result, null, 2));
}

function startLogStream() {
  const controller = new AbortController();
  let output = "";
  let failure;
  const completion = runKubectl(
    [
      "logs",
      "-f",
      `-l=${appSelector}`,
      "--all-containers=true",
      "--prefix=true",
      "--since=10s",
      "--ignore-errors=true",
    ],
    {
      capture: true,
      signal: controller.signal,
      follow: true,
      onStdout: (chunk) => {
        output += chunk;
      },
    },
  ).then(
    () => {
      if (!controller.signal.aborted) {
        failure = new Error("The Pod log stream ended unexpectedly");
      }
    },
    (error) => {
      if (!controller.signal.aborted) {
        failure = error;
      }
    },
  );

  return {
    output: () => output,
    failure: () => failure,
    stop: async () => {
      controller.abort();
      await completion;
    },
  };
}

async function waitForLogOutput(logStream) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (logStream.failure()) {
      throw logStream.failure();
    }
    if (logStream.output().length > 0) {
      return;
    }
    await delay(100);
  }

  throw new Error("No Pod logs arrived within 10000 ms");
}

async function waitForLogEvent(logStream, predicate, description) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (logStream.failure()) {
      throw new Error(
        `Could not follow Pod logs: ${logStream.failure().message}`,
      );
    }
    const entry = parseLogEntries(logStream.output()).find(predicate);
    if (entry) {
      return entry;
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function parseLogEntries(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\[pod\/([^/]+)\/[^\]]+\]\s+(\{.*\})$/);
    if (!match) {
      return [];
    }

    try {
      return [{ podName: match[1], ...JSON.parse(match[2]) }];
    } catch {
      return [];
    }
  });
}

async function sendWorkRequest(endpoint, operationId) {
  const url = new URL(`/work?durationMs=${operationDurationMs}`, endpoint);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      headers: {
        connection: "close",
        "x-operation-id": operationId,
      },
      signal: AbortSignal.timeout(25_000),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    return {
      statusCode: response.status,
      requestId: response.headers.get("x-request-id"),
      latencyMs: round(performance.now() - startedAt),
      successful:
        response.status === 200 &&
        body?.status === "completed" &&
        body?.operationId === operationId,
      body,
    };
  } catch (error) {
    return {
      latencyMs: round(performance.now() - startedAt),
      transportError:
        error.cause?.code ?? error.name ?? "unknown_transport_error",
    };
  }
}

function assertWorkCompleted(work, operationId, podName) {
  if (
    !work.successful ||
    work.body?.operationId !== operationId ||
    work.body?.instanceId !== podName ||
    work.body?.requestId !== work.requestId ||
    work.body?.durationMs !== operationDurationMs
  ) {
    throw new Error(
      `The in-flight work request did not complete on ${podName}: ${JSON.stringify(
        work,
      )}`,
    );
  }
}

function assertGracefulShutdown(started, completed) {
  if (
    started.signal !== "SIGTERM" ||
    completed.signal !== "SIGTERM" ||
    completed.graceful !== true ||
    typeof completed.drainDurationMs !== "number" ||
    !Number.isFinite(completed.drainDurationMs) ||
    completed.drainDurationMs < 0 ||
    completed.drainDurationMs > shutdownTimeoutMs
  ) {
    throw new Error(
      `The application did not finish graceful shutdown within ${shutdownTimeoutMs} ms`,
    );
  }
}

async function waitForTerminatingEndpoint(podName) {
  const deadline = Date.now() + 10_000;
  let latestPod;
  let latestEndpoint;

  while (Date.now() < deadline) {
    const [pod, endpoints] = await Promise.all([
      getPod(podName, deadline),
      getEndpointSlices(deadline),
    ]);
    latestPod = pod;
    latestEndpoint = endpoints.find(
      (endpoint) => endpoint.targetRef?.name === podName,
    );

    if (
      latestPod?.metadata.deletionTimestamp &&
      latestPod.metadata.deletionGracePeriodSeconds === podGracePeriodSeconds &&
      latestEndpoint?.conditions?.terminating === true &&
      latestEndpoint.conditions.ready === false
    ) {
      return {
        pod: latestPod,
        endpoint: latestEndpoint,
        observedAt: performance.now(),
      };
    }

    await delay(200);
  }

  throw new Error(
    `The Pod did not become a terminating, non-ready endpoint: ${JSON.stringify(
      {
        deletionTimestamp: latestPod?.metadata.deletionTimestamp,
        deletionGracePeriodSeconds:
          latestPod?.metadata.deletionGracePeriodSeconds,
        conditions: latestEndpoint?.conditions,
      },
    )}`,
  );
}

async function waitForReplacement(originalUid) {
  const timeoutMs = 45_000;
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const pods = await getPods(deadline);
      if (
        pods.items.length === 3 &&
        !pods.items.some((pod) => pod.metadata.uid === originalUid)
      ) {
        await runClusterAcceptance(deadline);
        return pods.items;
      }
      lastError = new Error("The deleted Pod UID is still present");
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  throw new Error(
    `The Deployment did not recover within ${timeoutMs} ms: ${lastError?.message}`,
    { cause: lastError },
  );
}

async function getPods(deadline) {
  return getResource("pods", `-l=${appSelector}`, deadline);
}

async function getPod(podName, deadline) {
  return getResource("pod", podName, deadline);
}

async function getEndpointSlices(deadline) {
  const slices = await getResource(
    "endpointslices.discovery.k8s.io",
    `-l=kubernetes.io/service-name=${appName}`,
    deadline,
  );
  return slices.items.flatMap((slice) => slice.endpoints ?? []);
}

async function getResource(resource, nameOrSelector, deadline) {
  const output = await runKubectl(
    ["get", resource, nameOrSelector, "-o", "json"],
    { capture: true, deadline },
  );
  return JSON.parse(output);
}

async function reportFailureDiagnostics(logStream, podName) {
  console.error("Termination diagnostics before recovery:");
  const commands = [
    ["describe", "deployment", appName],
    ["get", "pods", `-l=${appSelector}`, "-o", "wide"],
    [
      "get",
      "endpointslices.discovery.k8s.io",
      `-l=kubernetes.io/service-name=${appName}`,
      "-o",
      "wide",
    ],
  ];

  for (const args of commands) {
    try {
      console.error(`$ kubectl ${args.join(" ")}`);
      console.error(await runKubectl(args, { capture: true }));
    } catch (error) {
      console.error(error.message);
    }
  }

  if (podName) {
    try {
      console.error(`$ kubectl describe pod ${podName}`);
      console.error(
        await runKubectl(["describe", "pod", podName], { capture: true }),
      );
    } catch (error) {
      console.error(error.message);
    }
  }

  const relevantLogs = logStream
    .output()
    .split(/\r?\n/)
    .filter((line) => /work\.started|server\.shutdown/.test(line));
  if (relevantLogs.length > 0) {
    console.error(relevantLogs.join("\n"));
  }
}

function isPodReady(pod) {
  return (
    pod.status.phase === "Running" &&
    pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    )
  );
}

function round(value) {
  return Math.round(value * 100) / 100;
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
