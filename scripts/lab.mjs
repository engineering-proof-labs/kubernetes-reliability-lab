import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand } from "./process.mjs";
import { ensureLocalTools, KIND_NODE_IMAGE, localTools } from "./tools.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clusterName = "reliability-lab";
const contextName = `kind-${clusterName}`;
const namespace = "reliability-lab";
const appName = "reliability-api";
const replicaCount = 3;
const appSelector = `app.kubernetes.io/name=${appName}`;
const defaultHostPort = 8080;
const cacheDirectory = join(projectRoot, ".cache");
const kubeconfigPath = join(cacheDirectory, "kubeconfig");
const statePath = join(cacheDirectory, "lab-state.json");

async function main() {
  const command = process.argv[2];
  const actions = {
    up: labUp,
    status: labStatus,
    check: labCheck,
    logs: labLogs,
    down: labDown,
  };
  const action = actions[command];

  if (!action) {
    throw new Error("Usage: node scripts/lab.mjs <up|status|check|logs|down>");
  }

  await action();
}

async function labUp() {
  await ensureDocker();
  await ensureLocalTools();

  const requestedHostPort = getRequestedHostPort();
  const imageTag = await buildLocalImage();
  const state = await ensureCluster(requestedHostPort);
  await runCommand(
    localTools.kind,
    ["load", "docker-image", imageName(imageTag), "--name", clusterName],
    {
      cwd: projectRoot,
    },
  );

  await saveState({ ...state, imageTag });
  await applyResources(imageTag);
  await waitForDeployment();
  await waitForHttpContract(imageTag, state.hostPort);

  console.log(`Lab is ready at ${nodePortUrl(state.hostPort)}`);
  console.log(`Cluster context: ${contextName}; namespace: ${namespace}`);
  console.log(`Image/version: ${imageName(imageTag)}`);
}

async function labStatus() {
  await ensureDocker();
  await ensureLocalTools();

  if (!(await clusterExists())) {
    console.log(`kind cluster ${clusterName} is not running`);
    return;
  }

  await requireOwnedCluster();
  await runKubectl(["get", "deployment,pods,service", "-o", "wide"]);
}

async function labCheck() {
  const state = await requireOwnedCluster();
  await verifyHttpContract(state.imageTag, state.hostPort);
}

async function labLogs() {
  await requireOwnedCluster();
  await runKubectl(["logs", `deployment/${appName}`, "--follow"]);
}

async function labDown() {
  await ensureDocker();
  await ensureLocalTools();

  if (!(await clusterExists())) {
    await removeOwnedFiles();
    console.log(`kind cluster ${clusterName} is already absent`);
    return;
  }

  await requireOwnedCluster();
  await runCommand(
    localTools.kind,
    [
      "delete",
      "cluster",
      "--name",
      clusterName,
      "--kubeconfig",
      kubeconfigPath,
    ],
    { cwd: projectRoot },
  );
  await removeOwnedFiles();
  console.log(`Deleted kind cluster ${clusterName}`);
}

async function ensureCluster(requestedHostPort) {
  await mkdir(cacheDirectory, { recursive: true });

  if (await clusterExists()) {
    const state = await requireOwnedCluster();
    if (requestedHostPort !== null && requestedHostPort !== state.hostPort) {
      throw new Error(
        `This cluster maps host port ${state.hostPort}; delete it before selecting port ${requestedHostPort}`,
      );
    }
    return state;
  }

  const hostPort = requestedHostPort ?? defaultHostPort;
  await removeOwnedFiles();
  console.log(`Creating one-node kind cluster ${clusterName}`);
  await runCommand(
    localTools.kind,
    [
      "create",
      "cluster",
      "--name",
      clusterName,
      "--image",
      KIND_NODE_IMAGE,
      "--config",
      await kindConfigPath(hostPort),
      "--kubeconfig",
      kubeconfigPath,
      "--wait",
      "120s",
    ],
    { cwd: projectRoot },
  );

  const controlPlaneContainerId = await getControlPlaneContainerId();
  const state = {
    clusterName,
    controlPlaneContainerId,
    hostPort,
    imageTag: "",
  };
  await saveState(state);
  return state;
}

