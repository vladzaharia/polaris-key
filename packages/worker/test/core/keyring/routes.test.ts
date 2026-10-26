/// <reference types="@cloudflare/workers-types" />
// The key ring routes, part I (U-36.2): GET, POST, and the wraps PUT and DELETE, through the real
// router. Fake values only: the server never opens a wrap.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../../seed.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { loadProduct } from "../../../src/core/products.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { setDeviceStatus } from "../../../src/core/devices/store.js";
import { getRing } from "../../../src/core/keyring/store.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";

const P = "djdl";
const RING = "rg_AAAAAAAAAAAAAAAAAAAAAA";
const KID = "0123456789abcdef0123456789abcdef";
const D1 = "dev-ring-1";
const D2 = "dev-ring-2";
const D3 = "dev-ring-3";
const wrapOf = (tag: string) => ({
  kem: "x25519",
  enc: `enc${tag}`,
  ct: `ct${tag}`,
});

interface World {
  db: Db;
  env: Env;
  key: string;
  tokens: Record<string, string>;
  subject: string;
}

async function enable(db: Db, sync: boolean): Promise<void> {
  const on = (enabled: boolean) => ({ enabled });
  await setServices(
    db,
    P,
    serializeServices({
      services: {
        license: on(true),
        config: on(true),
        release: on(false),
        distribution: on(false),
        update: on(false),
        identity: on(true),
        sync: on(sync),
        commerce: on(false),
        connect: on(false),
      },
    }),
    "manifest",
    NOW,
  );
}

/** Sign the email in and bind its pairwise subject to the device. */
async function bindSubject(w: World, id: string, email: string) {
  const who = { issuerKey: "email", subject: email, kind: "email" } as const;
  const r = await signIn(w.db, who, NOW, {
    unfenced: true,
    product: { slug: P },
  });
  if (r.status !== "signed_in") throw new Error(`sign-in ${r.status}`);
  const subject = r.subject!;
  expect(await setDeviceSubject(w.env, w.db, P, id, subject)).toBe(true);
  return subject;
}

async function addDevice(w: World, id: string, email: string | null) {
  const product = (await loadProduct(w.env, w.db, P))!;
  const res = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${w.key}`, "x-pkey-device": id }),
    w.env,
    w.db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  w.tokens[id] = ((await res.json()) as { token: string }).token;
  if (email) w.subject = await bindSubject(w, id, email);
  const k = await newKeys();
  await upsertDeviceKeys(w.db, P, id, k, NOW);
}

async function world(sync = true): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  await seedProduct(db, P);
  await enable(db, sync);
  const { key } = await seedLicenseWithKey(db, P);
  const w: World = { db, env, key, tokens: {}, subject: "" };
  await addDevice(w, D1, "ada@example.com");
  await addDevice(w, D2, "ada@example.com");
  return w;
}

async function call(
  w: World,
  device: string | null,
  method: string,
  path: string,
  body?: unknown,
  now = NOW,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (device) headers.authorization = `Bearer ${w.tokens[device]}`;
  const res = await dispatchWith(
    new Request(`https://key.plrs.im/${P}/devices/keyring${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    w.env,
    w.db,
    now,
  );
  const text = await res.text();
  // The shared plain-text 405 sets no cache header.
  if (res.status !== 405)
    expect(res.headers.get("cache-control")).toBe("no-store");
  return {
    status: res.status,
    body: text.startsWith("{") ? JSON.parse(text) : text,
  };
}

const create = (w: World, device = D1, over: Record<string, unknown> = {}) =>
  call(w, device, "POST", "", {
    ringId: RING,
    rootKid: KID,
    wrap: wrapOf("1"),
    recovery: { ct: "rec" },
    ...over,
  });
const putWrap = (w: World, device: string, target: string, over = {}) =>
  call(w, device, "PUT", `/wraps/${target}`, {
    epoch: 1,
    kid: KID,
    ...wrapOf(target),
    ...over,
  });

let w: World;
beforeEach(async () => {
  w = await world();
});

describe("availability", () => {
  it("is 404 while Cloud Sync is off", async () => {
    const off = await world(false);
    expect((await call(off, D1, "GET", "")).status).toBe(404);
    expect((await create(off)).status).toBe(404);
  });

  it("is 404 when the catalog is in server mode, 200 in e2e and by default", async () => {
    const put = (mode: string | null) =>
      w.db.run(
        "INSERT OR REPLACE INTO product_schema (product, catalog_version, catalog_json, active, created_at) VALUES (?, 1, ?, 1, ?)",
        P,
        JSON.stringify({
          schemaVersion: 1,
          cloudSync: mode === null ? {} : { encryption: mode },
        }),
        NOW,
      );
    expect((await call(w, D1, "GET", "")).status).toBe(200);
    await put("server");
    expect((await call(w, D1, "GET", "")).status).toBe(404);
    await put("e2e");
    expect((await call(w, D1, "GET", "")).status).toBe(200);
    await put(null);
    expect((await call(w, D1, "GET", "")).status).toBe(200);
  });

  it("does not reach routes U-36.3 owns", async () => {
    expect((await call(w, D1, "GET", "/recovery")).status).toBe(404);
    expect((await call(w, D1, "POST", "/reset", {})).status).toBe(404);
  });

  it("refuses the wrong method with 405", async () => {
    expect((await call(w, D1, "DELETE", "")).status).toBe(405);
    expect((await call(w, D1, "GET", `/wraps/${D1}`)).status).toBe(405);
  });
});

