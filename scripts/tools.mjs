import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./process.mjs";

export const KIND_VERSION = "0.33.0";
export const KUBERNETES_VERSION = "1.35.8";
export const KIND_NODE_IMAGE =
  "kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const target = getDownloadTarget();
const toolDirectory = join(
  projectRoot,
  ".cache",
  "tools",
  `${target.os}-${target.arch}`,
);
let toolchainPromise;

export const localTools = {
  kind: join(toolDirectory, `kind-${KIND_VERSION}${target.extension}`),
  kubectl: join(
    toolDirectory,
    `kubectl-${KUBERNETES_VERSION}${target.extension}`,
  ),
};

export async function ensureLocalTools() {
  toolchainPromise ??= installLocalTools();
  return toolchainPromise;
}

async function installLocalTools() {
  await mkdir(toolDirectory, { recursive: true });

  const kindAsset = `kind-${target.os}-${target.arch}`;
  await ensureVerifiedBinary(
    localTools.kind,
    `https://github.com/kubernetes-sigs/kind/releases/download/v${KIND_VERSION}/${kindAsset}`,
    `https://github.com/kubernetes-sigs/kind/releases/download/v${KIND_VERSION}/${kindAsset}.sha256sum`,
    true,
  );

  const kubectlAsset = `kubectl${target.extension}`;
  const kubectlUrl = `https://dl.k8s.io/release/v${KUBERNETES_VERSION}/bin/${target.os}/${target.arch}/${kubectlAsset}`;
  await ensureVerifiedBinary(
    localTools.kubectl,
    kubectlUrl,
    `${kubectlUrl}.sha256`,
    false,
  );

  const kindVersion = await runCommand(localTools.kind, ["version"], {
    capture: true,
  });
  if (!kindVersion.includes(`v${KIND_VERSION}`)) {
    throw new Error(`Expected kind ${KIND_VERSION}, received: ${kindVersion}`);
  }

  const kubectlVersion = await runCommand(
    localTools.kubectl,
    ["version", "--client", "--output=yaml"],
    { capture: true },
  );
  if (!kubectlVersion.includes(`v${KUBERNETES_VERSION}`)) {
    throw new Error(
      `Expected kubectl ${KUBERNETES_VERSION}, received a different version`,
    );
  }

  return localTools;
}

function getDownloadTarget() {
  const operatingSystems = {
    win32: { os: "windows", extension: ".exe" },
    linux: { os: "linux", extension: "" },
    darwin: { os: "darwin", extension: "" },
  };
  const operatingSystem = operatingSystems[process.platform];
  const architectures = { x64: "amd64", arm64: "arm64" };
  const architecture = architectures[process.arch];

  if (!operatingSystem || !architecture) {
    throw new Error(
      `Unsupported kind/kubectl platform: ${process.platform}/${process.arch}`,
    );
  }

  if (process.platform === "win32" && architecture === "arm64") {
    throw new Error("kind does not publish a Windows arm64 binary yet");
  }

  return { ...operatingSystem, arch: architecture };
}

async function ensureVerifiedBinary(
  destination,
  assetUrl,
  checksumUrl,
  checksumHasFilename,
) {
  const sidecar = `${destination}.sha256`;
  const existingIsValid = await verifyCachedBinary(destination, sidecar);
  if (existingIsValid) {
    return;
  }

  await rm(destination, { force: true });
  await rm(sidecar, { force: true });

  const [assetResponse, checksumResponse] = await Promise.all([
    fetch(assetUrl, { signal: AbortSignal.timeout(60_000) }),
    fetch(checksumUrl, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!assetResponse.ok || !checksumResponse.ok) {
    throw new Error(
      `Tool download failed (${assetResponse.status}, ${checksumResponse.status})`,
    );
  }

  const [asset, checksumText] = await Promise.all([
    assetResponse.arrayBuffer(),
    checksumResponse.text(),
  ]);
  const expected = parseChecksum(checksumText, checksumHasFilename);
  const bytes = Buffer.from(asset);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`SHA-256 verification failed for ${assetUrl}`);
  }

  const temporaryPath = `${destination}.${process.pid}.tmp`;
  await writeFile(temporaryPath, bytes, { mode: 0o755 });
  await rename(temporaryPath, destination);
  await writeFile(sidecar, `${expected}\n`, "utf8");

  if (process.platform !== "win32") {
    await chmod(destination, 0o755);
  }
}

async function verifyCachedBinary(binaryPath, sidecarPath) {
  try {
    const [binary, sidecar] = await Promise.all([
      readFile(binaryPath),
      readFile(sidecarPath, "utf8"),
    ]);
    const expected = parseChecksum(sidecar, false);
    const actual = createHash("sha256").update(binary).digest("hex");
    return actual === expected;
  } catch {
    return false;
  }
}

function parseChecksum(text, hasFilename) {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  const match = line.match(
    hasFilename ? /^([a-f0-9]{64})\s+\S+$/i : /^([a-f0-9]{64})$/i,
  );
  if (!match) {
    throw new Error("The published SHA-256 checksum has an unexpected format");
  }

  return match[1].toLowerCase();
}
