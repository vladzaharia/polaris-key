/**
 * ST-08: the table behind Settings → All settings names the editor of each key, not of its area.
 * It is hand-kept, so these tests are what keep it true to the registry: every key the table can
 * show has a home, no home names a key that is gone, every page home is a route that opens that
 * page, and a kind never contradicts who owns the value.
 */

import { describe, expect, it } from "vitest";
import { SETTING_HOMES } from "../src/console/sections/core/model/settingHomes.js";
import { pageOf } from "../src/console/nav.js";
import { parseLocation, productPage } from "../src/console/routes.js";
import { SETTINGS_INDEX } from "../src/console/settings.generated.js";

const PRODUCT = SETTINGS_INDEX.filter((e) => e.scope === "product");
/** What All settings can list: a live product entry (a pending or deprecated one is filtered). */
const SHOWN = PRODUCT.filter(
  (e) => e.pending === null && e.deprecated === null,
);

describe("settings homes", () => {
  it("has a home for every setting the All settings table can list", () => {
    expect(
      SHOWN.filter((e) => !(e.key in SETTING_HOMES)).map((e) => e.key),
    ).toEqual([]);
  });

  it("names no key the registry does not have at product scope", () => {
    const keys = new Set(PRODUCT.map((e) => e.key));
    expect(Object.keys(SETTING_HOMES).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("sends every page home to a route that opens that page and record", () => {
    for (const [key, home] of Object.entries(SETTING_HOMES)) {
      if (home.kind !== "page") continue;
      const hash = productPage("djdl", home.page, { id: home.id });
      const { route } = parseLocation(hash);
      expect(
        route.kind === "product"
          ? { key, page: route.page, id: route.id }
          : { key, notFound: hash },
        key,
      ).toEqual({ key, page: home.page, id: home.id });
    }
  });

  it("puts a record id only on a page that has records", () => {
    for (const [key, home] of Object.entries(SETTING_HOMES)) {
      if (home.kind === "page" && home.id !== undefined)
        expect(pageOf(home.page).record, key).toBeDefined();
    }
  });

  it("keeps each kind consistent with who owns the value", () => {
    const owner = new Map(SHOWN.map((e) => [e.key, e.ownership]));
    for (const [key, home] of Object.entries(SETTING_HOMES)) {
      const o = owner.get(key);
      if (o === undefined) continue;
      // A `.pkey/` file can only declare what the manifest owns or the console may claim from it.
      if (home.kind === "manifest")
        expect(["manifest", "claimable"], key).toContain(o);
      // No manifest spelling and no console control: only an operator-owned value is left to the API.
      if (home.kind === "api") expect(o, key).toBe("operator");
    }
  });

  it("does not give every key of an area the same home when its editors differ", () => {
    // The mistake this table replaced: one page per `<service>|<area>`. These areas split.
    const homesOf = (area: string): Set<string> =>
      new Set(
        SHOWN.filter((e) => `${e.service}|${e.area}` === area).map((e) =>
          JSON.stringify(SETTING_HOMES[e.key]),
        ),
      );
    for (const area of [
      "license|license.policy",
      "license|license.autoIssue",
      "release|release.sync",
      "release|release.compatibility",
      "core|general",
      "core|access",
      "core|storefront",
      "identity|identity.keyEntry",
    ]) {
      const homes = homesOf(area);
      // A one-key area has one home trivially; the others must have kept their keys apart.
      if (SHOWN.filter((e) => `${e.service}|${e.area}` === area).length > 1)
        expect(homes.size, area).toBeGreaterThan(1);
    }
  });

  // The split families the review found, each by key.
  it.each([
    [
      "license.defaults.deviceLimit",
      { kind: "page", page: "settings", section: "License defaults" },
    ],
    [
      "license.defaults.maxOfflineDays",
      { kind: "page", page: "settings", section: "License defaults" },
    ],
    [
      "license.fingerprint",
      { kind: "page", page: "enrollment", section: "Fingerprint policy" },
    ],
    // Enrollment has no auto-issue control (P0-47).
    ["license.autoIssue", { kind: "manifest", file: "product" }],
    [
      "release.github",
      { kind: "page", page: "settings", section: "Repository" },
    ],
    ["release.binaryName", { kind: "manifest", file: "release" }],
    ["release.summaryMarker", { kind: "manifest", file: "release" }],
    // Update → Feed's "Artifact policy" edits `update.operatorPolicy`, not this key.
    ["release.artifactPolicy", { kind: "manifest", file: "release" }],
    [
      "update.operatorPolicy",
      { kind: "page", page: "feed", section: "Artifact policy" },
    ],
    // Release → Compatibility only reads the window; the form is on Update → Feed.
    [
      "release.compatWindow",
      { kind: "page", page: "feed", section: "Compatibility window" },
    ],
    ["core.presentation", { kind: "manifest", file: "product" }],
    [
      "core.trustPolicy",
      { kind: "page", page: "keys", section: "Device trust" },
    ],
    [
      "storefront.polarisKey.listed",
      {
        kind: "page",
        page: "storefronts",
        id: "polaris-key",
        section: "Polaris Locker → Listing",
      },
    ],
    // ST-14: Settings → Polaris Locker.
    [
      "identity.keyEntry.claimByKey",
      { kind: "page", page: "portal", section: "Polaris Locker" },
    ],
    [
      "portal.enabled",
      { kind: "page", page: "portal", section: "Polaris Locker" },
    ],
    [
      "portal.keyReissue",
      { kind: "page", page: "portal", section: "Polaris Locker" },
    ],
    ["identity.keyEntry.limit", { kind: "manifest", file: "product" }],
  ])("%s", (key, home) => {
    expect(SETTING_HOMES[key]).toEqual(home);
  });
});
