/// <reference types="@cloudflare/workers-types" />

// `POST /<p>/identity/nearby/poll` (I-40.7; WIRE-CONTRACT-V5 §12.11.5 rule 10): each answer, the
// token coming once, the approve-time credential dying at the swap, a removed or rebound device,
// the storage-failure path that keeps the request, and the gates.

import { describe, expect, it } from "vitest";
import { newKeys } from "../../deviceKeyFixtures.js";
import { NOW } from "../../seed.js";
import { handleNearbyApprove } from "../../../src/services/identity/passthrough/nearbyApprove.js";
import { handleNearbyPoll } from "../../../src/services/identity/passthrough/nearbyPoll.js";
import { validateDeviceToken } from "../../../src/core/devices.js";
import { hashKey } from "../../../src/platform/crypto.js";
import {
  claimNearby,
  dropNearby,
  readNearby,
} from "../../../src/services/identity/passthrough/nearbyStore.js";
import {
  answerOf,
  D,
  IP,
  M,
  M2,
  SLUG,
  sign,
  startRequest,
  world,
  type Keys,
  type W,
} from "./nearbyWorld.js";

const VERB = "https://key.plrs.im/djdl/identity/nearby/poll";

/** D polls: the proof is made with the key it started with, for the handle. */
async function poll(
  w: W,
  s: { handle: string; keys: Keys },
  o: {
    now?: number;
    device?: string | null;
    raw?: string;
    proofKey?: CryptoKey;
    proofDevice?: string;
  } = {},
) {
  const device = o.device === undefined ? D : o.device;
  const res = await handleNearbyPoll(
    new Request(VERB, {
      method: "POST",
      headers: {
        ...(device ? { "x-pkey-device": device } : {}),
        "cf-connecting-ip": IP,
      },
      body:
        o.raw ??
        JSON.stringify({
          request: s.handle,
          proof: await sign(
            o.proofKey ?? s.keys.priv,
            o.proofDevice ?? D,
            s.handle,
            "nearby-poll",
          ),
        }),
    }),
    w.env,
    w.db,
    w.product,
    o.now ?? NOW,
  );
  return answerOf(res);
}

async function decide(
  w: W,
  s: { handle: string; keys: Keys },
  decision: "approve" | "deny",
) {
  const res = await handleNearbyApprove(
    new Request(`https://key.plrs.im/${SLUG}/identity/nearby/approve`, {
      method: "POST",
      headers: {
        "x-pkey-device": w.m.id,
        "cf-connecting-ip": IP,
        authorization: `Bearer ${w.m.token}`,
      },
      body: JSON.stringify({
        request: s.handle,
        signKey: s.keys.signKey,
        agreeKey: s.keys.agreeKey,
        decision,
        proof: await sign(w.m.keys.priv, w.m.id, s.handle),
      }),
    }),
    w.env,
    w.db,
    w.product,
    NOW,
  );
  expect([200, 204]).toContain(res.status);
}

const deviceD = async (w: W): Promise<Record<string, any>> =>
  (await w.db.first<Record<string, any>>(
    "SELECT * FROM devices WHERE product = ? AND device_id = ?",
    SLUG,
    D,
  ))!;

const code = (r: { body: Record<string, any> }) => r.body.error?.code;

