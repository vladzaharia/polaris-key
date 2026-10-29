/// <reference types="@cloudflare/workers-types" />

// I-40.10 (WIRE-CONTRACT-V5 §12.11.5 rules 9 and 11, §13.11): the hand-off from a nearby approval to
// Cloud Sync's key ring, through the real router. M approves D, D polls and gets its credential, and
// the sync key wrap for D travels over its own route (`PUT /<p>/devices/keyring/wraps/{deviceId}`)
// and no other: the nearby routes take and return no key material, and the flow needs neither
// Connect nor the relay. Wrap values here are fake; the server never opens one.

import { describe, expect, it } from "vitest";
import { newKeys } from "../deviceKeyFixtures.js";
import { NOW } from "../seed.js";
import { dispatchWith } from "../../src/dispatch.js";
import { setServices } from "../../src/core/products/store.js";
import { serializeServices } from "../../src/core/services.js";
import { servicesOn } from "../transcripts/world.js";
import {
  nearbyRef,
  readNearby,
} from "../../src/services/identity/passthrough/nearbyStore.js";
import {
  D,
  IP,
  M,
  SLUG,
  sign,
  world,
  type Keys,
  type W,
} from "../services/identity/nearbyWorld.js";

const RING = "rg_AAAAAAAAAAAAAAAAAAAAAA";
const KID = "0123456789abcdef0123456789abcdef";
const wrapOf = (tag: string) => ({ kem: 32, enc: `enc${tag}`, ct: `ct${tag}` });
const MARK = "wrapmarkZ9";

const root = (path: string) => `https://key.plrs.im/${SLUG}${path}`;

interface Answer {
  status: number;
  text: string;
  body: Record<string, any>;
}

