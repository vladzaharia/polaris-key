/// <reference types="@cloudflare/workers-types" />

// `POST /<p>/identity/nearby/approve` without the bind (I-40.5; WIRE-CONTRACT-V5 §12.11.5): the
// refusals, the network rule, a sticky denial, `choose` writing nothing, the budgets and the off
// states. The bind is I-40.6's.

import { describe, expect, it } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { newKeys } from "../../deviceKeyFixtures.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../../seed.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { loadProduct, type Product } from "../../../src/core/products.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { servicesOn } from "../../transcripts/world.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import {
  handleNearbyApprove,
  NEARBY_APPROVE_RATE,
  NEARBY_APPROVE_SUBJECT_RATE,
} from "../../../src/services/identity/passthrough/nearbyApprove.js";
import {
  createNearby,
  nearbyNetHash,
  nearbyRef,
  readNearby,
} from "../../../src/services/identity/passthrough/nearbyStore.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";

const SLUG = "djdl";
const M = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
const D = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const NO_SUBJECT = "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN";
const NO_KEYS = "KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK";
const IP = "198.51.100.7";
const HANDLE = "nr_AAAAAAAAAAAAAAAAAAAAAA";

type Keys = Awaited<ReturnType<typeof newKeys>>;

interface Dev {
  token: string;
  keys: Keys;
}
interface W {
  db: Db;
  env: Env;
  product: Product;
  accountId: string;
  m: Dev;
  noSubject: Dev;
  noKeys: Dev;
}

/** The device token of a device that activates the licence `key`. */
async function activate(
  cx: Pick<W, "db" | "env" | "product">,
  id: string,
  key: string,
): Promise<string> {
  const headers = { authorization: `Bearer ${key}`, "x-pkey-device": id };
  const out = await handleActivate(
    mkReq("POST", headers),
    cx.env,
    cx.db,
    cx.product,
    NOW,
  );
  expect(out.status).toBe(200);
  const parsed = (await out.json()) as { token: string };
  return parsed.token;
}

/** M is signed in with a registered key; the account owns `owned` licences, each with free seats. */
async function world(owned = 2): Promise<W> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  await seedProduct(db, SLUG);
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: servicesOn("config", "license", "identity"),
    }),
    "manifest",
    NOW,
  );
  const product = (await loadProduct(env, db, SLUG))!;
  const base = { db, env, product };
  const { key } = await seedLicenseWithKey(db, SLUG);
  const email = "ada@example.com";
  const who = {
    issuerKey: "email",
    subject: email,
    kind: "email",
    email,
    emailVerified: true,
  } as const;
  const r = await signIn(db, who, NOW, {
    unfenced: true,
    product: { slug: SLUG },
  });
  if (r.status !== "signed_in") throw new Error("sign-in failed");
  const accountId = r.account.id;

  const mKeys = await newKeys();
  const m = { token: await activate(base, M, key), keys: mKeys };
  expect(await setDeviceSubject(env, db, SLUG, M, r.subject!)).toBe(true);
  await upsertDeviceKeys(db, SLUG, M, mKeys, NOW);

  const nsKeys = await newKeys();
  const noSubject = {
    token: await activate(base, NO_SUBJECT, key),
    keys: nsKeys,
  };
  await upsertDeviceKeys(db, SLUG, NO_SUBJECT, nsKeys, NOW);

  const nkKeys = await newKeys();
  const noKeys = { token: await activate(base, NO_KEYS, key), keys: nkKeys };
  expect(await setDeviceSubject(env, db, SLUG, NO_KEYS, r.subject!)).toBe(true);

  for (let i = 0; i < owned; i++) {
    const { licenseId } = await seedLicenseWithKey(db, SLUG, {
      id: `lic_own_${i}`,
    });
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      accountId,
      SLUG,
      licenseId,
    );
  }
  return { ...base, accountId, m, noSubject, noKeys };
}

function netReq(ip: string): Request {
  return new Request("https://x/", { headers: { "cf-connecting-ip": ip } });
}

