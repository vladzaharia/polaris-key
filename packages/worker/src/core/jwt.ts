/// <reference types="@cloudflare/workers-types" />

/**
 * The Worker's JWT signers: ES256 (ECDSA P-256 / SHA-256) and RS256 (RSASSA-PKCS1-v1_5 /
 * SHA-256), hand-rolled over WebCrypto (P5-01), and HS256 (HMAC-SHA-256) for the R2 temporary
 * credentials P2-02's upload tickets mint (`core/publisher.ts`).
 *
 * Before this file the Worker carried two copies of the RS256 path — `rsaToPkcs8` + `signRs256`
 * in `services/config/mint.ts`, and `toPkcs8` + `signAppJwt` in `services/release/githubApp.ts`
 * — and the ES256 path lived only in `mint.ts`. The store connectors (App Store Connect, Google
 * Play) would have made a third and a fourth. Edge-mint, the GitHub App client and the outlet
 * token helpers (`core/outletTokens.ts`) all sign here now.
 *
 * SIGNING ONLY. Nothing here verifies, caches or fetches. The code is deliberately not `jose`'s
 * `SignJWT`: `edgeMint.test.ts` pins the header shape and key order (`{alg, typ, kid?}`), and
 * the GitHub App JWT must keep its exact bytes, so the encoding stays under our control.
 *
 * An EdDSA JWT is not here on purpose: that is a compact JWS, and `@polaris-key/jws` owns it.
 */

import {
  b64urlEncode,
  b64urlEncodeUtf8,
  toArrayBuffer,
} from "../platform/bytes.js";

/** Strip PEM armor + whitespace and decode the base64 body to raw DER bytes. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a DER tag+length prefix (definite form) for a body of `n` bytes. */
function derLen(tag: number, n: number): number[] {
  if (n < 0x80) return [tag, n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [tag, 0x80 | bytes.length, ...bytes];
}

/**
 * RSA private keys may arrive as PKCS#1 (`BEGIN RSA PRIVATE KEY`, how GitHub distributes App
 * keys); WebCrypto only imports PKCS#8, so wrap PKCS#1 DER in the PKCS#8 PrivateKeyInfo
 * envelope (the fixed rsaEncryption AlgorithmIdentifier prefix). An existing PKCS#8
 * (`BEGIN PRIVATE KEY`, how Google distributes service-account keys) passes through as-is.
 */
function rsaToPkcs8(pem: string): ArrayBuffer {
  const der = pemToDer(pem);
  if (/BEGIN PRIVATE KEY/.test(pem)) return toArrayBuffer(der);
  // PKCS#8 = SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption NULL, OCTET STRING pkcs1 }
  const rsaOid = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const octetHeader = derLen(0x04, der.length);
  const inner = [...version, ...rsaOid, ...octetHeader, ...der];
  const seq = [...derLen(0x30, inner.length), ...inner];
  return toArrayBuffer(Uint8Array.from(seq));
}

/** Import an ES256 signing key from a PKCS#8 PEM. THROWS unless it is a P-256 PKCS#8 key —
 *  which is also how the outlet-credential store validates an App Store Connect `.p8`. */
export async function importEs256PrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(pemToDer(pem)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** Import an RS256 signing key from a PKCS#1 or PKCS#8 PEM. THROWS on anything else. */
export async function importRs256PrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    rsaToPkcs8(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** `b64url(header) + "." + b64url(payload)`, with the header in the pinned key order. */
function signingInput(
  alg: "ES256" | "RS256" | "HS256",
  payload: Record<string, unknown>,
  kid: string | undefined,
): string {
  const header = { alg, typ: "JWT", ...(kid ? { kid } : {}) };
  return (
    b64urlEncodeUtf8(JSON.stringify(header)) +
    "." +
    b64urlEncodeUtf8(JSON.stringify(payload))
  );
}

/**
 * Sign an ES256 JWT. Header `{alg:"ES256", typ:"JWT", kid?}`; WebCrypto returns the raw `r||s`
 * signature JWS ES256 wants (not DER), so no conversion is needed.
 */
export async function signJwtEs256(
  payload: Record<string, unknown>,
  pem: string,
  kid?: string,
): Promise<string> {
  const input = signingInput("ES256", payload, kid);
  const key = await importEs256PrivateKey(pem);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toArrayBuffer(new TextEncoder().encode(input)),
  );
  return input + "." + b64urlEncode(sig);
}

/**
 * Sign an RS256 JWT. Header `{alg:"RS256", typ:"JWT", kid?}`. Accepts a PKCS#1 or PKCS#8 PEM.
 * RSASSA-PKCS1-v1_5 is deterministic, so the same key, payload and kid always give the same
 * bytes — which is what lets the tests pin the GitHub App JWT exactly.
 */
export async function signJwtRs256(
  payload: Record<string, unknown>,
  pem: string,
  kid?: string,
): Promise<string> {
  const input = signingInput("RS256", payload, kid);
  const key = await importRs256PrivateKey(pem);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    toArrayBuffer(new TextEncoder().encode(input)),
  );
  return input + "." + b64urlEncode(sig);
}

/**
 * Sign an HS256 JWT with a shared secret (the raw UTF-8 bytes of `secret` are the HMAC key).
 * Header `{alg:"HS256", typ:"JWT"}`. Used for R2 temporary credentials (P2-02): R2 verifies the
 * JWT with the parent access key's secret, so the secret never leaves the Worker.
 */
export async function signJwtHs256(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const input = signingInput("HS256", payload, undefined);
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(new TextEncoder().encode(input)),
  );
  return input + "." + b64urlEncode(sig);
}
