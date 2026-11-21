import { describe, expect, it } from "vitest";
import { readAppConfig } from "../src/config.js";

describe("application configuration", () => {
  it("uses the pod name and configured version when provided", () => {
    expect(
      readAppConfig(
        { PORT: "9000", APP_VERSION: "  1.2.3 ", POD_NAME: "  api-abc " },
        "local-host",
      ),
    ).toEqual({
      port: 9000,
      version: "1.2.3",
      instanceId: "api-abc",
      startupDelayMs: 0,
    });
  });

  it("uses local defaults when optional environment values are absent", () => {
    expect(readAppConfig({}, "local-host")).toEqual({
      port: 8080,
      version: "dev",
      instanceId: "local-host",
      startupDelayMs: 0,
    });
  });

  it("accepts a bounded startup delay for the probe exercise", () => {
    expect(readAppConfig({ STARTUP_DELAY_MS: "8000" }).startupDelayMs).toBe(
      8_000,
    );
  });

  it.each(["-1", "60001", "1.5", "slow"])(
    "rejects invalid STARTUP_DELAY_MS value %j",
    (startupDelay) => {
      expect(() => readAppConfig({ STARTUP_DELAY_MS: startupDelay })).toThrow(
        "STARTUP_DELAY_MS must be an integer between 0 and 60000",
      );
    },
  );

  it.each(["0", "65536", "1.5", "port", ""])(
    "rejects invalid PORT value %j",
    (port) => {
      expect(() => readAppConfig({ PORT: port }, "local-host")).toThrow(
        "PORT must be an integer between 1 and 65535",
      );
    },
  );
});
