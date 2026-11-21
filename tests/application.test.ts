import assert from "node:assert/strict";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/application.js";

const readinessFailureFile = join(
  tmpdir(),
  "kubernetes-reliability-lab-readiness-failure",
);
const livenessFailureFile = join(
  tmpdir(),
  "kubernetes-reliability-lab-liveness-failure",
);

describe("HTTP application", () => {
  const logs: string[] = [];
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await Promise.all([
      rm(readinessFailureFile, { force: true }),
      rm(livenessFailureFile, { force: true }),
    ]);
    server = createApplication(
      {
        port: 0,
        version: "1.2.3",
        instanceId: "pod-a",
        startupDelayMs: 0,
      },
      (line) => logs.push(line),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    assert(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all([
      rm(readinessFailureFile, { force: true }),
      rm(livenessFailureFile, { force: true }),
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    ]);
  });

  it("returns the configured version and instance with a server request ID", async () => {
    const response = await fetch(`${baseUrl}/?ignored=value`);
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(response.json()).resolves.toEqual({
      version: "1.2.3",
      instanceId: "pod-a",
    });

    const accessLog = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(accessLog).toMatchObject({
      requestId,
      method: "GET",
      path: "/",
      status: 200,
      instanceId: "pod-a",
      version: "1.2.3",
    });
    expect(accessLog.durationMs).toEqual(expect.any(Number));
    expect(Number.isNaN(Date.parse(String(accessLog.timestamp)))).toBe(false);
    expect(JSON.stringify(accessLog)).not.toContain("ignored=value");
  });

  it("reports that the process is live", async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("reports startup and readiness independently from liveness", async () => {
    const [startup, readiness, liveness] = await Promise.all([
      fetch(`${baseUrl}/health/startup`),
      fetch(`${baseUrl}/health/ready`),
      fetch(`${baseUrl}/health/live`),
    ]);

    expect(startup.status).toBe(200);
    await expect(startup.json()).resolves.toEqual({ status: "ok" });
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toEqual({ status: "ok" });
    expect(liveness.status).toBe(200);
    await expect(liveness.json()).resolves.toEqual({ status: "ok" });
  });

  it("marks readiness failed without failing liveness", async () => {
    await writeFile(readinessFailureFile, "active");

    try {
      const readiness = await fetch(`${baseUrl}/health/ready`);
      const liveness = await fetch(`${baseUrl}/health/live`);

      expect(readiness.status).toBe(503);
      await expect(readiness.json()).resolves.toEqual({ status: "not_ready" });
      expect(liveness.status).toBe(200);
      await expect(liveness.json()).resolves.toEqual({ status: "ok" });
    } finally {
      await rm(readinessFailureFile, { force: true });
    }
  });

  it("marks liveness failed without failing readiness", async () => {
    await writeFile(livenessFailureFile, "active");

    try {
      const liveness = await fetch(`${baseUrl}/health/live`);
      const readiness = await fetch(`${baseUrl}/health/ready`);

      expect(liveness.status).toBe(503);
      await expect(liveness.json()).resolves.toEqual({ status: "unhealthy" });
      expect(readiness.status).toBe(200);
      await expect(readiness.json()).resolves.toEqual({ status: "ok" });
    } finally {
      await rm(livenessFailureFile, { force: true });
    }
  });

  it("keeps the startup route unavailable during configured initialization", async () => {
    const delayedServer = createApplication({
      port: 0,
      version: "1.2.3",
      instanceId: "slow-pod",
      startupDelayMs: 1_000,
    });
    delayedServer.listen(0, "127.0.0.1");
    await once(delayedServer, "listening");

    const address = delayedServer.address();
    assert(address && typeof address !== "string");
    const delayedUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

    try {
      const starting = await fetch(`${delayedUrl}/health/startup`);
      expect(starting.status).toBe(503);
      await expect(starting.json()).resolves.toEqual({ status: "starting" });

      await new Promise((resolve) => setTimeout(resolve, 1_050));
      const started = await fetch(`${delayedUrl}/health/startup`);
      expect(started.status).toBe(200);
      await expect(started.json()).resolves.toEqual({ status: "ok" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        delayedServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });
});
