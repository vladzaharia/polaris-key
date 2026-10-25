/**
 * A-28.1: the one store-app binding read (`storeAppBinding` / `storeAppBindings`), CM-20 D12's
 * precedence per field. Own active credential first (never falls through to the team key), else
 * the platform pin; metadata only, no audit row.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { NOW, seedProduct } from "../seed.js";
import type { Db } from "../../src/db/types.js";
import {
  PLATFORM_CREDENTIALS,
  PLATFORM_STORES,
  setPlatformPin,
  storeAppBinding,
  storeAppBindings,
  type PlatformCredentialId,
} from "../../src/core/platformCredentials.js";

const P = "prod";
const Q = "other";

// One valid pin per platform slot, and a second distinct one.
const PINS: Record<PlatformCredentialId, [string, string]> = {
  "app-store.api-key": ["1234567890", "1234567891"],
  "app-store.in-app-purchase-key": ["com.example.app", "com.example.two"],
  "google-play.service-account": ["com.example.app", "com.example.two"],
  "microsoft-store.partner-center": ["9NBLGGH4NNS1", "9NBLGGH4NNS2"],
  "steam.publisher-key": ["480", "481"],
};

let db: Db;
beforeEach(async () => {
  db = makeTestDb();
  await seedProduct(db, P);
  await seedProduct(db, Q);
});

async function own(
  product: string,
  id: PlatformCredentialId,
  credentialId: string,
  opts: { pin?: string | null; status?: string } = {},
) {
  const spec = PLATFORM_CREDENTIALS[id];
  const meta = opts.pin ? JSON.stringify({ [spec.pinField]: opts.pin }) : "{}";
  await db.run(
    `INSERT INTO outlet_credentials
       (product, credential_id, kind, outlet_id, enc_value_json, meta_json, status, created_at, created_by)
     VALUES (?, ?, ?, NULL, '{}', ?, ?, ?, 'test')`,
    product,
    credentialId,
    spec.kind,
    meta,
    opts.status ?? "active",
    NOW,
  );
}

async function platform(
  product: string,
  id: PlatformCredentialId,
  pin: string,
) {
  const r = await setPlatformPin(db, {
    id,
    product,
    pin,
    actor: "t",
    now: NOW,
  });
  expect(r.ok).toBe(true);
}

const IDS = Object.keys(PLATFORM_CREDENTIALS) as PlatformCredentialId[];

describe("storeAppBinding", () => {
  it("answers an empty binding when nothing is assigned", async () => {
    for (const store of PLATFORM_STORES)
      expect(await storeAppBinding(db, P, store)).toEqual({
        store,
        fields: {},
        ambiguous: [],
      });
  });

  it.each(IDS)("%s: platform pin only -> source platform", async (id) => {
    const spec = PLATFORM_CREDENTIALS[id];
    await platform(P, id, PINS[id][0]);
    const b = await storeAppBinding(db, P, spec.store);
    expect(b.fields[spec.pinField as "appId"]).toEqual({
      value: PINS[id][0],
      source: "platform",
      credential: id,
    });
    expect(b.ambiguous).toEqual([]);
  });

  it.each(IDS)("%s: own pin beats the platform pin", async (id) => {
    const spec = PLATFORM_CREDENTIALS[id];
    await platform(P, id, PINS[id][0]);
    await own(P, id, "mine", { pin: PINS[id][1] });
    const b = await storeAppBinding(db, P, spec.store);
    expect(b.fields[spec.pinField as "appId"]).toEqual({
      value: PINS[id][1],
      source: "product-credential",
      credential: "mine",
    });
  });

  it.each(IDS)(
    "%s: an own credential without a pin does not fall through",
    async (id) => {
      const spec = PLATFORM_CREDENTIALS[id];
      await platform(P, id, PINS[id][0]);
      await own(P, id, "mine");
      const b = await storeAppBinding(db, P, spec.store);
      expect(b.fields[spec.pinField as "appId"]).toBeUndefined();
      expect(b.ambiguous).toEqual([]);
    },
  );

  it.each(IDS)(
    "%s: a disabled or revoked own credential is ignored",
    async (id) => {
      const spec = PLATFORM_CREDENTIALS[id];
      await own(P, id, "a", { pin: PINS[id][1], status: "disabled" });
      await own(P, id, "b", { pin: PINS[id][1], status: "revoked" });
      expect((await storeAppBinding(db, P, spec.store)).fields).toEqual({});
      await platform(P, id, PINS[id][0]);
      const b = await storeAppBinding(db, P, spec.store);
      expect(b.fields[spec.pinField as "appId"]?.source).toBe("platform");
    },
  );

  it.each(IDS)(
    "%s: disagreeing own pins -> lowest id wins, ambiguous",
    async (id) => {
      const spec = PLATFORM_CREDENTIALS[id];
      await own(P, id, "zeta", { pin: PINS[id][1] });
      await own(P, id, "alpha", { pin: PINS[id][0] });
      await own(P, id, "mid"); // unpinned: ignored for the value
      const b = await storeAppBinding(db, P, spec.store);
      expect(b.fields[spec.pinField as "appId"]).toEqual({
        value: PINS[id][0],
        source: "product-credential",
        credential: "alpha",
      });
      expect(b.ambiguous).toEqual([spec.pinField]);
    },
  );

  it("agreeing own pins are not ambiguous", async () => {
    const id = "steam.publisher-key";
    await own(P, id, "a", { pin: "480" });
    await own(P, id, "b", { pin: "480" });
    expect((await storeAppBinding(db, P, "steam")).ambiguous).toEqual([]);
  });

  it("App Store resolves its two fields independently", async () => {
    await own(P, "app-store.api-key", "asc", { pin: "42" });
    await platform(P, "app-store.in-app-purchase-key", "com.example.app");
    const b = await storeAppBinding(db, P, "app-store");
    expect(b.fields.appleId?.source).toBe("product-credential");
    expect(b.fields.bundleId).toEqual({
      value: "com.example.app",
      source: "platform",
      credential: "app-store.in-app-purchase-key",
    });
  });

  it("one product's pin never answers for another", async () => {
    await platform(P, "steam.publisher-key", "480");
    await own(P, "google-play.service-account", "g", {
      pin: "com.example.app",
    });
    for (const b of await storeAppBindings(db, Q)) expect(b.fields).toEqual({});
  });

  it("storeAppBindings returns every store in order", async () => {
    expect((await storeAppBindings(db, P)).map((b) => b.store)).toEqual([
      ...PLATFORM_STORES,
    ]);
  });

  it("writes no audit row", async () => {
    await platform(P, "steam.publisher-key", "480");
    await own(P, "app-store.api-key", "asc", { pin: "42" });
    const count = async () => [
      (await db.first<{ n: number }>("SELECT COUNT(*) n FROM audit"))!.n,
      (await db.first<{ n: number }>("SELECT COUNT(*) n FROM platform_audit"))!
        .n,
    ];
    const before = await count();
    await storeAppBindings(db, P);
    expect(await count()).toEqual(before);
  });
});
