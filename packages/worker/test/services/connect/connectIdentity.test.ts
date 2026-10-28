/**
 * CC-06.1: `GET /<p>/connect/identity` and `/devices` (WIRE-CONTRACT-V5 §15.3, §15.4, §15.9): the
 * roster and certificate the Worker signs, the epoch and K_disc that follow the members, the
 * principal rule, the subject store and the roster lifetime guard.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import { RING_SECONDS } from "@polaris-key/protocol/connect";
import { dispatchWith } from "../../../src/dispatch.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  TEST_KID,
  TEST_PUB,
} from "../../seed.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { serializeServices } from "../../../src/core/services.js";
import { setServices } from "../../../src/core/products/store.js";
import { loadProduct } from "../../../src/core/products.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { assertConnectDoc } from "../../../src/core/signing.js";
import {
  currentRing,
  getRing,
  membersHash,
  PREV_DISC_KEY_SECONDS,
} from "../../../src/services/connect/ring.js";
import { connectRingsStore } from "../../../src/services/connect/subjectStore.js";
import { connectProductDeletion } from "../../../src/services/connect/productDeletion.js";

const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const OTHER = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

interface World {
  db: Db;
  env: Env;
  subject: string;
  tokens: Record<string, string>;
}

const SERVICE_SLUGS = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
  "commerce",
  "connect",
] as const;

/** Exactly these services on, every other off. */
async function enable(db: Db, on: readonly string[]): Promise<void> {
  const services = Object.fromEntries(
    SERVICE_SLUGS.map((k) => [k, { enabled: on.includes(k) }]),
  );
  await setServices(
    db,
    SLUG,
    serializeServices({ services } as never),
    "manifest",
    NOW,
  );
}

async function activate(
  w: Pick<World, "db" | "env">,
  key: string,
  deviceId: string,
): Promise<string> {
  const product = (await loadProduct(w.env, w.db, SLUG))!;
  const headers = { authorization: `Bearer ${key}`, "x-pkey-device": deviceId };
  const res = await handleActivate(
    mkReq("POST", headers),
    w.env,
    w.db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function bindTo(
  w: Pick<World, "db" | "env">,
  deviceId: string,
  email: string,
): Promise<string> {
  const who = { issuerKey: "email", subject: email, kind: "email" } as const;
  const opts = { unfenced: true as const, product: { slug: SLUG } };
  const r = await signIn(w.db, who, NOW, opts);
  if (r.status !== "signed_in") throw new Error(r.status);
  const bound = await setDeviceSubject(w.env, w.db, SLUG, deviceId, r.subject!);
  expect(bound).toBe(true);
  return r.subject!;
}

/** Devices A and B of one person, both with keys. C and OTHER are added by tests. */
async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  await seedProduct(db, SLUG);
  await enable(db, ["license", "identity", "connect"]);
  const { key } = await seedLicenseWithKey(db, SLUG);
  const w = { db, env, tokens: {} as Record<string, string> };
  for (const d of [A, B]) w.tokens[d] = await activate(w, key, d);
  const subject = await bindTo(w, A, "ada@example.com");
  await bindTo(w, B, "ada@example.com");
  for (const d of [A, B])
    await upsertDeviceKeys(db, SLUG, d, await newKeys(), NOW);
  return { ...w, subject };
}

const get = (
  w: Pick<World, "db" | "env">,
  path: string,
  deviceId: string | null,
  token: string | null,
  now = NOW,
) =>
  dispatchWith(
    new Request(`${BASE}/${SLUG}/connect/${path}`, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(deviceId ? { "x-pkey-device": deviceId } : {}),
      },
    }) as unknown as Request,
    w.env,
    w.db,
    now,
  );

interface Identity {
  ring: string;
  certificate: string;
  discKeys: string[];
}

const trust = { [TEST_KID]: TEST_PUB };

async function identity(w: World, deviceId = A, now = NOW): Promise<Identity> {
  const res = await get(w, "identity", deviceId, w.tokens[deviceId]!, now);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as Identity;
}

