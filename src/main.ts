import { createApplication } from "./application.js";
import { readAppConfig } from "./config.js";

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

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close((error) => {
        if (error) {
          console.error(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              event: "server.shutdown_failed",
              signal,
              message: error.message,
              instanceId: config.instanceId,
              version: config.version,
            }),
          );
          process.exitCode = 1;
          return;
        }

        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            event: "server.shutdown",
            signal,
            instanceId: config.instanceId,
            version: config.version,
          }),
        );
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
