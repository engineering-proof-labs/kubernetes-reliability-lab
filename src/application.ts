import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AppConfig } from "./config.js";

const readinessFailureFile = join(
  tmpdir(),
  "kubernetes-reliability-lab-readiness-failure",
);
const livenessFailureFile = join(
  tmpdir(),
  "kubernetes-reliability-lab-liveness-failure",
);

type AccessLog = {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  instanceId: string;
  version: string;
};

export function createApplication(
  config: AppConfig,
  writeLog: (line: string) => void = console.log,
): Server {
  const applicationStartedAt = performance.now();

  return createServer((request, response) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const path = (request.url ?? "/").split("?", 1)[0] || "/";

    response.setHeader("X-Request-Id", requestId);
    response.once("finish", () => {
      const accessLog: AccessLog = {
        timestamp: new Date().toISOString(),
        requestId,
        method: request.method ?? "UNKNOWN",
        path,
        status: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        instanceId: config.instanceId,
        version: config.version,
      };

      writeLog(JSON.stringify(accessLog));
    });

    if (request.method === "GET" && path === "/") {
      sendJson(response, 200, {
        version: config.version,
        instanceId: config.instanceId,
      });
      return;
    }

    if (request.method === "GET" && path === "/health/startup") {
      const startupComplete =
        performance.now() - applicationStartedAt >= config.startupDelayMs;
      sendJson(response, startupComplete ? 200 : 503, {
        status: startupComplete ? "ok" : "starting",
      });
      return;
    }

    if (request.method === "GET" && path === "/health/ready") {
      const ready =
        config.readinessMode === "normal" && !existsSync(readinessFailureFile);
      sendJson(response, ready ? 200 : 503, {
        status: ready ? "ok" : "not_ready",
      });
      return;
    }

    if (request.method === "GET" && path === "/health/live") {
      const live = !existsSync(livenessFailureFile);
      sendJson(response, live ? 200 : 503, {
        status: live ? "ok" : "unhealthy",
      });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: Record<string, string>,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}
