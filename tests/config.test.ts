import { describe, expect, it } from "vitest";
import { readAppConfig } from "../src/config.js";

describe("application configuration", () => {
  it("uses the pod name and configured version when provided", () => {
    expect(
      readAppConfig(
        { PORT: "9000", APP_VERSION: "  1.2.3 ", POD_NAME: "  api-abc " },
        "local-host",
      ),
    ).toEqual({ port: 9000, version: "1.2.3", instanceId: "api-abc" });
  });

  it("uses local defaults when optional environment values are absent", () => {
    expect(readAppConfig({}, "local-host")).toEqual({
      port: 8080,
      version: "dev",
      instanceId: "local-host",
    });
  });

  it.each(["0", "65536", "1.5", "port", ""])(
    "rejects invalid PORT value %j",
    (port) => {
      expect(() => readAppConfig({ PORT: port }, "local-host")).toThrow(
        "PORT must be an integer between 1 and 65535",
      );
    },
  );
});
