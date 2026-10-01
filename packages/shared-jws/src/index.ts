// @polaris-key/jws — the FROZEN Polaris Key wire crypto: compact JWS (EdDSA / Ed25519)
// encode + verify, implemented on WebCrypto so the SAME code runs in workerd (the Worker
// signer) and Node 22 (SDKs/tools). The cross-language conformance corpus pins this
// byte-for-byte; the Swift/Python SDKs re-implement the identical construction natively.
//
//   protected header = {"alg":"EdDSA","typ":<typ>,"kid":<kid>}   (key order fixed: alg, typ, kid)
//   signingInput     = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
//   signature        = Ed25519 over the ASCII bytes of signingInput
//   compact JWS      = signingInput "." base64url(signature)
//
// SECURITY: the verifying key is selected by the header `kid` from a caller-supplied
// trust set, NEVER from the document; `alg` is asserted `EdDSA` before any signature math
// so a `none`/HMAC downgrade is rejected.
//
// Wire contract v4 (docs/security/WIRE-CONTRACT-V4.md §1.1, §1.2) makes the verifier strict
// for every `typ`: byte-level Ed25519 pre-checks (`S < L`, canonical `A` and `R`, no
// small-order `A` or `R`) before WebCrypto's cofactorless verify, and an I-JSON profile for the
// header and the payload (`scanStrictJson`). The scan also reports `nonWireIntegers`, the RFC
// 6901 pointers of every number token that cannot be a wire integer, from which every integer
// claim is decided (V4 §3).

import { MAX_JSON_DEPTH } from "@polaris-key/protocol/core";

export { MAX_JSON_DEPTH };

export interface JwsHeader {
  alg: "EdDSA";
  /** Document type, for domain separation across the doc kinds sharing this envelope. */
  typ?: JwsTyp;
  kid: string;
}

/**
 * Document-type domain separator. One signing key signs every document kind, so without this
 * a trust manifest could be replayed where a config document is expected.
 * See docs/security/WIRE-CONTRACT-V3.md §2.
 *
 * `pkey-config+jws` and `pkey-trust+jws` carry over verbatim from wire contract v2 — the
 * document *shapes* changed in v3, the type strings did not (Amendment A1; pre-launch, and
 * corpus v1 is gone, so no dual-shape ambiguity ever shipped).
 */
export type JwsTyp =
  | "pkey-license+jws"
  | "pkey-config+jws"
  | "pkey-trust+jws"
  | "pkey-bundle+jws"
  /** Wire contract v4 §2.3: the channel feed, signed by the product key. */
  | "pkey-feed+jws"
  /** Wire contract v4 §2.4: the release record, signed by a CI-held release key. */
  | "pkey-release+jws";

export interface VerifyOptions {
  /**
   * Require this `typ` (WIRE-CONTRACT-V3 §2). A header carrying a DIFFERENT type is rejected,
   * and so is a header carrying NONE — there is no tolerance for an absent `typ`, because a
   * typeless artifact is exactly the one that can be replayed at whichever call site an
   * attacker prefers.
   *
   * Omitting this asks for no domain separation at all, which no shipping call site does.
   */
  typ?: JwsTyp;
  /**
   * RAISE the decoded-payload cap for this call only, and with it the encoded-length
   * pre-check derived from it. Exists for exactly one artifact: `pkey-bundle+jws`, whose
   * payload wraps up to three inner compact JWSs and is capped at 262 144 bytes instead of
   * 65 536 (WIRE-CONTRACT-V3 §1). The caller passes the cap explicitly for that `typ`;
   * nothing else in the system may.
   *
   * The option can only ever raise: the effective cap is `max(MAX_DOC_BYTES, this)`, so a
   * value below the frozen 64 KiB default is inert rather than silently tightening one call
   * site out of step with the wire contract. Absent (or non-finite) ⇒ byte-identical to the
   * cap-less behavior. The HEADER cap is untouched — moving a blob into the header is R2-04,
   * and no `typ` widens it.
   */
  maxPayloadBytes?: number;
}

