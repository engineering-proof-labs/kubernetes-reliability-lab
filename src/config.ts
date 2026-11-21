import { hostname } from "node:os";

export interface AppConfig {
  port: number;
  version: string;
  instanceId: string;
  startupDelayMs: number;
  readinessMode: "normal" | "blocked";
}

export function readAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  fallbackInstanceId = hostname(),
): AppConfig {
  const rawPort = env.PORT ?? "8080";
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const port = Number(rawPort);
  if (port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const version = env.APP_VERSION?.trim() || "dev";
  const instanceId = env.POD_NAME?.trim() || fallbackInstanceId;
  const rawStartupDelay = env.STARTUP_DELAY_MS ?? "0";
  if (!/^\d+$/.test(rawStartupDelay)) {
    throw new Error("STARTUP_DELAY_MS must be an integer between 0 and 60000");
  }

  const startupDelayMs = Number(rawStartupDelay);
  if (startupDelayMs > 60_000) {
    throw new Error("STARTUP_DELAY_MS must be an integer between 0 and 60000");
  }

  const readinessMode = env.READINESS_MODE?.trim() || "normal";
  if (readinessMode !== "normal" && readinessMode !== "blocked") {
    throw new Error("READINESS_MODE must be either normal or blocked");
  }

  return { port, version, instanceId, startupDelayMs, readinessMode };
}
