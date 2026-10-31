import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_NAME, SDK_VERSION } from "../src/version.js";

describe("SDK version", () => {
  it("X-PKey-SDK-Version is the @polaris-key/node package version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };
    expect(SDK_NAME).toBe(pkg.name);
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
