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
  kem: 32,
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

  it("is 404 for the U-36.3 routes while Cloud Sync is off, and for unknown sub-paths", async () => {
    const off = await world(false);
    expect((await call(off, D1, "GET", "/recovery")).status).toBe(404);
    expect((await call(off, D1, "POST", "/reset", {})).status).toBe(404);
    expect((await call(off, D1, "POST", "/adopt", {})).status).toBe(404);
    expect((await call(w, D1, "GET", "/recoveries")).status).toBe(404);
    expect((await call(w, D1, "GET", "/recovery/x")).status).toBe(404);
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
      kem: 32,
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
      { wrap: { kem: 32, enc: "a b", ct: "ct" } },
      { wrap: { kem: "", enc: "e", ct: "c" } },
      { wrap: { kem: "x25519", enc: "e", ct: "c" } },
      { wrap: { kem: "32", enc: "e", ct: "c" } },
      { wrap: { kem: 33, enc: "e", ct: "c" } },
      { wrap: { enc: "e", ct: "c" } },
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
      kem: 32,
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

// ── Recovery, adopt and reset (U-36.3) ─────────────────────────────────────────────────────────

/** A 61-byte blob in the contract layout (version 1), distinguished by `fill`. */
const blob = (fill: number, version = 1, len = 61): string => {
  const b = new Uint8Array(len).fill(fill);
  b[0] = version;
  return Buffer.from(b).toString("base64url");
};
const REC = blob(7);
const RING2 = "rg_BBBBBBBBBBBBBBBBBBBBBB";
const KID2 = "fedcba9876543210fedcba9876543210";

const auditActions = async (db: Db) =>
  (
    await db.all<{ action: string; target_id: string; summary: string }>(
      "SELECT action, target_id, summary FROM audit WHERE action LIKE 'keyring.%' ORDER BY at, id",
    )
  ).map((r) => r.action);

describe("recovery", () => {
  it("answers 404 until a blob is set, and fetches a set one without a wrap", async () => {
    await create(w, D1, { recovery: undefined });
    expect((await call(w, D2, "GET", "/recovery")).status).toBe(404);
    expect(
      (await call(w, D1, "PUT", "/recovery", { ct: REC, epoch: 1, kid: KID }))
        .status,
    ).toBe(204);
    // D2 holds no wrap and still fetches: it is the device with no root.
    const r = await call(w, D2, "GET", "/recovery");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ct: REC, epoch: 1, kid: KID });
  });

  it("audits every fetch and write, with no blob in the row", async () => {
    await create(w);
    await call(w, D1, "PUT", "/recovery", { ct: REC, epoch: 1, kid: KID });
    await call(w, D2, "GET", "/recovery");
    expect((await auditActions(w.db)).sort()).toEqual([
      "keyring.recovery.fetch",
      "keyring.recovery.set",
    ]);
    const rows = await w.db.all<Record<string, unknown>>(
      "SELECT * FROM audit WHERE action LIKE 'keyring.%'",
    );
    expect(JSON.stringify(rows)).not.toContain(REC);
    expect(
      rows.find((r) => r.action === "keyring.recovery.fetch")?.target_id,
    ).toBe(D2);
  });

  it("limits the fetch to 5 a day per device and 5 per subject, and the device count includes a not-set answer", async () => {
    await create(w);
    await call(w, D1, "PUT", "/recovery", { ct: REC, epoch: 1, kid: KID });
    const limited: string[] = [];
    // The test env's limiter is the real Durable Object stand-in. The device budget is D2's own;
    // the subject budget is shared by every device of the account.
    for (let i = 0; i < 6; i++)
      limited.push(String((await call(w, D2, "GET", "/recovery")).status));
    expect(limited).toEqual(["200", "200", "200", "200", "200", "429"]);
    expect((await call(w, D1, "GET", "/recovery")).status).toBe(429);
    expect(
      (await call(w, D2, "GET", "/recovery", undefined, NOW + 86_401)).status,
    ).toBe(200);
  });

  it("counts the subject budget only for a fetch that returns a blob", async () => {
    await create(w, D1, { recovery: undefined });
    // Nothing is set: four probes find nothing and spend none of the subject budget.
    for (let i = 0; i < 4; i++)
      expect((await call(w, D1, "GET", "/recovery")).status).toBe(404);
    await call(w, D1, "PUT", "/recovery", { ct: REC, epoch: 1, kid: KID });
    // Under a count-everything rule the subject would have 1 left; here all 5 real fetches work.
    const got: string[] = [];
    for (let i = 0; i < 6; i++)
      got.push(String((await call(w, D2, "GET", "/recovery")).status));
    expect(got).toEqual(["200", "200", "200", "200", "200", "429"]);
  });

  it("emails the account on a fetch, a write and a reset, saying no one asks for the code", async () => {
    const sent: { subject: string; text: string }[] = [];
    w.env.EMAIL = {
      send: async (m: { subject: string; text: string }) => {
        sent.push(m);
      },
    } as unknown as Env["EMAIL"];
    await create(w);
    await call(w, D1, "PUT", "/recovery", { ct: REC, epoch: 1, kid: KID });
    await call(w, D2, "GET", "/recovery");
    await call(w, D1, "POST", "/reset", {
      ringId: RING2,
      rootKid: KID2,
      wrap: wrapOf("9"),
    });
    expect(sent.map((m) => m.subject)).toEqual([
      expect.stringMatching(/recovery code changed/i),
      expect.stringMatching(/^Recovery started on /),
      expect.stringMatching(/encryption was reset/i),
    ]);
    expect(sent[0]!.text).toContain(
      "No one will ask you for your recovery code.",
    );
    expect(sent[1]!.text).toContain(
      "No one will ask you for your recovery code.",
    );
    expect(JSON.stringify(sent)).not.toContain(REC);
  });

  it("checks the blob layout, the epoch and kid, and who may write", async () => {
    await create(w);
    const put = (body: unknown, d = D1) => call(w, d, "PUT", "/recovery", body);
    const ok = { ct: REC, epoch: 1, kid: KID };
    expect((await put({ ...ok, ct: blob(7, 2) })).status).toBe(400);
    expect((await put({ ...ok, ct: blob(7, 1, 60) })).status).toBe(400);
    expect((await put({ ...ok, ct: blob(7, 1, 62) })).status).toBe(400);
    expect((await put({ ...ok, ct: "rec" })).status).toBe(400);
    expect((await put({ ...ok, ct: `${REC}=` })).status).toBe(400);
    expect((await put({ ...ok, epoch: 0 })).status).toBe(400);
    expect((await put({ ...ok, kid: "nope" })).status).toBe(400);
    expect((await put({ ...ok, epoch: 2 })).status).toBe(409);
    expect((await put({ ...ok, kid: KID2 })).status).toBe(409);
    // D2 holds no wrap, so it cannot seal.
    expect((await put(ok, D2)).status).toBe(403);
    expect((await put(ok)).status).toBe(204);
    expect(await auditActions(w.db)).toEqual(["keyring.recovery.set"]);
  });

  it("is 409 for a subject with no ring and 405 for other methods", async () => {
    expect(
      (await call(w, D1, "PUT", "/recovery", { ct: REC, epoch: 1, kid: KID }))
        .status,
    ).toBe(403);
    expect((await call(w, D1, "DELETE", "/recovery")).status).toBe(405);
    expect((await call(w, D1, "POST", "/recovery", {})).status).toBe(405);
  });

  it("needs a live device token and a signed-in subject", async () => {
    await create(w);
    expect((await call(w, null, "GET", "/recovery")).status).toBe(401);
    await addDevice(w, D3, null);
    expect((await call(w, D3, "GET", "/recovery")).status).toBe(403);
    expect(
      (await call(w, D3, "PUT", "/recovery", { ct: REC, epoch: 1, kid: KID }))
        .status,
    ).toBe(403);
  });
});

