/// <reference types="@cloudflare/workers-types" />

// `PUT /<p>/devices/keys` (CC-03.2): the device bearer, the `keys` proof of possession, the
// unchanged re-send that spends no budget, the 4-a-day limit, the unique `agreeKey`, and that a
// refusal never says which check failed.

import { describe, expect, it } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { mkReq, NOW } from "../../seed.js";
import { handleDeviceKeys } from "../../../src/core/devices/keysRoute.js";
import {
  getDeviceKeys,
  keyPopMessage,
} from "../../../src/core/devices/keys.js";
import { newKeys, world, type World } from "../../deviceKeyFixtures.js";
import { dispatchWith } from "../../../src/dispatch.js";

const b64 = (b: Uint8Array): string => base64UrlEncodeBytes(b);
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";

async function register(w: World, deviceId = DEVICE): Promise<string> {
  const res = await dispatchWith(
    new Request("https://key.plrs.im/djdl/devices/register", {
      method: "POST",
      headers: { "x-pkey-device": deviceId },
    }),
    w.env,
    w.db,
    NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function body(
  k: { signKey: string; agreeKey: string; priv: CryptoKey },
  deviceId = DEVICE,
  issuedAt = NOW,
): Promise<Record<string, unknown>> {
  const msg = keyPopMessage({
    product: "djdl",
    deviceId,
    signKey: k.signKey,
    agreeKey: k.agreeKey,
    issuedAt,
  })!;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, k.priv, msg),
  );
  return {
    signKey: k.signKey,
    agreeKey: k.agreeKey,
    issuedAt,
    sig: b64(sig),
  };
}

async function put(
  w: World,
  token: string | null,
  payload: unknown,
  now = NOW,
  method = "PUT",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleDeviceKeys(
    mkReq(
      method,
      token ? { authorization: `Bearer ${token}` } : {},
      method === "GET" ? undefined : payload,
    ),
    w.env,
    w.db,
    w.product,
    now,
  );
  const text = await res.text();
  return {
    status: res.status,
    body: text.startsWith("{") ? (JSON.parse(text) as never) : {},
  };
}

const INVALID = { error: { code: "device_keys_invalid" } };

describe("PUT /<p>/devices/keys", () => {
  it("registers keys and answers keySeq 1", async () => {
    const w = await world();
    const token = await register(w);
    const k = await newKeys();
    const r = await put(w, token, await body(k));
    expect(r).toEqual({ status: 200, body: { keySeq: 1 } });
    const row = await getDeviceKeys(w.db, "djdl", DEVICE);
    expect(row?.sign_key).toBe(k.signKey);
    expect(row?.agree_key).toBe(k.agreeKey);
  });

  it("is reached through the router, ahead of /devices/<id>", async () => {
    const w = await world();
    const token = await register(w);
    const k = await newKeys();
    const res = await dispatchWith(
      new Request("https://key.plrs.im/djdl/devices/keys", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(await body(k)),
      }),
      w.env,
      w.db,
      NOW,
    );
    expect([res.status, await res.json()]).toEqual([200, { keySeq: 1 }]);
  });

  it("answers an identical re-send with the same keySeq and spends no budget", async () => {
    const w = await world();
    const token = await register(w);
    const k = await newKeys();
    await put(w, token, await body(k));
    for (let i = 0; i < 6; i++)
      expect((await put(w, token, await body(k))).body).toEqual({ keySeq: 1 });
    const k2 = await newKeys();
    expect((await put(w, token, await body(k2))).body).toEqual({ keySeq: 2 });
  });

  it("allows 4 changes a day and refuses the fifth with 429", async () => {
    const w = await world();
    const token = await register(w);
    for (let i = 1; i <= 4; i++) {
      const r = await put(w, token, await body(await newKeys()));
      expect(r.body).toEqual({ keySeq: i });
    }
    const fifth = await put(w, token, await body(await newKeys()));
    expect(fifth.status).toBe(429);
    expect(fifth.body).toEqual({ error: { code: "rate_limited" } });
    expect((await getDeviceKeys(w.db, "djdl", DEVICE))?.key_seq).toBe(4);
  });

  it("refuses a missing, foreign or non-device token with 401", async () => {
    const w = await world();
    const k = await newKeys();
    expect((await put(w, null, await body(k))).status).toBe(401);
    expect(
      (await put(w, "pkeyt_" + "x".repeat(43), await body(k))).status,
    ).toBe(401);
    expect((await put(w, "pkey_nope", await body(k))).status).toBe(401);
  });

  it("refuses a device that is no longer authorized", async () => {
    const w = await world();
    const token = await register(w);
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = 'djdl'",
    );
    const r = await put(w, token, await body(await newKeys()));
    expect(r.status).toBe(401);
    expect(await getDeviceKeys(w.db, "djdl", DEVICE)).toBeNull();
  });

  it("refuses other methods", async () => {
    const w = await world();
    const token = await register(w);
    const k = await newKeys();
    for (const m of ["POST", "GET", "DELETE"])
      expect((await put(w, token, await body(k), NOW, m)).status).toBe(405);
  });

  it("answers one device_keys_invalid for a bad proof, a stale proof, a bad key and a taken agreeKey", async () => {
    const w = await world();
    const token = await register(w);
    const token2 = await register(w, DEVICE_2);
    const holder = await newKeys();
    expect((await put(w, token2, await body(holder, DEVICE_2))).status).toBe(
      200,
    );

    const k = await newKeys();
    const good = await body(k);
    const other = await newKeys();
    const cases: Record<string, Record<string, unknown>> = {
      wrongSigner: { ...good, signKey: other.signKey },
      tamperedAgree: { ...good, agreeKey: (await newKeys()).agreeKey },
      stale: await body(k, DEVICE, NOW - 301),
      future: await body(k, DEVICE, NOW + 301),
      forDeviceTwo: await body(k, DEVICE_2),
      lowOrderAgree: await body({
        ...k,
        agreeKey: b64(new Uint8Array(32)),
      }),
      takenAgree: await body({ ...k, agreeKey: holder.agreeKey }),
      shortKey: { ...good, signKey: "AAAA" },
      padded: { ...good, sig: good.sig + "=" },
    };
    for (const [name, payload] of Object.entries(cases)) {
      const r = await put(w, token, payload);
      expect({ name, status: r.status, body: r.body }).toEqual({
        name,
        status: 400,
        body: INVALID,
      });
    }
    expect(await getDeviceKeys(w.db, "djdl", DEVICE)).toBeNull();
  });

  it("accepts the edge of the skew window", async () => {
    const w = await world();
    const token = await register(w);
    const r = await put(
      w,
      token,
      await body(await newKeys(), DEVICE, NOW - 300),
    );
    expect(r.status).toBe(200);
  });

  it("answers bad_request for a malformed body", async () => {
    const w = await world();
    const token = await register(w);
    for (const payload of [
      [],
      "x",
      {},
      { signKey: 1, agreeKey: "a", issuedAt: 1, sig: "s" },
      { signKey: "a", agreeKey: "b", issuedAt: 1.5, sig: "s" },
      { signKey: "a", agreeKey: "b", issuedAt: "1", sig: "s" },
    ]) {
      const r = await put(w, token, payload);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "bad_request" } });
    }
  });

  it("refuses a body over 2 KiB", async () => {
    const w = await world();
    const token = await register(w);
    const r = await put(w, token, { pad: "x".repeat(3000) });
    expect(r.status).toBe(413);
  });
});
