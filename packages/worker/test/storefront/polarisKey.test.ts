/**
 * PS-01 (notes/S-21 §6.1): the `polaris-key` storefront adapter. The conformance suite
 * (`conformance.test.ts`, item 11) holds its first-party ops to the contract; this file checks the
 * declaration itself, the fit report's projection of the shared listing onto its column, and the
 * readiness checklist, one test per check.
 */

import { describe, expect, it } from "vitest";
import { supports } from "../../src/core/adapters/contract.js";
import {
  storefrontAdapter,
  STOREFRONT_OPS,
} from "../../src/core/storefront/adapter.js";
import type { ListingModel } from "../../src/core/storefront/listingModel.js";
import { LISTING_STORES } from "../../src/core/storefront/listingProfiles.js";
import {
  fitReport,
  projectListing,
} from "../../src/core/storefront/projection.js";
import { POLARIS_KEY_ADAPTER } from "../../src/core/storefront/stores/polarisKey.js";
import {
  polarisKeyReadiness,
  type PolarisKeyCheckId,
  type PolarisKeyReadinessInput,
} from "../../src/core/storefront/stores/polarisKeyReadiness.js";

describe("the polaris-key declaration", () => {
  it("is in the registry, credential-less and gate-less, serving the direct outlet", () => {
    const a = storefrontAdapter("polaris-key");
    expect(a).toBe(POLARIS_KEY_ADAPTER);
    expect(a).toMatchObject({
      label: "Polaris Key",
      outletKinds: ["direct"],
      credential: null,
      gate: null,
      ci: null,
      confirmation: { phrase: "app-name", label: "Polaris Key" },
      audit: { action: "polaris-key" },
    });
    expect(a!.specPin).toBeUndefined();
  });

  it("declares S-21 §6.1's op table: first-party ops are supported, the rest say why", () => {
    const ops = POLARIS_KEY_ADAPTER.capabilities.ops;
    const firstParty = STOREFRONT_OPS.filter(
      (op) => ops[op].mode === "first-party",
    );
    expect(firstParty.sort()).toEqual(
      [
        "connect",
        "listApps",
        "identifiers",
        "readListing",
        "writeListingText",
        "writeListingAssets",
        "category",
        "submit",
        "status",
      ].sort(),
    );
    for (const op of firstParty)
      expect(supports(POLARIS_KEY_ADAPTER.capabilities, op)).toBe(true);
    expect(ops.pricing).toEqual({
      mode: "unsupported",
      reason: "Listed products are obtained without payment",
    });
    expect(ops.createApp).toEqual({
      mode: "unsupported",
      reason: "Every Polaris Key product already has a storefront page",
    });
    for (const op of STOREFRONT_OPS) {
      const s = ops[op];
      if (s.mode === "unsupported")
        expect(s.reason).not.toMatch(/coming soon|not yet|later/i);
    }
  });

  it("has the listing profile of S-21 §6.1", () => {
    expect(POLARIS_KEY_ADAPTER.listing.fields).toEqual({
      name: { maxChars: 60, perLocale: true, required: true },
      shortDescription: { maxChars: 140, perLocale: true, required: true },
      description: { maxChars: 4000, perLocale: true },
    });
    const { icon, header, screenshots } = POLARIS_KEY_ADAPTER.listing.images;
    expect(icon).toMatchObject({ min: 1, max: 1 });
    expect(header).toMatchObject({ min: 0, max: 1, aspect: [16, 9] });
    expect(screenshots).toMatchObject({ min: 0, max: 8 });
    expect(LISTING_STORES).toContain("polaris-key");
  });
});

/** A model that fits Polaris Key. */
function model(over: Partial<ListingModel> = {}): ListingModel {
  return {
    app: { defaultLocale: "en-US", name: "Diceroll" },
    locales: {
      "en-US": {
        shortDescription: "A tiny dice roller for tabletop nights.",
        description: "Diceroll rolls dice.\n\nThat is all it does.",
      },
    },
    overrides: [],
    ...over,
  };
}