export interface VerifiedJws<T> {
  kid: string;
  payload: T;
  /**
   * WIRE-CONTRACT-V4 §3: the RFC 6901 pointer of every number token in the PAYLOAD that cannot
   * be a wire integer, because it has a fraction or an exponent part or its digits exceed
   * 2^53 − 1 in magnitude. An integer claim at one of these pointers is refused, whatever
   * number `JSON.parse` made of it (`7.0`, `17e8` and `1700000000.00000001` all read as
   * integers in JavaScript).
   */
  nonWireIntegers: ReadonlySet<string>;
}

/** A trust set: `kid` → raw 32-byte Ed25519 public key, base64url-encoded. */
export type TrustSet = Record<string, string>;

const enc = new TextEncoder();
/** WIRE-CONTRACT-V4 §1.2 rules 1–2: ill-formed UTF-8 throws, and a leading BOM is kept (so the
 *  check below can refuse it) rather than silently stripped. */
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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

/**
 * The decoded-payload cap in force for one `verifyJws` call. `VerifyOptions.maxPayloadBytes`
 * may only RAISE it (`pkey-bundle+jws` at 262 144, §1); a smaller or non-finite request leaves
 * the frozen 64 KiB default in place, so no call site can quietly tighten below the contract.
 */
function payloadCapFor(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return MAX_DOC_BYTES;
  }
  return Math.max(MAX_DOC_BYTES, Math.floor(requested));
}

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
export function hasDuplicateKeys(text: string): boolean {
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

// ── Strict JSON (WIRE-CONTRACT-V4 §1.2) ─────────────────────────────────────────────────────

/** The plain integer token of an integer claim (V4 §3 rule 1). */
const PLAIN_INTEGER_RE = /^-?(0|[1-9][0-9]*)$/;
const MAX_WIRE_DIGITS = "9007199254740991";

/**
 * V4 §1.2 rule 8, judged exactly from the token's decimal digits with no floating point: zero,
 * or a magnitude of at least 10^−307 and below 10^308. An exponent of more than six significant
 * digits is out of range outright.
 */
export function numberTokenInRange(token: string): boolean {
  const m = /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?$/.exec(token);
  if (!m) return false;
  const int = m[1]!;
  const digits = int + (m[2] ?? "");
  const first = digits.search(/[1-9]/);
  if (first === -1) return true;
  const expDigits = (m[4] ?? "0").replace(/^0+/, "");
  if (expDigits.length > 6) return false;
  const exp = (m[3] === "-" ? -1 : 1) * Number(expDigits || "0");
  const power = int.length - 1 - first + exp;
  return power >= -307 && power <= 307;
}

/** True when a number token cannot be a wire integer: a fraction or exponent part, or digits
 *  above 2^53 − 1 in magnitude (V4 §3). */
export function isNonWireIntegerToken(token: string): boolean {
  if (!PLAIN_INTEGER_RE.test(token)) return true;
  const digits = token.replace(/^-/, "");
  return (
    digits.length > MAX_WIRE_DIGITS.length ||
    (digits.length === MAX_WIRE_DIGITS.length && digits > MAX_WIRE_DIGITS)
  );
}

/** RFC 6901 reference token: `~` is written `~0`, then `/` is written `~1`. */
function pointerToken(name: string): string {
  return name.replace(/~/g, "~0").replace(/\//g, "~1");
}

export interface StrictJsonScan {
  ok: boolean;
  /** Sorted in JavaScript's default string order; empty when `ok` is false. */
  nonWireIntegers: string[];
}

class StrictJsonRefused extends Error {}

/** One RFC 8259 number token, matched in place (sticky). */
const NUMBER_TOKEN_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * Scan one JSON text under WIRE-CONTRACT-V4 §1.2 without building a value. Refuses anything
 * that is not exactly one JSON object under RFC 8259's grammar (no `NaN`/`Infinity`, no
 * comment, no trailing comma, no leading BOM), an unescaped U+0000–U+001F in a string, a lone
 * surrogate (escaped or raw), a duplicate member name (compared after unescaping, by UTF-16
 * unit, which is scalar order once lone surrogates are refused; never normalized), U+0000 in a
 * member name, a number outside rule 8's range, and nesting past `MAX_JSON_DEPTH` levels
 * (the top-level object is level 1). Reports the pointer of every number token that cannot be
 * a wire integer. Exported for P3-12's signer guard and P3-03's feed composer.
 */
export function scanStrictJson(text: string): StrictJsonScan {
  let i = 0;
  const nonWire: string[] = [];
  const refuse = (): never => {
    throw new StrictJsonRefused();
  };
  const ws = (): void => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const hex4 = (): number => {
    const h = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) refuse();
    i += 4;
    return parseInt(h, 16);
  };
  const str = (): string => {
    if (text.charCodeAt(i) !== 0x22) refuse();
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) refuse();
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        break;
      }
      if (c < 0x20) refuse();
      if (c === 0x5c) {
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u":
            out += String.fromCharCode(hex4());
            break;
          default:
            refuse();
        }
        continue;
      }
      out += text[i];
      i++;
    }
    // Rule 5: no lone surrogate, however it was written.
    for (let k = 0; k < out.length; k++) {
      const u = out.charCodeAt(k);
      if (u >= 0xd800 && u <= 0xdbff) {
        const n = out.charCodeAt(k + 1);
        if (n >= 0xdc00 && n <= 0xdfff) {
          k++;
          continue;
        }
        refuse();
      } else if (u >= 0xdc00 && u <= 0xdfff) refuse();
    }
    return out;
  };
  const num = (pointer: string): void => {
    NUMBER_TOKEN_RE.lastIndex = i;
    const m = NUMBER_TOKEN_RE.exec(text);
    if (!m) refuse();
    const token = m![0];
    i += token.length;
    if (!numberTokenInRange(token)) refuse();
    if (isNonWireIntegerToken(token)) nonWire.push(pointer);
  };
  const value = (depth: number, pointer: string): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      if (depth + 1 > MAX_JSON_DEPTH) refuse();
      i++;
      const names = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        const name = str();
        if (name.indexOf("\u0000") !== -1) refuse();
        if (names.has(name)) refuse();
        names.add(name);
        ws();
        if (text[i] !== ":") refuse();
        i++;
        value(depth + 1, `${pointer}/${pointerToken(name)}`);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return;
        }
        refuse();
      }
    }
    if (c === "[") {
      if (depth + 1 > MAX_JSON_DEPTH) refuse();
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (let index = 0; ; index++) {
        value(depth + 1, `${pointer}/${index}`);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return;
        }
        refuse();
      }
    }
    if (c === '"') {
      str();
      return;
    }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      num(pointer);
      return;
    }
    for (const lit of ["true", "false", "null"]) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return;
      }
    }
    refuse();
  };
  try {
    ws();
    if (text[i] !== "{") return { ok: false, nonWireIntegers: [] };
    value(0, "");
    ws();
    if (i !== text.length) return { ok: false, nonWireIntegers: [] };
    return { ok: true, nonWireIntegers: nonWire.sort() };
  } catch (e) {
    if (e instanceof StrictJsonRefused || e instanceof RangeError)
      return { ok: false, nonWireIntegers: [] };
    throw e;
  }
}

