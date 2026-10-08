/**
 * SHA-256 digests in the three shapes the Worker stores and compares (hex, base64url, base64),
 * and the HMAC-SHA-256 key import.
 *
 * ONE implementation (P0-15): before this module there were about twenty private `sha256Hex`
 * functions and as many inline `crypto.subtle.digest("SHA-256", …)` + hex loops. Every copy
 * hashed a string as its UTF-8 bytes and answered lower-case hex; so does this one.
 *
 * A leaf module: it imports only `platform/` siblings.
 */

import {
  b64urlEncode,
  base64Encode,
  hexEncode,
  toArrayBuffer,
  utf8Encode,
} from "./bytes.js";

/** What a digest takes: a string (hashed as its UTF-8 bytes) or bytes. */
export type DigestInput = string | Uint8Array | ArrayBuffer;

/**
 * The bytes to digest, without a copy: WebCrypto reads exactly a view's `byteOffset`/`byteLength`
 * window, so a whole assembled artifact is hashed in place rather than duplicated first.
 */
function digestBytes(data: DigestInput): ArrayBuffer | Uint8Array {
  return typeof data === "string" ? utf8Encode(data) : data;
}

/** The raw 32-byte SHA-256 of `data`. */
export async function sha256(data: DigestInput): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestBytes(data)),
  );
}

/** SHA-256 as lower-case hex (64 characters). */
export async function sha256Hex(data: DigestInput): Promise<string> {
  return hexEncode(await sha256(data));
}

/**
 * SHA-256 of `input` as unpadded base64url, optionally truncated to `length` characters. This is
 * the digest shape the device id (`pkey-device:…`) and the fingerprint component and hwid hashes
 * (`pkey-hw:…`) use, so the Worker and every SDK derive identical values from identical inputs.
 */
export async function sha256B64url(
  input: DigestInput,
  length?: number,
): Promise<string> {
  const digest = b64urlEncode(await sha256(input));
  return length === undefined ? digest : digest.slice(0, length);
}

/** SHA-256 as standard, padded base64: the `'sha256-…'` CSP source shape. */
export async function sha256Base64(data: DigestInput): Promise<string> {
  return base64Encode(await sha256(data));
}

/** An HMAC-SHA-256 key from a secret's UTF-8 bytes. */
export function importHmacKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(utf8Encode(material)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** HMAC-SHA-256 of `data` under `key`, as raw bytes. */
export async function hmacSha256(
  key: CryptoKey,
  data: DigestInput,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, digestBytes(data)),
  );
}
