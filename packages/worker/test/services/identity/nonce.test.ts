/// <reference types="@cloudflare/workers-types" />

// `POST /<p>/identity/nonce` (I-13.2): the nonce's shape and lifetime, the binding to product,
// device and signing key, single use, the registered-key rule, and the limits.

import { describe, expect, it } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { newKeys, world, type World } from "../../deviceKeyFixtures.js";
import { NOW } from "../../seed.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import {
  consumeExchangeNonce,
  handleExchangeNonce,
  NONCE_DEVICE_LIMIT,
} from "../../../src/services/identity/passthrough/nonce.js";

const b64 = (b: Uint8Array): string => base64UrlEncodeBytes(b);
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";

async function post(
  w: World,
  body: unknown,
  opts: { device?: string | null; method?: string; ip?: string } = {},
): Promise<{
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}> {
  const device = opts.device === undefined ? DEVICE : opts.device;
  const res = await handleExchangeNonce(
    new Request("https://key.plrs.im/djdl/identity/nonce", {
      method: opts.method ?? "POST",
      headers: {
        ...(device ? { "x-pkey-device": device } : {}),
        "cf-connecting-ip": opts.ip ?? "198.51.100.7",
      },
      body: opts.method === "GET" ? null : JSON.stringify(body),
    }),
    w.env,
    w.db,
    w.product,
    NOW,
  );
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text.startsWith("{") ? (JSON.parse(text) as never) : {},
  };
}

describe("POST /<p>/identity/nonce", () => {
  it("answers 43 base64url characters, 300 seconds, no-store", async () => {
    const w = await world();
    const r = await post(w, await newKeys());
    expect(r.status).toBe(200);
    expect(r.body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.expiresIn).toBe(300);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("issues a fresh nonce each call", async () => {
    const w = await world();
    const k = await newKeys();
    const a = await post(w, k);
    const b = await post(w, k);
    expect(a.body.nonce).not.toBe(b.body.nonce);
  });

  it("is taken once, for the product, device and key it was issued to", async () => {
    const w = await world();
    const k = await newKeys();
    const nonce = (await post(w, k)).body.nonce as string;
    const rec = await consumeExchangeNonce(
      w.env,
      "djdl",
      nonce,
      DEVICE,
      k.signKey,
    );
    expect(rec).toMatchObject({
      product: "djdl",
      deviceId: DEVICE,
      issuedAt: NOW,
    });
    expect(
      await consumeExchangeNonce(w.env, "djdl", nonce, DEVICE, k.signKey),
    ).toBeNull();
  });

  it("is not reachable under another product, and keeps its own", async () => {
    const w = await world();
    const k = await newKeys();
    const nonce = (await post(w, k)).body.nonce as string;
    expect(
      await consumeExchangeNonce(w.env, "other", nonce, DEVICE, k.signKey),
    ).toBeNull();
    expect(
      await consumeExchangeNonce(w.env, "djdl", nonce, DEVICE, k.signKey),
    ).not.toBeNull();
  });

  it("is spent by a presentation under another device or key", async () => {
    const w = await world();
    const k = await newKeys();
    const other = await newKeys();
    for (const [product, device, key] of [
      ["djdl", DEVICE_2, k.signKey],
      ["djdl", DEVICE, other.signKey],
    ] as const) {
      const nonce = (await post(w, k)).body.nonce as string;
      expect(
        await consumeExchangeNonce(w.env, product, nonce, device, key),
      ).toBeNull();
      expect(
        await consumeExchangeNonce(w.env, "djdl", nonce, DEVICE, k.signKey),
      ).toBeNull();
    }
  });

  it("refuses a malformed nonce without a lookup", async () => {
    const w = await world();
    const k = await newKeys();
    expect(
      await consumeExchangeNonce(w.env, "djdl", "short", DEVICE, k.signKey),
    ).toBeNull();
  });

  it("requires the registered signing key", async () => {
    const w = await world();
    const held = await newKeys();
    await upsertDeviceKeys(w.db, "djdl", DEVICE, held, NOW);
    const other = await newKeys();
    const r = await post(w, other);
    expect(r).toMatchObject({
      status: 400,
      body: { error: { code: "device_keys_invalid" } },
    });
    expect((await post(w, held)).status).toBe(200);
  });

  it("refuses bad keys with one answer", async () => {
    const w = await world();
    const k = await newKeys();
    const zero = b64(new Uint8Array(32));
    for (const body of [
      { signKey: zero, agreeKey: k.agreeKey },
      { signKey: k.signKey, agreeKey: zero },
      { signKey: "short", agreeKey: k.agreeKey },
    ]) {
      expect(await post(w, body)).toMatchObject({
        status: 400,
        body: { error: { code: "device_keys_invalid" } },
      });
    }
  });

  it("refuses a bad device id, body and method", async () => {
    const w = await world();
    const k = await newKeys();
    expect((await post(w, k, { device: null })).status).toBe(400);
    expect((await post(w, k, { device: "a:b" })).status).toBe(400);
    expect((await post(w, { signKey: 1 })).status).toBe(400);
    expect((await post(w, [])).status).toBe(400);
    expect((await post(w, k, { method: "GET" })).status).toBe(405);
  });

  it("limits a device to 10 a minute, and a network to 30", async () => {
    const w = await world();
    const k = await newKeys();
    for (let i = 0; i < NONCE_DEVICE_LIMIT.limit; i++)
      expect((await post(w, k)).status).toBe(200);
    expect((await post(w, k)).status).toBe(429);
    for (let i = 0; i < 19; i++) {
      const device = `D${String(i).padStart(31, "0")}`;
      expect((await post(w, k, { device })).status).toBe(200);
    }
    expect((await post(w, k, { device: DEVICE_2 })).status).toBe(429);
    expect(
      (await post(w, k, { device: DEVICE_2, ip: "203.0.113.9" })).status,
    ).toBe(200);
  });
});