async function send(
  w: W,
  path: string,
  o: {
    method?: string;
    bearer?: string;
    device?: string;
    body?: unknown;
    now?: number;
  } = {},
): Promise<Answer> {
  const res = await dispatchWith(
    new Request(root(path), {
      method: o.method ?? "POST",
      headers: {
        "cf-connecting-ip": IP,
        ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}),
        ...(o.device ? { "x-pkey-device": o.device } : {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    }),
    w.env,
    w.db,
    o.now ?? NOW,
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    body: text.startsWith("{") ? (JSON.parse(text) as Record<string, any>) : {},
  };
}

/** Cloud Sync on (it needs Config and Identity); Connect and the relay are always off. */
async function syncOn(w: W): Promise<void> {
  await setServices(
    w.db,
    SLUG,
    serializeServices({
      services: servicesOn("config", "license", "identity", "sync"),
    }),
    "manifest",
    NOW,
  );
  delete (w.env as any).LAUNCH_CONNECT;
  delete (w.env as any).LAUNCH_RELAY;
}

interface Flow {
  w: W;
  handle: string;
  keys: Keys;
  started: Answer;
}

/** D starts a request, through the route and with a real proof. */
async function start(w: W): Promise<Flow> {
  const keys = await newKeys();
  const started = await send(w, "/identity/nearby/start", {
    device: D,
    body: {
      signKey: keys.signKey,
      agreeKey: keys.agreeKey,
      deviceName: "Kitchen TV",
      proof: await sign(
        keys.priv,
        D,
        `${keys.signKey}.${keys.agreeKey}`,
        "nearby-start",
      ),
    },
  });
  expect(started.status).toBe(201);
  return { w, handle: started.body.request, keys, started };
}

const approve = async (f: Flow, extra: Record<string, unknown> = {}) =>
  send(f.w, "/identity/nearby/approve", {
    device: M,
    bearer: f.w.m.token,
    body: {
      request: f.handle,
      deviceId: D,
      signKey: f.keys.signKey,
      agreeKey: f.keys.agreeKey,
      decision: "approve",
      proof: await sign(f.w.m.keys.priv, M, f.handle),
      ...extra,
    },
  });

const poll = async (f: Flow, now: number) =>
  send(f.w, "/identity/nearby/poll", {
    device: D,
    now,
    body: {
      request: f.handle,
      proof: await sign(f.keys.priv, D, f.handle, "nearby-poll"),
    },
  });

const ring = (
  w: W,
  bearer: string,
  device: string,
  method = "GET",
  body?: unknown,
  now = NOW,
) => send(w, "/devices/keyring", { method, bearer, device, body, now });

const createRing = (w: W) =>
  ring(w, w.m.token, M, "POST", {
    ringId: RING,
    rootKid: KID,
    wrap: wrapOf("M"),
    recovery: { ct: "rec" },
  });

const putWrapFor = (w: W, tag: string, now = NOW + 1) =>
  send(w, `/devices/keyring/wraps/${D}`, {
    method: "PUT",
    bearer: w.m.token,
    device: M,
    now,
    body: { epoch: 1, kid: KID, ...wrapOf(tag) },
  });

describe("nearby approval, then the Cloud Sync key hand-off", () => {
  it("approve, wrap PUT 204, D's poll token, D's keyring GET returns the wrap", async () => {
    const w = await world({ free: 1 });
    await syncOn(w);
    expect((await createRing(w)).status).toBe(201);
    const f = await start(w);

    // Before the approval D is no device of the subject: M's wrap for it is refused.
    expect((await putWrapFor(w, "early")).status).toBe(404);

    const a = await approve(f);
    expect([a.status, a.body]).toEqual([
      200,
      { status: "approved", deviceLabel: "Kitchen TV" },
    ]);

    // The wrap travels over its own route, as soon as the approval answers.
    expect((await putWrapFor(w, "D")).status).toBe(204);

    const p = await poll(f, NOW + 3);
    expect(p.status).toBe(200);
    const token = p.body.access_token as string;
    expect(token).toMatch(/^pkeyt_/);

    const mine = await ring(w, token, D, "GET", undefined, NOW + 4);
    expect(mine.status).toBe(200);
    expect(mine.body.ring).toMatchObject({ ringId: RING, epoch: 1 });
    expect(mine.body.wrap).toMatchObject(wrapOf("D"));

    // M reads its own wrap, never D's.
    const m = await ring(w, w.m.token, M, "GET", undefined, NOW + 4);
    expect(m.body.wrap).toMatchObject(wrapOf("M"));
    expect(m.text).not.toContain("encD");
  });

  it("passes with Connect and the relay off", async () => {
    const w = await world({ free: 1 });
    await syncOn(w);
    const env = w.env as unknown as Record<string, unknown>;
    expect(env.LAUNCH_CONNECT).toBeUndefined();
    expect(env.LAUNCH_RELAY).toBeUndefined();
    const f = await start(w);
    expect((await approve(f)).status).toBe(200);
    const p = await poll(f, NOW + 3);
    expect([p.status, typeof p.body.access_token]).toEqual([200, "string"]);
    // Connect's route does not exist for this product.
    const connect = await send(w, "/connect/start", {
      bearer: p.body.access_token,
    });
    expect(connect.status).toBe(404);
  });

  it("the wrap needs a ring and the current epoch: the nearby approval does not create one", async () => {
    const w = await world({ free: 1 });
    await syncOn(w);
    const f = await start(w);
    expect((await approve(f)).status).toBe(200);
    const none = await ring(w, w.m.token, M);
    expect(none.body).toEqual({ ring: null, wrap: null });
    // With no ring there is nothing to wrap, and M holds no wrap to deposit one from.
    expect([403, 409]).toContain((await putWrapFor(w, "x")).status);
  });

  it("D, with no wrap deposited, gets the ring and a null wrap", async () => {
    const w = await world({ free: 1 });
    await syncOn(w);
    await createRing(w);
    const f = await start(w);
    await approve(f);
    const p = await poll(f, NOW + 3);
    const mine = await ring(
      w,
      p.body.access_token,
      D,
      "GET",
      undefined,
      NOW + 4,
    );
    expect(mine.status).toBe(200);
    expect(mine.body.wrap).toBeNull();
  });

  it("a wrap deposited for D before its poll is not served on the approve-time credential (D never sees it)", async () => {
    const w = await world({ free: 1 });
    await syncOn(w);
    await createRing(w);
    const f = await start(w);
    await approve(f);
    expect((await putWrapFor(w, "D")).status).toBe(204);
    // The credential minted at approval is stored as a hash only: nothing a caller holds opens it.
    const stored = await readNearby(
      w.env,
      (await nearbyRef(w.env, SLUG, f.handle))!,
    );
    expect(JSON.stringify(stored)).not.toContain("pkeyt_");
    expect((await ring(w, "pkeyt_guessed", D)).status).toBe(401);
  });
});

describe("no key material on the nearby routes", () => {
  it("answers carry no ring, wrap or key members", async () => {
    const w = await world({ free: 1 });
    await syncOn(w);
    await createRing(w);
    const f = await start(w);
    const bodies = [f.started, await approve(f), await poll(f, NOW + 3)];
    for (const b of bodies) {
      const walk = (v: unknown): string[] =>
        v && typeof v === "object"
          ? Object.entries(v).flatMap(([k, x]) => [k, ...walk(x)])
          : [];
      const names = walk(b.body);
      for (const banned of [
        "wrap",
        "ring",
        "enc",
        "ct",
        "kem",
        "rootKid",
        "recovery",
        "signKey",
        "agreeKey",
        "privateKey",
      ])
        expect(names, banned).not.toContain(banned);
    }
  });

  it("a wrap offered on approve is neither stored nor audited nor echoed", async () => {
    const w = await world({ free: 1 });
    await syncOn(w);
    const f = await start(w);
    const a = await approve(f, {
      wrap: { kem: 32, enc: MARK, ct: MARK },
      rootKid: KID,
    });
    expect([200, 400]).toContain(a.status);
    expect(a.text).not.toContain(MARK);
    const { nearbyRef } =
      await import("../../src/services/identity/passthrough/nearbyStore.js");
    const rec = await readNearby(
      w.env,
      (await nearbyRef(w.env, SLUG, f.handle))!,
    );
    expect(JSON.stringify(rec ?? null)).not.toContain(MARK);
    const audits = JSON.stringify(await w.db.all("SELECT * FROM audit"));
    expect(audits).not.toContain(MARK);
    const wraps = await w.db.all(
      "SELECT * FROM sqlite_master WHERE name LIKE '%wrap%'",
    );
    for (const t of wraps as { name: string; type: string }[]) {
      if (t.type !== "table") continue;
      const rows = JSON.stringify(await w.db.all(`SELECT * FROM ${t.name}`));
      expect(rows).not.toContain(MARK);
    }
  });

  it("nothing secret reaches the audit rows or the stored request through the whole flow", async () => {
    const w = await world({ free: 1 });
    await syncOn(w);
    await createRing(w);
    const f = await start(w);
    await approve(f);
    const { nearbyRef } =
      await import("../../src/services/identity/passthrough/nearbyStore.js");
    const ref = (await nearbyRef(w.env, SLUG, f.handle))!;
    const approved = JSON.stringify(await readNearby(w.env, ref));
    await putWrapFor(w, "D");
    const p = await poll(f, NOW + 3);
    const token = p.body.access_token as string;
    const audits = JSON.stringify(await w.db.all("SELECT * FROM audit"));
    for (const secret of [
      token,
      f.handle,
      w.m.token,
      "encD",
      "ctD",
      "encM",
      "ctM",
    ]) {
      expect(audits, secret).not.toContain(secret);
      expect(approved, secret).not.toContain(secret);
    }
    // Only the label travels in the nearby audit rows.
    const rows = await w.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM audit WHERE action LIKE 'identity.nearby.%'",
    );
    expect(rows.map((r) => r.action)).toEqual(["identity.nearby.approved"]);
    expect(rows[0]!.summary).toContain("Kitchen TV");
    expect(rows[0]!.summary).not.toContain(f.keys.signKey);
    expect(rows[0]!.summary).not.toContain(f.keys.agreeKey);
  });

  it("the nearby routes do not serve the key ring paths, and the ring does not serve nearby", async () => {
    const w = await world({ free: 1 });
    await syncOn(w);
    await createRing(w);
    const f = await start(w);
    await approve(f);
    for (const path of [
      "/identity/nearby/wraps",
      "/identity/nearby/keyring",
      "/identity/nearby/wrap",
    ]) {
      const r = await send(w, path, { bearer: w.m.token, device: M, body: {} });
      expect(r.status, path).toBe(404);
    }
    const r = await send(w, "/devices/keyring/nearby/approve", {
      bearer: w.m.token,
      device: M,
      body: {},
    });
    expect(r.status).toBe(404);
  });
});
