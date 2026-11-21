import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireOwnedCluster, runKubectl } from "./lab.mjs";

const appName = "reliability-api";
const replicaCount = 3;
const selector = `-l=app.kubernetes.io/name=${appName}`;

async function main() {
  const state = await requireOwnedCluster();
  const before = await getPods();
  assertReadyPods(before);

  const deletedPod = before.items[0];
  await runKubectl([
    "delete",
    "pod",
    deletedPod.metadata.name,
    "--wait=true",
    "--timeout=120s",
  ]);
  await runKubectl([
    "rollout",
    "status",
    `deployment/${appName}`,
    "--timeout=120s",
  ]);

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

  const endpointSlices = await getResource(
    "endpointslices.discovery.k8s.io",
    `-l=kubernetes.io/service-name=${appName}`,
  );
  const readyEndpoints = endpointSlices.items
    .flatMap((slice) => slice.endpoints ?? [])
    .filter((endpoint) => endpoint.conditions?.ready === true);
  if (readyEndpoints.length !== replicaCount) {
    throw new Error(
      `Expected ${replicaCount} ready Service endpoints after replacement, found ${readyEndpoints.length}`,
    );
  }

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
        readyServiceEndpoints: readyEndpoints.length,
        responseInstanceId: body.instanceId,
      },
      null,
      2,
    ),
  );
}

async function getPods() {
  return getResource("pods", selector);
}

async function getResource(resource, nameOrSelector) {
  const output = await runKubectl(
    ["get", resource, nameOrSelector, "-o", "json"],
    { capture: true },
  );
  return JSON.parse(output);
}

function assertReadyPods(pods) {
  if (pods.items.length !== replicaCount) {
    throw new Error(
      `Expected ${replicaCount} API Pods, found ${pods.items.length}`,
    );
  }

  const notReady = pods.items.filter((pod) => {
    const ready = pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    );
    return pod.status.phase !== "Running" || !ready;
  });
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
