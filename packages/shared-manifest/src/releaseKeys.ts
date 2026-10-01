/**
 * `.pkey/release` `releaseKeys` (P3-03, plans/P3-01.md §3): the Ed25519 public keys a product's
 * CI signs release records with (`pkey-release+jws`, WIRE-CONTRACT-V4 §2.4).
 *
 * A release key is NEVER a product signing key: the Worker holds the private half of every
 * product key, so a product key declared here would let the Worker mint records and the
 * two-signer property (README §3.3) would be gone without a trace. The validator cannot see a
 * product's signing keys, so that check runs in the Worker at sync
 * (`release_key_is_product_key`); this module checks what one document can: the encoding, the
 * point (V4 §1.1 checks 2–3), duplicates, and reuse of the Sparkle archive key.
 */

/** At most this many keys at once: two during a rotation, with room for a staged third. */
export const MAX_RELEASE_KEYS = 4;
/** A release key's `kid`: the JWS header `kid` CI signs with. */
export const RELEASE_KEY_KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * A raw 32-byte Ed25519 public key in unpadded base64url, the `TrustSet` encoding: 43
 * characters whose last one carries no stray low bits, so one key has exactly one spelling.
 */
export const RELEASE_KEY_PUBLIC_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** One declared release key, as persisted to `release_config.release_keys_json`. */
export interface ManifestReleaseKey {
  kid: string;
  /** Raw Ed25519 public key, base64url (43 characters). */
  publicKey: string;
}

/** The field prime p = 2^255 − 19. */
const ED25519_P = (1n << 255n) - 19n;

/** The eight small-order encodings and the two "negative zero" encodings, lowercase hex (the
 *  same lists as `@polaris-key/jws`, which this package does not depend on; a test pins them). */
export const WEAK_POINT_ENCODINGS: readonly string[] = [
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  "0100000000000000000000000000000000000000000000000000000000000080",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Decode base64 or base64url (padding optional) without `atob`, so the validator runs the same
 * in every runtime. `null` for a character outside both alphabets or an impossible length.
 */
export function decodeBase64Loose(s: string): Uint8Array | null {
  const body = s.replace(/=+$/, "");
  if (body.length % 4 === 1) return null;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of body) {
    let v: number;
    if (ch === "+" || ch === "-") v = 62;
    else if (ch === "/" || ch === "_") v = 63;
    else {
      v = B64.indexOf(ch);
      if (v < 0) return null;
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The raw key bytes of a well-formed `publicKey`, or `null`. */
export function releaseKeyBytes(publicKey: unknown): Uint8Array | null {
  if (
    typeof publicKey !== "string" ||
    !RELEASE_KEY_PUBLIC_PATTERN.test(publicKey)
  )
    return null;
  const bytes = decodeBase64Loose(publicKey);
  return bytes && bytes.length === 32 ? bytes : null;
}

/**
 * WIRE-CONTRACT-V4 §1.1 checks 2–3 on a key `A`: `y < p`, not a "negative zero", not of small
 * order. A key that fails is one no v4 verifier accepts a signature from.
 */
export function isWeakEd25519Key(key: Uint8Array): boolean {
  if (key.length !== 32) return true;
  let y = 0n;
  for (let k = 31; k >= 0; k--) y = (y << 8n) | BigInt(key[k]!);
  y &= (1n << 255n) - 1n;
  if (y >= ED25519_P) return true;
  return WEAK_POINT_ENCODINGS.includes(hexOf(key));
}

/** Byte equality of two keys. */
export function sameKeyBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The declared keys as persisted. Entries that are not well formed are dropped (validation has
 *  already refused them; this is the defensive read the Worker's resync also uses). */
export function normalizeReleaseKeys(raw: unknown): ManifestReleaseKey[] {
  if (!Array.isArray(raw)) return [];
  const out: ManifestReleaseKey[] = [];
  for (const entry of raw.slice(0, MAX_RELEASE_KEYS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      continue;
    const { kid, publicKey } = entry as Record<string, unknown>;
    if (typeof kid !== "string" || !RELEASE_KEY_KID_PATTERN.test(kid)) continue;
    if (releaseKeyBytes(publicKey) === null) continue;
    out.push({ kid, publicKey: publicKey as string });
  }
  return out;
}