describe("POST nearby/poll", () => {
  describe("the states", () => {
    it("pending while undecided, and a claimed request is pending too", async () => {
      const w = await world();
      const s = await startRequest(w);
      let r = await poll(w, s, { now: NOW });
      expect([r.status, r.body]).toEqual([200, { status: "pending" }]);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect((await claimNearby(w.env, s.ref, M, NOW)).ok).toBe(true);
      r = await poll(w, s, { now: NOW + 3 });
      expect([r.status, r.body]).toEqual([200, { status: "pending" }]);
    });

    it("a poll inside the interval is 429 slow_down, and the slot is taken once", async () => {
      const w = await world();
      const s = await startRequest(w);
      expect((await poll(w, s, { now: NOW })).status).toBe(200);
      for (const at of [NOW, NOW + 2]) {
        const r = await poll(w, s, { now: at });
        expect([r.status, r.body]).toEqual([
          429,
          { status: "slow_down", interval: 3 },
        ]);
      }
      expect((await poll(w, s, { now: NOW + 3 })).status).toBe(200);
    });

    it("a denial is sticky", async () => {
      const w = await world();
      const s = await startRequest(w);
      await decide(w, s, "deny");
      for (const at of [NOW, NOW + 3, NOW + 6]) {
        const r = await poll(w, s, { now: at });
        expect([r.status, r.body]).toEqual([
          200,
          { status: "error", reason: "access_denied" },
        ]);
      }
    });

    it("an unknown, malformed-but-shaped or other product's handle is timeout", async () => {
      const w = await world();
      const s = await startRequest(w);
      const other = { ...s, handle: "nr_BBBBBBBBBBBBBBBBBBBBBB" };
      const r = await poll(w, other);
      expect([r.status, r.body]).toEqual([200, { status: "timeout" }]);
    });

    it("an expired or collected request is timeout", async () => {
      const w = await world();
      const s = await startRequest(w);
      await dropNearby(w.env, s.ref);
      expect((await poll(w, s)).body).toEqual({ status: "timeout" });
    });
  });

  describe("the credential", () => {
    it("is answered once, replaces the approve-time hash, and validates", async () => {
      const w = await world({ free: 1 });
      const s = await startRequest(w);
      await decide(w, s, "approve");
      const approved = (await readNearby(w.env, s.ref))!;
      const atApprove = approved.tokenHash!;
      expect((await deviceD(w)).token_hash).toBe(atApprove);

      const r = await poll(w, s, { now: NOW + 3 });
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.body.token_type).toBe("Bearer");
      expect(r.body.scope).toBe("email");
      expect(r.body.subject).toBe(w.subject);
      expect(r.body.device.id).toBe(D);
      const token = r.body.access_token as string;
      expect(token).toMatch(/^pkeyt_/);

      // The stored hash is the new credential's, the approve-time one is gone.
      const row = await deviceD(w);
      expect(row.token_hash).toBe(await hashKey(token, w.env.KEY_HASH_PEPPER));
      expect(row.token_hash).not.toBe(atApprove);
      const valid = await validateDeviceToken(
        w.env,
        w.db,
        w.product,
        token,
        NOW + 4,
        { deviceId: D },
      );
      expect("error" in valid).toBe(false);

      // The request is gone: later polls never carry a token.
      for (const at of [NOW + 6, NOW + 9]) {
        const again = await poll(w, s, { now: at });
        expect([again.status, again.body]).toEqual([
          200,
          { status: "timeout" },
        ]);
      }
      expect(await readNearby(w.env, s.ref)).toBeNull();
      // The token is in no stored record.
      const rows = JSON.stringify(
        await w.db.all(
          "SELECT * FROM audit WHERE action LIKE 'identity.nearby.%'",
        ),
      );
      expect(rows).not.toContain(token);
    });

    it("a licence-less approval is answered with no licence", async () => {
      const w = await world();
      const s = await startRequest(w);
      await decide(w, s, "approve");
      const r = await poll(w, s, { now: NOW + 3 });
      expect(r.status).toBe(200);
      expect(r.body.license).toBeNull();
    });

    it("two polls racing for the token: one wins", async () => {
      const w = await world();
      const s = await startRequest(w);
      await decide(w, s, "approve");
      const [a, b] = await Promise.all([
        poll(w, s, { now: NOW + 3 }),
        poll(w, s, { now: NOW + 3 }),
      ]);
      const got = [a, b].filter((r) => r.body.access_token);
      expect(got).toHaveLength(1);
      const other = [a, b].find((r) => !r.body.access_token)!;
      expect(["slow_down", "timeout"]).toContain(other.body.status);
    });

    it("a device removed after the approval gets timeout, and no token", async () => {
      const w = await world();
      const s = await startRequest(w);
      await decide(w, s, "approve");
      await w.db.run(
        "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
        SLUG,
        D,
      );
      const r = await poll(w, s, { now: NOW + 3 });
      expect([r.status, r.body]).toEqual([200, { status: "timeout" }]);
    });

    it("a device with no row gets timeout", async () => {
      const w = await world();
      const s = await startRequest(w);
      await decide(w, s, "approve");
      await w.db.run(
        "DELETE FROM devices WHERE product = ? AND device_id = ?",
        SLUG,
        D,
      );
      expect((await poll(w, s, { now: NOW + 3 })).body).toEqual({
        status: "timeout",
      });
    });

    it("a device rebound after the approval (another credential, or another subject) gets timeout", async () => {
      for (const set of [
        "token_hash = 'rebound'",
        "subject = 'sub_other'",
        "license_id = 'lic_other'",
      ]) {
        const w = await world({ free: 1 });
        const s = await startRequest(w);
        await decide(w, s, "approve");
        await w.db.run(
          `UPDATE devices SET ${set} WHERE product = ? AND device_id = ?`,
          SLUG,
          D,
        );
        const before = await deviceD(w);
        const r = await poll(w, s, { now: NOW + 3 });
        expect([set, r.status, r.body]).toEqual([
          set,
          200,
          { status: "timeout" },
        ]);
        expect(await deviceD(w)).toEqual(before);
      }
    });

    it("a storage failure is 503 with Retry-After and keeps the request", async () => {
      const w = await world();
      const s = await startRequest(w);
      await decide(w, s, "approve");
      const real = w.db.runChanges.bind(w.db);
      w.db.runChanges = async () => {
        throw new Error("d1 down");
      };
      const r = await poll(w, s, { now: NOW + 3 });
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("unavailable");
      expect(r.headers.get("retry-after")).toBe("3");
      w.db.runChanges = real;
      expect((await readNearby(w.env, s.ref))!.state).toBe("approved");
      const again = await poll(w, s, { now: NOW + 6 });
      expect(again.status).toBe(200);
      expect(again.body.access_token).toMatch(/^pkeyt_/);
    });
  });

  describe("refusals", () => {
    it("a wrong device id, a wrong key and a wrong purpose are one 400 invalid_grant", async () => {
      const w = await world();
      const s = await startRequest(w);
      const other = await newKeys();
      const cases = [
        await poll(w, s, { device: M2, now: NOW }),
        await poll(w, s, { proofKey: other.priv, now: NOW + 3 }),
        await poll(w, s, { proofDevice: M2, now: NOW + 6 }),
        await poll(w, s, {
          raw: JSON.stringify({
            request: s.handle,
            proof: await sign(s.keys.priv, D, s.handle, "nearby-approve"),
          }),
          now: NOW + 9,
        }),
      ];
      for (const r of cases)
        expect([r.status, code(r)]).toEqual([400, "invalid_grant"]);
      // None of them took the poll slot.
      expect((await readNearby(w.env, s.ref))!.lastPollAt).toBeUndefined();
    });

    it("a missing or malformed device header is 400 bad_request", async () => {
      const w = await world();
      const s = await startRequest(w);
      for (const device of [null, "bad id!"]) {
        const r = await poll(w, s, { device });
        expect([r.status, code(r)]).toEqual([400, "bad_request"]);
      }
    });

    it("a malformed body is 400 bad_request", async () => {
      const w = await world();
      const s = await startRequest(w);
      for (const raw of [
        "not json",
        "[]",
        "{}",
        '{"request":"x","proof":"y"}',
      ]) {
        const r = await poll(w, s, { raw });
        expect([r.status, code(r)]).toEqual([400, "bad_request"]);
      }
    });

    it("another method is 405", async () => {
      const w = await world();
      const res = await handleNearbyPoll(
        new Request(VERB, { method: "GET" }),
        w.env,
        w.db,
        w.product,
        NOW,
      );
      expect(res.status).toBe(405);
    });
  });

  describe("off states are 404, even for a malformed body", () => {
    const switches: [string, (w: W) => Promise<unknown>][] = [
      [
        "the launch gate",
        async (w) => void delete (w.env as any).LAUNCH_IDENTITY_NEARBY,
      ],
      [
        "the launch gate hard-off in [vars]",
        async (w) => void ((w.env as any).LAUNCH_IDENTITY_NEARBY = "off"),
      ],
      [
        "the product's identity.nearby setting",
        (w) =>
          w.db.run(
            "INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by) VALUES (?, 'identity.nearby', 'false', 'manifest', ?, 'test')",
            SLUG,
            NOW,
          ),
      ],
    ];
    it.each(switches)("%s", async (_name, turnOff) => {
      const w = await world();
      const s = await startRequest(w);
      await decide(w, s, "approve");
      await turnOff(w);
      const answers = [];
      for (const raw of ["not json", "[]", "{}", undefined])
        answers.push(await poll(w, s, { raw }));
      for (const r of answers)
        expect([r.status, code(r)]).toEqual([404, "not_found"]);
      expect((await readNearby(w.env, s.ref))!.state).toBe("approved");
    });
  });
});
