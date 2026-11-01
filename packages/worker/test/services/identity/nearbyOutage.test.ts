/// <reference types="@cloudflare/workers-types" />

// Nearby approval under a request-store outage and a missing client network (I-40.12;
// WIRE-CONTRACT-V5 §12.11.5): a store that cannot be reached is a retryable 503 that keeps the
// request, proximity refuses a caller with no client network, an approver on another network
// cannot spend the key-mismatch budget, and a bind that stopped part-way resumes under the same
// subject.

import { describe, expect, it } from "vitest";
import { newKeys } from "../../deviceKeyFixtures.js";
import { NOW } from "../../seed.js";
import { handleNearbyApprove } from "../../../src/services/identity/passthrough/nearbyApprove.js";
import { handleNearbyPoll } from "../../../src/services/identity/passthrough/nearbyPoll.js";
import { handleNearbyStart } from "../../../src/services/identity/passthrough/nearbyStart.js";
import {
  NEARBY_CLAIM_STALE_SECONDS,
  readNearby,
} from "../../../src/services/identity/passthrough/nearbyStore.js";
import {
  answerOf,
  D,
  IP,
  SLUG,
  sign,
  startRequest,
  world,
  type Dev,
  type Keys,
  type W,
} from "./nearbyWorld.js";

/** Makes the single-use store fail while `down(body)` says so; `body` is the op it was sent. */
function breakStore(w: W, down: (op: Record<string, any>) => boolean) {
  const real = w.env.SINGLE_USE!;
  w.env.SINGLE_USE = {
    ...real,
    idFromName: real.idFromName.bind(real),
    get: (id: DurableObjectId) => {
      const stub = real.get(id);
      return {
        fetch: async (url: string, init: RequestInit) => {
          if (down(JSON.parse(String(init.body))))
            throw new Error("durable object reset");
          return stub.fetch(url, init);
        },
      };
    },
  } as unknown as Env;
  return () => {
    w.env.SINGLE_USE = real;
  };
}
type Env = NonNullable<W["env"]["SINGLE_USE"]>;

const BASE = `https://key.plrs.im/${SLUG}/identity/nearby`;
type S = { handle: string; keys: Keys };

async function approve(
  w: W,
  s: S,
  o: {
    by?: Dev;
    ip?: string | null;
    keys?: Keys;
    now?: number;
    decision?: "approve" | "deny";
  } = {},
) {
  const me = o.by ?? w.m;
  const keys = o.keys ?? s.keys;
  const headers: Record<string, string> = {
    authorization: `Bearer ${me.token}`,
    "x-pkey-device": me.id,
  };
  const ip = o.ip === undefined ? IP : o.ip;
  if (ip) headers["cf-connecting-ip"] = ip;
  const body = {
    decision: o.decision ?? "approve",
    request: s.handle,
    deviceId: D,
    proof: await sign(me.keys.priv, me.id, s.handle),
    agreeKey: keys.agreeKey,
    signKey: keys.signKey,
  };
  const req = new Request(`${BASE}/approve`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const { env, db, product } = w;
  return answerOf(
    await handleNearbyApprove(req, env, db, product, o.now ?? NOW),
  );
}

async function poll(w: W, s: S, now: number) {
  return answerOf(
    await handleNearbyPoll(
      new Request(`${BASE}/poll`, {
        method: "POST",
        headers: { "x-pkey-device": D, "cf-connecting-ip": IP },
        body: JSON.stringify({
          request: s.handle,
          proof: await sign(s.keys.priv, D, s.handle, "nearby-poll"),
        }),
      }),
      w.env,
      w.db,
      w.product,
      now,
    ),
  );
}

const code = (r: { body: Record<string, any> }) => r.body.error?.code;
const deviceD = (w: W) =>
  w.db.first<{ token_hash: string | null; subject: string | null }>(
    "SELECT token_hash, subject FROM devices WHERE device_id = ? AND product = ?",
    D,
    SLUG,
  );

describe("a request-store outage keeps the request (§12.11.5 rule 10)", () => {
  it("poll: the read failing is 503 with Retry-After, and a later poll gets the token", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    expect((await approve(w, s)).status).toBe(200);
    const restore = breakStore(w, () => true);
    const down = await poll(w, s, NOW + 3);
    expect(down.status).toBe(503);
    expect(down.body.error).toBe("unavailable");
    expect(down.headers.get("retry-after")).toBe("3");
    restore();
    expect((await readNearby(w.env, s.ref))!.state).toBe("approved");
    const later = await poll(w, s, NOW + 6);
    expect(later.status).toBe(200);
    expect(later.body.access_token).toMatch(/^pkeyt_/);
  });

  it("poll: the poll slot failing is 503, not a timeout, and the request is kept", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    expect((await approve(w, s)).status).toBe(200);
    const restore = breakStore(w, (op) => op.op === "update");
    const down = await poll(w, s, NOW + 3);
    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBe("3");
    restore();
    expect((await poll(w, s, NOW + 6)).body.access_token).toMatch(/^pkeyt_/);
  });

  it("approve: an unreachable store is 503 and the request is kept", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    const restore = breakStore(w, () => true);
    const r = await approve(w, s);
    expect([r.status, code(r)]).toEqual([503, "unavailable"]);
    restore();
    expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
    expect((await approve(w, s)).status).toBe(200);
  });

  it("approve: the claim failing is 503, not 404, and binds nothing", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    const restore = breakStore(w, (op) => op.op === "update");
    const r = await approve(w, s);
    expect([r.status, code(r)]).toEqual([503, "unavailable"]);
    restore();
    expect(await deviceD(w)).toBeNull();
    expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
  });
});