/** D's request, as `start` would have written it (D's keys; the network of `ip`). */
async function startRequest(
  w: W,
  o: { handle?: string; slug?: string; ip?: string; device?: string } = {},
) {
  const keys = await newKeys();
  const handle = o.handle ?? HANDLE;
  const slug = o.slug ?? SLUG;
  const ref = (await nearbyRef(w.env, slug, handle))!;
  const written = await createNearby(w.env, ref, {
    product: slug,
    deviceId: o.device ?? D,
    signKey: keys.signKey,
    agreeKey: keys.agreeKey,
    label: "Kitchen TV",
    meta: {},
    netHash: await nearbyNetHash(w.env, netReq(o.ip ?? IP)),
    startedAt: NOW,
    proven: false,
  });
  expect(written).toBe(true);
  return { handle, ref, keys };
}

async function sign(
  priv: CryptoKey,
  device: string,
  value: string,
  purpose = "nearby-approve",
) {
  const msg = ["pkey-proof/1", purpose, SLUG, device, value, "-"].join("\n");
  return base64UrlEncodeBytes(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(msg)),
    ),
  );
}

interface Call {
  as?: "m" | "noSubject" | "noKeys";
  device?: string;
  token?: string | null;
  ip?: string;
  decision?: "approve" | "deny";
  keys?: { signKey: string; agreeKey: string };
  handle?: string;
  extra?: Record<string, unknown>;
  raw?: string;
  proofBy?: Keys;
}

async function approve(
  w: W,
  start: { handle: string; keys: Keys },
  o: Call = {},
): Promise<{ status: number; headers: Headers; body: Record<string, any> }> {
  const who = o.as ?? "m";
  const dev = who === "m" ? M : who === "noSubject" ? NO_SUBJECT : NO_KEYS;
  const me = w[who];
  const handle = o.handle ?? start.handle;
  const payload =
    o.raw ??
    JSON.stringify({
      request: handle,
      signKey: (o.keys ?? start.keys).signKey,
      agreeKey: (o.keys ?? start.keys).agreeKey,
      decision: o.decision ?? "approve",
      proof: await sign((o.proofBy ?? me.keys).priv, o.device ?? dev, handle),
      ...(o.extra ?? {}),
    });
  const token = o.token === undefined ? me.token : o.token;
  const res = await handleNearbyApprove(
    new Request(`https://key.plrs.im/${SLUG}/identity/nearby/approve`, {
      method: "POST",
      headers: {
        "x-pkey-device": o.device ?? dev,
        "cf-connecting-ip": o.ip ?? IP,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: payload,
    }),
    w.env,
    w.db,
    w.product,
    NOW,
  );
  return summarise(res);
}

async function summarise(res: Response) {
  const parsed = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, headers: res.headers, body: parsed };
}

const code = (r: { body: Record<string, any> }) => r.body.error?.code;

