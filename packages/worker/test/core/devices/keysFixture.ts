/// <reference types="@cloudflare/workers-types" />
// Shared fixtures of the device-keys route tests.
import { expect } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, mkReq, NOW, seedProduct } from "../../seed.js";
import { loadProduct, type Product } from "../../../src/core/products.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { CONFIG_ONLY } from "../../transcripts/world.js";
import { handleDeviceKeys } from "../../../src/core/devices/keysRoute.js";
import { keyPopMessage } from "../../../src/core/devices/keys.js";
import { dispatchWith } from "../../../src/dispatch.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";

export const b64 = (b: Uint8Array): string => base64UrlEncodeBytes(b);
export const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
export const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";

export interface World {
  db: Db;
  env: Env;
  product: Product;
}

export async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl");
  await setServices(
    db,
    "djdl",
    serializeServices({ services: CONFIG_ONLY }),
    "manifest",
    NOW,
  );
  return { db, env, product: (await loadProduct(env, db, "djdl"))! };
}

export async function register(w: World, deviceId = DEVICE): Promise<string> {
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

export async function newKeys(agreeRaw?: Uint8Array): Promise<{
  signKey: string;
  agreeKey: string;
  priv: CryptoKey;
}> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const signKey = b64(
    new Uint8Array(
      (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
    ),
  );
  const raw = agreeRaw ?? crypto.getRandomValues(new Uint8Array(32));
  if (!agreeRaw) raw[31]! &= 0x7f;
  return { signKey, agreeKey: b64(raw), priv: kp.privateKey };
}

export async function body(
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

export async function put(
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
