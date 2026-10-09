import { describe, expect, it } from "vitest";
import { versionInWindow } from "../src/core/entitlements.js";
import { WriteChecks } from "../src/admin/lib/writeChecks.js";

describe("SEC-WP-22 licensing hardening", () => {
  it("SEC-LIC-6: a bounded window refuses an unparseable version; an open one admits it", () => {
    expect(versionInWindow("", { max: "1.0.0" })).toBe(false);
    expect(versionInWindow("garbage", { min: "1.0.0" })).toBe(false);
    expect(versionInWindow("1.0.0", { max: "1.0.0" })).toBe(true);
    expect(versionInWindow("garbage", {})).toBe(true);
  });
  it("SEC-LIC-8: expiresAt must be a whole in-range number, or absent/null", () => {
    const bad = (v: unknown) =>
      new WriteChecks().expiresAt("expiresAt", v).response() !== null;
    expect(bad(1.5)).toBe(true);
    expect(bad("5")).toBe(true);
    expect(bad({})).toBe(true);
    expect(bad(-1)).toBe(true);
    expect(bad(1e300)).toBe(true);
    expect(bad(1800000000)).toBe(false);
    expect(bad(null)).toBe(false);
    expect(bad(undefined)).toBe(false);
  });
});
