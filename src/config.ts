import { hostname } from "node:os";

export interface AppConfig {
  port: number;
  version: string;
  instanceId: string;
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

  return { port, version, instanceId };
}