async function buildLocalImage() {
  const imageTag = await computeImageTag();
  console.log(`Building ${imageName(imageTag)}`);
  await runCommand("docker", ["build", "--tag", imageName(imageTag), "."], {
    cwd: projectRoot,
  });
  return imageTag;
}

async function computeImageTag() {
  const sourceFiles = await collectSourceFiles(join(projectRoot, "src"));
  const files = [
    ".dockerignore",
    "Dockerfile",
    "package-lock.json",
    "package.json",
    "tsconfig.json",
    ...sourceFiles.map((path) => path.slice(projectRoot.length + 1)),
  ].sort();
  const hash = createHash("sha256");

  for (const path of files) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(projectRoot, path)));
    hash.update("\0");
  }

  return `local-${hash.digest("hex").slice(0, 12)}`;
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collectSourceFiles(path) : [path];
    }),
  );
  return nestedFiles.flat().sort();
}

async function applyResources(imageTag) {
  await runKubectl([
    "apply",
    "-f",
    join(projectRoot, "kubernetes", "namespace.yaml"),
  ]);

  const deploymentPath = join(projectRoot, "kubernetes", "deployment.yaml");
  const deploymentTemplate = await readFile(deploymentPath, "utf8");
  const deployment = deploymentTemplate
    .replaceAll("__IMAGE__", imageName(imageTag))
    .replaceAll("__VERSION__", imageTag);
  if (deployment.includes("__IMAGE__") || deployment.includes("__VERSION__")) {
    throw new Error(
      "Deployment manifest contains an unresolved image or version",
    );
  }

  await runKubectl(["apply", "-f", "-"], { input: deployment });
  await runKubectl([
    "apply",
    "-f",
    join(projectRoot, "kubernetes", "service.yaml"),
  ]);
}

async function waitForDeployment() {
  await runKubectl([
    "rollout",
    "status",
    `deployment/${appName}`,
    "--timeout=120s",
  ]);
}

async function verifyHttpContract(expectedVersion, hostPort) {
  const root = await requestJson("/", hostPort);
  if (
    root.status !== 200 ||
    root.body.version !== expectedVersion ||
    typeof root.body.instanceId !== "string" ||
    root.body.instanceId.length === 0
  ) {
    throw new Error(`Unexpected GET / response: ${JSON.stringify(root)}`);
  }

  for (const path of ["/health/startup", "/health/ready", "/health/live"]) {
    const health = await requestJson(path, hostPort);
    if (health.status !== 200 || health.body.status !== "ok") {
      throw new Error(`Unexpected ${path} response: ${JSON.stringify(health)}`);
    }
  }

  console.log(
    JSON.stringify({
      version: root.body.version,
      instanceId: root.body.instanceId,
      health: "ok",
    }),
  );
}

async function waitForHttpContract(expectedVersion, hostPort) {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await verifyHttpContract(expectedVersion, hostPort);
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw new Error(
    `The API did not become reachable within 30 seconds: ${lastError?.message}`,
  );
}

