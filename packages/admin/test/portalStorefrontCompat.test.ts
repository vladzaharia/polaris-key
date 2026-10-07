/**
 * The portal client and the storefront's shapes (PS-04's API, PS-05's UI): `GET /api/discover`
 * and `GET /api/library` carry open products, link-only listings and library entries, and the
 * client hands every one of them to the pages (PS-04's interim filter is gone). An answer from a
 * Worker before PS-04 (no `cta`, no `paths`) still reads, and an offer this build cannot show
 * honestly (an action it does not know, an Add with no reason) is left out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { portalApi } from "../src/portal/api.js";
import {
  entryItem,
  fetchedRequests,
  license,
  libraryItem,
  mockFetch,
} from "./portalHarness.js";

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
const path = (kind: string, reason: string, terms: unknown = TERMS) => ({
  kind,
  detail: null,
  label: null,
  terms,
  action: "add",
  reason,
});

describe("the portal client and the storefront's shapes", () => {
  it("Discover hands over offers to add, open products and links", async () => {
    mockFetch({
      "GET /api/discover": {
        offers: [
          // A Worker before PS-04: no `cta`, no `paths`; its reason and terms are the one path.
          {
            ...PRESENTATION,
            product: "old",
            name: "Old",
            offer: TERMS,
            reason: "group:beta",
          },
          {
            ...PRESENTATION,
            product: "moss",
            name: "Moss",
            offer: TERMS,
            reason: "free_with_account",
            cta: "add",
            shortDescription: "A garden",
            paths: [
              path("auto_issue", "free_with_account"),
              path("open", "open", null),
            ],
            stores: [],
          },
          {
            ...PRESENTATION,
            product: "open",
            name: "Open",
            offer: null,
            reason: "open",
            cta: "add",
            paths: [path("open", "open", null)],
            stores: [],
          },
          {
            ...PRESENTATION,
            product: "teaser",
            name: "Teaser",
            offer: null,
            reason: null,
            cta: "link",
            paths: [],
            stores: [
              {
                id: "steam:main",
                kind: "steam",
                label: "Steam",
                url: "https://store.example/steam",
              },
              // Never a non-https page.
              { id: "x", kind: "x", label: "X", url: "http://x.example" },
            ],
          },
          // S-22's priced offer: an action this build cannot take is not shown.
          {
            ...PRESENTATION,
            product: "buy",
            name: "Buy",
            offer: TERMS,
            reason: "price",
            cta: "buy",
            paths: [{ ...path("price", "price"), action: "buy" }],
          },
          // An Add with no path cannot say why (Q-6): not shown.
          {
            ...PRESENTATION,
            product: "why",
            name: "Why",
            offer: TERMS,
            reason: null,
            cta: "add",
            paths: [],
          },
        ],
      },
    });
    const { offers } = await portalApi.discover();
    expect(offers.map((o) => o.product)).toEqual([
      "old",
      "moss",
      "open",
      "teaser",
    ]);
    const [old, moss, open, teaser] = offers;
    expect(old!.cta).toBe("add");
    expect(old!.paths).toEqual([
      {
        kind: "group",
        detail: "beta",
        label: null,
        terms: TERMS,
        action: "add",
        reason: "group:beta",
      },
    ]);
    expect(moss!.paths.map((p) => p.kind)).toEqual(["auto_issue", "open"]);
    expect(moss!.shortDescription).toBe("A garden");
    expect(moss!.offer).toEqual(TERMS);
    expect(open!.offer).toBeNull();
    expect(open!.reason).toBe("open");
    expect(teaser!.cta).toBe("link");
    expect(teaser!.paths).toEqual([]);
    expect(teaser!.stores).toEqual([
      {
        id: "steam:main",
        kind: "steam",
        label: "Steam",
        url: "https://store.example/steam",
      },
    ]);
  });

  it("the library hands over licences and entries, and nothing of a kind it doesn't know", async () => {
    const held = libraryItem(license({ product: "moss", productName: "Moss" }));
    mockFetch({
      "GET /api/library": {
        products: [
          held,
          { ...held, product: "moss2", kind: "license" },
          entryItem("open", "Open"),
          { ...entryItem("grant", "Grant"), kind: "grant" },
        ],
        discoverCount: 1,
      },
    });
    const body = await portalApi.library();
    expect(body.products.map((p) => [p.product, p.kind ?? "license"])).toEqual([
      ["moss", "license"],
      ["moss2", "license"],
      ["open", "entry"],
    ]);
    expect(body.discoverCount).toBe(1);
  });

  it("the storefront page reads the listing; an answer it can't show is a 404", async () => {
    mockFetch({
      "GET /api/discover/moss": {
        ...PRESENTATION,
        product: "moss",
        name: "Moss",
        offer: TERMS,
        reason: "free_with_account",
        cta: "add",
        shortDescription: null,
        paths: [path("auto_issue", "free_with_account")],
        stores: [],
        description: "Grow things.\nSlowly.",
        screenshots: ["/media/moss/screenshot-0?v=1", 7],
      },
      "GET /api/discover/odd": { product: "odd", cta: "buy" },
    });
    const page = await portalApi.storefrontProduct("moss");
    expect(page.description).toBe("Grow things.\nSlowly.");
    expect(page.screenshots).toEqual(["/media/moss/screenshot-0?v=1"]);
    await expect(portalApi.storefrontProduct("odd")).rejects.toMatchObject({
      status: 404,
    });
    await expect(portalApi.storefrontProduct("gone")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("claims by path only when one is named, and removes an entry by product", async () => {
    const bodies: unknown[] = [];
    mockFetch({
      "POST /api/discover/moss/claim": (init: RequestInit | undefined) => {
        bodies.push(init?.body ?? null);
        return {
          added: true,
          product: "moss",
          kind: "entry",
          entry: { via: "open", addedAt: 1 },
        };
      },
      "DELETE /api/library/moss": { ok: true, product: "moss" },
    });
    await portalApi.claimDiscover("moss");
    await portalApi.claimDiscover("moss", "open");
    expect(bodies[0]).toBeNull();
    expect(JSON.parse(String(bodies[1]))).toEqual({ path: "open" });
    await portalApi.removeLibraryEntry("moss");
    expect(fetchedRequests()).toEqual([
      "POST /api/discover/moss/claim",
      "POST /api/discover/moss/claim",
      "DELETE /api/library/moss",
    ]);
  });
});