describe("proximity needs a client network", () => {
  it("start with no cf-connecting-ip is refused (503 unavailable)", async () => {
    const w = await world();
    const keys = await newKeys();
    const send = async (ip: string | null) =>
      answerOf(
        await handleNearbyStart(
          new Request(`${BASE}/start`, {
            method: "POST",
            headers: {
              "x-pkey-device": D,
              ...(ip ? { "cf-connecting-ip": ip } : {}),
            },
            body: JSON.stringify({
              signKey: keys.signKey,
              agreeKey: keys.agreeKey,
              proof: await sign(
                keys.priv,
                D,
                `${keys.signKey}.${keys.agreeKey}`,
                "nearby-start",
              ),
            }),
          }),
          w.env,
          w.db,
          w.product,
          NOW,
        ),
      );
    const none = await send(null);
    expect([none.status, code(none)]).toEqual([503, "unavailable"]);
    expect((await send(IP)).status).toBe(201);
  });

  it("approve with no cf-connecting-ip is 403 not_nearby and writes nothing", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    const r = await approve(w, s, { ip: null });
    expect([r.status, code(r)]).toEqual([403, "not_nearby"]);
    expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
  });
});

describe("an approver on another network", () => {
  it("cannot spend the key-mismatch budget", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    const wrong = await newKeys();
    for (let i = 0; i < 5; i++) {
      const r = await approve(w, s, { keys: wrong, ip: "203.0.113.9" });
      expect([r.status, code(r)]).toEqual([403, "not_nearby"]);
    }
    expect((await readNearby(w.env, s.ref))!.state).toBe("pending");
    expect((await approve(w, s)).status).toBe(200);
  });

  it("a near approver with wrong keys still spends it", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    const wrong = await newKeys();
    for (let i = 0; i < 3; i++) await approve(w, s, { keys: wrong });
    expect(await readNearby(w.env, s.ref)).toBeNull();
  });
});

describe("a bind in flight across a takeover", () => {
  it("resumes under the same subject: the second approver completes it and D polls its token", async () => {
    const w = await world({ free: 1 });
    const s = await startRequest(w);
    // M's bind lands, then the decision cannot be written (the store drops that one write).
    const restore = breakStore(
      w,
      (op) => op.op === "update" && op.set?.state === "approved",
    );
    const first = await approve(w, s, { by: w.m });
    expect(first.status).toBe(503);
    restore();
    const bound = await deviceD(w);
    expect(bound?.token_hash).toBeTruthy();
    expect(bound?.subject).toBe(w.subject);
    expect((await readNearby(w.env, s.ref))!.state).toBe("claimed");
    // The claim goes stale; the same person's other device retakes it.
    const second = await approve(w, s, {
      by: w.m2,
      now: NOW + NEARBY_CLAIM_STALE_SECONDS,
    });
    expect(second.status).toBe(200);
    const rec = (await readNearby(w.env, s.ref))!;
    expect(rec.state).toBe("approved");
    expect((await deviceD(w))!.token_hash).toBe(rec.tokenHash);
    const got = await poll(w, s, NOW + NEARBY_CLAIM_STALE_SECONDS + 3);
    expect(got.body.access_token).toMatch(/^pkeyt_/);
  });
});
