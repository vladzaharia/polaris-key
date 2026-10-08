/**
 * Byte encodings: base64url, standard base64, hex and the ArrayBuffer copy WebCrypto wants.
 *
 * ONE implementation of each (P0-15). Before this module the Worker carried about two dozen
 * private base64url encoders and decoders and some forty inline hex loops, because the one in
 * `crypto.ts` was private and a service may import only `core/`. They all agreed on the encoder;
 * the decoders did not, so the decoders below are named for the inputs they accept rather than
 * merged into one: a caller picks the semantics it had, and `test/platformPrimitives.test.ts`
 * refuses a new local copy.
 *
 * A leaf module: it imports nothing else in `src/` (the `platform/` layer rule).
 */

/** A standalone `ArrayBuffer` holding exactly `b`'s bytes (a view's offset and length kept). */
export function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

/** `s` as UTF-8 bytes. */
export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function asBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Bytes as a binary string (one char per byte), the shape `btoa` takes. */
function toBinaryString(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return bin;
}

/** A binary string (what `atob` returns) as bytes. */
function fromBinaryString(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── standard base64 (RFC 4648 §4, padded) ───────────────────────────────────────────────────

/** Bytes as standard, padded base64 (`+`, `/`, `=`). */
export function base64Encode(bytes: Uint8Array | ArrayBuffer): string {
  return btoa(toBinaryString(asBytes(bytes)));
}

/**
 * Standard base64 to bytes, with exactly `atob`'s (WHATWG forgiving-base64) leniency: ASCII
 * whitespace is ignored and complete padding may be omitted. Throws on anything else.
 */
export function base64Decode(s: string): Uint8Array {
  return fromBinaryString(atob(s));
}

// ── base64url (RFC 4648 §5, unpadded) ───────────────────────────────────────────────────────

/** Bytes as unpadded base64url: the token, cookie, PKCE and JWS-segment alphabet. */
export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  return base64Encode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** `s`'s UTF-8 bytes as unpadded base64url. */
export function b64urlEncodeUtf8(s: string): string {
  return b64urlEncode(utf8Encode(s));
}

/**
 * base64url to bytes, leniently: maps `-`/`_` to `+`/`/`, restores the padding, and decodes
 * with `atob`, so standard-alphabet and already-padded input are also accepted. Throws on
 * anything `atob` refuses. For untrusted input that must be canonical, use `b64urlDecodeStrict`.
 */
export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64Decode(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

/** `b64urlDecode`, then UTF-8 (a malformed sequence decodes to U+FFFD; it does not throw). */
export function b64urlDecodeUtf8(s: string): string {
  return new TextDecoder().decode(b64urlDecode(s));
}

/**
 * base64url to bytes, strictly: only `[A-Za-z0-9_-]`, no padding, no whitespace, and never a
 * length that leaves one dangling character. `null` instead of throwing.
 */
export function b64urlDecodeStrict(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    return b64urlDecode(s);
  } catch {
    return null;
  }
}

// ── hex ─────────────────────────────────────────────────────────────────────────────────────

/** Bytes as lower-case hex, two digits a byte. */
export function hexEncode(bytes: Uint8Array | ArrayBuffer): string {
  let out = "";
  for (const b of asBytes(bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Hex (either case, even length, at least one byte) to bytes; `null` for anything else. */
export function hexDecode(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
