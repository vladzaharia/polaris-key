/// <reference types="@cloudflare/workers-types" />

// `POST /<p>/identity/nearby/approve`, the bind (I-40.6; WIRE-CONTRACT-V5 §12.11.5 rules 6 to 9):
// the licence the person picked, `create`, a licence-less device, the silent single, the retryable
// refusals that keep the request, one winner under a race, and what D ends up holding.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindServiceRegistry, bound } from "../../../src/core/contributions.js";
import type { ServiceRegistry } from "../../../src/core/registry.js";
import type { DeviceChange } from "../../../src/core/devices/lifecycle.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { NOW, seedLicenseWithKey } from "../../seed.js";
import {
  getDeviceKeys,
  upsertDeviceKeys,
} from "../../../src/core/devices/keys.js";
import { withMintClaim } from "../../../src/services/identity/passthrough/mint.js";
import { handleNearbyApprove } from "../../../src/services/identity/passthrough/nearbyApprove.js";
import {
  claimNearby,
  createNearby,
  NEARBY_CLAIM_STALE_SECONDS,
  nearbyNetHash,
  readNearby,
} from "../../../src/services/identity/passthrough/nearbyStore.js";

import {
  activate,
  answerOf,
  D,
  FILL,
  HANDLE,
  IP,
  M,
  M2,
  netReq,
  SLUG,
  sign,
  startRequest,
  world as baseWorld,
  type Dev,
  type Keys,
  type Opts,
  type W,
} from "./nearbyWorld.js";

/** The world, with the device-change recorder cleared of its setup. */
async function world(o: Opts = {}): Promise<W> {
  const w = await baseWorld(o);
  seen = [];
  return w;
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
  return answerOf(res);
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
