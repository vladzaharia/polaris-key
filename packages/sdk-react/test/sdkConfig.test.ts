// `pkey sdk --lang react --write` (SDK parity pass §3.19, SP-02): the committed sample
// (`sdkConfigSample.ts`, pinned to the renderer by packages/cli/test/sdkConfig.test.ts) satisfies
// `PolarisKeyConfig` with no edits; `pnpm typecheck` here proves the config is the provider's own.

import { describe, expect, it } from "vitest";
import type { PolarisKeyConfig } from "@polaris-key/react";
import polarisKey, {
  pinnedKeys,
  pinnedReleaseKeys,
} from "./sdkConfigSample.js";

describe("pkey sdk --lang react sample", () => {
  it("is the provider's product facts and trust pins, with the pins for the desktop host", () => {
    const config: PolarisKeyConfig = {
      ...polarisKey,
      version: "1.2.3",
    };
    expect(config.productSlug).toBe("acme");
    expect(config.expectedServices).toEqual([
      "license",
      "config",
      "release",
      "update",
    ]);
    // P0-47: bearer mode verifies in the page, so the config carries the pins themselves.
    expect(config.trust?.pinnedKeys).toEqual(pinnedKeys);
    expect(Object.keys(pinnedKeys)).toEqual(["pkey-test-prod-2026"]);
    expect(Object.keys(pinnedReleaseKeys)).toEqual(["acme-release-2026"]);
  });
});
