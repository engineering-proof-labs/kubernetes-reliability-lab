import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AppConfig } from "./config.js";

const maximumWorkDurationMs = 10_000;
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

    if (request.method === "GET" && path === "/work") {
      const durationMs = readWorkDuration(request.url ?? "");
      if (durationMs === null) {
        sendJson(response, 400, {
          error: `durationMs must be an integer between 1 and ${maximumWorkDurationMs}`,
        });
        return;
      }

      const operationId = request.headers["x-operation-id"];
      if (
        operationId !== undefined &&
        (typeof operationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            operationId,
          ))
      ) {
        sendJson(response, 400, { error: "x-operation-id must be a UUID" });
        return;
      }

      writeLog(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "work.started",
          requestId,
          ...(operationId === undefined ? {} : { operationId }),
          durationMs,
          instanceId: config.instanceId,
        }),
      );

      setTimeout(() => {
        sendJson(response, 200, {
          status: "completed",
          requestId,
          ...(operationId === undefined ? {} : { operationId }),
          instanceId: config.instanceId,
          durationMs,
        });
      }, durationMs);
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
  body: Record<string, string | number>,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function readWorkDuration(requestUrl: string): number | null {
  const query = requestUrl.split("?", 2)[1];
  if (query === undefined) {
    return null;
  }

  const rawDuration = new URLSearchParams(query).get("durationMs");
  if (rawDuration === null || !/^\d+$/.test(rawDuration)) {
    return null;
  }

  const durationMs = Number(rawDuration);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > maximumWorkDurationMs
  ) {
    return null;
  }

  return durationMs;
}
