/// <reference types="@cloudflare/workers-types" />

// KEK-based key custody. Per-product signing keys + secrets are envelope-encrypted in D1
// under ONE platform KEK (`env.PLATFORM_KEK`, base64 of 32 random bytes). The KEK imports
// as a raw AES-256-GCM key; the sealed blob carries a fresh 12-byte nonce so the same
// plaintext never produces the same ciphertext. `open` fails CLOSED on a missing KEK or any
// auth-tag mismatch — it NEVER returns a wrong or partial plaintext.

import type { Env } from "./env.js";

/** A sealed value: AES-256-GCM under the platform KEK. iv = base64url 12-byte nonce,
 *  ct = base64url(ciphertext || tag). `v` pins the envelope format for forward-compat. */
export interface Sealed {
  v: 1;
  iv: string;
  ct: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a standard base64 string (the KEK is base64, not base64url). */
function b64Decode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Import the platform KEK as a raw AES-256-GCM key. The KEK is base64 of 32 bytes; if it
 *  decodes to anything other than 32 bytes we SHA-256 it to a deterministic 32-byte key. */
async function importKek(env: Env): Promise<CryptoKey> {
  const raw = env.PLATFORM_KEK;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("PLATFORM_KEK is not configured");
  }
  let keyBytes = b64Decode(raw);
  if (keyBytes.length !== 32) {
    keyBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", toArrayBuffer(keyBytes)),
    );
  }
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Envelope-encrypt `plaintext` under the platform KEK. Returns `JSON.stringify(Sealed)`.
 *  THROWS if the KEK is missing (a product can never persist key material un-sealed). */
export async function seal(env: Env, plaintext: string): Promise<string> {
  const key = await importKek(env);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(enc.encode(plaintext)),
  );
  const sealed: Sealed = {
    v: 1,
    iv: b64urlEncode(iv),
    ct: b64urlEncode(new Uint8Array(ct)),
  };
  return JSON.stringify(sealed);
}

/** Decrypt a `JSON.stringify(Sealed)` blob back to plaintext. THROWS on a missing KEK or any
 *  auth-tag / format failure — callers MUST treat a throw as "no usable value" (fail closed). */
export async function open(env: Env, sealedJson: string): Promise<string> {
  const key = await importKek(env);
  let sealed: Sealed;
  try {
    sealed = JSON.parse(sealedJson) as Sealed;
  } catch {
    throw new Error("sealed value is not valid JSON");
  }
  if (
    sealed.v !== 1 ||
    typeof sealed.iv !== "string" ||
    typeof sealed.ct !== "string"
  ) {
    throw new Error("sealed value has an unexpected shape");
  }
  // A bad auth tag (tampered ct) makes subtle.decrypt reject — we propagate the throw so a
  // wrong/partial plaintext can never escape.
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(b64urlDecode(sealed.iv)) },
    key,
    toArrayBuffer(b64urlDecode(sealed.ct)),
  );
  return dec.decode(pt);
}

function pkcs8ToPem(der: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(der);
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

/** Generate a fresh Ed25519 key in the exact wire format the JWS signer/jwks expect:
 *  private as a PKCS#8 PEM (for `signJws`), public as a raw 32-byte base64url (for JWKS /
 *  `verifyJws` trust sets). */
export async function generateEd25519(): Promise<{
  privatePkcs8Pem: string;
  publicRawB64url: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey(
    "pkcs8",
    pair.privateKey,
  )) as ArrayBuffer;
  const rawPub = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;
  return {
    privatePkcs8Pem: pkcs8ToPem(pkcs8),
    publicRawB64url: b64urlEncode(new Uint8Array(rawPub)),
  };
}
