/// <reference types="@cloudflare/workers-types" />
// Shared fixtures of the device-keys route tests.
import { expect } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { mkReq, NOW } from "../../seed.js";
import { newKeys, world, type World } from "../../deviceKeyFixtures.js";

export { newKeys, world, type World };
import { handleDeviceKeys } from "../../../src/core/devices/keysRoute.js";
import { keyPopMessage } from "../../../src/core/devices/keys.js";
import { dispatchWith } from "../../../src/dispatch.js";

export const b64 = (b: Uint8Array): string => base64UrlEncodeBytes(b);
export const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
export const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";

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