async function requestJson(path, hostPort) {
  const response = await fetch(`${nodePortUrl(hostPort)}${path}`, {
    signal: AbortSignal.timeout(3_000),
  });
  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Expected JSON from ${path}, received HTTP ${response.status}`,
    );
  }

  return { status: response.status, body };
}

async function runClusterAcceptance() {
  const state = await requireOwnedCluster();
  await verifyHttpContract(state.imageTag, state.hostPort);

  const [deployment, pods, service, endpointSlices] = await Promise.all([
    getResource("deployment", appName),
    getResource("pods", `-l=${appSelector}`),
    getResource("service", appName),
    getResource(
      "endpointslices.discovery.k8s.io",
      `-l=kubernetes.io/service-name=${appName}`,
    ),
  ]);

  assertDeployment(deployment, state.imageTag);
  const readyPods = assertReadyPods(pods);
  assertService(service);
  assertReadyEndpoints(endpointSlices, replicaCount);

  const root = await requestJson("/", state.hostPort);
  if (!readyPods.some((pod) => root.body.instanceId === pod.metadata.name)) {
    throw new Error("The API instanceId does not match a ready Pod name");
  }

  console.log(
    `Cluster acceptance passed: ${replicaCount} ready Pods, ${replicaCount} Service endpoints, HTTP routes, and configured resources.`,
  );
}

async function getResource(resource, nameOrSelector) {
  const output = await runKubectl(
    ["get", resource, nameOrSelector, "-o", "json"],
    { capture: true },
  );
  return JSON.parse(output);
}

function assertDeployment(deployment, expectedVersion) {
  const container = deployment.spec.template.spec.containers.find(
    (item) => item.name === "api",
  );
  if (
    deployment.spec.replicas !== replicaCount ||
    deployment.status.availableReplicas !== replicaCount ||
    deployment.spec.progressDeadlineSeconds !== 60 ||
    deployment.spec.strategy?.type !== "RollingUpdate" ||
    deployment.spec.strategy?.rollingUpdate?.maxUnavailable !== 0 ||
    deployment.spec.strategy?.rollingUpdate?.maxSurge !== 1 ||
    deployment.spec.template.spec.terminationGracePeriodSeconds !== 30 ||
    container?.image !== imageName(expectedVersion) ||
    container?.env?.find((item) => item.name === "APP_VERSION")?.value !==
      expectedVersion ||
    container?.env?.find((item) => item.name === "STARTUP_DELAY_MS")?.value !==
      "8000" ||
    container?.env?.find((item) => item.name === "READINESS_MODE")?.value !==
      "normal" ||
    !matchesHttpProbe(container?.startupProbe, "/health/startup", 10) ||
    !matchesHttpProbe(container?.livenessProbe, "/health/live", 3) ||
    !matchesHttpProbe(container?.readinessProbe, "/health/ready", 1) ||
    container?.readinessProbe?.successThreshold !== 1 ||
    container?.resources?.requests?.cpu !== "100m" ||
    container?.resources?.requests?.memory !== "64Mi" ||
    container?.resources?.limits?.cpu !== "500m" ||
    container?.resources?.limits?.memory !== "128Mi"
  ) {
    throw new Error(
      "Deployment does not match the replica, rollout, termination, version, probe, or resource contract",
    );
  }
}

function matchesHttpProbe(probe, path, failureThreshold) {
  return (
    probe?.httpGet?.path === path &&
    probe.httpGet.port === "http" &&
    probe.periodSeconds === 2 &&
    probe.timeoutSeconds === 1 &&
    probe.failureThreshold === failureThreshold
  );
}

function assertReadyPods(pods) {
  if (pods.items.length !== replicaCount) {
    throw new Error(
      `Expected ${replicaCount} API Pods, found ${pods.items.length}`,
    );
  }

  const notReady = pods.items.filter((pod) => {
    const isReady = pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    );
    return pod.status.phase !== "Running" || !isReady;
  });
  if (notReady.length > 0) {
    throw new Error(
      `Not all API Pods are Running and Ready: ${notReady.map((pod) => pod.metadata.name).join(", ")}`,
    );
  }

  return pods.items;
}

function assertService(service) {
  const port = service.spec.ports.find((item) => item.name === "http");
  if (
    service.spec.type !== "NodePort" ||
    port?.port !== 80 ||
    port?.targetPort !== 8080 ||
    port?.nodePort !== 30080
  ) {
    throw new Error("Service does not match the NodePort contract");
  }
}

function assertReadyEndpoints(endpointSlices, expectedCount) {
  const endpoints = endpointSlices.items.flatMap(
    (slice) => slice.endpoints ?? [],
  );
  const ready = endpoints.filter(
    (endpoint) => endpoint.conditions?.ready === true,
  );
  if (ready.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} ready Service endpoints, found ${ready.length}`,
    );
  }
}

