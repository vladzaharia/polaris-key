/**
 * Change tier's "what changes" (licenses.change-tier): each limit that moves, old to new, from the
 * tier list and the license's own values.
 */

import { describe, expect, it } from "vitest";
import { tierDiff } from "../src/console/sections/license/components/ChangeTierDialog.js";
import { limitRows } from "../src/console/sections/license/components/LimitsTable.js";
import { dayProgress } from "../src/console/sections/license/components/LicenseRail.js";
import { DETAIL, PRO, TIERS, UNUSED } from "./licenseFixture.js";

const PRODUCT = { defaultDeviceLimit: 3, defaultMaxOfflineDays: 7 };
const NOW = Date.UTC(2026, 9, 7);
const plain = { ...DETAIL, maxOfflineDays: null, channels: [] };

describe("tierDiff", () => {
  it("lists devices, tracks, versions and duration that change, old to new", () => {
    const d = tierDiff(plain, "edu", TIERS, PRODUCT, NOW);
    expect(d.changes.map((c) => [c.key, c.from, c.to])).toEqual(
      [
        ["devices", "5", "1"],
        ["versions", "≥ 1.0.0", "Any"],
        [
          "duration",
          expect.stringMatching(/^Ends /),
          expect.stringMatching(/^Ends /),
        ],
      ].filter((r) => r[0] !== "tracks"),
    );
    expect(d.changes[0]!.note).toMatch(
      /2 devices are signed in; none is signed out/,
    );
    expect(d.unchanged).toEqual(["offline days 7"]);
  });

  it("keeps a limit the license sets itself", () => {
    const own = { ...plain, deviceLimit: 4 };
    const d = tierDiff(own, "edu", TIERS, PRODUCT, NOW);
    expect(d.changes.some((c) => c.key === "devices")).toBe(false);
    expect(d.unchanged).toContain("devices 4");
  });

  it("moving to no tier falls back to the platform default and a lifetime", () => {
    const d = tierDiff(plain, null, TIERS, PRODUCT, NOW);
    expect(d.changes.find((c) => c.key === "devices")).toMatchObject({
      from: "5",
      to: "3",
    });
    expect(d.changes.find((c) => c.key === "duration")!.to).toBe("Lifetime");
  });

  it("moving to a tier with no term and no limit reads Lifetime and the product limit", () => {
    const d = tierDiff(plain, UNUSED.id, TIERS, PRODUCT, NOW);
    expect(d.changes.find((c) => c.key === "duration")!.to).toBe("Lifetime");
    expect(d.changes.find((c) => c.key === "devices")!.to).toBe("3");
  });
});

describe("limitRows", () => {
  it("marks what the license sets and says what the tier gives instead", () => {
    const rows = limitRows(DETAIL, TIERS, PRODUCT);
    const offline = rows.find((r) => r.kind === "offline")!;
    expect(offline).toMatchObject({
      value: "14 days",
      from: "Set on this license",
      gives: "Platform default gives 7",
      overridden: true,
    });
    const devices = rows.find((r) => r.kind === "devices")!;
    expect(devices).toMatchObject({ value: "5", from: PRO.label });
  });
});

describe("dayProgress", () => {
  it("places today between start and end, clamped", () => {
    expect(dayProgress(0, 100, 25)).toBe(25);
    expect(dayProgress(0, 100, 250)).toBe(100);
    expect(dayProgress(0, 100, -5)).toBe(0);
    expect(dayProgress(10, 10, 5)).toBe(100);
  });
});
