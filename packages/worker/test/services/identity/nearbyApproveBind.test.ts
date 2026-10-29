/// <reference types="@cloudflare/workers-types" />

// `POST /<p>/identity/nearby/approve`, the bind (I-40.6; WIRE-CONTRACT-V5 §12.11.5 rules 6 to 9):
// the licence the person picked, `create`, a licence-less device, the silent single, the retryable
// refusals that keep the request, one winner under a race, and what D ends up holding.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindServiceRegistry, bound } from "../../../src/core/contributions.js";
import type { ServiceRegistry } from "../../../src/core/registry.js";
import type { DeviceChange } from "../../../src/core/devices/lifecycle.js";
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
  seedTier,
} from "../../seed.js";
import { loadProduct, type Product } from "../../../src/core/products.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { servicesOn } from "../../transcripts/world.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import {
  getDeviceKeys,
  upsertDeviceKeys,
} from "../../../src/core/devices/keys.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import { withMintClaim } from "../../../src/services/identity/passthrough/mint.js";
import { handleNearbyApprove } from "../../../src/services/identity/passthrough/nearbyApprove.js";
import {
  claimNearby,
  createNearby,
  NEARBY_CLAIM_STALE_SECONDS,
  nearbyNetHash,
  nearbyRef,
  readNearby,
} from "../../../src/services/identity/passthrough/nearbyStore.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";

const SLUG = "djdl";
const M = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
const M2 = "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";
const D = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const FILL = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
const IP = "198.51.100.7";
const HANDLE = "nr_AAAAAAAAAAAAAAAAAAAAAA";

type Keys = Awaited<ReturnType<typeof newKeys>>;
interface Sent {
  to: string;
  subject: string;
  text: string;
}
interface Dev {
  id: string;
  token: string;
  keys: Keys;
}
interface W {
  db: Db;
  env: Env;
  product: Product;
  accountId: string;
  subject: string;
  m: Dev;
  m2: Dev;
  sent: Sent[];
}

async function activate(
  w: Pick<W, "db" | "env" | "product">,
  id: string,
  key: string,
): Promise<string> {
  const req = mkReq("POST", {
    "x-pkey-device": id,
    authorization: `Bearer ${key}`,
  });
  const res = await handleActivate(req, w.env, w.db, w.product, NOW);
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  return token;
}

interface Opts {
  /** Licences the account owns with a free seat. */
  free?: number;
  /** A licence the account owns with its only seat taken. */
  full?: boolean;
  /** The policy grants the account a new licence (`create`). */
  grant?: boolean;
  license?: boolean;
}

async function world(o: Opts = {}): Promise<W> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  const sent: Sent[] = [];
  env.EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im";
  env.EMAIL = {
    send: async (m: Sent) => {
      sent.push(m);
      return { messageId: "m" };
    },
  } as unknown as Env["EMAIL"];
  await seedProduct(db, SLUG);
  const license = o.license !== false;
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: license
        ? servicesOn("config", "license", "identity")
        : servicesOn("config", "identity"),
    }),
    "manifest",
    NOW,
  );
  if (o.grant) {
    await seedTier(db, SLUG, "free", { deviceLimit: 2 });
    const policy = {
      mode: "oidcDefault",
      tierId: "free",
      rateLimitPerHour: 100,
      enabled: true,
    };
    await db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify(policy),
      SLUG,
    );
  }
  const product = (await loadProduct(env, db, SLUG))!;
  const base = { db, env, product };

  const email = "ada@example.com";
  const person = {
    emailVerified: true,
    email,
    kind: "email",
    subject: email,
    issuerKey: "email",
  } as const;
  const r = await signIn(db, person, NOW, {
    product: { slug: SLUG },
    unfenced: true,
  });
  if (r.status !== "signed_in") throw new Error("sign-in failed");
  const accountId = r.account.id;
  const subject = r.subject!;

  // M signs in on a licence of its own and has registered keys; so does a second approver.
  const { key } = await seedLicenseWithKey(db, SLUG);
  const dev = async (id: string): Promise<Dev> => {
    const keys = await newKeys();
    const token = await activate(base, id, key);
    expect(await setDeviceSubject(env, db, SLUG, id, subject)).toBe(true);
    await upsertDeviceKeys(db, SLUG, id, keys, NOW);
    return { id, token, keys };
  };
  const m = await dev(M);
  const m2 = await dev(M2);

  const own = async (id: string, tier: string | null) => {
    const l = await seedLicenseWithKey(db, SLUG, { id, tierId: tier });
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      accountId,
      SLUG,
      id,
    );
    return l;
  };
  for (let i = 0; i < (o.free ?? 0); i++) await own(`lic_free_${i}`, null);
  if (o.full) {
    await seedTier(db, SLUG, "one", { deviceLimit: 1 });
    const l = await own("lic_full", "one");
    await activate(base, FILL, l.key);
  }
  seen = [];
  return { ...base, accountId, subject, m, m2, sent };
}

