// @polaris-key/jws — the FROZEN Polaris Key wire crypto: compact JWS (EdDSA / Ed25519)
// encode + verify, implemented on WebCrypto so the SAME code runs in workerd (the Worker
// signer) and Node 22 (SDKs/tools). The cross-language conformance corpus pins this
// byte-for-byte; the Swift/Python SDKs re-implement the identical construction natively.
//
//   protected header = {"alg":"EdDSA","kid":<kid>}            (key order fixed)
//   signingInput     = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
//   signature        = Ed25519 over the ASCII bytes of signingInput
//   compact JWS      = signingInput "." base64url(signature)
//
// SECURITY: the verifying key is selected by the header `kid` from a caller-supplied
// trust set, NEVER from the document; `alg` is asserted `EdDSA` before any signature math
// so a `none`/HMAC downgrade is rejected.

export interface JwsHeader {
  alg: "EdDSA";
  kid: string;
}

export interface VerifiedJws<T> {
  kid: string;
  payload: T;
}

/** A trust set: `kid` → raw 32-byte Ed25519 public key, base64url-encoded. */
export type TrustSet = Record<string, string>;

const enc = new TextEncoder();
const dec = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(enc.encode(s));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a base64url string (handles missing padding + the `-_` alphabet). */
export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return base64ToBytes(pad);
}

/** Encode bytes as base64url (unpadded). Exposed for ETag/thumbprint callers. */
export function base64UrlEncodeBytes(bytes: Uint8Array): string {
  return base64UrlEncode(bytes);
}

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

/** Import an Ed25519 PKCS#8 PEM as a WebCrypto signing key. */
export async function importSigningKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(pemToPkcs8(pem)),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

/** Import a 32-byte raw Ed25519 public key (base64url) for verification. */
export async function importVerifyKey(rawBase64Url: string): Promise<CryptoKey> {
  const raw = base64UrlDecode(rawBase64Url);
  if (raw.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

/** Sign an arbitrary JSON-serialisable payload into a compact JWS. */
export async function signJws(
  payload: unknown,
  signingKeyPem: string,
  kid: string,
): Promise<string> {
  const header: JwsHeader = { alg: "EdDSA", kid };
  const signingInput =
    base64UrlEncodeString(JSON.stringify(header)) +
    "." +
    base64UrlEncodeString(JSON.stringify(payload));
  const key = await importSigningKey(signingKeyPem);
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    toArrayBuffer(enc.encode(signingInput)),
  );
  return signingInput + "." + base64UrlEncode(new Uint8Array(sig));
}

/**
 * Verify a compact JWS against a trust set, returning the decoded `kid` + payload or
 * `null` on ANY failure (malformed, unknown `kid`, wrong `alg`, bad signature). The
 * signature is checked over the ASCII bytes of `encHeader.encPayload` exactly as
 * received — the payload is never re-serialised, so cross-language verification is
 * byte-stable.
 */
export async function verifyJws<T = unknown>(
  jws: string,
  trustedKeys: TrustSet,
): Promise<VerifiedJws<T> | null> {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSig] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  let payload: T;
  try {
    header = JSON.parse(dec.decode(base64UrlDecode(encHeader)));
    payload = JSON.parse(dec.decode(base64UrlDecode(encPayload))) as T;
  } catch {
    return null;
  }

  if (header.alg !== "EdDSA" || typeof header.kid !== "string") return null;
  const rawKey = trustedKeys[header.kid];
  if (!rawKey) return null;

  let key: CryptoKey;
  try {
    key = await importVerifyKey(rawKey);
  } catch {
    return null;
  }

  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    toArrayBuffer(base64UrlDecode(encSig)),
    toArrayBuffer(enc.encode(encHeader + "." + encPayload)),
  );
  if (!ok) return null;
  return { kid: header.kid, payload };
}

/** SHA-256 base64url over arbitrary bytes (ETag / JWKS thumbprint helper). */
export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return base64UrlEncode(new Uint8Array(digest));
}
