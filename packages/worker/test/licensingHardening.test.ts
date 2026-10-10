import { describe, expect, it } from "vitest";
import { versionInWindow } from "../src/core/entitlements.js";
import { WriteChecks } from "../src/admin/lib/writeChecks.js";

describe("licensing hardening", () => {
  it("a bounded window refuses an unparseable version; an open one admits it", () => {
    expect(versionInWindow("", { max: "1.0.0" })).toBe(false);
    expect(versionInWindow("garbage", { min: "1.0.0" })).toBe(false);
    expect(versionInWindow("1.0.0", { max: "1.0.0" })).toBe(true);
    expect(versionInWindow("garbage", {})).toBe(true);
  });
  it("the default window (min 0.0.0, no max) is open and admits non-semver clients", () => {
    for (const v of ["1.0", "1.2.3.4", "2024.10", "garbage", ""])
      expect(versionInWindow(v, { min: "0.0.0" })).toBe(true);
    expect(versionInWindow("1.0.0", { min: "0.0.0" })).toBe(true);
  });
  it("a truly bounded window refuses non-semver and garbage, orders semver as before", () => {
    for (const r of [
      { min: "2.0.0" },
      { max: "3.0.0" },
      { min: "0.0.0", max: "3.0.0" },
    ])
      for (const v of ["1.0", "1.2.3.4", "2024.10", "garbage", ""])
        expect(versionInWindow(v, r)).toBe(false);
    expect(versionInWindow("2.0.0", { min: "2.0.0" })).toBe(true);
    expect(versionInWindow("1.9.9", { min: "2.0.0" })).toBe(false);
    expect(versionInWindow("3.0.0", { max: "3.0.0" })).toBe(true);
    expect(versionInWindow("3.0.1", { max: "3.0.0" })).toBe(false);
  });
  it("expiresAt must be a whole in-range number, or absent/null", () => {
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

describe("RateLimitDO input validation", () => {
  it("rejects windowSec 0", async () => {
    const { RateLimitDO } = await import("../src/rateLimitDo.js");
    const dobj = new RateLimitDO({ storage: {} } as never, {} as never);
    const res = await dobj.fetch(
      new Request("https://x/", {
        method: "POST",
        body: JSON.stringify({
          bucket: "b",
          id: "i",
          limit: 1,
          windowSec: 0,
          now: 5,
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