function netReq(ip: string): Request {
  return new Request("https://x/", { headers: { "cf-connecting-ip": ip } });
}

async function startRequest(w: W, o: { proven?: boolean } = {}) {
  const keys = await newKeys();
  const ref = (await nearbyRef(w.env, SLUG, HANDLE))!;
  expect(
    await createNearby(w.env, ref, {
      product: SLUG,
      deviceId: D,
      signKey: keys.signKey,
      agreeKey: keys.agreeKey,
      label: "Kitchen TV",
      meta: { platform: "linux" },
      netHash: await nearbyNetHash(w.env, netReq(IP)),
      startedAt: NOW,
      proven: o.proven ?? false,
    }),
  ).toBe(true);
  return { handle: HANDLE, ref, keys };
}

async function sign(priv: CryptoKey, device: string, value: string) {
  const msg = ["pkey-proof/1", "nearby-approve", SLUG, device, value, "-"].join(
    "\n",
  );
  return base64UrlEncodeBytes(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(msg)),
    ),
  );
}

async function approve(
  w: W,
  s: { handle: string; keys: Keys },
  o: { by?: Dev; extra?: Record<string, unknown>; now?: number } = {},
) {
  const me = o.by ?? w.m;
  const res = await handleNearbyApprove(
    new Request(`https://key.plrs.im/${SLUG}/identity/nearby/approve`, {
      method: "POST",
      headers: {
        "x-pkey-device": me.id,
        "cf-connecting-ip": IP,
        authorization: `Bearer ${me.token}`,
      },
      body: JSON.stringify({
        request: s.handle,
        signKey: s.keys.signKey,
        agreeKey: s.keys.agreeKey,
        decision: "approve",
        proof: await sign(me.keys.priv, me.id, s.handle),
        ...(o.extra ?? {}),
      }),
    }),
    w.env,
    w.db,
    w.product,
    o.now ?? NOW,
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, headers: res.headers, body };
}

const APPROVED_BODY = { status: "approved", deviceLabel: "Kitchen TV" };

/** M picks the licence whose only seat is taken. */
const pickFull = (w: W, s: { handle: string; keys: Keys }) =>
  approve(w, s, {
    extra: { choice: { kind: "license", licenseId: "lic_full" } },
  });

const code = (r: { body: Record<string, any> }) => r.body.error?.code;

const deviceD = (w: W) =>
  w.db.first<Record<string, any>>(
    "SELECT * FROM devices WHERE product = ? AND device_id = ?",
    SLUG,
    D,
  );

/** The device-change events a listener hears (R-7), recorded for the test. */
let seen: DeviceChange[] = [];
let saved: ServiceRegistry;
beforeEach(() => {
  saved = bound();
  seen = [];
  const registry = new Map(saved);
  registry.set("identity", {
    contributes: {
      onDeviceChange: {
        recorder: async (_ctx: unknown, e: DeviceChange) => {
          seen.push(e);
        },
      },
    },
  } as never);
  bindServiceRegistry(registry);
});
afterEach(() => bindServiceRegistry(saved));

const events = () => seen.filter((e) => e.deviceId === D);

/** D holds a seat on `licenseId`, its subject, its keys and `bound_by = signin`. */
async function expectBound(w: W, s: Awaited<ReturnType<typeof startRequest>>) {
  const row = await deviceD(w);
  expect(row).toMatchObject({ subject: w.subject, bound_by: "signin" });
  expect(await getDeviceKeys(w.db, SLUG, D)).toMatchObject({
    sign_key: s.keys.signKey,
    agree_key: s.keys.agreeKey,
  });
  const kinds = events().map((e) => e.kind);
  expect(kinds).toContain("bound");
  expect(kinds.indexOf("keys")).toBeGreaterThan(kinds.indexOf("bound"));
  return row!;
}

