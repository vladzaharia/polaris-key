import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_NAME, SDK_VERSION } from "../src/version.js";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { name: string; version: string };

describe("sdk identity", () => {
  it("matches package.json", () => {
    // The browser bundle can't read package.json at runtime, so these are literals. This test
    // is what keeps them honest when Changesets bumps the version.
    expect(SDK_NAME).toBe(pkg.name);
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
