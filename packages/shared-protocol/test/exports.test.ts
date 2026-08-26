// Pins the v3 subpath layout and the barrel's legacy-compat guarantees: subpaths carry
// wire contract v3 values; the barrel keeps the v2 values until P8 so unmigrated
// consumers keep working. If this test fails after an edit, a consumer somewhere is
// about to verify or sign with the wrong ISSUER or send the wrong header names.
import { describe, expect, it } from "vitest";

import * as barrel from "../src/index.js";
import * as core from "../src/core.js";
import * as legacy from "../src/legacy.js";
import { DEFAULT_RELEASE_ACCESS } from "../src/release.js";

describe("@plrs/protocol layout", () => {
  it("core carries wire contract v3", () => {
    expect(core.PROTOCOL_VERSION).toBe(3);
    expect(core.ISSUER).toBe("plrs.im");
    expect(core.HEADER_DEVICE).toBe("X-Polaris-Device");
    expect(core.HEADER_SDK_NAME).toBe("X-Polaris-SDK");
    expect(core.MAX_BUNDLE_BYTES).toBe(262_144);
  });

  it("the barrel keeps the legacy v2 values until consumers migrate", () => {
    expect(barrel.ISSUER).toBe("key.plrs.im");
    expect(barrel.HEADER_DEVICE).toBe("X-PKey-Device");
    // ...but the version counter is v3 everywhere — there is only one contract.
    expect(barrel.PROTOCOL_VERSION).toBe(3);
  });

  it("legacy and core disagree only where the rebrand demands it", () => {
    expect(legacy.ISSUER).not.toBe(core.ISSUER);
    expect(legacy.HEADER_DEVICE).not.toBe(core.HEADER_DEVICE);
    // Hash domains are NOT rebranded (fingerprintVersion 1 unchanged).
    expect(core.FINGERPRINT_HASH_PREFIX).toBe("pkey-hw");
  });

  it("release access gains the entitled mode with public defaults intact", () => {
    const modes: barrel.ReleaseAccess[] = ["public", "authenticated", "licensed", "entitled"];
    expect(modes).toHaveLength(4);
    expect(DEFAULT_RELEASE_ACCESS).toEqual({ metadata: "public", artifacts: "public" });
  });

  it("the gate vocabulary includes not-applicable", () => {
    const status: barrel.LicenseStatus = "not-applicable";
    expect(status).toBe("not-applicable");
  });
});
