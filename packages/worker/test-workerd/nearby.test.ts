/// <reference types="@cloudflare/workers-types" />
// I-40.10: nearby approval (WIRE-CONTRACT-V5 §12.11.5) under concurrency on the REAL runtime: the
// request lives in the real `SingleUseDO` (compare-and-set claim, decision and poll slot), and the
// credential swap is one conditional UPDATE on real D1. The Node lane serialises its mock; here two
// approvals, two polls, an approval against a poll, a stale claim and the request's lifetime run
// against the object's actual input gate.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { D1Db } from "../src/db/d1.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { setServices } from "../src/core/products/store.js";
import { SERVICE_SLUGS, serializeServices } from "../src/core/services.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { setDeviceSubject } from "../src/core/accounts/accountSubjects.js";
import { upsertDeviceKeys } from "../src/core/devices/keys.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleNearbyApprove } from "../src/services/identity/passthrough/nearbyApprove.js";
import { handleNearbyPoll } from "../src/services/identity/passthrough/nearbyPoll.js";
import {
  claimNearby,
  createNearby,
  nearbyNetHash,
  nearbyRef,
  readNearby,
} from "../src/services/identity/passthrough/nearbyStore.js";
import { hashKey } from "../src/platform/crypto.js";
import { NOW, seedLicenseWithKey, seedProduct } from "./seed.js";

// The route gate is a runtime setting with no binding in the lane's config: switch it on here.
const workerEnv = { ...env, LAUNCH_IDENTITY_NEARBY: "on" } as unknown as Env;
const db: Db = new D1Db(env.DB);
const IP = "198.51.100.7";
const D = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

let counter = 0;

interface Keys {
  signKey: string;
  agreeKey: string;
  priv: CryptoKey;
}
interface Dev {
  id: string;
  token: string;
  keys: Keys;
}

async function newKeys(): Promise<Keys> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  raw[31]! &= 0x7f;
  return {
    signKey: base64UrlEncodeBytes(
      new Uint8Array(
        (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
      ),
    ),
    agreeKey: base64UrlEncodeBytes(raw),
    priv: kp.privateKey,
  };
}

async function sign(
  slug: string,
  priv: CryptoKey,
  device: string,
  value: string,
  purpose: string,
): Promise<string> {
  const msg = ["pkey-proof/1", purpose, slug, device, value, "-"].join("\n");
  return base64UrlEncodeBytes(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(msg)),
    ),
  );
}

interface World {
  slug: string;
  product: Product;
  subject: string;
  m: Dev;
  m2: Dev;
}

/** A product with Config and Identity, one account, two signed-in devices holding keys. */
async function world(): Promise<World> {
  const slug = `nb${++counter}`;
  await seedProduct(workerEnv, db, slug, { schemaVersion: 1, entries: [] });
  const on = new Set(["config", "identity"]);
  const services = {} as Record<string, { enabled: boolean }>;
  for (const s of SERVICE_SLUGS) services[s] = { enabled: on.has(s) };
  await setServices(
    db,
    slug,
    serializeServices({ services } as never),
    "manifest",
    NOW,
  );
  const product = (await loadProduct(workerEnv, db, slug))!;
  const email = `ada${counter}@example.com`;
  const r = await signIn(
    db,
    {
      emailVerified: true,
      email,
      kind: "email",
      subject: email,
      issuerKey: "email",
    },
    NOW,
    { product: { slug }, unfenced: true },
  );
  if (r.status !== "signed_in") throw new Error("sign-in failed");
  const subject = r.subject!;
  const { key } = await seedLicenseWithKey(db, slug);
  const dev = async (id: string): Promise<Dev> => {
    const res = await handleActivate(
      new Request("https://key.plrs.im/x", {
        method: "POST",
        headers: { "x-pkey-device": id, authorization: `Bearer ${key}` },
      }),
      workerEnv,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(await setDeviceSubject(workerEnv, db, slug, id, subject)).toBe(true);
    const keys = await newKeys();
    await upsertDeviceKeys(db, slug, id, keys, NOW);
    return { id, token, keys };
  };
  return {
    slug,
    product,
    subject,
    m: await dev(`M${counter}`.padEnd(32, "M")),
    m2: await dev(`N${counter}`.padEnd(32, "N")),
  };
}

interface Req {
  handle: string;
  keys: Keys;
  deviceId: string;
}

const handleOf = () =>
  `nr_${base64UrlEncodeBytes(crypto.getRandomValues(new Uint8Array(16)))}`;

const refOf = async (w: World, r: Req) =>
  (await nearbyRef(workerEnv, w.slug, r.handle))!;

/** D's request, written as `start` does (the Node lane covers the route itself). */
async function started(w: World, deviceId = D): Promise<Req> {
  const keys = await newKeys();
  const handle = handleOf();
  expect(
    await createNearby(
      workerEnv,
      (await nearbyRef(workerEnv, w.slug, handle))!,
      {
        product: w.slug,
        deviceId,
        signKey: keys.signKey,
        agreeKey: keys.agreeKey,
        label: "Kitchen TV",
        meta: {},
        netHash: await nearbyNetHash(
          workerEnv,
          new Request("https://x/", { headers: { "cf-connecting-ip": IP } }),
        ),
        startedAt: NOW,
        proven: false,
      },
    ),
  ).toBe(true);
  return { handle, keys, deviceId };
}

interface Answer {
  status: number;
  body: Record<string, any>;
}

async function answerOf(res: Response): Promise<Answer> {
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, body };
}

