import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  appName,
  getResource,
  isPodReady,
  replicaCount,
  requireOwnedCluster,
  runKubectl,
} from "./lab.mjs";

const selector = `-l=app.kubernetes.io/name=${appName}`;

async function main() {
  const state = await requireOwnedCluster();
  const before = await getPods();
  assertReadyPods(before);

  const deletedPod = before.items[0];
  await runKubectl(
    [
      "delete",
      "pod",
      deletedPod.metadata.name,
      "--wait=true",
      "--timeout=120s",
    ],
    { timeoutMs: 125_000 },
  );
  await runKubectl(
    ["rollout", "status", `deployment/${appName}`, "--timeout=120s"],
    { timeoutMs: 125_000 },
  );

  const after = await getPods();
  assertReadyPods(after);

  const previousUids = new Set(before.items.map((pod) => pod.metadata.uid));
  const replacements = after.items.filter(
    (pod) => !previousUids.has(pod.metadata.uid),
  );
  if (
    after.items.some((pod) => pod.metadata.uid === deletedPod.metadata.uid) ||
    replacements.length !== 1
  ) {
    throw new Error(
      `Expected one new Pod UID after deleting ${deletedPod.metadata.name}`,
    );
  }

  const readyEndpoints = await waitForReadyEndpoints(after.items);

  const response = await fetch(`http://127.0.0.1:${state.hostPort}/`, {
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.json();
  if (
    response.status !== 200 ||
    !after.items.some((pod) => pod.metadata.name === body.instanceId)
  ) {
    throw new Error("The Service did not return an identity from a ready Pod");
  }

  console.log(
    JSON.stringify(
      {
        deletedPod: {
          name: deletedPod.metadata.name,
          uid: deletedPod.metadata.uid,
        },
        replacementPods: replacements.map((pod) => ({
          name: pod.metadata.name,
          uid: pod.metadata.uid,
        })),
        readyPods: after.items.length,
        readyServiceEndpoints: readyEndpoints.size,
        responseInstanceId: body.instanceId,
      },
      null,
      2,
    ),
  );
}

async function waitForReadyEndpoints(pods) {
  const deadline = Date.now() + 30_000;
  const expected = new Set(pods.map((pod) => pod.metadata.uid));
  let ready = [];

  while (Date.now() < deadline) {
    const slices = await getResource(
      "endpointslices.discovery.k8s.io",
      `-l=kubernetes.io/service-name=${appName}`,
      deadline,
    );
    ready = slices.items
      .flatMap((slice) => slice.endpoints ?? [])
      .filter((endpoint) => endpoint.conditions?.ready === true);

    const actual = new Set(ready.map((endpoint) => endpoint.targetRef?.uid));
    if (
      actual.size === expected.size &&
      [...expected].every((uid) => actual.has(uid))
    ) {
      return actual;
    }
    await delay(Math.max(0, Math.min(250, deadline - Date.now())));
  }

  const actual = ready.map((endpoint) => endpoint.targetRef?.name);
  throw new Error(
    `Service endpoints did not converge to the expected Pods: ${JSON.stringify(actual)}`,
  );
}

async function getPods() {
  return getResource("pods", selector);
}

function assertReadyPods(pods) {
  if (pods.items.length !== replicaCount) {
    throw new Error(
      `Expected ${replicaCount} API Pods, found ${pods.items.length}`,
    );
  }

  const notReady = pods.items.filter((pod) => !isPodReady(pod));
  if (notReady.length > 0) {
    throw new Error(
      `All API Pods must be Running and Ready before replacement: ${notReady.map((pod) => pod.metadata.name).join(", ")}`,
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
