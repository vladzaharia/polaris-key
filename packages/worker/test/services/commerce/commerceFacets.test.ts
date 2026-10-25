/**
 * P0-27.5 — the device claim, the binding listing, the hooks and the recheck dispatch through
 * `COMMERCE_FACETS`. The answers below were recorded BEFORE the bridge switched over and must
 * not change: every `bad_body` message, the unknown-store refusal, and the Steam oracle guard.
 */

import { afterEach, describe, expect, it } from "vitest";
import { STORES } from "../../../src/core/licensing/storeGrants.js";
import {
  COMMERCE_FACETS,
  commerceFacetFor,
} from "../../../src/services/commerce/stores/index.js";
import { STEAM_DLC } from "../../commerceFake.js";
import {
  commerceWorld,
  route,
  type CommerceWorld,
} from "../../commerceWorld.js";

let w: CommerceWorld | null = null;
afterEach(() => {
  w?.close();
  w = null;
});

const claim = (cw: CommerceWorld, body: unknown) =>
  route(cw, "POST", "/commerce/claim", { token: cw.tokenA, body });

const answer = async (r: Response) => ({
  status: r.status,
  body: await r.text(),
});

describe("the facet registry", () => {
  it("every wire store has exactly one facet, and nothing else is registered", () => {
    const facets = Object.values(COMMERCE_FACETS);
    for (const store of STORES)
      expect(facets.filter((f) => f?.store === store)).toHaveLength(1);
    expect(facets).toHaveLength(STORES.length);
    for (const store of STORES)
      expect(commerceFacetFor(store)?.store).toBe(store);
  });

  it("an unknown store id has no facet", () => {
    expect(commerceFacetFor("gog" as never)).toBeUndefined();
    expect(commerceFacetFor("__proto__" as never)).toBeUndefined();
  });
});

describe("the claim answers exactly as before", () => {
  const cases: [string, unknown][] = [
    ["no store", {}],
    ["unknown store", { store: "gog" }],
    ["non-string store", { store: 42 }],
    ["inherited store name", { store: "__proto__" }],
    ["apple without a transaction", { store: "app-store" }],
    [
      "apple with a numeric transaction",
      { store: "app-store", signedTransaction: 1 },
    ],
    ["play without a sku", { store: "play", purchaseToken: "tok_abcdefghij" }],
    ["play without a token", { store: "play", productId: "skins_pack" }],
    ["steam without a ticket", { store: "steam", dlcAppId: STEAM_DLC }],
    [
      "steam with a non-hex ticket",
      { store: "steam", ticket: "zz", dlcAppId: STEAM_DLC },
    ],
    [
      "steam with a bad app id",
      { store: "steam", ticket: "aa".repeat(10), dlcAppId: "0" },
    ],
    [
      "steam with a non-numeric app id",
      { store: "steam", ticket: "aa".repeat(10), dlcAppId: "abc" },
    ],
  ];
  for (const [name, body] of cases)
    it(name, async () => {
      w = await commerceWorld();
      expect(await answer(await claim(w, body))).toMatchSnapshot();
    });

  it("a malformed body to a store with no credential answers 404: the context is read before the body is parsed", async () => {
    w = await commerceWorld({ credentials: false });
    for (const body of [
      { store: "app-store" },
      { store: "play", purchaseToken: "tok_abcdefghij" },
      { store: "steam", ticket: "zz", dlcAppId: "0" },
    ])
      expect(await answer(await claim(w, body))).toMatchSnapshot();
  });

  it("an unmapped Steam app answers as a non-owner and makes no store call", async () => {
    w = await commerceWorld();
    const res = await claim(w, {
      store: "steam",
      ticket: "aa".repeat(10),
      dlcAppId: "999999",
    });
    expect(await answer(res)).toMatchSnapshot();
    expect(w.fakes.steam.requests).toHaveLength(0);
    expect(w.fakes.foreign).toEqual([]);
  });
});
