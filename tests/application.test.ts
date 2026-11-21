import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/application.js";

describe("HTTP application", () => {
  const logs: string[] = [];
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApplication(
      { port: 0, version: "1.2.3", instanceId: "pod-a" },
      (line) => logs.push(line),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    assert(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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

  it("returns a JSON 404 for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });
});