async function decide(
  w: World,
  r: Req,
  by: Dev,
  decision: "approve" | "deny" = "approve",
  now = NOW,
): Promise<Answer> {
  const res = await handleNearbyApprove(
    new Request(`https://key.plrs.im/${w.slug}/identity/nearby/approve`, {
      method: "POST",
      headers: {
        "x-pkey-device": by.id,
        "cf-connecting-ip": IP,
        authorization: `Bearer ${by.token}`,
      },
      body: JSON.stringify({
        request: r.handle,
        deviceId: r.deviceId,
        signKey: r.keys.signKey,
        agreeKey: r.keys.agreeKey,
        decision,
        proof: await sign(
          w.slug,
          by.keys.priv,
          by.id,
          r.handle,
          "nearby-approve",
        ),
      }),
    }),
    workerEnv,
    db,
    w.product,
    now,
  );
  return answerOf(res);
}

async function poll(
  w: World,
  r: Req,
  now: number,
  deviceId = D,
): Promise<Answer> {
  const res = await handleNearbyPoll(
    new Request(`https://key.plrs.im/${w.slug}/identity/nearby/poll`, {
      method: "POST",
      headers: { "x-pkey-device": deviceId, "cf-connecting-ip": IP },
      body: JSON.stringify({
        request: r.handle,
        proof: await sign(
          w.slug,
          r.keys.priv,
          deviceId,
          r.handle,
          "nearby-poll",
        ),
      }),
    }),
    workerEnv,
    db,
    w.product,
    now,
  );
  return answerOf(res);
}

/** M claims the request and then stalls. */
async function claimedByM(w: World, r: Req) {
  const ref = await refOf(w, r);
  expect((await claimNearby(workerEnv, ref, w.m.id, NOW)).ok).toBe(true);
  return ref;
}

const deviceRow = (w: World, id: string) =>
  db.first<Record<string, any>>(
    "SELECT * FROM devices WHERE product = ? AND device_id = ?",
    w.slug,
    id,
  );

const tokensOf = (answers: Answer[]): string[] =>
  answers.map((a) => a.body.access_token).filter(Boolean);

const approvedAudits = async (w: World) =>
  (
    await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE action = 'identity.nearby.approved' AND product = ?",
      w.slug,
    )
  ).length;

afterEach(() => {
  vi.useRealTimers();
});

