// @plrs/jws — the FROZEN Polaris Key wire crypto: compact JWS (EdDSA / Ed25519)
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
  /** Document type, for domain separation across the doc kinds sharing this envelope. */
  typ?: JwsTyp;
  kid: string;
}

/**
 * Document-type domain separator (wire contract v2). One signing key signs BOTH config docs
 * and trust manifests, so without this a manifest could be replayed where a config doc is
 * expected. See docs/security/WIRE-CONTRACT-V2.md §2.4.
 */
export type JwsTyp =
  // Wire contract v2 (legacy; removed in P8 once no signer/verifier emits them)
  | "pkey-config+jws"
  | "pkey-trust+jws"
  // Wire contract v3 (docs/security/WIRE-CONTRACT-V3.md §2)
  | "plrs-license+jws"
  | "plrs-config+jws"
  | "plrs-trust+jws"
  | "plrs-bundle+jws";

export interface VerifyOptions {
  /**
   * Require this `typ`. When omitted, a header carrying NO `typ` is accepted (v1
   * compatibility) but a header carrying a DIFFERENT one is still rejected — so the
   * cross-protocol replay is closed immediately, before `typ` becomes mandatory.
   */
  typ?: JwsTyp;
  /**
   * Wire contract v3 §2: a missing `typ` is REJECTED, not tolerated. v3 verifiers
   * (client-core) set this; v2 call sites keep the v1-compat tolerance until they and
   * corpus v1 are retired in P8, at which point this becomes the only behavior.
   */
  requireTyp?: boolean;
}

export interface VerifiedJws<T> {
  kid: string;
  payload: T;
}

/** A trust set: `kid` → raw 32-byte Ed25519 public key, base64url-encoded. */
export type TrustSet = Record<string, string>;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Hard cap on the decoded payload size before we hand it to `JSON.parse`. A multi-megabyte
 * payload would otherwise let an attacker drive a JSON-parse memory/CPU DoS on the verifier.
 * 64 KiB comfortably exceeds any legitimate Polaris Key config doc. (Per-SDK caps in the
 * node/python/swift mirrors are handled separately; this only guards the TS shared core.)
 */
const MAX_DOC_BYTES = 65536;

/**
 * Hard cap on the decoded PROTECTED HEADER. A legitimate header is ~60 bytes. Without this,
 * the payload cap above is trivially bypassed by moving the blob into the header instead —
 * an 8 MiB header was decoded and JSON-parsed pre-verification (audit finding R2-04).
 */
const MAX_HEADER_BYTES = 1024;

/** Encoded-form caps, checked BEFORE decoding so an oversized blob is never allocated. */
const b64Cap = (bytes: number): number => Math.ceil((bytes * 4) / 3) + 4;
const MAX_HEADER_B64 = b64Cap(MAX_HEADER_BYTES);
const MAX_PAYLOAD_B64 = b64Cap(MAX_DOC_BYTES);

/** The base64url alphabet, unpadded. Nothing else is a valid JWS segment. */
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * Strict base64url decode: rejects `+`, `/`, `=`, whitespace and any other out-of-alphabet
 * byte instead of silently discarding it. Python's `urlsafe_b64decode(validate=False)` used to
 * accept junk that Node and Swift rejected, making one SDK accept wire bytes the others refused
 * (audit finding R2-05). Returns null rather than throwing.
 */
function base64UrlDecodeStrict(s: string): Uint8Array | null {
  if (!B64URL_RE.test(s)) return null;
  try {
    return base64UrlDecode(s);
  } catch {
    return null;
  }
}

/**
 * True if any JSON object in `text` declares the same key twice.
 *
 * `JSON.parse` cannot help here: it collapses duplicates before a reviver ever runs, and the
 * languages disagree about WHICH one wins — TS and Python keep the last, Swift's
 * `JSONSerialization` keeps the first (audit finding R2-06). That makes
 * `{"alg":"none",…,"alg":"EdDSA"}` read as `EdDSA` in TS/Python and `none` in Swift: the
 * algorithm-downgrade guard returning opposite answers per language. The only safe resolution
 * is to reject, so every implementation agrees.
 *
 * Scans the raw text tracking one key-set per open object (null marks an array, whose commas
 * do not introduce keys).
 */