describe("credentials", () => {
  it("needs a live device token", async () => {
    expect((await call(w, null, "GET", "")).status).toBe(401);
    w.tokens.junk = "pkeyt_nope";
    expect((await call(w, "junk", "GET", "")).status).toBe(401);
    await setDeviceStatus(w.db, P, D1, "deauthorized", { now: NOW });
    expect((await call(w, D1, "GET", "")).status).toBe(401);
  });

  it("needs a signed-in subject", async () => {
    await addDevice(w, D3, null);
    const r = await call(w, D3, "GET", "");
    expect(r).toEqual({
      status: 403,
      body: { error: { code: "account_required" } },
    });
    expect((await create(w, D3)).status).toBe(403);
  });
});

describe("GET and POST", () => {
  it("answers an empty ring, then the created one with the creator's wrap", async () => {
    expect((await call(w, D1, "GET", "")).body).toEqual({
      ring: null,
      wrap: null,
    });
    const c = await create(w);
    expect(c).toEqual({ status: 201, body: { ringId: RING, epoch: 1 } });
    const g = await call(w, D1, "GET", "");
    expect(g.body.ring).toMatchObject({
      ringId: RING,
      epoch: 1,
      rootKid: KID,
      state: "active",
      createdAt: NOW,
      recovery: { set: true, createdAt: NOW },
      adopted: [],
    });
    expect(g.body.ring.previous).toBeUndefined();
    expect(g.body.wrap).toEqual({
      epoch: 1,
      kid: KID,
      kem: "x25519",
      enc: "enc1",
      ct: "ct1",
      by: D1,
    });
    // The other device sees the ring and no wrap.
    expect((await call(w, D2, "GET", "")).body.wrap).toBeNull();
  });

  it("refuses a second ring with 409 keyring_conflict and writes nothing", async () => {
    await create(w);
    const again = await create(w, D2, { ringId: "rg_BBBBBBBBBBBBBBBBBBBBBB" });
    expect(again).toEqual({
      status: 409,
      body: { error: { code: "keyring_conflict" } },
    });
    expect((await getRing(w.db, P, w.subject))?.ringId).toBe(RING);
    expect((await call(w, D2, "GET", "")).body.wrap).toBeNull();
  });

  it("refuses malformed bodies with 400", async () => {
    for (const over of [
      { ringId: "rg_short" },
      { rootKid: "ABC" },
      { wrap: { kem: "x25519", enc: "a b", ct: "ct" } },
      { wrap: { kem: "", enc: "e", ct: "c" } },
      { wrap: "x" },
      { recovery: { ct: "bad ct" } },
      { recovery: 1 },
    ])
      expect((await create(w, D1, over)).status).toBe(400);
    const res = await dispatchWith(
      new Request(`https://key.plrs.im/${P}/devices/keyring`, {
        method: "POST",
        headers: { authorization: `Bearer ${w.tokens[D1]}` },
        body: "[",
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(400);
    expect(await getRing(w.db, P, w.subject)).toBeNull();
  });

  it("caps the body", async () => {
    const r = await create(w, D1, {
      wrap: { ...wrapOf("1"), ct: "A".repeat(5000) },
    });
    expect(r.status).toBe(413);
  });

  it("serves no wrap that predates the device's current keys", async () => {
    await create(w);
    await upsertDeviceKeys(w.db, P, D1, await newKeys(), NOW + 100);
    // The lifecycle listener normally drops the row; plant it again to model its failure.
    await w.db.run(
      `INSERT OR IGNORE INTO keyring_wraps
         (product, subject, device_id, ring_id, epoch, kid, kem, enc, ct, by_device, created_at)
       VALUES (?, ?, ?, ?, 1, ?, 'x25519', 'old', 'old', ?, ?)`,
      P,
      w.subject,
      D1,
      RING,
      KID,
      D1,
      NOW,
    );
    expect(
      (await call(w, D1, "GET", "", undefined, NOW + 200)).body.wrap,
    ).toBeNull();
  });

  it("serves no wrap row left by another subject", async () => {
    await create(w);
    await addDevice(w, D3, "grace@example.com");
    // A stale row under D3 for ada's ring (the unbind listener failed).
    await w.db.run(
      `INSERT INTO keyring_wraps
         (product, subject, device_id, ring_id, epoch, kid, kem, enc, ct, by_device, created_at)
       VALUES (?, ?, ?, ?, 1, ?, 'x25519', 'stale', 'stale', ?, ?)`,
      P,
      w.subject,
      D3,
      RING,
      KID,
      D1,
      NOW,
    );
    const g = await call(w, D3, "GET", "");
    expect(g.body).toEqual({ ring: null, wrap: null });
  });
});

describe("wraps", () => {
  beforeEach(async () => {
    await create(w);
  });

  it("lets the holder wrap to another device of the subject, who then reads it", async () => {
    expect((await putWrap(w, D1, D2)).status).toBe(204);
    const g = await call(w, D2, "GET", "");
    expect(g.body.wrap).toEqual({
      epoch: 1,
      kid: KID,
      kem: "x25519",
      enc: `enc${D2}`,
      ct: `ct${D2}`,
      by: D1,
    });
  });

  it("is create-only", async () => {
    await putWrap(w, D1, D2);
    const again = await putWrap(w, D1, D2, { ct: "other" });
    expect(again).toEqual({
      status: 409,
      body: { error: { code: "keyring_conflict" } },
    });
    expect((await call(w, D2, "GET", "")).body.wrap.ct).toBe(`ct${D2}`);
  });

  it("refuses a depositor that holds no root", async () => {
    await addDevice(w, D3, "ada@example.com");
    const r = await putWrap(w, D2, D3);
    expect(r).toEqual({ status: 403, body: { error: { code: "forbidden" } } });
  });

  it("lets a device store a wrap for itself", async () => {
    expect((await putWrap(w, D2, D2)).status).toBe(204);
    expect((await call(w, D2, "GET", "")).body.wrap.by).toBe(D2);
  });

  it("answers one 404 for a target that is another subject's, unknown, keyless or gone", async () => {
    await addDevice(w, D3, "grace@example.com");
    expect((await putWrap(w, D1, D3)).status).toBe(404);
    expect((await putWrap(w, D1, "no-such-device")).status).toBe(404);
    expect((await putWrap(w, D1, "bad id")).status).toBe(404);
    await w.db.run(
      "DELETE FROM device_keys WHERE product = ? AND device_id = ?",
      P,
      D2,
    );
    expect((await putWrap(w, D1, D2)).status).toBe(404);
    await upsertDeviceKeys(w.db, P, D2, await newKeys(), NOW);
    await setDeviceStatus(w.db, P, D2, "deauthorized", { now: NOW });
    expect((await putWrap(w, D1, D2)).status).toBe(404);
  });

  it("refuses a stale epoch or another kid with 409, and a malformed body with 400", async () => {
    expect((await putWrap(w, D1, D2, { epoch: 2 })).status).toBe(409);
    expect((await putWrap(w, D1, D2, { kid: "f".repeat(32) })).status).toBe(
      409,
    );
    expect((await putWrap(w, D1, D2, { epoch: 0 })).status).toBe(400);
    expect((await putWrap(w, D1, D2, { epoch: "1" })).status).toBe(400);
    expect((await putWrap(w, D1, D2, { kid: "nope" })).status).toBe(400);
    expect((await putWrap(w, D1, D2, { enc: "" })).status).toBe(400);
    expect((await call(w, D2, "GET", "")).body.wrap).toBeNull();
  });

  it("answers 409 for a subject with no ring", async () => {
    await addDevice(w, D3, "grace@example.com");
    await addDevice(w, "dev-ring-4", "grace@example.com");
    // D3 holds no wrap; a self wrap with no ring is a conflict, not a write.
    expect((await putWrap(w, D3, D3)).status).toBe(409);
  });

  it("removes only the caller's own wrap, idempotently", async () => {
    await putWrap(w, D1, D2);
    expect((await call(w, D1, "DELETE", `/wraps/${D2}`)).status).toBe(403);
    expect((await call(w, D2, "GET", "")).body.wrap).not.toBeNull();
    expect((await call(w, D2, "DELETE", `/wraps/${D2}`)).status).toBe(204);
    expect((await call(w, D2, "DELETE", `/wraps/${D2}`)).status).toBe(204);
    expect((await call(w, D2, "GET", "")).body.wrap).toBeNull();
  });

  it("drops a wrap when the device's keys change (R-7)", async () => {
    await putWrap(w, D1, D2);
    const { notifyDeviceChange } =
      await import("../../../src/core/devices/lifecycle.js");
    await notifyDeviceChange(
      { db: w.db, env: w.env, now: NOW + 5 } as never,
      { kind: "keys", product: P, deviceId: D2 } as never,
    );
    expect((await call(w, D2, "GET", "")).body.wrap).toBeNull();
  });
});