describe("reset", () => {
  const reset = (d = D1, over: Record<string, unknown> = {}) =>
    call(w, d, "POST", "/reset", {
      ringId: RING2,
      rootKid: KID2,
      wrap: wrapOf("9"),
      recovery: { ct: REC },
      ...over,
    });

  it("replaces the ring, keeps the old one 30 days, audits and drops the old wraps from view", async () => {
    await create(w);
    await putWrap(w, D1, D2);
    const r = await reset();
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ringId: RING2, epoch: 1 });
    const ring = (await call(w, D1, "GET", "")).body;
    expect(ring.ring.ringId).toBe(RING2);
    expect(ring.ring.rootKid).toBe(KID2);
    expect(ring.ring.recovery.set).toBe(true);
    expect(ring.ring.previous).toEqual({
      ringId: RING,
      kid: KID,
      until: NOW + 30 * 86_400,
    });
    expect(ring.wrap.kid).toBe(KID2);
    // D2's wrap was for the old ring: not served for the new one.
    expect((await call(w, D2, "GET", "")).body.wrap).toBeNull();
    expect(await auditActions(w.db)).toEqual(["keyring.reset"]);
  });

  it("needs no wrap (start over), but a ring, a new id and keys", async () => {
    await create(w);
    // D2 holds no wrap: it can still reset.
    expect((await reset(D2)).status).toBe(201);
    expect((await reset(D2)).status).toBe(409); // same ringId as the current one
    const none = await world();
    expect(
      (
        await call(none, D1, "POST", "/reset", {
          ringId: RING2,
          rootKid: KID2,
          wrap: wrapOf("9"),
        })
      ).status,
    ).toBe(409);
  });

  it("refuses a ring id the subject already had: the current, the previous, an adopted one", async () => {
    const RING3 = "rg_CCCCCCCCCCCCCCCCCCCCCC";
    await create(w);
    expect((await reset(D1)).status).toBe(201); // RING -> RING2
    // RING is now the previous ring: not reusable, and nothing changes.
    const back = await reset(D1, { ringId: RING });
    expect(back.status).toBe(409);
    expect(back.body).toMatchObject({ error: { code: "keyring_conflict" } });
    const { ring } = (await call(w, D1, "GET", "")).body;
    expect(ring.ringId).toBe(RING2);
    expect(ring.previous.ringId).toBe(RING);
    // Adopt the previous root, then replace again: RING is no longer previous, but the store still
    // holds it as an adopted root, so it stays refused. RING2 is previous now.
    expect(
      (
        await call(w, D1, "POST", "/adopt", {
          fromRingId: RING,
          epoch: 1,
          kid: KID,
          ct: blob(5),
        })
      ).status,
    ).toBe(204);
    expect((await reset(D1, { ringId: RING3 })).status).toBe(201);
    expect((await reset(D1, { ringId: RING })).status).toBe(409);
    expect((await reset(D1, { ringId: RING2 })).status).toBe(409);
    expect((await reset(D1, { ringId: RING3 })).status).toBe(409);
    expect((await call(w, D1, "GET", "")).body.ring.ringId).toBe(RING3);
  });

  it("checks the body and the recovery blob layout", async () => {
    await create(w);
    expect((await reset(D1, { ringId: "x" })).status).toBe(400);
    expect((await reset(D1, { rootKid: "x" })).status).toBe(400);
    expect((await reset(D1, { wrap: {} })).status).toBe(400);
    expect((await reset(D1, { recovery: { ct: "rec" } })).status).toBe(400);
    expect((await reset(D1, { recovery: { ct: blob(7, 3) } })).status).toBe(
      400,
    );
    expect((await reset(D1, { recovery: undefined })).status).toBe(201);
    expect((await call(w, D1, "GET", "")).body.ring.recovery.set).toBe(false);
  });
});

