/**
 * PS-04 made `GET /api/discover` and `GET /api/library` additive: open products (no licence
 * terms), audience-`everyone` links and library entries (no licence). Until PS-05 renders them,
 * the client hands PX-16's Discover page and the library only what they can show.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { portalApi } from "../src/portal/api.js";
import { license, libraryItem, mockFetch } from "./portalHarness.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PRESENTATION = {
  developerName: null,
  tintColor: null,
  website: null,
  iconUrl: null,
  headerUrl: null,
  support: null,
  platforms: [],
};
const TERMS = {
  tier: "free",
  tierLabel: "Free",
  deviceLimit: 2,
  expiresAt: null,
  expiryDays: null,
};

describe("the portal client and PS-04's additive shapes", () => {
  it("Discover keeps only offers with licence terms to add", async () => {
    mockFetch({
      "GET /api/discover": {
        offers: [
          // A pre-PS-04 offer: no `cta`.
          {
            ...PRESENTATION,
            product: "old",
            name: "Old",
            offer: TERMS,
            reason: "free_with_account",
          },
          {
            ...PRESENTATION,
            product: "moss",
            name: "Moss",
            offer: TERMS,
            reason: "free_with_account",
            cta: "add",
            paths: [],
          },
          {
            ...PRESENTATION,
            product: "open",
            name: "Open",
            offer: null,
            reason: "open",
            cta: "add",
            paths: [],
          },
          {
            ...PRESENTATION,
            product: "teaser",
            name: "Teaser",
            offer: null,
            reason: null,
            cta: "link",
            paths: [],
          },
        ],
      },
    });
    const { offers } = await portalApi.discover();
    expect(offers.map((o) => o.product)).toEqual(["old", "moss"]);
  });

  it("the library keeps only licence-backed products", async () => {
    const held = libraryItem(license({ product: "moss", productName: "Moss" }));
    mockFetch({
      "GET /api/library": {
        products: [
          held,
          { ...held, product: "moss2", kind: "license" },
          {
            ...held,
            product: "open",
            kind: "entry",
            via: "open",
            license: null,
            licenseCount: 0,
          },
        ],
        discoverCount: 1,
      },
    });
    const body = await portalApi.library();
    expect(body.products.map((p) => p.product)).toEqual(["moss", "moss2"]);
    expect(body.discoverCount).toBe(1);
  });
});
