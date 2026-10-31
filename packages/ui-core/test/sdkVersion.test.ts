import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_NAME, SDK_VERSION } from "../src/browser/sdk/version.js";

describe("browser SDK version", () => {
  it("the literal sent as X-PKey-SDK-Version is the @polaris-key/react version", () => {
    const pkg = JSON.parse(
      readFileSync(
        new URL("../../sdk-react/package.json", import.meta.url),
        "utf8",
      ),
    ) as { name: string; version: string };
    expect(SDK_NAME).toBe(pkg.name);
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