function hasDuplicateKeys(text: string): boolean {
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = ++i;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') break;
        i++;
      }
      const literal = text.slice(start, i);
      i++;
      if (expectKey) {
        const top = stack[stack.length - 1];
        if (top) {
          let key: string;
          try {
            key = JSON.parse(`"${literal}"`) as string;
          } catch {
            return true; // unparseable key — refuse rather than guess
          }
          if (top.has(key)) return true;
          top.add(key);
        }
        expectKey = false;
      }
      continue;
    }
    if (c === "{") {
      stack.push(new Set<string>());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
      expectKey = false;
    } else if (c === "}" || c === "]") {
      stack.pop();
      expectKey = false;
    } else if (c === ",") {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
    i++;
  }
  return false;
}

/** Parse JSON, rejecting duplicate object keys. Returns null on any failure. */
function parseStrictJson<T>(bytes: Uint8Array): T | null {
  let text: string;
  try {
    text = dec.decode(bytes);
  } catch {
    return null;
  }
  if (hasDuplicateKeys(text)) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

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
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
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
export async function importVerifyKey(
  rawBase64Url: string,
): Promise<CryptoKey> {
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
  typ?: JwsTyp,
): Promise<string> {
  // Key order is part of the frozen wire contract. When `typ` is omitted the emitted bytes are
  // byte-identical to v1, so every existing corpus case still round-trips; when present it sits
  // between `alg` and `kid`.
  const header: JwsHeader = typ
    ? { alg: "EdDSA", typ, kid }
    : { alg: "EdDSA", kid };
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
  opts: VerifyOptions = {},
): Promise<VerifiedJws<T> | null> {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSig] = parts as [string, string, string];

  // --- 1. Bound the ENCODED segments before decoding anything (R2-04). -------------------
  if (encHeader.length > MAX_HEADER_B64) return null;
  if (encPayload.length > MAX_PAYLOAD_B64) return null;

  // --- 2. Header: strict decode, bound, parse with duplicate-key rejection. --------------
  const headerBytes = base64UrlDecodeStrict(encHeader);
  if (!headerBytes || headerBytes.byteLength > MAX_HEADER_BYTES) return null;
  const header = parseStrictJson<{
    alg?: unknown;
    typ?: unknown;
    kid?: unknown;
  }>(headerBytes);
  // A non-object header (`"x"`, `1`, `null`) must fail here, not on property access.
  if (!header || typeof header !== "object") return null;

  // --- 3. Algorithm + type + key selection, all BEFORE any signature math. ---------------
  if (header.alg !== "EdDSA") return null;
  // Domain separation. An absent `typ` is tolerated for v1 compatibility, but a header
  // asserting a DIFFERENT type is rejected outright — that closes cross-protocol replay
  // (a trust manifest presented where a config doc is expected) immediately.
  if (header.typ === undefined) {
    // Wire v3 verifiers demand a typ (WIRE-CONTRACT-V3 §2); v2 tolerates absence.
    if (opts.requireTyp) return null;
  } else {
    if (typeof header.typ !== "string") return null;
    if (opts.typ !== undefined && header.typ !== opts.typ) return null;
  }
  if (typeof header.kid !== "string") return null;
  const rawKey = trustedKeys[header.kid];
  if (!rawKey) return null;

  let key: CryptoKey;
  try {
    key = await importVerifyKey(rawKey);
  } catch {
    return null;
  }

  // --- 4. Verify the signature. Everything below this line is authenticated bytes. -------
  // Must fail CLOSED: an out-of-alphabet signature segment and a WebCrypto rejection both
  // become `null`, matching the Python/Swift mirrors — never a thrown error.
  const sigBytes = base64UrlDecodeStrict(encSig);
  if (!sigBytes) return null;
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      toArrayBuffer(sigBytes),
      toArrayBuffer(enc.encode(encHeader + "." + encPayload)),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  // --- 5. ONLY NOW parse the payload. ----------------------------------------------------
  // Previously this ran before the signature check, so every caller JSON-parsed attacker
  // bytes for free. Swift already had this ordering; TS and Python did not (R2-04).
  const payloadBytes = base64UrlDecodeStrict(encPayload);
  if (!payloadBytes || payloadBytes.byteLength > MAX_DOC_BYTES) return null;
  const payload = parseStrictJson<T>(payloadBytes);
  if (payload === null) return null;

  return { kid: header.kid, payload };
}

/** SHA-256 base64url over arbitrary bytes (ETag / JWKS thumbprint helper). */
export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return base64UrlEncode(new Uint8Array(digest));
}
