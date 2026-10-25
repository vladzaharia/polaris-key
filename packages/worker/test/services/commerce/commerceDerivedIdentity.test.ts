/**
 * A-28.2 (CM-20 D12): the identity fields of `commerce.stores` are optional and come from the
 * app the product is assigned on the store. A typed value wins; no typed value and no assignment
 * is off; a store with no block stays off (D13). The binding is an assignment, not proof a key
 * exists (pins outlive `deletePlatformCredential`), so the key checks are unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SLUG } from "../../releaseRoutesFixture.js";
import { NOW } from "../../seed.js";
import {
  APP_APPLE_ID,
  BUNDLE_ID,
  PLAY_PACKAGE,
  STEAM_APP,
  STEAM_DLC,
} from "../../commerceFake.js";
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
} from "../../commerceWorld.js";
import { effectiveCommerceSettings } from "../../../src/services/commerce/identity.js";
import { readyStorefronts } from "../../../src/services/commerce/public.js";
import {
  putPlatformCredential,
  setPlatformPin,
} from "../../../src/core/platformCredentials.js";
import { putOutletCredential } from "../../../src/core/outletCredentials.js";
import { setupOf } from "../../../src/services/commerce/admin.js";
import { generateKeyPairSync } from "node:crypto";
import type { Db } from "../../../src/db/types.js";

const worlds: CommerceWorld[] = [];
afterEach(() => {
  for (const x of worlds.splice(0)) x.close();
});
async function world(opts: Parameters<typeof commerceWorld>[0] = {}) {
  const x = await commerceWorld(opts);
  worlds.push(x);
  return x;
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
      ambiguous: false,
    });
    expect(e.identity.play).toEqual({
      value: "gg.other.app",
      source: "typed",
      assigned: PLAY_PACKAGE,
      mismatch: true,
      ambiguous: false,
    });
    expect(e.settings.play?.packageName).toBe("gg.other.app"); // typed wins
    expect(e.identity.steam).toEqual({
      value: STEAM_APP,
      source: "assigned",
      assigned: STEAM_APP,
      mismatch: false,
      ambiguous: false,
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
      ambiguous: false,
    });
    expect(b.identity.steam).toEqual({
      value: null,
      source: null,
      assigned: null,
      mismatch: false,
      ambiguous: false,
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
      appAppleId: null, // never derived from the API-key pin (typed only)
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

  it("never derives the Apple ID, whichever bundle id is in force", async () => {
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
    const off = await world({
      credentials: false,
      settings: { play: { pushAudience: "a", pushServiceAccount: "x@y.z" } },
    });
    await tick(off, NOW + 3600);
    expect(off.fakes.google.requests).toHaveLength(0);
  });
});

const p8Pem = () =>
  generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;

const hook = (cw: CommerceWorld, signedPayload: string) =>
  route(cw, "POST", "/distribution/hooks/app-store", {
    body: { signedPayload },
  });

describe("review round: the Apple ID is never derived (B1)", () => {
  it("an own IAP key pinned to the bundle plus a stray platform appleId pin: a Production REFUND for the bundle revokes", async () => {
    const cw = await world({ settings: { appStore: {} } });
    // The platform API-key pin names ANOTHER app's Apple ID.
    expect(
      (
        await setPlatformPin(cw.db, {
          id: "app-store.api-key",
          product: SLUG,
          pin: "42",
          actor: "t",
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    const e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.settings.appStore?.appAppleId).toBeNull();

    const signed = await bought(cw);
    expect(
      (await claim(cw, { store: "app-store", signedTransaction: signed }))
        .status,
    ).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);

    const tx = {
      transactionId: "2000000111",
      appAccountToken: await bindingOf(cw, cw.tokenA),
    };
    cw.fakes.apple.transactions.set(tx.transactionId, {
      ...tx,
      revocationDate: NOW * 1000,
    });
    const n = await cw.fakes.apple.signNotification(
      {
        uuid: "1b6e2f6a-0000-4000-8000-0000000000aa",
        type: "REFUND",
        tx,
        appAppleId: APP_APPLE_ID,
      },
      NOW,
    );
    const res = await hook(cw, n);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toMatchObject({ ignored: "wrong_app" });
    expect(await grants(cw, cw.licenseA)).toEqual([]);
  });
});

describe("review round: StoreIdentity.ambiguous (D15)", () => {
  it("is set from the binding for the identity field, per store", async () => {
    const cw = await world({
      settings: { appStore: {}, steam: {}, play: { ...SETTINGS.play } },
    });
    let e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.identity["app-store"].ambiguous).toBe(false);
    // A second active IAP key pinned to a different bundle: the lowest id ("iap") wins.
    const r = await putOutletCredential(cw.env, cw.db, {
      product: SLUG,
      credentialId: "iap2",
      kind: "app-store-server-key",
      outletId: null,
      value: {
        keyId: "IAPKEY5678",
        issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
        p8: p8Pem(),
      },
      pin: "gg.other.app",
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.identity["app-store"]).toMatchObject({
      value: BUNDLE_ID,
      source: "assigned",
      ambiguous: true,
    });
    expect(e.identity.steam.ambiguous).toBe(false);
    expect(e.identity.play.ambiguous).toBe(false);
  });
});

describe("review round: the hooks resolve only their own store", () => {
  it("`only` reads one store's binding, the others stay off", async () => {
    const cw = await world({
      settings: { appStore: {}, steam: {}, play: { ...SETTINGS.play } },
    });
    const reads: string[] = [];
    const counting: Db = {
      ...cw.db,
      all: (sql, ...p) => (reads.push(sql), cw.db.all(sql, ...p)),
      first: (sql, ...p) => (reads.push(sql), cw.db.first(sql, ...p)),
      run: (sql, ...p) => cw.db.run(sql, ...p),
      runChanges: (sql, ...p) => cw.db.runChanges(sql, ...p),
      batch: (st) => cw.db.batch(st),
    };
    const own = () =>
      reads.filter((q) => q.includes("outlet_credentials")).length;
    await effectiveCommerceSettings(counting, SLUG);
    const all = own();
    expect(all).toBe(3);
    reads.length = 0;
    const e = await effectiveCommerceSettings(counting, SLUG, ["play"]);
    expect(own()).toBe(1);
    expect(e.settings.play?.packageName).toBe(PLAY_PACKAGE);
    expect(e.settings.appStore).toBeNull();
    expect(e.settings.steam).toBeNull();
  });

  it("the Play hook still limits per IP before the signature check, and the App Store hook reads only the App Store", async () => {
    const cw = await world({
      settings: { appStore: {}, steam: {}, play: { ...SETTINGS.play } },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++)
      statuses.push(
        (
          await route(cw, "POST", "/distribution/hooks/play-rtdn", {
            body: {},
          })
        ).status,
      );
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
    // A junk App Store delivery is a bare 401, not a not-found.
    expect((await hook(cw, "x.y.z")).status).toBe(401);
  });
});

describe("review round: the own-credential-unpinned reason", () => {
  it("an own key with no pin hides the platform pin: own_credential_unpinned, not no_app_assigned", async () => {
    const cw = await world({
      credentials: false,
      settings: { appStore: {}, steam: {} },
    });
    await setPlatformPin(cw.db, {
      id: "app-store.in-app-purchase-key",
      product: SLUG,
      pin: BUNDLE_ID,
      actor: "t",
      now: NOW,
    });
    const setup = () =>
      effectiveCommerceSettings(cw.db, SLUG).then((eff) =>
        setupOf({ env: cw.env, db: cw.db, product: { slug: SLUG } }, eff),
      );
    expect((await setup())["app-store"].reason).not.toBe("no_app_assigned");
    // An own IAP key with no pin.
    const r = await putOutletCredential(cw.env, cw.db, {
      product: SLUG,
      credentialId: "iap",
      kind: "app-store-server-key",
      outletId: null,
      value: {
        keyId: "IAPKEY1234",
        issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
        p8: p8Pem(),
      },
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    } as never);
    expect(r.ok).toBe(true);
    const s = await setup();
    expect(s["app-store"]).toMatchObject({
      configured: false,
      reason: "own_credential_unpinned",
    });
    // No platform pin for Steam and no own key: still no_app_assigned.
    expect(s.steam.reason).toBe("no_app_assigned");
  });
});

describe("review round: Play, Steam and the platform key with a derived identity", () => {
  it("Play: a push for another package is ignored wrong_app, the derived package is acted on", async () => {
    const cw = await world({
      settings: { play: { ...SETTINGS.play, packageName: undefined } },
    });
    const e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.settings.play?.packageName).toBe(PLAY_PACKAGE);
    const push = async (packageName: string, id: string) =>
      route(cw, "POST", "/distribution/hooks/play-rtdn", {
        body: cw.fakes.google.pushBody(id, {
          packageName,
          voidedPurchaseNotification: {
            purchaseToken: "tok",
            orderId: "GPA.1",
            productType: 2,
            refundType: 1,
          },
        }),
        headers: {
          authorization: `Bearer ${await cw.fakes.google.pushToken(NOW)}`,
        },
      });
    const other = await push("gg.other.app", "m-1");
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ ignored: "wrong_app" });
    const mine = await push(PLAY_PACKAGE, "m-2");
    expect(mine.status).toBe(200);
    expect(await mine.json()).not.toMatchObject({ ignored: "wrong_app" });
  });

  it("Steam: the derived app id is the one every Steam call is made for", async () => {
    const cw = await world({ settings: { steam: {} } });
    const e = await effectiveCommerceSettings(cw.db, SLUG);
    expect(e.settings.steam).toEqual({ appId: STEAM_APP });
    cw.fakes.steam.tickets.set("ab".repeat(10), {
      steamid: "76561198000000001",
      identity: await bindingOf(cw, cw.tokenA),
    });
    cw.fakes.steam.owns.set(`76561198000000001:${STEAM_DLC}`, {
      ownsapp: true,
      ownersteamid: "76561198000000001",
    });
    const res = await claim(cw, {
      store: "steam",
      ticket: "ab".repeat(10),
      dlcAppId: STEAM_DLC,
    });
    expect(res.status).toBe(200);
    expect(
      cw.fakes.steam.requests.some(
        (r) => r.url.searchParams.get("appid") === STEAM_APP,
      ),
    ).toBe(true);
    // A DLC the product does not map is refused as before.
    expect(
      (
        await claim(cw, {
          store: "steam",
          ticket: "ab".repeat(10),
          dlcAppId: "999999",
        })
      ).status,
    ).not.toBe(200);
  });

  it("an end-to-end App Store claim through the platform key: platform pin and platform credential, no own key", async () => {
    const cw = await world({
      credentials: false,
      settings: { appStore: {} },
    });
    expect(
      (
        await putPlatformCredential(cw.env, cw.db, {
          id: "app-store.in-app-purchase-key",
          value: {
            keyId: "IAPKEY9999",
            issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
            p8: p8Pem(),
          },
          actor: "t",
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    await setPlatformPin(cw.db, {
      id: "app-store.in-app-purchase-key",
      product: SLUG,
      pin: BUNDLE_ID,
      actor: "t",
      now: NOW,
    });
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
    expect(await reason(other)).toBe("wrong_app");
  });
});