describe("the fit report projects the shared listing for polaris-key", () => {
  it("a fitting listing is green, with the name, the tile line and the description", () => {
    const [row] = fitReport({ model: model() }, ["polaris-key"]);
    expect(row).toMatchObject({ store: "polaris-key", label: "Polaris Key" });
    expect(row!.status).toBe("green");
    expect(row!.payload!.locales["en-US"]).toEqual({
      name: "Diceroll",
      shortDescription: "A tiny dice roller for tabletop nights.",
      description: "Diceroll rolls dice.\n\nThat is all it does.",
    });
  });

  it("the polaris-key override wins over the model; another store's does not", () => {
    const p = projectListing(
      {
        model: model({
          overrides: [
            {
              store: "polaris-key",
              locale: null,
              field: "shortDescription",
              value: "Roll dice in the Library.",
            },
            {
              store: "play",
              locale: null,
              field: "name",
              value: "Diceroll for Android",
            },
          ],
        }),
      },
      "polaris-key",
    );
    expect(p.payload!.locales["en-US"]).toMatchObject({
      name: "Diceroll",
      shortDescription: "Roll dice in the Library.",
    });
  });

  it("over a limit is red with no payload, and nothing is cut", () => {
    const m = model({
      locales: {
        "en-US": { shortDescription: "s".repeat(141), description: "d" },
      },
    });
    const frozen = JSON.stringify(m);
    const [row] = fitReport({ model: m }, ["polaris-key"]);
    expect(row!.status).toBe("red");
    expect(row!.payload).toBeNull();
    expect(row!.issues).toEqual([
      expect.objectContaining({
        field: "shortDescription",
        issue: "too_long",
        limit: 140,
        actual: 141,
      }),
    ]);
    expect(JSON.stringify(m)).toBe(frozen);
  });

  it("a missing short description is red", () => {
    const [row] = fitReport(
      { model: model({ locales: { "en-US": { description: "d" } } }) },
      ["polaris-key"],
    );
    expect(row!.status).toBe("red");
    expect(row!.issues.map((i) => [i.field, i.issue])).toEqual([
      ["shortDescription", "missing"],
    ]);
  });
});

const READY: PolarisKeyReadinessInput = {
  portalEnabled: true,
  listingFit: "green",
  hasIcon: true,
  obtainPaths: ["group"],
  audience: "eligible",
  getIt: { releaseDownloads: 2, storeLinks: 0, website: false },
  issuedTiers: [{ path: "group", tier: "pro", exists: true, deviceLimit: 3 }],
};

function check(over: Partial<PolarisKeyReadinessInput>, id: PolarisKeyCheckId) {
  return polarisKeyReadiness({ ...READY, ...over }).find((c) => c.id === id)!;
}

describe("polarisKeyReadiness: the five checks of S-21 §6.1", () => {
  it("answers the five checks in order, all passing for a ready product", () => {
    const checks = polarisKeyReadiness(READY);
    expect(checks.map((c) => c.id)).toEqual([
      "portal",
      "listing",
      "obtain-path",
      "get-it",
      "licence-tier",
    ]);
    expect(checks.map((c) => c.state)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    for (const c of checks) expect(c.reason.length).toBeGreaterThan(10);
  });

  it("1. portal: fails when the portal is off for the product", () => {
    expect(check({ portalEnabled: false }, "portal")).toMatchObject({
      state: "fail",
      reason: expect.stringContaining("Turn the portal on"),
    });
  });

  it("2. listing: no listing or red fails, no icon fails, amber warns", () => {
    expect(check({ listingFit: null }, "listing").state).toBe("fail");
    expect(check({ listingFit: "red" }, "listing").state).toBe("fail");
    expect(check({ hasIcon: false }, "listing")).toMatchObject({
      state: "fail",
      reason: "Add an icon to the listing",
    });
    expect(check({ listingFit: "amber" }, "listing").state).toBe("warn");
  });

  it("3. obtain path: none fails; audience everyone passes with a warning that names it", () => {
    expect(check({ obtainPaths: [] }, "obtain-path").state).toBe("fail");
    expect(
      check({ obtainPaths: [], audience: "everyone" }, "obtain-path"),
    ).toMatchObject({
      state: "warn",
      reason: expect.stringContaining("Everyone signed in"),
    });
    expect(
      check({ obtainPaths: ["group", "open"] }, "obtain-path").reason,
    ).toContain("2 obtain paths");
  });

  it("4. get it: a download or a store link passes, only a website warns, nothing fails", () => {
    expect(
      check(
        { getIt: { releaseDownloads: 0, storeLinks: 1, website: false } },
        "get-it",
      ).state,
    ).toBe("pass");
    expect(
      check(
        { getIt: { releaseDownloads: 0, storeLinks: 0, website: true } },
        "get-it",
      ).state,
    ).toBe("warn");
    expect(
      check(
        { getIt: { releaseDownloads: 0, storeLinks: 0, website: false } },
        "get-it",
      ).state,
    ).toBe("fail");
  });

  it("5. licence tier: no issuing path passes; a missing tier or no device limit fails", () => {
    expect(check({ issuedTiers: [] }, "licence-tier").state).toBe("pass");
    expect(
      check(
        {
          issuedTiers: [
            { path: "group", tier: "gold", exists: false, deviceLimit: null },
          ],
        },
        "licence-tier",
      ),
    ).toMatchObject({
      state: "fail",
      reason: "The group path issues tier gold, which does not exist",
    });
    expect(
      check(
        {
          issuedTiers: [
            {
              path: "auto_issue",
              tier: "free",
              exists: true,
              deviceLimit: null,
            },
          ],
        },
        "licence-tier",
      ),
    ).toMatchObject({
      state: "fail",
      reason: "Tier free, issued by the auto_issue path, has no device limit",
    });
  });
});