/** The request is approved and holds only the hash of D's credential. */
async function expectApproved(
  w: W,
  s: Awaited<ReturnType<typeof startRequest>>,
  licenseId: string | null,
) {
  const rec = (await readNearby(w.env, s.ref))!;
  const row = (await deviceD(w))!;
  expect(rec).toMatchObject({
    state: "approved",
    approvedBy: M,
    subject: w.subject,
    licenseId,
    tokenHash: row.token_hash,
  });
  expect(JSON.stringify(rec)).not.toContain("pkeyt_");
  expect(rec.tokenHash).toBeTruthy();
}

describe("nearby/approve: the bind", () => {
  it("binds the licence the person picked", async () => {
    const w = await world({ free: 2 });
    const s = await startRequest(w);
    const r = await approve(w, s, {
      extra: { choice: { kind: "license", licenseId: "lic_free_1" } },
    });
    expect([r.status, r.body]).toEqual([200, APPROVED_BODY]);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const row = await expectBound(w, s);
    expect(row.license_id).toBe("lic_free_1");
    expect(row.seat_no).not.toBeNull();
    await expectApproved(w, s, "lic_free_1");
  });

  it("binds the one free candidate with no choice sent (the silent single)", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    const r = await approve(w, s);
    expect([r.status, r.body.status]).toEqual([200, "approved"]);
    const row = await expectBound(w, s);
    expect(row.license_id).toBe("lic_free_0");
    await expectApproved(w, s, "lic_free_0");
  });

  it("binds the one free candidate even when others are full", async () => {
    const w = await world({ free: 1, full: true });
    const s = await startRequest(w);
    const r = await approve(w, s);
    expect(r.status).toBe(200);
    expect((await deviceD(w))!.license_id).toBe("lic_free_0");
  });

  it("create happens only when sent, and mints a licence for the account", async () => {
    const w = await world({ grant: true });
    const s = await startRequest(w);
    const asked = await approve(w, s);
    expect([asked.status, asked.body.status]).toEqual([200, "choose"]);
    expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
    const r = await approve(w, s, { extra: { choice: { kind: "create" } } });
    expect([r.status, r.body.status]).toEqual([200, "approved"]);
    const row = await expectBound(w, s);
    const lic = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM licenses WHERE product = ? AND id = ?",
      SLUG,
      row.license_id,
    );
    expect(lic?.account_id).toBe(w.accountId);
    await expectApproved(w, s, row.license_id);
  });

  it("binds a licence-less device when there is nothing to choose", async () => {
    const w = await world({ license: false });
    const s = await startRequest(w);
    const r = await approve(w, s);
    expect([r.status, r.body]).toEqual([200, APPROVED_BODY]);
    const row = await expectBound(w, s);
    expect(row.seat_no ?? null).toBeNull();
    await expectApproved(w, s, null);
  });

  it("deviceLabel is null when D sent none", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    const ref = s.ref;
    // A request with no label.
    const { dropNearby } =
      await import("../../../src/services/identity/passthrough/nearbyStore.js");
    await dropNearby(w.env, ref);
    await createNearby(w.env, ref, {
      product: SLUG,
      deviceId: D,
      signKey: s.keys.signKey,
      agreeKey: s.keys.agreeKey,
      label: null,
      meta: {},
      netHash: await nearbyNetHash(w.env, netReq(IP)),
      startedAt: NOW,
      proven: false,
    });
    const r = await approve(w, s);
    expect([r.status, r.body]).toEqual([
      200,
      { status: "approved", deviceLabel: null },
    ]);
  });

  describe("consent", () => {
    const grantRow = (w: W) =>
      w.db.first<{ claims_json: string }>(
        "SELECT claims_json FROM account_product_grants WHERE account_id = ? AND product = ?",
        w.accountId,
        SLUG,
      );
    const consentAudits = (w: W) =>
      w.db.all<{ summary: string }>(
        "SELECT summary FROM audit WHERE action = 'signin.consent.granted'",
      );

    it("with none standing, the tap records the asked scope and audits it with via nearby", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      expect(await grantRow(w)).toBeNull();
      expect((await approve(w, s)).status).toBe(200);
      expect(JSON.parse((await grantRow(w))!.claims_json)).toEqual([
        "name",
        "picture",
        "email",
      ]);
      const audits = await consentAudits(w);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.summary).toContain("via nearby");
    });

    it("a standing consent stands: nothing is rewritten or audited", async () => {
      const w = await world({ free: 1 });
      await w.db.run(
        `INSERT INTO account_product_grants
           (account_id, product, claims_json, granted_at, modified_at, scope_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
        w.accountId,
        SLUG,
        JSON.stringify(["email"]),
        NOW,
        NOW,
        "old",
      );
      const s = await startRequest(w);
      expect((await approve(w, s)).status).toBe(200);
      expect(JSON.parse((await grantRow(w))!.claims_json)).toEqual(["email"]);
      expect(await consentAudits(w)).toHaveLength(0);
    });

    it("a refused bind writes no consent", async () => {
      const w = await world({ full: true });
      const s = await startRequest(w);
      const r = await pickFull(w, s);
      expect(r.status).toBe(403);
      expect(await grantRow(w)).toBeNull();
    });
  });

  describe("audit and email", () => {
    it("audits identity.nearby.approved with the label only, and emails the primary address", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      expect((await approve(w, s)).status).toBe(200);
      const rows = await w.db.all<Record<string, any>>(
        "SELECT * FROM audit WHERE action = 'identity.nearby.approved'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.summary).toBe(
        "A nearby sign-in was approved for Kitchen TV (via nearby)",
      );
      expect(rows[0]!.target_id).toBe(D);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(HANDLE);
      expect(dump).not.toContain("pkeyt_");
      expect(w.sent).toHaveLength(1);
      expect(w.sent[0]!.to).toBe("ada@example.com");
      expect(w.sent[0]!.subject).toContain("Kitchen TV");
      expect(JSON.stringify(w.sent)).not.toContain(HANDLE);
    });

    it("a mail failure never undoes the bind", async () => {
      const w = await world({ free: 1 });
      (w.env as any).EMAIL = {
        send: async () => {
          throw new Error("down");
        },
      };
      const s = await startRequest(w);
      expect((await approve(w, s)).status).toBe(200);
      expect((await readNearby(w.env, s.ref))!.state).toBe("approved");
    });

    it("nothing is audited or sent on a refusal", async () => {
      const w = await world({ full: true });
      const s = await startRequest(w);
      await pickFull(w, s);
      expect(
        await w.db.all(
          "SELECT 1 FROM audit WHERE action = 'identity.nearby.approved'",
        ),
      ).toHaveLength(0);
      expect(w.sent).toHaveLength(0);
    });
  });

  describe("refusals M can retry keep the request", () => {
    it("a full licence is 403 device_limit and the request is pending again", async () => {
      const w = await world({ full: true });
      const s = await startRequest(w);
      const r = await pickFull(w, s);
      expect([r.status, code(r)]).toEqual([403, "device_limit"]);
      expect(r.body.error).toMatchObject({ code: "device_limit" });
      const rec = (await readNearby(w.env, s.ref))!;
      expect(rec.state).toBe("pending");
      expect(rec.claimedBy).toBeUndefined();
      expect(await deviceD(w)).toBeNull();
      expect(events()).toEqual([]);
      // M can choose again.
      const free = await world({ full: true, free: 1 });
      const s2 = await startRequest(free);
      expect(
        (
          await approve(free, s2, {
            extra: { choice: { kind: "license", licenseId: "lic_full" } },
          })
        ).status,
      ).toBe(403);
      const again = await approve(free, s2, {
        extra: { choice: { kind: "license", licenseId: "lic_free_0" } },
      });
      expect(again.status).toBe(200);
    });

    it("a lost mint is 409 and the request is pending again", async () => {
      const w = await world({ grant: true });
      const s = await startRequest(w);
      const held = await withMintClaim(
        w.env,
        { slug: SLUG },
        w.accountId,
        async () => approve(w, s, { extra: { choice: { kind: "create" } } }),
      );
      expect(held.won).toBe(true);
      if (held.won) {
        expect([held.value.status, code(held.value)]).toEqual([
          409,
          "license_choice_required",
        ]);
      }
      expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
      expect(await deviceD(w)).toBeNull();
      const ok = await approve(w, s, { extra: { choice: { kind: "create" } } });
      expect(ok.status).toBe(200);
    });

    it("a licence that is not on the offer is 404 and the request stays open", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      const r = await approve(w, s, {
        extra: { choice: { kind: "license", licenseId: "lic_nope" } },
      });
      expect([r.status, code(r)]).toEqual([404, "not_found"]);
      expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
    });

    it("the subject's budget refuses with rate_limited and puts the request back", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      const { NEARBY_APPROVE_SUBJECT_RATE } =
        await import("../../../src/services/identity/passthrough/nearbyApprove.js");
      const { rateLimitOk } = await import("../../../src/core/rateLimit.js");
      for (let i = 0; i < NEARBY_APPROVE_SUBJECT_RATE.limit; i++)
        await rateLimitOk(
          w.env,
          SLUG,
          { ...NEARBY_APPROVE_SUBJECT_RATE, id: w.subject },
          NOW,
        );
      const r = await approve(w, s);
      expect([r.status, code(r)]).toEqual([429, "rate_limited"]);
      expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
      expect(await deviceD(w)).toBeNull();
    });
  });

  describe("the body", () => {
    it("replaceDeviceId, keep and key in the choice are 400 bad_request and bind nothing", async () => {
      const w = await world({ full: true, free: 1 });
      const s = await startRequest(w);
      for (const choice of [
        { kind: "license", licenseId: "lic_full", replaceDeviceId: FILL },
        { kind: "keep" },
        { kind: "key", key: "pkey_x" },
      ]) {
        const r = await approve(w, s, { extra: { choice } });
        expect([r.status, code(r)]).toEqual([400, "bad_request"]);
      }
      expect(await deviceD(w)).toBeNull();
      expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
    });
  });

  describe("one bind", () => {
    it("two approvals racing give exactly one bind", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      const [a, b] = await Promise.all([
        approve(w, s, { by: w.m }),
        approve(w, s, { by: w.m2 }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 404]);
      const rows = await w.db.all(
        "SELECT 1 FROM audit WHERE action = 'identity.nearby.approved'",
      );
      expect(rows).toHaveLength(1);
      expect(w.sent).toHaveLength(1);
      expect(events().filter((e) => e.kind === "bound")).toHaveLength(1);
      const rec = (await readNearby(w.env, s.ref))!;
      expect(rec.state).toBe("approved");
      expect((await deviceD(w))!.token_hash).toBe(rec.tokenHash);
    });

    it("a decided request cannot be approved again", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      expect((await approve(w, s)).status).toBe(200);
      const again = await approve(w, s);
      expect([again.status, code(again)]).toEqual([404, "not_found"]);
    });

    it("a fresh claim by another approver blocks; a stale one (30 s) can be retaken", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      expect((await claimNearby(w.env, s.ref, "other", NOW)).ok).toBe(true);
      const fresh = await approve(w, s);
      expect([fresh.status, code(fresh)]).toEqual([404, "not_found"]);
      expect(await deviceD(w)).toBeNull();
      const stale = await approve(w, s, {
        now: NOW + NEARBY_CLAIM_STALE_SECONDS,
      });
      expect(stale.status).toBe(200);
      expect((await readNearby(w.env, s.ref))!.approvedBy).toBe(M);
    });
  });

  describe("D's keys and credential", () => {
    it("a signing key other than the request's already held for D ends the request", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      await upsertDeviceKeys(w.db, SLUG, D, await newKeys(), NOW);
      const r = await approve(w, s);
      expect([r.status, code(r)]).toEqual([400, "device_keys_invalid"]);
      expect(await readNearby(w.env, s.ref)).toBeNull();
    });

    it("an agreeKey another device holds ends the request", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      await w.db.run(
        "UPDATE device_keys SET agree_key = ? WHERE product = ? AND device_id = ?",
        s.keys.agreeKey,
        SLUG,
        M2,
      );
      const r = await approve(w, s);
      expect([r.status, code(r)]).toEqual([400, "device_keys_invalid"]);
      expect(await deviceD(w)).toBeNull();
    });

    it("a credential on D's id that was not proven at start is never taken over", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      const { key } = await seedLicenseWithKey(w.db, SLUG, { id: "lic_other" });
      await activate(w, D, key);
      const r = await approve(w, s);
      expect([r.status, code(r)]).toEqual([404, "not_found"]);
      expect(await readNearby(w.env, s.ref)).toBeNull();
    });

    it("a proven request binds, and only the hash of the credential is kept", async () => {
      const w = await world({ license: false });
      const s = await startRequest(w, { proven: true });
      expect((await approve(w, s)).status).toBe(200);
      await expectApproved(w, s, null);
    });
  });
});