describe("GET /<p>/connect/identity", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("signs the roster of the person's devices and the caller's certificate at the ring's epoch", async () => {
    const id = await identity(w);
    const ring = await verifyJws<Record<string, unknown>>(id.ring, trust, {
      typ: "pkey-ring+jws",
    });
    const cert = await verifyJws<Record<string, unknown>>(
      id.certificate,
      trust,
      { typ: "pkey-peer+jws" },
    );
    expect(ring?.payload).toMatchObject({
      iss: "key.plrs.im",
      aud: SLUG,
      sub: w.subject,
      epoch: 1,
      issuedAt: NOW,
      expiresAt: NOW + RING_SECONDS,
    });
    const devices = (ring!.payload.devices as { deviceId: string }[]).map(
      (d) => d.deviceId,
    );
    expect(devices).toEqual([A, B]);
    const mine = (ring!.payload.devices as Record<string, string>[]).find(
      (d) => d.deviceId === A,
    )!;
    expect(cert?.payload).toMatchObject({
      aud: SLUG,
      sub: w.subject,
      deviceId: A,
      signKey: mine.signKey,
      agreeKey: mine.agreeKey,
      ringEpoch: 1,
      issuedAt: NOW,
      expiresAt: NOW + 604_800,
    });
    expect(id.discKeys).toHaveLength(1);
    expect(id.discKeys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("keeps the epoch and K_disc while the members are unchanged, and gives both devices the same", async () => {
    const a = await identity(w, A);
    const b = await identity(w, B, NOW + 60);
    expect(b.discKeys).toEqual(a.discKeys);
    const row = await getRing(w.db, SLUG, w.subject);
    expect(row?.epoch).toBe(1);
  });

  it("bumps the epoch and rotates K_disc when a device joins, delivering the old key for 24 h", async () => {
    const first = await identity(w);
    const { key } = await seedLicenseWithKey(w.db, SLUG, { id: "lic_x" }).then(
      (r) => r,
    );
    w.tokens[C] = await activate(w, key, C);
    await bindTo(w, C, "ada@example.com");
    await upsertDeviceKeys(w.db, SLUG, C, await newKeys(), NOW);
    const next = await identity(w, A, NOW + 10);
    const ring = await verifyJws<{ epoch: number; devices: unknown[] }>(
      next.ring,
      trust,
      { typ: "pkey-ring+jws" },
    );
    expect(ring?.payload.epoch).toBe(2);
    expect(ring?.payload.devices).toHaveLength(3);
    expect(next.discKeys).toHaveLength(2);
    expect(next.discKeys[1]).toBe(first.discKeys[0]);
    expect(next.discKeys[0]).not.toBe(first.discKeys[0]);
    const later = await identity(w, A, NOW + 10 + PREV_DISC_KEY_SECONDS);
    expect(later.discKeys).toEqual([next.discKeys[0]]);
  });

  it("bumps the epoch when a device rotates its keys or leaves, and never lowers it", async () => {
    await identity(w);
    await upsertDeviceKeys(w.db, SLUG, B, await newKeys(), NOW + 5, NOW + 5);
    const rotated = await identity(w, A, NOW + 10);
    const r2 = await verifyJws<{ epoch: number }>(rotated.ring, trust, {
      typ: "pkey-ring+jws",
    });
    expect(r2?.payload.epoch).toBe(2);
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
      SLUG,
      B,
    );
    const left = await identity(w, A, NOW + 20);
    const r3 = await verifyJws<{ epoch: number; devices: unknown[] }>(
      left.ring,
      trust,
      { typ: "pkey-ring+jws" },
    );
    expect(r3?.payload.epoch).toBe(3);
    expect(r3?.payload.devices).toHaveLength(1);
  });

  it("never includes another person's devices", async () => {
    const { key } = await seedLicenseWithKey(w.db, SLUG, { id: "lic_y" });
    w.tokens[OTHER] = await activate(w, key, OTHER);
    await bindTo(w, OTHER, "grace@example.com");
    await upsertDeviceKeys(w.db, SLUG, OTHER, await newKeys(), NOW);
    const id = await identity(w);
    const ring = await verifyJws<{ devices: { deviceId: string }[] }>(
      id.ring,
      trust,
      { typ: "pkey-ring+jws" },
    );
    expect(ring?.payload.devices.map((d) => d.deviceId)).toEqual([A, B]);
    const theirs = await identity(w, OTHER);
    expect(theirs.discKeys).not.toEqual(id.discKeys);
  });

  it("refuses a missing or foreign token, and a header that is missing or names another device", async () => {
    expect((await get(w, "identity", A, null)).status).toBe(401);
    expect(
      (await get(w, "identity", A, "pkeyt_" + "x".repeat(43))).status,
    ).toBe(401);
    expect((await get(w, "identity", null, w.tokens[A]!)).status).toBe(400);
    expect((await get(w, "identity", B, w.tokens[A]!)).status).toBe(401);
  });

  it("answers 409 device_keys_required for a device with no keys", async () => {
    await w.db.run("DELETE FROM device_keys WHERE device_id = ?", A);
    const res = await get(w, "identity", A, w.tokens[A]!);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "device_keys_required" },
    });
  });

  it("answers 403 account_required for a device with no signed-in account", async () => {
    await w.db.run(
      "UPDATE devices SET subject = NULL WHERE product = ? AND device_id = ?",
      SLUG,
      A,
    );
    const res = await get(w, "identity", A, w.tokens[A]!);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "account_required",
    );
  });

  it("is off when the service is off: the not-found", async () => {
    await enable(w.db, ["license", "identity"]);
    expect((await get(w, "identity", A, w.tokens[A]!)).status).toBe(404);
  });

  it("answers only GET", async () => {
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/connect/identity`, {
        method: "POST",
        headers: { authorization: `Bearer ${w.tokens[A]}`, "x-pkey-device": A },
      }) as unknown as Request,
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(405);
  });
});

describe("GET /<p>/connect/devices", () => {
  it("lists the person's devices with display data and no key", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE devices SET label = 'Studio Mac' WHERE product = ? AND device_id = ?",
      SLUG,
      A,
    );
    const res = await get(w, "devices", A, w.tokens[A]!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devices: Record<string, unknown>[];
    };
    expect(body.devices.map((d) => [d.deviceId, d.self])).toEqual([
      [A, true],
      [B, false],
    ]);
    expect(body.devices[0]).toMatchObject({ label: "Studio Mac" });
    expect(JSON.stringify(body)).not.toMatch(/signKey|agreeKey/);
  });
});

describe("the roster lifetime guard", () => {
  const dev = { deviceId: A, signKey: "", agreeKey: "" };
  it("refuses a roster whose span is not 1..RING_SECONDS at the signer", async () => {
    const k = await newKeys();
    dev.signKey = k.signKey;
    dev.agreeKey = k.agreeKey;
    const doc = (issuedAt: number, expiresAt: number) => ({
      iss: "key.plrs.im",
      aud: SLUG,
      sub: "ps_" + "A".repeat(22),
      epoch: 1,
      issuedAt,
      expiresAt,
      devices: [dev],
    });
    expect(() =>
      assertConnectDoc(doc(100, 100 + RING_SECONDS), "pkey-ring+jws"),
    ).not.toThrow();
    expect(() =>
      assertConnectDoc(doc(100, 101), "pkey-ring+jws"),
    ).not.toThrow();
    expect(() => assertConnectDoc(doc(100, 100), "pkey-ring+jws")).toThrow();
    expect(() => assertConnectDoc(doc(100, 99), "pkey-ring+jws")).toThrow();
    expect(() =>
      assertConnectDoc(doc(100, 101 + RING_SECONDS), "pkey-ring+jws"),
    ).toThrow();
  });
});

describe("the connect.rings subject store", () => {
  it("merges (drops the absorbed row), exports and deletes", async () => {
    const w = await world();
    await identity(w);
    const ctx = { db: w.db, env: w.env, now: NOW };
    const other = "ps_" + "B".repeat(22);
    await w.db.run(
      `INSERT INTO connect_rings (product, subject, epoch, members_hash, disc_key, bumped_at)
       VALUES (?, ?, 3, 'h', 'k', ?)`,
      SLUG,
      other,
      NOW,
    );
    await connectRingsStore.merge(ctx, {
      product: SLUG,
      from: other,
      to: w.subject,
    });
    expect(await getRing(w.db, SLUG, other)).toBeNull();
    const exported = await connectRingsStore.export!(ctx, {
      product: SLUG,
      subject: w.subject,
    });
    expect(exported).toEqual({ epoch: 1, bumpedAt: NOW });
    expect(JSON.stringify(exported)).not.toContain(
      (await getRing(w.db, SLUG, w.subject))!.disc_key,
    );
    await connectRingsStore.delete(ctx, { product: SLUG, subject: w.subject });
    expect(await getRing(w.db, SLUG, w.subject)).toBeNull();
  });

  it("a product's deletion statements drop its rows", async () => {
    const w = await world();
    await identity(w);
    const [stmt] = connectProductDeletion(SLUG, NOW);
    await w.db.run(stmt!.sql, ...stmt!.params);
    expect(await getRing(w.db, SLUG, w.subject)).toBeNull();
  });

  it("hashes the set of devices and keys, not their order", async () => {
    const m = (id: string) => ({
      deviceId: id,
      signKey: "s" + id,
      agreeKey: "a" + id,
      keySeq: 1,
    });
    expect(await membersHash([m("x"), m("y")])).toBe(
      await membersHash([m("y"), m("x")]),
    );
    expect(await membersHash([m("x")])).not.toBe(await membersHash([m("y")]));
  });
});

describe("members obey the principal rule", () => {
  /** Device C: a second person-licence of Ada's, bound to her account, with keys. */
  async function withThird(w: World): Promise<string> {
    const { key } = await seedLicenseWithKey(w.db, SLUG, { id: "lic_c" });
    w.tokens[C] = await activate(w, key, C);
    await bindTo(w, C, "ada@example.com");
    await upsertDeviceKeys(w.db, SLUG, C, await newKeys(), NOW);
    return "lic_c";
  }
  const roster = async (w: World): Promise<string[]> => {
    const id = await identity(w, A, NOW + 5);
    const r = await verifyJws<{ devices: { deviceId: string }[] }>(
      id.ring,
      trust,
      { typ: "pkey-ring+jws" },
    );
    return r!.payload.devices.map((d) => d.deviceId);
  };

  it("includes a third device while its licence is in good standing", async () => {
    const w = await world();
    await withThird(w);
    expect(await roster(w)).toEqual([A, B, C]);
  });

  it("leaves out a device whose licence was removed from the library", async () => {
    const w = await world();
    const lic = await withThird(w);
    const acc = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM account_product_subjects WHERE product = ? AND subject = ?",
      SLUG,
      w.subject,
    );
    await w.db.run(
      "INSERT INTO license_auto_attach_blocks (product, license_id, account_id, created_at) VALUES (?, ?, ?, ?)",
      SLUG,
      lic,
      acc!.account_id,
      NOW,
    );
    expect(await roster(w)).toEqual([A, B]);
  });

  it("leaves out a device whose licence is floating", async () => {
    const w = await world();
    const lic = await withThird(w);
    await w.db.run(
      "UPDATE licenses SET email = NULL, account_id = NULL WHERE product = ? AND id = ?",
      SLUG,
      lic,
    );
    expect(await roster(w)).toEqual([A, B]);
  });

  it("leaves out a device whose licence is disabled", async () => {
    const w = await world();
    const lic = await withThird(w);
    await w.db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      SLUG,
      lic,
    );
    expect(await roster(w)).toEqual([A, B]);
  });

  it("the linked-devices list follows the same rule", async () => {
    const w = await world();
    const lic = await withThird(w);
    await w.db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      SLUG,
      lic,
    );
    const res = await get(w, "devices", A, w.tokens[A]!);
    const body = (await res.json()) as { devices: { deviceId: string }[] };
    expect(body.devices.map((d) => d.deviceId)).toEqual([A, B]);
  });
});

describe("the previous discovery key", () => {
  it("is kept when a bump only adds a device, and dropped when a device left", async () => {
    const w = await world();
    const first = await identity(w);
    const { key } = await seedLicenseWithKey(w.db, SLUG, { id: "lic_n" });
    w.tokens[C] = await activate(w, key, C);
    await bindTo(w, C, "ada@example.com");
    await upsertDeviceKeys(w.db, SLUG, C, await newKeys(), NOW);
    const added = await identity(w, A, NOW + 5);
    expect(added.discKeys).toHaveLength(2);
    expect(added.discKeys[1]).toBe(first.discKeys[0]);
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
      SLUG,
      C,
    );
    const left = await identity(w, A, NOW + 10);
    expect(left.discKeys).toHaveLength(1);
    expect(left.discKeys[0]).not.toBe(added.discKeys[0]);
    const row = await getRing(w.db, SLUG, w.subject);
    expect([row?.epoch, row?.prev_disc_key]).toEqual([3, null]);
  });
});

describe("currentRing under a race and past the cap", () => {
  const m = (id: string, k = "k") => ({
    deviceId: id,
    signKey: "s" + k,
    agreeKey: "a" + k,
    keySeq: 1,
  });

  it("re-reads the members after a lost race and returns what it computed for", async () => {
    const w = await world();
    const sub = "ps_" + "Z".repeat(22);
    await currentRing(w.db, SLUG, sub, async () => [m("x")], NOW);
    let calls = 0;
    const out = await currentRing(
      w.db,
      SLUG,
      sub,
      async () => {
        calls++;
        if (calls === 1) {
          // another request bumps to a different set while this one is mid-read
          await w.db.run(
            "UPDATE connect_rings SET epoch = 2, members_hash = 'other' WHERE product = ? AND subject = ?",
            SLUG,
            sub,
          );
          return [m("x"), m("y")];
        }
        return [m("x"), m("y")];
      },
      NOW + 1,
    );
    expect(calls).toBeGreaterThan(1);
    expect(out.row.members_hash).toBe(await membersHash(out.members));
    expect(out.row.epoch).toBe(3);
  });

  it("refuses more than 128 members before any bump or key draw", async () => {
    const w = await world();
    const sub = "ps_" + "Y".repeat(22);
    const many = Array.from({ length: 129 }, (_, i) =>
      m(String(i).padStart(32, "0"), String(i)),
    );
    await expect(
      currentRing(w.db, SLUG, sub, async () => many, NOW),
    ).rejects.toThrow(/more devices/);
    expect(await getRing(w.db, SLUG, sub)).toBeNull();
  });
});
