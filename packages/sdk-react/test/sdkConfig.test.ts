// `pkey sdk --lang react --write` (SDK parity pass §3.19, SP-02): the committed sample
// (sdkConfigSample.ts, pinned to the renderer by packages/cli/test/sdkConfig.test.ts) spreads into
// `PolarisKeyProviderProps` with no edits; `pnpm typecheck` here is the proof that the props are
// the provider's own.

import { describe, expect, it } from "vitest";
import type { PolarisKeyProviderProps } from "../src/index.js";
import polarisConfig, {
  pinnedKeys,
  pinnedReleaseKeys,
} from "./sdkConfigSample.js";

describe("pkey sdk --lang react sample", () => {
  it("is the provider's product facts, with the pins for the desktop host", () => {
    const props: PolarisKeyProviderProps = {
      ...polarisConfig,
      version: "1.2.3",
      children: null,
    };
    expect(props.productSlug).toBe("acme");
    expect(props.expectServices).toEqual([
      "license",
      "config",
      "release",
      "update",
    ]);
    expect(Object.keys(pinnedKeys)).toEqual(["pkey-test-prod-2026"]);
    expect(Object.keys(pinnedReleaseKeys)).toEqual(["acme-release-2026"]);
  });
});