describe("adopt", () => {
  const adopt = (d: string, over: Record<string, unknown> = {}) =>
    call(w, d, "POST", "/adopt", {
      fromRingId: RING,
      epoch: 1,
      kid: KID,
      ct: blob(5),
      ...over,
    });

  async function afterReset() {
    await create(w);
    expect(
      (
        await call(w, D1, "POST", "/reset", {
          ringId: RING2,
          rootKid: KID2,
          wrap: wrapOf("9"),
        })
      ).status,
    ).toBe(201);
  }

  it("stores the previous root sealed under the new one, once", async () => {
    await afterReset();
    expect((await adopt(D1)).status).toBe(204);
    expect((await adopt(D1, { ct: blob(6) })).status).toBe(204);
    const { ring } = (await call(w, D1, "GET", "")).body;
    expect(ring.adopted).toEqual([
      { ringId: RING, epoch: 1, kid: KID, ct: blob(5) },
    ]);
  });

  it("refuses a root the server does not name, an expired previous ring, and non-holders", async () => {
    await afterReset();
    expect(
      (await adopt(D1, { fromRingId: "rg_CCCCCCCCCCCCCCCCCCCCCC" })).status,
    ).toBe(409);
    expect((await adopt(D1, { kid: KID2 })).status).toBe(409);
    expect((await adopt(D2)).status).toBe(403);
    expect(
      (
        await call(
          w,
          D1,
          "POST",
          "/adopt",
          {
            fromRingId: RING,
            epoch: 1,
            kid: KID,
            ct: blob(5),
          },
          NOW + 31 * 86_400,
        )
      ).status,
    ).toBe(409);
  });

  it("checks the blob layout and the members", async () => {
    await afterReset();
    expect((await adopt(D1, { ct: blob(5, 2) })).status).toBe(400);
    expect((await adopt(D1, { ct: blob(5, 1, 60) })).status).toBe(400);
    expect((await adopt(D1, { fromRingId: "x" })).status).toBe(400);
    expect((await adopt(D1, { epoch: 0 })).status).toBe(400);
    expect((await adopt(D1, { kid: "x" })).status).toBe(400);
    expect((await call(w, D1, "GET", "/adopt")).status).toBe(405);
  });

  it("completes a merge candidate", async () => {
    await create(w);
    await w.db.run(
      "INSERT INTO keyring_adopted (product, subject, ring_id, epoch, kid, ct, created_at) VALUES (?, ?, ?, 1, ?, NULL, ?)",
      P,
      w.subject,
      RING2,
      KID2,
      NOW,
    );
    expect((await adopt(D1, { fromRingId: RING2, kid: KID2 })).status).toBe(
      204,
    );
    expect((await call(w, D1, "GET", "")).body.ring.adopted[0].ct).toBe(
      blob(5),
    );
  });
});