describe("POST /<p>/identity/nearby/approve", () => {
  describe("the refusals", () => {
    it("a device with no sign-in is 403 account_required", async () => {
      const w = await world();
      const s = await startRequest(w);
      const r = await approve(w, s, { as: "noSubject" });
      expect([r.status, code(r)]).toEqual([403, "account_required"]);
      expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
    });

    it("a device with no registered signing key is 409 device_keys_required", async () => {
      const w = await world();
      const s = await startRequest(w);
      const r = await approve(w, s, { as: "noKeys" });
      expect([r.status, code(r)]).toEqual([409, "device_keys_required"]);
    });

    it("a missing or wrong bearer is 401", async () => {
      const w = await world();
      const s = await startRequest(w);
      expect((await approve(w, s, { token: null })).status).toBe(401);
      expect((await approve(w, s, { token: "pkeyt_nope" })).status).toBe(401);
    });

    it("a bad proof is one 400 invalid_grant body, whatever the cause", async () => {
      const w = await world();
      const s = await startRequest(w);
      const other = await newKeys();
      const bodies = [
        await approve(w, s, { proofBy: other }),
        await approve(w, s, { extra: { proof: "A".repeat(86) } }),
        await approve(w, s, { extra: { proof: "short" } }),
      ];
      for (const r of bodies)
        expect([r.status, r.body]).toEqual([
          400,
          { error: { code: "invalid_grant" } },
        ]);
      // A proof of another purpose, or over another handle, is the same answer.
      const wrongPurpose = await approve(w, s, {
        extra: { proof: await sign(w.m.keys.priv, M, s.handle, "nearby-poll") },
      });
      expect(wrongPurpose.body).toEqual({ error: { code: "invalid_grant" } });
      const wrongHandle = await approve(w, s, {
        extra: {
          proof: await sign(w.m.keys.priv, M, "nr_BBBBBBBBBBBBBBBBBBBBBB"),
        },
      });
      expect(wrongHandle.body).toEqual({ error: { code: "invalid_grant" } });
    });

    it("an unknown, expired or malformed-but-shaped handle is 404", async () => {
      const w = await world();
      const s = await startRequest(w);
      const r = await approve(w, s, { handle: "nr_BBBBBBBBBBBBBBBBBBBBBB" });
      expect([r.status, code(r)]).toEqual([404, "not_found"]);
    });

    it("another product's handle, and M's own request, are 404 and stay open", async () => {
      const w = await world();
      for (const o of [{ slug: "other" }, { device: M }]) {
        const s = await startRequest(w, o);
        const r = await approve(w, s);
        expect([r.status, code(r)]).toEqual([404, "not_found"]);
        expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
      }
    });

    it("bad bodies are 400 bad_request", async () => {
      const w = await world();
      const s = await startRequest(w);
      const bad = [
        "not json",
        "[]",
        "{}",
        JSON.stringify({ request: "nope" }),
        ...[
          { kind: "keep" },
          { kind: "key", key: "k" },
          { kind: "create", extra: 1 },
          { kind: "license" },
          { kind: "license", licenseId: "l", replaceDeviceId: "d" },
          { kind: "license", licenseId: 1 },
          "create",
          null,
          [],
        ].map((choice) =>
          JSON.stringify({
            request: s.handle,
            signKey: s.keys.signKey,
            agreeKey: s.keys.agreeKey,
            decision: "approve",
            proof: "A".repeat(86),
            choice,
          }),
        ),
        JSON.stringify({
          request: s.handle,
          signKey: s.keys.signKey,
          agreeKey: s.keys.agreeKey,
          decision: "maybe",
          proof: "A".repeat(86),
        }),
      ];
      for (const raw of bad) {
        const r = await approve(w, s, { raw });
        expect([r.status, code(r)]).toEqual([400, "bad_request"]);
      }
      const big = await approve(w, s, { raw: "x".repeat(5000) });
      expect(big.status).toBe(413);
    });

    it("a bad X-PKey-Device is 400", async () => {
      const w = await world();
      const s = await startRequest(w);
      const r = await approve(w, s, { device: "not a valid id!" });
      expect(r.status).toBe(400);
    });
  });

  describe("keys", () => {
    it("keys that differ from the start's are 404 and the third ends the request", async () => {
      const w = await world();
      const s = await startRequest(w);
      const wrong = await newKeys();
      for (let i = 0; i < 3; i++) {
        const r = await approve(w, s, { keys: wrong });
        expect([r.status, code(r)]).toEqual([404, "not_found"]);
      }
      // Ended: the right keys now find nothing.
      expect(await readNearby(w.env, s.ref)).toBeNull();
      expect((await approve(w, s)).status).toBe(404);
    });

    it("a request that two mismatches have touched is still open for the right keys", async () => {
      const w = await world();
      const s = await startRequest(w);
      const wrong = await newKeys();
      await approve(w, s, { keys: wrong });
      await approve(w, s, {
        keys: { signKey: s.keys.signKey, agreeKey: wrong.agreeKey },
      });
      expect((await approve(w, s)).status).toBe(200);
    });
  });

  describe("proximity (the approver's network against the start's)", () => {
    const cases: [string, string, string, boolean][] = [
      ["IPv4 exact", "198.51.100.7", "198.51.100.7", true],
      ["IPv4 next address", "198.51.100.7", "198.51.100.8", false],
      ["IPv4 other network", "198.51.100.7", "203.0.113.7", false],
      ["IPv6 same /64", "2001:db8:1:2:aaaa::1", "2001:db8:1:2:bbbb::9", true],
      ["IPv6 other /64", "2001:db8:1:2::1", "2001:db8:1:3::1", false],
      [
        "IPv4-mapped IPv6 against the IPv4",
        "198.51.100.7",
        "::ffff:198.51.100.7",
        true,
      ],
      [
        "IPv4 against the mapped form",
        "::ffff:198.51.100.7",
        "198.51.100.7",
        true,
      ],
      [
        "mapped IPv6 of another IPv4",
        "198.51.100.7",
        "::ffff:198.51.100.9",
        false,
      ],
      ["IPv4 against IPv6", "198.51.100.7", "2001:db8:1:2::1", false],
    ];
    for (const [name, startIp, approveIp, near] of cases)
      it(`${name}: ${near ? "near" : "403 not_nearby"}`, async () => {
        const w = await world();
        const s = await startRequest(w, { ip: startIp });
        const r = await approve(w, s, { ip: approveIp });
        if (near) expect(r.status).toBe(200);
        else expect([r.status, code(r)]).toEqual([403, "not_nearby"]);
        // Nothing is written, and the request stays open.
        const rec = (await readNearby(w.env, s.ref))!;
        expect(rec.state).toBe("pending");
      });

    it("not_nearby leaves the request open for a device that is near", async () => {
      const w = await world();
      const s = await startRequest(w);
      expect((await approve(w, s, { ip: "203.0.113.1" })).status).toBe(403);
      expect((await approve(w, s, { decision: "deny" })).status).toBe(204);
    });

    it("a stored record never holds a raw address", async () => {
      const w = await world();
      const s = await startRequest(w);
      await approve(w, s);
      expect(JSON.stringify(await readNearby(w.env, s.ref))).not.toContain(IP);
    });
  });

  describe("deny", () => {
    it("is 204 no-store, final, and a second decision finds nothing", async () => {
      const w = await world();
      const s = await startRequest(w);
      const r = await approve(w, s, { decision: "deny" });
      expect(r.status).toBe(204);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const rec = (await readNearby(w.env, s.ref))!;
      expect(rec).toMatchObject({ state: "denied", claimedBy: M });
      // Sticky: neither a repeat denial nor an approval gets in.
      for (const decision of ["deny", "approve"] as const) {
        const again = await approve(w, s, { decision });
        expect([again.status, code(again)]).toEqual([404, "not_found"]);
      }
      expect((await readNearby(w.env, s.ref))!.state).toBe("denied");
    });

    it("is audited with the label only", async () => {
      const w = await world();
      const s = await startRequest(w);
      await approve(w, s, { decision: "deny" });
      const rows = await w.db.all<{
        action: string;
        target_id: string;
        summary: string;
      }>(
        "SELECT action, target_id, summary FROM audit WHERE action = 'identity.nearby.denied'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.target_id).toBe(D);
      expect(rows[0]!.summary).toContain("Kitchen TV");
      expect(rows[0]!.summary).not.toContain(IP);
    });
  });

  describe("choose", () => {
    it("answers the candidates and writes nothing", async () => {
      const w = await world(2);
      const s = await startRequest(w);
      const before = JSON.stringify(await readNearby(w.env, s.ref));
      const r = await approve(w, s);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.body.status).toBe("choose");
      expect(r.body.choices.state).toBe("choose");
      expect(
        r.body.choices.choices.map((c: { id: string }) => c.id).sort(),
      ).toEqual(["lic_own_0", "lic_own_1"]);
      expect(JSON.stringify(await readNearby(w.env, s.ref))).toBe(before);
      const devices = await w.db.all<{ device_id: string }>(
        "SELECT device_id FROM devices WHERE product = ? AND device_id = ?",
        SLUG,
        D,
      );
      expect(devices).toHaveLength(0);
      // Repeatable: the request is still open.
      expect((await approve(w, s)).body.status).toBe("choose");
    });

    it("is not charged to the subject", async () => {
      const w = await world(2);
      const s = await startRequest(w);
      for (let i = 0; i < NEARBY_APPROVE_SUBJECT_RATE.limit + 3; i++)
        expect((await approve(w, s)).status).toBe(200);
    });

    it("exactly one free candidate, or none, is not a choice", async () => {
      for (const owned of [0, 1]) {
        const w = await world(owned);
        const s = await startRequest(w);
        const r = await approve(w, s);
        // The bind is I-40.6's: until then, an approval that is not a choice is held back.
        expect([r.status, code(r)]).toEqual([503, "unavailable"]);
        expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
      }
    });

    it("a sent choice is not asked for again", async () => {
      const w = await world(2);
      const s = await startRequest(w);
      const r = await approve(w, s, { extra: { choice: { kind: "create" } } });
      expect(r.status).toBe(503);
    });
  });

  describe("budgets", () => {
    it("M's device has 10 a minute, failing closed", async () => {
      expect(NEARBY_APPROVE_RATE).toMatchObject({ limit: 10, windowSec: 60 });
      const w = await world(2);
      const s = await startRequest(w);
      for (let i = 0; i < NEARBY_APPROVE_RATE.limit; i++)
        expect((await approve(w, s)).status).toBe(200);
      const r = await approve(w, s);
      expect([r.status, code(r)]).toEqual([429, "rate_limited"]);
    });

    it("the subject has 5 an hour, charged on denials", async () => {
      expect(NEARBY_APPROVE_SUBJECT_RATE).toMatchObject({
        limit: 5,
        windowSec: 3600,
      });
      const w = await world(2);
      for (let i = 0; i < NEARBY_APPROVE_SUBJECT_RATE.limit; i++) {
        const s = await startRequest(w, {
          handle: `nr_${String(i).repeat(22)}`,
        });
        expect((await approve(w, s, { decision: "deny" })).status).toBe(204);
      }
      const s = await startRequest(w, { handle: `nr_${"9".repeat(22)}` });
      const r = await approve(w, s, { decision: "deny" });
      expect([r.status, code(r)]).toEqual([429, "rate_limited"]);
      // The refused denial decided nothing.
      expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
    });
  });

  describe("off states are 404, even for a malformed body", () => {
    const off: Record<string, (w: W) => Promise<void> | void> = {
      "the launch gate": (w) => {
        delete (w.env as unknown as Record<string, unknown>)
          .LAUNCH_IDENTITY_NEARBY;
      },
      "the launch gate hard-off in [vars]": (w) => {
        (w.env as unknown as Record<string, unknown>).LAUNCH_IDENTITY_NEARBY =
          "off";
      },
      "the product's identity.nearby setting": async (w) => {
        await w.db.run(
          `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
           VALUES (?, 'identity.nearby', 'false', 'manifest', ?, 'test')`,
          SLUG,
          NOW,
        );
      },
    };
    for (const [name, turnOff] of Object.entries(off))
      it(name, async () => {
        const w = await world();
        const s = await startRequest(w);
        await turnOff(w);
        for (const raw of ["not json", "[]", "{}", undefined]) {
          const r = await approve(w, s, raw === undefined ? {} : { raw });
          expect([r.status, code(r)]).toEqual([404, "not_found"]);
        }
        // And without a bearer: the gate answers before the credential is read.
        expect((await approve(w, s, { token: null, raw: "{}" })).status).toBe(
          404,
        );
        expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
      });

    it("Identity off, through the router", async () => {
      const w = await world();
      await setServices(
        w.db,
        SLUG,
        serializeServices({ services: servicesOn("config", "license") }),
        "manifest",
        NOW,
      );
      const res = await dispatchWith(
        new Request(`https://key.plrs.im/${SLUG}/identity/nearby/approve`, {
          method: "POST",
          headers: { "x-pkey-device": M },
          body: "{}",
        }) as unknown as Request,
        w.env,
        w.db,
        NOW,
      );
      expect(res.status).toBe(404);
    });
  });

  it("is served through the router with everything on", async () => {
    const w = await world();
    const s = await startRequest(w);
    const res = await dispatchWith(
      new Request(`https://key.plrs.im/${SLUG}/identity/nearby/approve`, {
        method: "POST",
        headers: {
          "x-pkey-device": M,
          "cf-connecting-ip": IP,
          authorization: `Bearer ${w.m.token}`,
        },
        body: JSON.stringify({
          request: s.handle,
          signKey: s.keys.signKey,
          agreeKey: s.keys.agreeKey,
          decision: "approve",
          proof: await sign(w.m.keys.priv, M, s.handle),
        }),
      }) as unknown as Request,
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({
      status: "choose",
    });
  });

  it("only POST is served", async () => {
    const w = await world();
    const res = await handleNearbyApprove(
      new Request(
        "https://key.plrs.im/djdl/identity/nearby/approve",
      ) as unknown as Request,
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(res.status).toBe(405);
  });
});
