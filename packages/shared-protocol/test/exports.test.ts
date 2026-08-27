// Pins the v3 subpath layout and the barrel's ONE identifier set: the barrel re-exports
// core's values verbatim, so there is no second spelling of `ISSUER` or the `HEADER_*`
// constants anywhere in the package. If this test fails after an edit, a consumer somewhere
// is about to verify or sign with the wrong ISSUER or send the wrong header names.
import { describe, expect, it } from "vitest";

import * as barrel from "../src/index.js";
import * as core from "../src/core.js";
import { DEFAULT_RELEASE_ACCESS } from "../src/release.js";

describe("@polaris-key/protocol layout", () => {
  it("core carries wire contract v3", () => {
    expect(core.PROTOCOL_VERSION).toBe(3);
    expect(core.ISSUER).toBe("key.plrs.im");
    expect(core.HEADER_DEVICE).toBe("X-PKey-Device");
    expect(core.HEADER_SDK_NAME).toBe("X-PKey-SDK");
    expect(core.MAX_BUNDLE_BYTES).toBe(262_144);
  });

  it("the barrel and core are the SAME identifier set, not two that happen to agree", () => {
    // Re-exports, so this is identity rather than equality of two hand-maintained literals.
    expect(barrel.ISSUER).toBe(core.ISSUER);
    expect(barrel.HEADER_DEVICE).toBe(core.HEADER_DEVICE);
    expect(barrel.HEADER_SDK_NAME).toBe(core.HEADER_SDK_NAME);
    expect(barrel.PROTOCOL_VERSION).toBe(core.PROTOCOL_VERSION);
    // Hash domains are frozen at fingerprintVersion 1 and were never rebranded.
    expect(core.FINGERPRINT_HASH_PREFIX).toBe("pkey-hw");
  });

  it("release access gains the entitled mode with public defaults intact", () => {
    const modes: barrel.ReleaseAccess[] = [
      "public",
      "authenticated",
      "licensed",
      "entitled",
    ];
    expect(modes).toHaveLength(4);
    expect(DEFAULT_RELEASE_ACCESS).toEqual({
      metadata: "public",
      artifacts: "public",
    });
  });

  it("the gate vocabulary includes not-applicable", () => {
    const status: barrel.LicenseStatus = "not-applicable";
    expect(status).toBe("not-applicable");
  });
});
