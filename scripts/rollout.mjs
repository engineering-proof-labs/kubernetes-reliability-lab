import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runTrafficExperiment } from "./traffic.mjs";
import {
  appName,
  getResource,
  isPodReady,
  replicaCount,
  requireOwnedCluster,
  runClusterAcceptance,
  runKubectl,
} from "./lab.mjs";

const selector = `-l=app.kubernetes.io/name=${appName}`;
const rolloutTimeout = "120s";

async function main() {
  const state = await requireOwnedCluster();
  await runClusterAcceptance();

  const baseline = await getDeployment();
  const baselineRevision = getRevision(baseline);
  const baselineVersion = state.imageTag;
  if (
    getContainerEnv(baseline, "APP_VERSION") !== baselineVersion ||
    getContainerEnv(baseline, "READINESS_MODE") !== "normal" ||
    getContainerImage(baseline) !== imageName(baselineVersion)
  ) {
    throw new Error("The rollout experiment requires the baseline deployment");
  }

  const healthyVersion = `rollout-${baselineVersion}`;
  let restoreNeeded = false;
  let result;
  let failure;
  let activeStage = "starting rollout experiment";

  try {
    restoreNeeded = true;
    activeStage = "rolling out the healthy release";
    console.log(`Rolling out healthy version ${healthyVersion}`);
    await setDeploymentEnv("APP_VERSION", healthyVersion);
    await waitForRollout();
    const healthyRelease = await assertHealthyRelease(healthyVersion);

    activeStage = "waiting for the blocked rollout deadline";
    console.log("Applying readiness-blocking configuration");
    await setDeploymentEnv("READINESS_MODE", "blocked");
    const rolloutStatusError = await waitForBlockedRollout();
    activeStage = "checking stalled Deployment and service state";
    const blockedState = await assertBlockedRollout(healthyVersion);
    activeStage = "collecting stalled rollout diagnostics";
    console.log(
      "The progress deadline was exceeded; collecting diagnostics before rollback",
    );
    const diagnostics = await collectDiagnostics(blockedState.blockedPods[0]);

    console.log(
      JSON.stringify(
        {
          blockedRollout: {
            revision: getRevision(blockedState.deployment),
            condition: blockedState.progressCondition,
            desiredReplicas: blockedState.deployment.spec.replicas,
            availableReplicas:
              blockedState.deployment.status.availableReplicas ?? 0,
            updatedReplicas:
              blockedState.deployment.status.updatedReplicas ?? 0,
            kubectlRolloutStatusError: rolloutStatusError,
            blockedReplicaSet: blockedState.blockedReplicaSet.metadata.name,
            blockedPods: blockedState.blockedPods.map(
              (pod) => pod.metadata.name,
            ),
            readyPods: blockedState.readyPods.map((pod) => pod.metadata.name),
            readyServiceEndpoints: [...blockedState.endpoints.readyPodNames],
          },
          diagnostics,
        },
        null,
        2,
      ),
    );

    activeStage = "checking traffic during the blocked rollout";
    console.log(
      "Checking traffic through the Service while the old Pods remain ready",
    );
    const stateHostPort = state.hostPort;
    const traffic = await runTrafficExperiment(
      new URL(`http://127.0.0.1:${stateHostPort}/`),
      30,
      3,
    );
    assertSuccessfulTraffic(traffic);

    activeStage = "rolling back to the baseline revision";
    console.log(
      `Rolling back explicitly to baseline revision ${baselineRevision}`,
    );
    await restoreBaseline(baselineRevision, baselineVersion);
    activeStage = "verifying the restored Service";
    await waitForClusterAcceptance();
    restoreNeeded = false;
    const verifiedDeployment = await getDeployment();
    assertBaselineRestored(
      verifiedDeployment,
      baselineVersion,
      baselineRevision,
    );

    result = {
      baselineRevision,
      baselineVersion,
      healthyVersion,
      healthyRevision: healthyRelease.revision,
      healthyPods: healthyRelease.podNames,
      blockedRevision: getRevision(blockedState.deployment),
      progressDeadlineSeconds:
        blockedState.deployment.spec.progressDeadlineSeconds,
      blockedReadyPods: blockedState.readyPods.length,
      blockedReadyEndpoints: blockedState.endpoints.readyPodNames.size,
      trafficDuringBlockedRollout: {
        attempted: traffic.attempted,
        successfulResponses: traffic.successfulResponses,
        httpErrors: traffic.httpErrors,
        transportErrors: traffic.transportErrors,
        uniqueResponseRequestIds: traffic.uniqueResponseRequestIds,
      },
      explicitRollbackRevision: baselineRevision,
      restoredVersion: getContainerEnv(verifiedDeployment, "APP_VERSION"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failure = new Error(`${activeStage}: ${message}`, { cause: error });
    await reportFailureDiagnostics();
  }

  if (restoreNeeded) {
    try {
      activeStage = "recovering the baseline after an experiment failure";
      await restoreBaseline(baselineRevision, baselineVersion);
      await waitForClusterAcceptance();
      restoreNeeded = false;
    } catch (error) {
      await reportFailureDiagnostics();
      const message = error instanceof Error ? error.message : String(error);
      failure = failure
        ? new Error(
            `${failure.message}; rollback recovery failed: ${message}`,
            {
              cause: failure,
            },
          )
        : error;
    }
  }

  if (failure) {
    throw failure;
  }

  console.log(JSON.stringify(result, null, 2));
}

async function assertHealthyRelease(expectedVersion) {
  const timeoutMs = 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const state = await getClusterState(deadline);
      const readyPods = state.pods.items.filter(isPodReady);
      if (
        getContainerEnv(state.deployment, "APP_VERSION") !== expectedVersion ||
        getContainerEnv(state.deployment, "READINESS_MODE") !== "normal" ||
        readyPods.length !== replicaCount ||
        state.endpoints.readyPodNames.size !== replicaCount ||
        readyPods.some(
          (pod) => !state.endpoints.readyPodNames.has(pod.metadata.name),
        )
      ) {
        throw new Error(
          "The healthy version has not reached all three Service endpoints",
        );
      }

      const responses = await Promise.all(
        readyPods.map((pod) => readPodResponse(pod, deadline)),
      );
      if (
        responses.some(
          (response) =>
            response.status !== 200 ||
            response.body.version !== expectedVersion ||
            !readyPods.some(
              (pod) => pod.metadata.name === response.body.instanceId,
            ),
        )
      ) {
        throw new Error(
          "The healthy version was not served by every ready Pod",
        );
      }

      return {
        revision: getRevision(state.deployment),
        podNames: readyPods.map((pod) => pod.metadata.name),
      };
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw new Error(
    `The healthy release did not pass endpoint and Pod checks within ${timeoutMs} ms: ${lastError?.message}`,
    { cause: lastError },
  );
}

async function waitForBlockedRollout() {
  try {
    await waitForRollout();
  } catch (error) {
    return error.message;
  }

  throw new Error("The blocked readiness update unexpectedly completed");
}

async function assertBlockedRollout(expectedVersion) {
  const state = await getClusterState();
  const progressCondition = state.deployment.status.conditions?.find(
    (condition) => condition.type === "Progressing",
  );
  const blockedReplicaSet = state.replicaSets.items.find(
    (replicaSet) =>
      getContainerEnv(replicaSet, "APP_VERSION") === expectedVersion &&
      getContainerEnv(replicaSet, "READINESS_MODE") === "blocked",
  );
  if (!blockedReplicaSet) {
    throw new Error("The blocked readiness ReplicaSet was not found");
  }

  const blockedHash = blockedReplicaSet.metadata.labels["pod-template-hash"];
  const blockedPods = state.pods.items.filter(
    (pod) => pod.metadata.labels["pod-template-hash"] === blockedHash,
  );
  const readyPods = state.pods.items.filter(isPodReady);
  const blockedPodsAreUnready =
    blockedPods.length === 1 && blockedPods.every((pod) => !isPodReady(pod));
  const readyEndpointsMatchPods =
    state.endpoints.readyPodNames.size === replicaCount &&
    readyPods.length === replicaCount &&
    readyPods.every((pod) =>
      state.endpoints.readyPodNames.has(pod.metadata.name),
    );

  if (
    progressCondition?.status !== "False" ||
    progressCondition.reason !== "ProgressDeadlineExceeded" ||
    getContainerEnv(state.deployment, "READINESS_MODE") !== "blocked" ||
    state.deployment.status.availableReplicas !== replicaCount ||
    state.deployment.status.updatedReplicas !== 1 ||
    state.deployment.status.replicas !== replicaCount + 1 ||
    !blockedPodsAreUnready ||
    !readyEndpointsMatchPods ||
    readyPods.some(
      (pod) =>
        getPodEnv(pod, "APP_VERSION") !== expectedVersion ||
        getPodEnv(pod, "READINESS_MODE") !== "normal",
    )
  ) {
    throw new Error(
      `Expected a stalled, unavailable update with three old endpoints: ${JSON.stringify(
        {
          progressCondition,
          replicas: state.deployment.status,
          readyPods: readyPods.map((pod) => pod.metadata.name),
          blockedPods: blockedPods.map((pod) => pod.metadata.name),
          readyEndpoints: [...state.endpoints.readyPodNames],
        },
      )}`,
    );
  }

  const responses = await Promise.all(
    readyPods.map((pod) => readPodResponse(pod)),
  );
  if (
    responses.some(
      (response) =>
        response.status !== 200 ||
        response.body.version !== expectedVersion ||
        !readyPods.some(
          (pod) => pod.metadata.name === response.body.instanceId,
        ),
    )
  ) {
    throw new Error(
      "The old healthy Pods stopped serving during the stalled update",
    );
  }

  return {
    ...state,
    progressCondition,
    blockedReplicaSet,
    blockedPods,
    readyPods,
  };
}

async function getClusterState(deadline) {
  const [deployment, pods, replicaSets, endpoints] = await Promise.all([
    getDeployment(deadline),
    getPods(deadline),
    getReplicaSets(deadline),
    getEndpointState(deadline),
  ]);
  return { deployment, pods, replicaSets, endpoints };
}

async function getDeployment(deadline) {
  return getResource("deployment", appName, deadline);
}

async function getPods(deadline) {
  return getResource("pods", selector, deadline);
}

async function getReplicaSets(deadline) {
  return getResource("replicasets", selector, deadline);
}

async function getEndpointState(deadline) {
  const slices = await getResource(
    "endpointslices.discovery.k8s.io",
    `-l=kubernetes.io/service-name=${appName}`,
    deadline,
  );
  const endpoints = slices.items.flatMap((slice) => slice.endpoints ?? []);
  return {
    readyPodNames: new Set(
      endpoints
        .filter((endpoint) => endpoint.conditions?.ready === true)
        .map((endpoint) => endpoint.targetRef?.name)
        .filter((name) => typeof name === "string"),
    ),
  };
}

async function setDeploymentEnv(name, value) {
  await runKubectl(["set", "env", `deployment/${appName}`, `${name}=${value}`]);
}

async function waitForRollout() {
  await runKubectl(
    [
      "rollout",
      "status",
      `deployment/${appName}`,
      `--timeout=${rolloutTimeout}`,
    ],
    { timeoutMs: 125_000 },
  );
}

async function waitForClusterAcceptance() {
  const timeoutMs = 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await runClusterAcceptance(deadline);
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw new Error(
    `The baseline did not pass cluster acceptance within ${timeoutMs} ms: ${lastError?.message}`,
    { cause: lastError },
  );
}

async function restoreBaseline(revision, version) {
  if (!isBaselineTemplate(await getDeployment(), version)) {
    await runKubectl([
      "rollout",
      "undo",
      `deployment/${appName}`,
      `--to-revision=${revision}`,
    ]);
  }

  const deadline = Date.now() + 120_000;
  let lastStatus;
  // The blocked revision's Progressing condition can outlive rollout undo.
  while (Date.now() < deadline) {
    const deployment = await getDeployment(deadline);
    const { metadata, status } = deployment;
    lastStatus = status;
    if (
      isBaselineTemplate(deployment, version) &&
      status.observedGeneration === metadata.generation &&
      status.updatedReplicas === replicaCount &&
      status.replicas === replicaCount &&
      status.availableReplicas === replicaCount
    ) {
      return;
    }
    await delay(Math.max(0, Math.min(500, deadline - Date.now())));
  }

  throw new Error(
    `Rollback did not restore ${version} within 120 seconds: ${JSON.stringify(lastStatus)}`,
  );
}

async function readPodResponse(pod, deadline) {
  const source = `const response = await fetch("http://127.0.0.1:8080/", { signal: AbortSignal.timeout(10000) }); console.log(JSON.stringify({ status: response.status, body: await response.json() }));`;
  const output = await runKubectl(
    [
      "exec",
      pod.metadata.name,
      "--",
      "node",
      "--input-type=module",
      "-e",
      source,
    ],
    { capture: true, deadline },
  );
  return JSON.parse(output);
}

async function reportFailureDiagnostics() {
  const commands = [
    ["describe", "deployment", appName],
    ["get", "pods", selector, "-o", "wide"],
    ["get", "replicasets", selector, "-o", "wide"],
    [
      "get",
      "endpointslices.discovery.k8s.io",
      `-l=kubernetes.io/service-name=${appName}`,
      "-o",
      "wide",
    ],
  ];
  console.error("Rollout diagnostics before rollback:");
  for (const args of commands) {
    try {
      console.error(`$ kubectl ${args.join(" ")}`);
      console.error(await runKubectl(args, { capture: true }));
    } catch (error) {
      console.error(error.message);
    }
  }

  try {
    const pods = await getPods();
    for (const pod of pods.items.filter((item) => !isPodReady(item))) {
      console.error(`$ kubectl describe pod ${pod.metadata.name}`);
      console.error(
        await runKubectl(["describe", "pod", pod.metadata.name], {
          capture: true,
        }),
      );
    }
  } catch (error) {
    console.error(error.message);
  }
}

async function collectDiagnostics(blockedPod) {
  const deploymentDescription = await runKubectl(
    ["describe", "deployment", appName],
    { capture: true },
  );
  const podDescription = await runKubectl(
    ["describe", "pod", blockedPod.metadata.name],
    { capture: true },
  );
  return {
    deployment: deploymentDescription,
    blockedPod: podDescription,
  };
}

async function assertBaselineRestored(deployment, version, baselineRevision) {
  assertBaselineTemplate(deployment, version);

  const restoredRevision = getRevision(deployment);
  if (restoredRevision <= baselineRevision) {
    throw new Error("The explicit rollback did not create a new revision");
  }
}

function assertBaselineTemplate(deployment, version) {
  if (!isBaselineTemplate(deployment, version)) {
    throw new Error("Rollback did not restore the baseline Pod template");
  }
}

function isBaselineTemplate(deployment, version) {
  return (
    getContainerEnv(deployment, "APP_VERSION") === version &&
    getContainerEnv(deployment, "READINESS_MODE") === "normal" &&
    getContainerImage(deployment) === imageName(version)
  );
}

function assertSuccessfulTraffic(traffic) {
  if (
    traffic.attempted !== 30 ||
    traffic.successfulResponses !== 30 ||
    traffic.httpErrors !== 0 ||
    traffic.transportErrors !== 0 ||
    traffic.uniqueResponseRequestIds !== 30
  ) {
    throw new Error(
      "The old ready Pods did not serve all traffic during the blocked rollout",
    );
  }
}

function getRevision(resource) {
  const revision = Number(
    resource.metadata.annotations?.["deployment.kubernetes.io/revision"],
  );
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("Kubernetes did not report a Deployment revision");
  }
  return revision;
}

function getContainerEnv(resource, name) {
  const container = resource.spec.template.spec.containers.find(
    (item) => item.name === "api",
  );
  return container?.env?.find((item) => item.name === name)?.value;
}

function getPodEnv(pod, name) {
  const container = pod.spec.containers.find((item) => item.name === "api");
  return container?.env?.find((item) => item.name === name)?.value;
}

function getContainerImage(resource) {
  const container = resource.spec.template.spec.containers.find(
    (item) => item.name === "api",
  );
  return container?.image;
}

function imageName(version) {
  return `kubernetes-reliability-lab:${version}`;
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
