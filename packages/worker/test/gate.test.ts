import { describe, expect, it } from "vitest";
import type { ManagedEntry } from "@polaris-key/protocol";
import {
  channelForVersion,
  checkBuildGate,
  compareSemver,
  isDevBuild,
  parseSemver,
} from "../src/gate.js";

// Convenience: an enforced entitlement entry.
const ent = (value: ManagedEntry["value"]): ManagedEntry => ({
  state: "enforced",
  value,
  updatedAt: 1_700_000_000,
});

describe("parseSemver", () => {
  it("parses MAJOR.MINOR.PATCH", () => {
    expect(parseSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it("parses a prerelease into dot-separated identifiers", () => {
    expect(parseSemver("1.0.0-beta.2")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ["beta", "2"],
    });
  });

  it("ignores build metadata", () => {
    expect(parseSemver("1.0.0+abc.def")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: [],
    });
    expect(parseSemver("1.0.0-rc.1+build.7")?.prerelease).toEqual(["rc", "1"]);
  });

  it("returns null for unparseable input", () => {
    expect(parseSemver("garbage")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("v1.2.3")).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("1.2.3.4")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders MAJOR.MINOR.PATCH", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
  });

  it("sorts a pre-release below its release", () => {
    expect(compareSemver("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBe(1);
  });

  it("orders prerelease identifiers (numeric vs alpha + length)", () => {
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    // A longer prerelease set with all-equal prefix is greater.
    expect(compareSemver("1.0.0-beta.1.1", "1.0.0-beta.1")).toBe(1);
    expect(compareSemver("1.0.0-beta", "1.0.0-beta.1")).toBe(-1);
    // Numeric identifiers compare numerically, not lexically.
    expect(compareSemver("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.2")).toBe(0);
  });

  it("ignores build metadata in comparison", () => {
    expect(compareSemver("1.0.0+a", "1.0.0+b")).toBe(0);
  });

  it("treats either unparseable operand as equal (no bound)", () => {
    expect(compareSemver("garbage", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "garbage")).toBe(0);
    expect(compareSemver("x", "y")).toBe(0);
  });
});

describe("channelForVersion", () => {
  it("maps the special 0.0.0-* prefixes", () => {
    expect(channelForVersion("0.0.0-dev+abc")).toBe("dev");
    expect(channelForVersion("0.0.0-staging.1")).toBe("staging");
    expect(channelForVersion("0.0.0-pr42.1")).toBe("pr");
    expect(channelForVersion("0.0.0-pr7")).toBe("pr");
  });

  it("treats everything else as stable", () => {
    expect(channelForVersion("1.2.3")).toBe("stable");
    expect(channelForVersion("2.0.0-beta.1")).toBe("stable");
    expect(channelForVersion("0.0.0-prfoo")).toBe("stable"); // pr requires a digit
  });
});

describe("isDevBuild", () => {
  it("recognizes the dev sentinel", () => {
    expect(isDevBuild("0.0.0-dev+sha")).toBe(true);
    expect(isDevBuild("0.0.0-dev")).toBe(true);
  });
  it("rejects real versions", () => {
    expect(isDevBuild("1.0.0")).toBe(false);
    expect(isDevBuild("0.0.0-staging.1")).toBe(false);
  });
});

describe("checkBuildGate — version window", () => {
  const base = {
    compatMin: "1.0.0",
    compatMax: "3.0.0",
    entitlements: {} as Record<string, ManagedEntry>,
  };

  it("allows a version inside the product compat window", () => {
    const r = checkBuildGate({ version: "2.0.0", ...base });
    expect(r.ok).toBe(true);
    // allowedRange is only attached on the failure branches, not on success.
    expect(r.allowedRange).toBeUndefined();
  });

  it("blocks a version below the product compat min", () => {
    const r = checkBuildGate({ version: "0.9.0", ...base });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("version-too-old");
    expect(r.allowedRange).toEqual({ min: "1.0.0", max: "3.0.0" });
  });

  it("blocks a version above the product compat max", () => {
    const r = checkBuildGate({ version: "4.0.0", ...base });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("version-too-new");
    expect(r.allowedRange?.max).toBe("3.0.0");
  });

  it("intersects with a per-key tighter min (per-key wins)", () => {
    const r = checkBuildGate({
      version: "1.5.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: { "app.minVersion": ent("2.0.0") },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("version-too-old");
    expect(r.allowedRange?.min).toBe("2.0.0");
  });

  it("intersects with a per-key tighter max (per-key wins)", () => {
    const r = checkBuildGate({
      version: "2.5.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: { "app.maxVersion": ent("2.0.0") },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("version-too-new");
    expect(r.allowedRange?.max).toBe("2.0.0");
  });

  it("ignores a per-key bound looser than the product window", () => {
    // app.minVersion 0.5.0 is looser than compatMin 1.0.0 → product min stays.
    // The build is still inside the (unchanged) window, so it passes with no allowedRange.
    const r = checkBuildGate({
      version: "1.0.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: { "app.minVersion": ent("0.5.0") },
    });
    expect(r.ok).toBe(true);
    // Cross-check the effective tighter-min via a below-min probe.
    const probe = checkBuildGate({
      version: "0.6.0",
      compatMin: "1.0.0",
      compatMax: "3.0.0",
      entitlements: { "app.minVersion": ent("0.5.0") },
    });
    expect(probe.ok).toBe(false);
    expect(probe.allowedRange?.min).toBe("1.0.0");
  });

  it("allows exactly at both boundaries (inclusive)", () => {
    expect(checkBuildGate({ version: "1.0.0", ...base }).ok).toBe(true);
    expect(checkBuildGate({ version: "3.0.0", ...base }).ok).toBe(true);
  });
});

describe("checkBuildGate — channel entitlement", () => {
  const win = { compatMin: "0.0.0", compatMax: "99.0.0" };

  it("permits a stable build with no channel entitlement", () => {
    const r = checkBuildGate({ version: "1.2.3", entitlements: {}, ...win });
    expect(r.ok).toBe(true);
  });

  it("blocks a staging build when channels are not entitled", () => {
    const r = checkBuildGate({
      version: "2.0.0",
      channelHeader: "staging",
      entitlements: {},
      ...win,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("channel-not-entitled");
  });

  it("permits a staging build when the channels entitlement grants it", () => {
    const r = checkBuildGate({
      version: "2.0.0",
      channelHeader: "staging",
      entitlements: { channels: ent(["staging"]) },
      ...win,
    });
    expect(r.ok).toBe(true);
  });

  it("permits a pr build when entitled, blocks when not", () => {
    expect(
      checkBuildGate({
        version: "1.0.0",
        channelHeader: "pr-42",
        entitlements: { channels: ent(["pr"]) },
        ...win,
      }).ok,
    ).toBe(true);
    expect(
      checkBuildGate({
        version: "1.0.0",
        channelHeader: "pr-42",
        entitlements: {},
        ...win,
      }).ok,
    ).toBe(false);
  });

  it("derives a stable channel from a stable version when no header is sent", () => {
    // With no channel header, a stable version derives the stable channel → always allowed.
    const r = checkBuildGate({ version: "2.0.0", entitlements: {}, ...win });
    expect(r.ok).toBe(true);
    // A non-stable version (0.0.0-staging.*) is filtered earlier by the window check,
    // so the channel-derivation path is exercised via the channelHeader cases above.
  });

  it("never blocks the stable channel on entitlement", () => {
    const r = checkBuildGate({
      version: "1.2.3",
      channelHeader: "stable",
      entitlements: {},
      ...win,
    });
    expect(r.ok).toBe(true);
  });
});

describe("checkBuildGate — dev bypass", () => {
  it("bypasses every gate for a dev build", () => {
    const r = checkBuildGate({
      version: "0.0.0-dev+abc",
      channelHeader: "staging",
      compatMin: "5.0.0",
      compatMax: "6.0.0",
      entitlements: {},
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.allowedRange).toBeUndefined();
  });
});
