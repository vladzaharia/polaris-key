// Blinded names (WIRE-CONTRACT-V5 §13.10.3):
// `blind(kind, ctx, n) = "x:" + base64url(HMAC-SHA256(K_names, kind 0x00 ctx 0x00 n))`.
// The server compares blinded names by bytes and never learns the plaintext.

import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { deriveNamesKey, type SyncCryptoPort } from "./crypto.js";

export type BlindKind = "setting" | "member" | "record" | "field" | "element";

/** The prefix no declared key or collection name may carry. */
export const BLIND_PREFIX = "x:";

const utf8 = new TextEncoder();

/**
 * `ctx` is the declared setting key or collection name that scopes the name, `n` the person's
 * own name (an element is its canonical JSON, see `canonicalJson`).
 */
export async function blind(
  port: SyncCryptoPort,
  root: Uint8Array,
  kind: BlindKind,
  ctx: string,
  n: string,
): Promise<string> {
  const key = await deriveNamesKey(port, root);
  const mac = await port.hmac(key, utf8.encode(`${kind}\0${ctx}\0${n}`));
  return BLIND_PREFIX + base64UrlEncodeBytes(mac);
}

const BLINDED = /^x:[A-Za-z0-9_-]{43}$/;

/** True for the shape of a blinded name (`^x:[A-Za-z0-9_-]{43}$`). */
export const isBlindedName = (s: string): boolean => BLINDED.test(s);
