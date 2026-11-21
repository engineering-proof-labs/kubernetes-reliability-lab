import { performance } from "node:perf_hooks";
import { createApplication } from "./application.js";
import { readAppConfig } from "./config.js";

const shutdownTimeoutMs = 20_000;

try {
  const config = readAppConfig();
  const server = createApplication(config);

  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "server.error",
        code: error.code,
        message: error.message,
        instanceId: config.instanceId,
        version: config.version,
      }),
    );
    process.exitCode = 1;
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "server.listening",
        port: config.port,
        instanceId: config.instanceId,
        version: config.version,
      }),
    );
  });

  let shutdownStarted = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (shutdownStarted) {
        return;
      }
      shutdownStarted = true;

      const shutdownStartedAt = performance.now();
      let forced = false;
      writeLifecycleEvent(config, "server.shutdown_started", { signal });

      const shutdownTimer = setTimeout(() => {
        forced = true;
        writeLifecycleEvent(config, "server.shutdown_timed_out", {
          signal,
          timeoutMs: shutdownTimeoutMs,
        });
        server.closeAllConnections();
      }, shutdownTimeoutMs);

      server.close((error) => {
        clearTimeout(shutdownTimer);
        if (error) {
          writeLifecycleEvent(config, "server.shutdown_failed", {
            signal,
            message: error.message,
          });
          process.exitCode = 1;
          return;
        }

        writeLifecycleEvent(config, "server.shutdown_completed", {
          signal,
          graceful: !forced,
          drainDurationMs:
            Math.round((performance.now() - shutdownStartedAt) * 100) / 100,
        });
        if (forced) {
          process.exitCode = 1;
        }
      });
    });
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Unknown startup error";
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "server.startup_failed",
      message,
    }),
  );
  process.exitCode = 1;
}

function writeLifecycleEvent(
  config: ReturnType<typeof readAppConfig>,
  event: string,
  details: Record<string, string | number | boolean>,
): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...details,
      instanceId: config.instanceId,
      version: config.version,
    }),
  );
}