/** Decode and parse one header or payload under V4 §1.2. Returns null on any failure. */
function parseStrictJson<T>(
  bytes: Uint8Array,
): { value: T; nonWireIntegers: string[] } | null {
  let text: string;
  try {
    text = dec.decode(bytes);
  } catch {
    return null; // rule 1: ill-formed UTF-8
  }
  if (text.charCodeAt(0) === 0xfeff) return null; // rule 2: no leading BOM
  const scan = scanStrictJson(text);
  if (!scan.ok) return null;
  try {
    return {
      value: JSON.parse(text) as T,
      nonWireIntegers: scan.nonWireIntegers,
    };
  } catch {
    return null;
  }
}

// ── Ed25519 strictness (WIRE-CONTRACT-V4 §1.1) ──────────────────────────────────────────────

/** The group order L = 2^252 + 27742317777372353535851937790883648493. */
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;
/** The field prime p = 2^255 − 19. */
const ED25519_P = (1n << 255n) - 19n;

/**
 * The eight small-order point encodings, lowercase hex (checked with noble on 2026-10-01):
 * order 1, order 2, the two of order 4, and the four of order 8. A key or an `R` equal to one
 * of them is refused before any signature math (V4 §1.1 check 3).
 */
export const SMALL_ORDER_ENCODINGS: readonly string[] = [
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
];

