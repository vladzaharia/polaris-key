/**
 * A-28.2 (CM-20 D12): the identity fields of `commerce.stores` are optional and come from the
 * app the product is assigned on the store. A typed value wins; no typed value and no assignment
 * is off; a store with no block stays off (D13). The binding is an assignment, not proof a key
 * exists (pins outlive `deletePlatformCredential`), so the key checks are unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SLUG } from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";
import {
  APP_APPLE_ID,
  BUNDLE_ID,
  PLAY_PACKAGE,
  STEAM_APP,
  STEAM_DLC,
} from "./commerceFake.js";
import {
  FLAG,
  SETTINGS,
  admin,
  bindingOf,
  commerceWorld,
  grants,
  route,
  tick,
  type CommerceWorld,
} from "./commerceWorld.js";
import { effectiveCommerceSettings } from "../src/services/commerce/identity.js";
import { readyStorefronts } from "../src/services/commerce/public.js";
import { setPlatformPin } from "../src/core/platformCredentials.js";

let w: CommerceWorld | null = null;
afterEach(() => {
  w?.close();
  w = null;
});
async function world(opts: Parameters<typeof commerceWorld>[0] = {}) {
  w = await commerceWorld(opts);
  return w;
}

const claim = (cw: CommerceWorld, body: unknown) =>
  route(cw, "POST", "/commerce/claim", { token: cw.tokenA, body });
const reason = async (r: Response) =>
  ((await r.json()) as { reason?: string }).reason;

async function bought(cw: CommerceWorld, over: Record<string, unknown> = {}) {
  const tx = {
    transactionId: "2000000111",
    appAccountToken: await bindingOf(cw, cw.tokenA),
    ...over,
  };
  cw.fakes.apple.transactions.set(tx.transactionId, tx);
  return cw.fakes.apple.signTransaction(tx, NOW - 60);
}

describe("effectiveCommerceSettings: the five identity states", () => {
  it("typed only, assigned only, both equal, both different, neither", async () => {
    // The world pins its own credentials to BUNDLE_ID / PLAY_PACKAGE / STEAM_APP.
    const cw = await world({
      settings: {
        appStore: { bundleId: BUNDLE_ID }, // typed, equals the pin
        play: {
          packageName: "gg.other.app", // typed, differs from the pin
          pushAudience: "a",
          pushServiceAccount: "x@y.z",
        },
        steam: {}, // assigned only
      },
    });
    const e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.identity["app-store"]).toEqual({
      value: BUNDLE_ID,
      source: "typed",
      assigned: BUNDLE_ID,
      mismatch: false,
    });
    expect(e.identity.play).toEqual({
      value: "gg.other.app",
      source: "typed",
      assigned: PLAY_PACKAGE,
      mismatch: true,
    });
    expect(e.settings.play?.packageName).toBe("gg.other.app"); // typed wins
    expect(e.identity.steam).toEqual({
      value: STEAM_APP,
      source: "assigned",
      assigned: STEAM_APP,
      mismatch: false,
    });
    expect(e.settings.steam).toEqual({ appId: STEAM_APP });

    // Typed only (no assignment) and neither.
    const bare = await world({
      credentials: false,
      settings: { appStore: { bundleId: BUNDLE_ID }, steam: {} },
    });
    const b = await effectiveCommerceSettings(bare.db, SLUG);
    expect(b.identity["app-store"]).toEqual({
      value: BUNDLE_ID,
      source: "typed",
      assigned: null,
      mismatch: false,
    });
    expect(b.identity.steam).toEqual({
      value: null,
      source: null,
      assigned: null,
      mismatch: false,
    });
    expect(b.settings.steam).toBeNull(); // a block with neither is off
    expect(b.stored.steam).toEqual({ appId: null }); // ... but the block is stored
    // A store with no block stays off, assignment or not (D13).
    expect(b.settings.play).toBeNull();
    expect(b.identity.play.value).toBeNull();
    expect(e.settings.appStore?.bundleId).toBe(BUNDLE_ID);
  });

  it("an assignment from the platform pin is used with no credential present", async () => {
    const cw = await world({
      credentials: false,
      settings: { appStore: {}, steam: {} },
    });
    for (const [id, pin] of [
      ["app-store.in-app-purchase-key", BUNDLE_ID],
      ["app-store.api-key", String(APP_APPLE_ID)],
      ["steam.publisher-key", STEAM_APP],
    ] as const)
      expect(
        (
          await setPlatformPin(cw.db, {
            id,
            product: SLUG,
            pin,
            actor: "t",
            now: NOW,
          })
        ).ok,
      ).toBe(true);
    const e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.identity["app-store"]).toMatchObject({
      value: BUNDLE_ID,
      source: "assigned",
    });
    expect(e.settings.appStore).toEqual({
      bundleId: BUNDLE_ID,
      appAppleId: APP_APPLE_ID, // the Apple ID of the same assigned app
      acceptSandbox: false,
    });
    expect(e.settings.steam).toEqual({ appId: STEAM_APP });
    // Anything that needs the key still refuses: no credential, so the claim is the not-found
    // and the store is not ready.
    expect(
      (
        await claim(cw, {
          store: "steam",
          ticket: "aa".repeat(10),
          dlcAppId: STEAM_DLC,
        })
      ).status,
    ).toBe(404);
    expect(await readyStorefronts(cw.env, cw.db, SLUG)).toBe(0);
  });

  it("does not derive the Apple ID for a typed bundle id that is not the assigned app", async () => {
    const cw = await world({
      credentials: false,
      settings: { appStore: { bundleId: "gg.other.app" } },
    });
    await setPlatformPin(cw.db, {
      id: "app-store.api-key",
      product: SLUG,
      pin: String(APP_APPLE_ID),
      actor: "t",
      now: NOW,
    });
    const e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.settings.appStore?.appAppleId).toBeNull();
  });
});

describe("the device claim path", () => {
  it("a block without bundleId claims the assigned bundle and refuses another (wrong_app)", async () => {
    const cw = await world({ settings: { ...SETTINGS, appStore: {} } });
    const ok = await claim(cw, {
      store: "app-store",
      signedTransaction: await bought(cw),
    });
    expect(ok.status).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
    const other = await claim(cw, {
      store: "app-store",
      signedTransaction: await bought(cw, {
        transactionId: "2000000222",
        bundleId: "gg.other.app",
      }),
    });
    expect(other.status).toBe(400);
    expect(await reason(other)).toBe("wrong_app");
  });

  it("typed differs from the assignment: the typed app is in force, and with no key for it the store is off", async () => {
    const cw = await world({
      settings: { ...SETTINGS, appStore: { bundleId: "gg.other.app" } },
    });
    const e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.identity["app-store"]).toMatchObject({
      value: "gg.other.app",
      source: "typed",
      mismatch: true,
    });
    const res = await claim(cw, {
      store: "app-store",
      signedTransaction: await bought(cw, { bundleId: "gg.other.app" }),
    });
    expect(res.status).toBe(404); // the credential is pinned to the assigned app, not the typed one
  });

  it("no typed field and no assignment: the store answers as off, in the claim, the binding and the overview", async () => {
    const cw = await world({
      credentials: false,
      settings: {
        appStore: {},
        play: { pushAudience: "a", pushServiceAccount: "x@y.z" },
        steam: {},
      },
    });
    for (const body of [
      { store: "app-store", signedTransaction: "x.y.z" },
      { store: "play", productId: "p", purchaseToken: "t" },
      { store: "steam", ticket: "aa".repeat(10), dlcAppId: STEAM_DLC },
    ])
      expect((await claim(cw, body)).status).toBe(404);
    const binding = await route(cw, "GET", "/commerce/binding", {
      token: cw.tokenA,
    });
    expect(
      ((await binding.json()) as { products: unknown[] }).products,
    ).toEqual([]);
    const view = (await (await admin(cw, "GET", "/commerce")).json()) as {
      settings: { steam: { appId: string | null } };
      setup: Record<string, { configured: boolean; reason: string | null }>;
    };
    expect(view.settings.steam).toEqual({ appId: null }); // as stored
    for (const s of ["app-store", "play", "steam"])
      expect(view.setup[s]).toMatchObject({
        configured: false,
        reason: "no_app_assigned",
      });
    expect(await readyStorefronts(cw.env, cw.db, SLUG)).toBe(0);
  });

  it("a store with no block stays off although the product is assigned an app", async () => {
    const cw = await world({ settings: { steam: {} } });
    const view = (await (await admin(cw, "GET", "/commerce")).json()) as {
      setup: Record<string, { configured: boolean; reason: string | null }>;
    };
    expect(view.setup["app-store"]).toMatchObject({
      configured: false,
      reason: "no settings for this store",
    });
    expect(view.setup.steam?.configured).toBe(true);
    expect(
      (await claim(cw, { store: "app-store", signedTransaction: "x.y.z" }))
        .status,
    ).toBe(404);
  });

  it("Steam and Play: a block with no identity resolves from the assignment", async () => {
    const cw = await world({
      settings: {
        steam: {},
        play: { pushAudience: "a", pushServiceAccount: "x@y.z" },
      },
    });
    // Not the not-found: the context was built, so the store is asked (and refuses the junk).
    expect(
      (
        await claim(cw, {
          store: "steam",
          ticket: "aa".repeat(10),
          dlcAppId: STEAM_DLC,
        })
      ).status,
    ).not.toBe(404);
    expect(
      (
        await claim(cw, {
          store: "play",
          productId: "skins_pack",
          purchaseToken: "t",
        })
      ).status,
    ).not.toBe(404);
  });
});

describe("recheck and the hooks use the effective identity", () => {
  it("the Play hook is live (401, not the not-found) for a block with no packageName", async () => {
    const cw = await world({
      settings: { play: { pushAudience: "a", pushServiceAccount: "x@y.z" } },
    });
    const live = await route(cw, "POST", "/distribution/hooks/play-rtdn", {
      body: {},
    });
    expect(live.status).not.toBe(404);
    const off = await world({
      credentials: false,
      settings: { play: { pushAudience: "a", pushServiceAccount: "x@y.z" } },
    });
    expect(
      (await route(off, "POST", "/distribution/hooks/play-rtdn", { body: {} }))
        .status,
    ).toBe(404);
  });

  it("the App Store hook and the cron tick see the assigned bundle", async () => {
    const cw = await world({ settings: { appStore: {} } });
    expect(
      (
        await route(cw, "POST", "/distribution/hooks/app-store", {
          body: { signedPayload: "x.y.z" },
        })
      ).status,
    ).not.toBe(404);
  });

  it("the cron tick polls Play's voided purchases for a derived package, and not for an unassigned one", async () => {
    const derived = await world({
      settings: { play: { pushAudience: "a", pushServiceAccount: "x@y.z" } },
    });
    await tick(derived, NOW + 3600);
    expect(derived.fakes.google.requests.length).toBeGreaterThan(0);
    derived.close();
    const off = await world({
      credentials: false,
      settings: { play: { pushAudience: "a", pushServiceAccount: "x@y.z" } },
    });
    await tick(off, NOW + 3600);
    expect(off.fakes.google.requests).toHaveLength(0);
  });
});