async function runKubectl(args, options = {}) {
  await ensureLocalTools();
  return runCommand(
    localTools.kubectl,
    [
      `--kubeconfig=${kubeconfigPath}`,
      `--context=${contextName}`,
      `--namespace=${namespace}`,
      ...args,
    ],
    { cwd: projectRoot, ...options },
  );
}

async function requireOwnedCluster() {
  if (!(await clusterExists())) {
    throw new Error(
      `kind cluster ${clusterName} is not running; use npm run lab:up`,
    );
  }

  const state = await readState();
  if (!state) {
    throw new Error(
      `Cluster ${clusterName} exists without this lab's ownership record; refusing to use or delete it`,
    );
  }

  const controlPlaneContainerId = await getControlPlaneContainerId();
  if (state.controlPlaneContainerId !== controlPlaneContainerId) {
    throw new Error(
      `Cluster ${clusterName} no longer matches this lab's ownership record; refusing to continue`,
    );
  }

  try {
    await access(kubeconfigPath);
  } catch {
    throw new Error(
      `Lab kubeconfig is missing at ${kubeconfigPath}; refusing to use the default context`,
    );
  }

  return state;
}

async function clusterExists() {
  await ensureLocalTools();
  const output = await runCommand(localTools.kind, ["get", "clusters"], {
    cwd: projectRoot,
    capture: true,
  });
  const clusters = output
    .split(/\r?\n/)
    .filter((line) => line && !/^No kind clusters found\.?$/i.test(line));
  return clusters.includes(clusterName);
}

async function getControlPlaneContainerId() {
  return runCommand(
    "docker",
    ["inspect", "--format={{.Id}}", `${clusterName}-control-plane`],
    { cwd: projectRoot, capture: true },
  );
}

async function ensureDocker() {
  await runCommand("docker", ["info", "--format={{.ServerVersion}}"], {
    cwd: projectRoot,
    capture: true,
  });
}

async function saveState(state) {
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (
      state.clusterName !== clusterName ||
      typeof state.controlPlaneContainerId !== "string" ||
      !Number.isInteger(state.hostPort) ||
      state.hostPort < 1 ||
      state.hostPort > 65_535 ||
      typeof state.imageTag !== "string"
    ) {
      throw new Error("Lab state file has an unexpected shape");
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function removeOwnedFiles() {
  await Promise.all([
    rm(statePath, { force: true }),
    rm(kubeconfigPath, { force: true }),
  ]);
}

async function kindConfigPath(hostPort) {
  if (hostPort === defaultHostPort) {
    return join(projectRoot, "kubernetes", "kind-config.yaml");
  }

  const sourcePath = join(projectRoot, "kubernetes", "kind-config.yaml");
  const source = await readFile(sourcePath, "utf8");
  const rendered = source.replace(
    `hostPort: ${defaultHostPort}`,
    `hostPort: ${hostPort}`,
  );
  if (source === rendered) {
    throw new Error("The kind config does not contain the expected host port");
  }

  const destination = join(cacheDirectory, "kind-config.yaml");
  await writeFile(destination, rendered, "utf8");
  return destination;
}

function getRequestedHostPort() {
  const rawHostPort = process.env.LAB_HOST_PORT;
  if (rawHostPort === undefined) {
    return null;
  }

  if (!/^\d+$/.test(rawHostPort)) {
    throw new Error("LAB_HOST_PORT must be an integer between 1 and 65535");
  }

  const hostPort = Number(rawHostPort);
  if (hostPort < 1 || hostPort > 65_535) {
    throw new Error("LAB_HOST_PORT must be an integer between 1 and 65535");
  }

  return hostPort;
}

function nodePortUrl(hostPort) {
  return `http://127.0.0.1:${hostPort}`;
}

function imageName(tag) {
  return `kubernetes-reliability-lab:${tag}`;
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

export { requireOwnedCluster, runClusterAcceptance, runKubectl };