/** The two "x = 0 with the sign bit set" encodings, which name no point (check 2). */
const NEGATIVE_ZERO_ENCODINGS: readonly string[] = [
  "0100000000000000000000000000000000000000000000000000000000000080",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
];

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let k = bytes.length - 1; k >= 0; k--) n = (n << 8n) | BigInt(bytes[k]!);
  return n;
}

/** V4 §1.1 checks 2 and 3 for one 32-byte point encoding (`A` or `R`). */
function isAcceptablePoint(enc32: Uint8Array): boolean {
  if (enc32.length !== 32) return false;
  const y = littleEndian(enc32) & ((1n << 255n) - 1n);
  if (y >= ED25519_P) return false;
  const hex = hexOf(enc32);
  if (NEGATIVE_ZERO_ENCODINGS.includes(hex)) return false;
  return !SMALL_ORDER_ENCODINGS.includes(hex);
}

/**
 * WIRE-CONTRACT-V4 §1.1 checks 1–3, on the trusted key `A` and the 64-byte signature `R ‖ S`,
 * before the backend's verify call: `S < L`, `A` and `R` canonical, neither of small order.
 * Byte comparisons only, so a lenient backend never accepts what a strict one refuses.
 */
export function ed25519Prechecks(key: Uint8Array, sig: Uint8Array): boolean {
  if (key.length !== 32 || sig.length !== 64) return false;
  if (littleEndian(sig.subarray(32, 64)) >= ED25519_L) return false;
  return isAcceptablePoint(key) && isAcceptablePoint(sig.subarray(0, 32));
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
  const maxPayloadBytes = payloadCapFor(opts.maxPayloadBytes);
  if (encHeader.length > MAX_HEADER_B64) return null;
  if (encPayload.length > b64Cap(maxPayloadBytes)) return null;

  // --- 2. Header: strict decode, bound, parse with duplicate-key rejection. --------------
  const headerBytes = base64UrlDecodeStrict(encHeader);
  if (!headerBytes || headerBytes.byteLength > MAX_HEADER_BYTES) return null;
  const parsedHeader = parseStrictJson<{
    alg?: unknown;
    typ?: unknown;
    kid?: unknown;
  }>(headerBytes);
  // A non-object header (`"x"`, `1`, `null`) must fail here, not on property access.
  const header = parsedHeader?.value;
  if (!header || typeof header !== "object") return null;

  // --- 3. Algorithm + type + key selection, all BEFORE any signature math. ---------------
  if (header.alg !== "EdDSA") return null;
  // Domain separation (WIRE-CONTRACT-V3 §2). Once the caller names a `typ`, a header carrying
  // a DIFFERENT one and a header carrying NONE are both rejected: tolerating absence would
  // leave every typeless artifact replayable at whichever call site an attacker prefers,
  // which is the cross-protocol replay this field exists to close.
  if (opts.typ !== undefined && header.typ !== opts.typ) return null;
  if (header.typ !== undefined && typeof header.typ !== "string") return null;
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
  // WIRE-CONTRACT-V4 §1.1: S < L, canonical A and R, no small-order A or R. OpenSSL (Node's
  // WebCrypto) accepts a non-canonical or small-order key, and every backend accepts a
  // small-order R, so the checks run here, before the backend sees the signature.
  if (!ed25519Prechecks(base64UrlDecode(rawKey), sigBytes)) return null;
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
  if (!payloadBytes || payloadBytes.byteLength > maxPayloadBytes) return null;
  const parsed = parseStrictJson<T>(payloadBytes);
  if (parsed === null) return null;

  return {
    kid: header.kid,
    payload: parsed.value,
    nonWireIntegers: new Set(parsed.nonWireIntegers),
  };
}

/** SHA-256 base64url over arbitrary bytes (ETag / JWKS thumbprint helper). */
export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return base64UrlEncode(new Uint8Array(digest));
}
