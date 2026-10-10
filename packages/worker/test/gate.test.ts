import { describe, expect, it } from "vitest";
import type { ManagedEntry } from "@polaris-key/protocol";
import {
  channelForVersion,
  checkBuildGate,
  compareSemver,
  isDevBuild,
  parseSemver,
} from "../src/core/licensing/gate.js";
import {
  channelEntitled,
  impliedChannel,
  isChannelName,
  normalizeChannelHeader,
} from "../src/core/channels.js";

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
    // P0-04: `staging` is the legacy spelling of `beta` (WIRE-CONTRACT-V3 §5.1 rule 2).
    expect(channelForVersion("0.0.0-staging.1")).toBe("beta");
    expect(channelForVersion("0.0.0-beta.3")).toBe("beta");
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

describe("checkBuildGate — dev bypass is opt-in (R3-01)", () => {
  const devBuild = {
    version: "0.0.0-dev+abc",
    channelHeader: "staging",
    compatMin: "5.0.0",
    compatMax: "6.0.0",
  };

  it("does NOT bypass anything for an unentitled dev build", () => {
    // `X-PKey-Version` is a header. Short-circuiting on it skipped both the window and the
    // channel entitlement for anyone who typed `0.0.0-dev`.
    const r = checkBuildGate({ ...devBuild, entitlements: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("version-too-old");
  });

  it("bypasses every gate when the license is entitled to the dev channel", () => {
    const r = checkBuildGate({
      ...devBuild,
      entitlements: { channels: ent(["stable", "dev"]) },
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.allowedRange).toBeUndefined();
  });

  it("bypasses every gate when the product opts in explicitly", () => {
    const r = checkBuildGate({
      ...devBuild,
      entitlements: {},
      allowDevBuilds: true,
    });
    expect(r.ok).toBe(true);
  });

  it("allowDevBuilds: false overrides a dev channel entitlement", () => {
    const r = checkBuildGate({
      ...devBuild,
      entitlements: { channels: ent(["dev"]) },
      allowDevBuilds: false,
    });
    expect(r.ok).toBe(false);
  });

  it("a dev build inside the window still needs the dev channel (R3-01)", () => {
    // An empty compatMin means "no floor" — a `0.0.0-*` prerelease sorts BELOW `0.0.0`, so
    // with any floor at all the window check fires first and the channel check is unreached.
    const inWindow = { compatMin: "", compatMax: "99.0.0" };
    expect(
      checkBuildGate({
        version: "0.0.0-dev+abc",
        entitlements: {},
        ...inWindow,
      }).reason,
    ).toBe("channel-not-entitled");
    expect(
      checkBuildGate({
        version: "0.0.0-dev+abc",
        entitlements: { channels: ent(["dev"]) },
        ...inWindow,
      }).ok,
    ).toBe(true);
  });
});

describe("checkBuildGate — the declared channel cannot loosen the build's own (R3-07)", () => {
  const win = { compatMin: "0.0.0", compatMax: "99.0.0" };

  it("a pr build declaring `stable` is still checked as pr", () => {
    const noFloor = { compatMin: "", compatMax: "99.0.0" };
    for (const version of ["0.0.0-pr-42+sha", "0.0.0-pr42+sha"]) {
      expect(
        checkBuildGate({
          version,
          channelHeader: "stable",
          entitlements: {},
          ...noFloor,
        }).reason,
      ).toBe("channel-not-entitled");
      expect(
        checkBuildGate({
          version,
          channelHeader: "stable",
          entitlements: { channels: ent(["pr"]) },
          ...noFloor,
        }).ok,
      ).toBe(true);
    }
  });

  it("an unrecognised channel declaration is refused, not coerced to stable", () => {
    // Malformed (`STAGING`, `Beta.2`) is refused outright; well-formed but ungranted
    // (`staging-2`, `nonsense`) must be granted by name (§5.1 rules 3–4).
    for (const channelHeader of [
      "staging-2",
      "STAGING",
      "Beta.2",
      "nonsense",
    ]) {
      const r = checkBuildGate({
        version: "1.2.3",
        channelHeader,
        entitlements: { channels: ent(["stable", "staging", "pr"]) },
        ...win,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("channel-not-entitled");
    }
  });

  it("a beta header is the alias case: a legacy staging grant covers it (P0-04)", () => {
    const r = checkBuildGate({
      version: "1.2.3",
      channelHeader: "beta",
      entitlements: { channels: ent(["stable", "staging", "pr"]) },
      ...win,
    });
    expect(r).toEqual({ ok: true });
  });

  it("ordinary words beginning with `pr` are no longer read as the pr channel (R3-13)", () => {
    // They are unrecognised, so they are refused — but as an unknown declaration, not by
    // being silently misfiled into a channel the caller never named.
    for (const channelHeader of ["prod", "production", "preview", "prerelease"])
      expect(
        checkBuildGate({
          version: "1.2.3",
          channelHeader,
          entitlements: { channels: ent(["pr"]) },
          ...win,
        }).ok,
      ).toBe(false);
  });
});

// ── The channel vocabulary (WIRE-CONTRACT-V3 §5.1, P0-04) ───────────────────────────────────

describe("isChannelName (§5.1 rule 1)", () => {
  it.each([
    ["stable", true],
    ["beta", true],
    ["pr-42", true],
    ["nightly", true],
    ["0day", true],
    ["a".repeat(64), true],
    ["a".repeat(65), false],
    ["-beta", false],
    ["Beta", false],
    ["beta.2", false],
    ["beta_2", false],
    ["", false],
  ])("%s → %s", (name, ok) => {
    expect(isChannelName(name)).toBe(ok);
  });
});

describe("impliedChannel (§5.1 rule 2)", () => {
  it.each([
    ["0.0.0-dev", "dev"],
    ["0.0.0-dev+abc123", "dev"],
    ["0.0.0-beta.3", "beta"],
    ["0.0.0-staging.1", "beta"],
    ["0.0.0-pr-42+sha", "pr-42"],
    ["0.0.0-pr42.1", "pr-42"],
    ["0.0.0-pr-1234567", "pr-1234567"],
    ["0.0.0-pr-12345678", "pr"],
    ["0.0.0-prfoo", "stable"],
    ["2.0.0-beta.1", "stable"],
    ["1.2.3", "stable"],
  ])("%s → %s", (version, channel) => {
    expect(impliedChannel(version)).toBe(channel);
  });
});

describe("normalizeChannelHeader (§5.1 rule 3)", () => {
  it.each([
    ["stable", "1.2.3", "stable"],
    ["latest", "1.2.3", "stable"],
    ["beta", "1.2.3", "beta"],
    ["staging", "1.2.3", "beta"],
    ["dev", "1.2.3", "dev"],
    ["pr", "1.2.3", "pr"],
    ["pr", "0.0.0-pr-42+sha", "pr-42"],
    ["pr", "0.0.0-pr42", "pr-42"],
    ["pr", "0.0.0-pr-12345678", "pr"],
    ["pr-7", "1.2.3", "pr-7"],
    ["pr7", "1.2.3", "pr-7"],
    ["pr-12345678", "1.2.3", "pr"],
    ["nightly", "1.2.3", "nightly"],
    ["staging-2", "1.2.3", "staging-2"],
    ["constructor", "1.2.3", "constructor"], // a name, not a prototype key
    ["STAGING", "1.2.3", null],
    ["Beta.2", "1.2.3", null],
    ["beta_2", "1.2.3", null],
    ["", "1.2.3", null],
  ])("%s on %s → %s", (header, version, channel) => {
    expect(normalizeChannelHeader(header, version)).toBe(channel);
  });
});

describe("channelEntitled (§5.1 rule 4)", () => {
  it.each([
    [[], "stable", true],
    [["stable"], "beta", false],
    [["stable", "beta"], "beta", true],
    [["stable", "staging"], "beta", true],
    [["stable", "beta"], "staging", false], // a `beta` grant never covers a manual `staging`
    [["stable", "staging"], "staging", true],
    [["stable", "pr"], "pr-42", true],
    [["stable", "pr"], "pr", true],
    [["stable", "pr-42"], "pr-42", true],
    [["stable", "pr-42"], "pr-7", false],
    [["stable", "pr-42"], "pr", false],
    [["stable", "beta"], "dev", false],
    [["stable", "dev"], "dev", true],
    [["stable", "nightly"], "nightly", true],
    [["stable", "beta"], "nightly", false],
    [["stable", "manual"], "nightly", false], // no literal `manual` family (P0-04 §2.4)
  ])("%j covers %s → %s", (granted, channel, ok) => {
    expect(channelEntitled(granted as string[], channel)).toBe(ok);
  });
});

describe("checkBuildGate — the channel vocabulary (P0-04)", () => {
  const win = { compatMin: "0.0.0", compatMax: "99.0.0" };
  const pre = { compatMin: "0.0.0-0", compatMax: "99.0.0" };
  const gate = (
    version: string,
    channelHeader: string | undefined,
    channels: string[] | undefined,
    window = win,
  ) =>
    checkBuildGate({
      version,
      ...(channelHeader === undefined ? {} : { channelHeader }),
      entitlements: channels ? { channels: ent(channels) } : {},
      ...window,
    }).reason ?? "ok";

  it("beta, latest, manual names and per-PR grants work at the gate", () => {
    expect(gate("2.0.0", "beta", ["stable", "beta"])).toBe("ok");
    expect(gate("2.0.0", "beta", ["stable", "staging"])).toBe("ok");
    expect(gate("2.0.0", "staging", ["stable", "beta"])).toBe("ok");
    expect(gate("2.0.0", "latest", undefined)).toBe("ok");
    expect(gate("2.0.0", "nightly", ["stable", "nightly"])).toBe("ok");
    expect(gate("2.0.0", "pr-42", ["stable", "pr"])).toBe("ok");
    expect(gate("2.0.0", "pr-42", ["stable", "pr-42"])).toBe("ok");
    expect(gate("0.0.0-pr-42+sha", "pr", ["stable", "pr-42"], pre)).toBe("ok");
  });

  it("refuses what the grant does not name", () => {
    expect(gate("2.0.0", "beta", ["stable"])).toBe("channel-not-entitled");
    expect(gate("2.0.0", "nightly", ["stable", "beta"])).toBe(
      "channel-not-entitled",
    );
    expect(gate("2.0.0", "pr-7", ["stable", "pr-42"])).toBe(
      "channel-not-entitled",
    );
    expect(gate("2.0.0", "dev", ["stable", "beta"])).toBe(
      "channel-not-entitled",
    );
    expect(gate("0.0.0-pr-42+sha", "stable", undefined, pre)).toBe(
      "channel-not-entitled",
    );
  });

  it("a 0.0.0-beta build implies beta (the one tightening)", () => {
    expect(gate("0.0.0-beta.3", undefined, ["stable", "beta"], pre)).toBe("ok");
    expect(gate("0.0.0-beta.3", undefined, ["stable"], pre)).toBe(
      "channel-not-entitled",
    );
    expect(gate("0.0.0-staging.1", undefined, ["stable", "beta"], pre)).toBe(
      "ok",
    );
    // With a compat floor of `0.0.0`, every `0.0.0-*` build is refused first by version.
    expect(gate("0.0.0-beta.3", undefined, ["stable"])).toBe("version-too-old");
  });
});