describe("nearby approval on workerd", () => {
  it("parallel approvals from two devices bind D once", async () => {
    const w = await world();
    const r = await started(w);
    const answers = await Promise.all([
      decide(w, r, w.m),
      decide(w, r, w.m2),
      decide(w, r, w.m),
      decide(w, r, w.m2),
      decide(w, r, w.m),
      decide(w, r, w.m2),
    ]);
    for (const a of answers) expect(a.status).toBeLessThan(500);
    const won = answers.filter((a) => a.body.status === "approved");
    expect(won).toHaveLength(1);
    // The losers are not found (the request was claimed or decided), never a second approval.
    for (const a of answers.filter((x) => x !== won[0]))
      expect([404, 409]).toContain(a.status);
    expect(await approvedAudits(w)).toBe(1);

    const rec = (await readNearby(workerEnv, await refOf(w, r)))!;
    expect(rec.state).toBe("approved");
    const row = (await deviceRow(w, D))!;
    expect(row.token_hash).toBe(rec.tokenHash);
    const count = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM devices WHERE product = ? AND device_id = ?",
      w.slug,
      D,
    );
    expect(count!.n).toBe(1);
    // The one deciding device is the one recorded.
    expect([w.m.id, w.m2.id]).toContain(rec.approvedBy);
  });

  it("an approval racing a denial: exactly one decision stands, and the poll agrees", async () => {
    const w = await world();
    const r = await started(w);
    const [a, d] = await Promise.all([
      decide(w, r, w.m, "approve"),
      decide(w, r, w.m2, "deny"),
    ]);
    const approved = a.body.status === "approved";
    const denied = d.status === 204;
    expect(approved && denied).toBe(false);
    expect(approved || denied).toBe(true);
    const p = await poll(w, r, NOW + 3);
    if (approved) {
      expect(p.body.access_token).toMatch(/^pkeyt_/);
      expect(a.status).toBe(200);
    } else {
      expect(p.body).toEqual({ status: "error", reason: "access_denied" });
      expect(await deviceRow(w, D)).toBeNull();
    }
  });

  it("parallel polls of an approved request give one token", async () => {
    const w = await world();
    const r = await started(w);
    expect((await decide(w, r, w.m)).status).toBe(200);
    const atApprove = (await deviceRow(w, D))!.token_hash;
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => poll(w, r, NOW + 3)),
    );
    const tokens = tokensOf(answers);
    expect(tokens).toHaveLength(1);
    for (const a of answers.filter((x) => !x.body.access_token))
      expect(["slow_down", "timeout"]).toContain(a.body.status);
    // The stored hash is that of the one token handed out; the approve-time one is gone.
    const stored = (await deviceRow(w, D))!.token_hash;
    expect(stored).toBe(await hashKey(tokens[0]!, workerEnv.KEY_HASH_PEPPER));
    expect(stored).not.toBe(atApprove);
    // And nothing later carries another.
    for (const at of [NOW + 6, NOW + 9]) {
      expect((await poll(w, r, at)).body).toEqual({ status: "timeout" });
    }
  });

  it("parallel polls outside one interval (the swap alone) still give one token", async () => {
    const w = await world();
    const r = await started(w);
    expect((await decide(w, r, w.m)).status).toBe(200);
    // Spaced `now` values: no poll is "too soon" for another, so the slot and the swap decide.
    const answers = await Promise.all(
      [3, 6, 9, 12, 15, 18].map((s) => poll(w, r, NOW + s)),
    );
    const tokens = tokensOf(answers);
    expect(tokens).toHaveLength(1);
    expect((await deviceRow(w, D))!.token_hash).toBe(
      await hashKey(tokens[0]!, workerEnv.KEY_HASH_PEPPER),
    );
    for (const a of answers.filter((x) => !x.body.access_token))
      expect(["pending", "slow_down", "timeout"]).toContain(a.body.status);
  });

  it("an approval against a poll, in either order, never loses or doubles the token", async () => {
    for (let i = 0; i < 6; i++) {
      const w = await world();
      const r = await started(w);
      // Stagger by i microtask turns so both interleavings occur.
      const lag = (n: number) =>
        Array.from({ length: n }).reduce<Promise<void>>(
          (p) => p.then(() => undefined),
          Promise.resolve(),
        );
      const [a, p1] = await Promise.all([
        decide(w, r, w.m),
        lag(i * 3).then(() => poll(w, r, NOW + 3)),
      ]);
      expect([a.status, a.body.status]).toEqual([200, "approved"]);
      expect(["pending", undefined]).toContain(p1.body.status);
      const p2 = await poll(w, r, NOW + 6);
      const tokens = tokensOf([p1, p2]);
      expect(tokens, `round ${i}`).toHaveLength(1);
      expect((await deviceRow(w, D))!.token_hash).toBe(
        await hashKey(tokens[0]!, workerEnv.KEY_HASH_PEPPER),
      );
      // A token, once taken, is not offered again.
      expect((await poll(w, r, NOW + 9)).body).toEqual({ status: "timeout" });
    }
  });

  it("a stale claim is retaken once, by one of many, and the first claimer loses", async () => {
    const w = await world();
    const r = await started(w);
    const ref = await claimedByM(w, r);
    // Fresh: nobody else gets in.
    expect((await claimNearby(workerEnv, ref, w.m2.id, NOW + 29)).ok).toBe(
      false,
    );
    expect((await decide(w, r, w.m2, "approve", NOW + 29)).status).toBe(404);

    // Stale at 30 s: five takers race, one wins.
    const takers = ["a", "b", "c", "d", "e"];
    const moves = await Promise.all(
      takers.map((t) => claimNearby(workerEnv, ref, t, NOW + 31)),
    );
    expect(moves.filter((m) => m.ok)).toHaveLength(1);
    const winner = takers[moves.findIndex((m) => m.ok)];
    const rec = (await readNearby(workerEnv, ref))!;
    expect([rec.state, rec.claimedBy]).toEqual(["claimed", winner]);
  });

  it("an approval that retakes a stale claim binds D and is the only decision", async () => {
    const w = await world();
    const r = await started(w);
    // M claims and stalls; M2 comes back after 30 s and decides.
    const ref = await claimedByM(w, r);
    const a = await decide(w, r, w.m2, "approve", NOW + 31);
    expect([a.status, a.body.status]).toEqual([200, "approved"]);
    // The stalled M can neither decide nor re-approve.
    const late = await decide(w, r, w.m, "approve", NOW + 32);
    expect(late.status).toBe(404);
    expect((await readNearby(workerEnv, ref))!.approvedBy).toBe(w.m2.id);
    const p = await poll(w, r, NOW + 33);
    expect(p.body.access_token).toMatch(/^pkeyt_/);
    expect(await approvedAudits(w)).toBe(1);
  });

  it("racing approvals across a stale claim bind D once", async () => {
    const w = await world();
    const r = await started(w);
    await claimedByM(w, r);
    const answers = await Promise.all([
      decide(w, r, w.m2, "approve", NOW + 31),
      decide(w, r, w.m2, "approve", NOW + 31),
      decide(w, r, w.m, "approve", NOW + 31),
    ]);
    expect(answers.filter((a) => a.body.status === "approved")).toHaveLength(1);
    expect(await approvedAudits(w)).toBe(1);
    const tokens = tokensOf([await poll(w, r, NOW + 40)]);
    expect(tokens).toHaveLength(1);
  });

  it("the request lapses with its 300 s lifetime: no decision, no token", async () => {
    const w = await world();
    const r = await started(w);
    const ref = await refOf(w, r);
    expect((await readNearby(workerEnv, ref))!.state).toBe("pending");
    // The object counts its lifetime on the runtime clock; move that clock past the lifetime.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 301_000);
    expect(await readNearby(workerEnv, ref)).toBeNull();
    expect((await decide(w, r, w.m, "approve", NOW + 301)).status).toBe(404);
    expect((await poll(w, r, NOW + 302)).body).toEqual({ status: "timeout" });
    expect(await deviceRow(w, D)).toBeNull();
  });

  it("an approved request that lapses before the poll gives no token", async () => {
    const w = await world();
    const r = await started(w);
    expect((await decide(w, r, w.m)).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 301_000);
    expect((await poll(w, r, NOW + 302)).body).toEqual({ status: "timeout" });
    // D stays bound to the approve-time hash, which no one holds.
    expect((await deviceRow(w, D))!.token_hash).toBeTruthy();
  });
});
