// Credential minting + hashing. License keys are self-identifying (`pkey_<product>_…`)
// so the backend/SDK can route by product from the key alone; per-device tokens are the
// `pkeyt_` device principal of wire contract v3 §6 and never shown. Keys are stored only as
// hashes (optionally peppered so a KV/D1 dump can't confirm guessed keys).
//
// The byte, digest and randomness primitives underneath live in `platform/` (P0-15).

import { hexEncode } from "./bytes.js";
import { hmacSha256, importHmacKey, sha256Hex } from "./hash.js";
import { randomToken } from "./random.js";

/** A license key: `pkey_<product>_<128-bit base64url>`, shown to the user once. */
export function mintLicenseKey(product: string): string {
  return `pkey_${product}_${randomToken(16)}`;
}

/**
 * The device-token prefix (wire contract v3 §6/§8). Stable across wire-contract revisions;
 * the `plrst_` spelling the interim suite design proposed and Amendment A1 withdrew is not
 * accepted, so no second prefix is ever tolerated on this path.
 */
export const DEVICE_TOKEN_PREFIX = "pkeyt_";

/** A per-device bearer token: `pkeyt_` + 43 base64url chars (256 bits), never shown. */
export function mintDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${randomToken(32)}`;
}

/**
 * Shape gate for a presented device token.
 *
 * Cheap, and deliberately BEFORE the hash + KV/D1 lookups in `validateDeviceToken`: without it
 * "a foreign prefix is rejected" would only be true by accident (no such hash is stored), which
 * is a property of the data rather than of the code, and it would quietly stop being true the
 * moment somebody re-imported old rows. The length is checked as a floor rather than an equality
 * so a future widening of the entropy is not a wire break.
 */
export function isDeviceToken(token: string): boolean {
  return /^pkeyt_[A-Za-z0-9_-]{43,}$/.test(token);
}

/**
 * An opaque, unguessable 256-bit token with NO prefix: the browser-session cookie value and the
 * portal's single-use download token.
 *
 * Deliberately not `pkeyt_`: neither is a device principal, and a prefix that says otherwise
 * would mislead anyone reading a log or a URL. These strings identify nothing by themselves;
 * they are looked up in the one store that owns them.
 */
export function mintOpaqueToken(): string {
  return randomToken(32);
}

/**
 * A pairwise subject (plans/I-04.md §2): `ps_` and 22 base64url characters, 128 random bits.
 * Random and stored, never derived from the account id (S-16 §5.1), so ending it ends it.
 */
export function mintPairwiseSubject(): string {
  return `ps_${randomToken(16)}`;
}

/** A short opaque id with a typed prefix (lic_, dev_, flow_, …). */
export function randomId(prefix: string): string {
  return `${prefix}_${randomToken(9)}`;
}

/**
 * The exact shape of a license key: `pkey_`, a lower-case slug, `_`, then EXACTLY 22 base64url
 * characters — `mintLicenseKey`'s 16 random bytes, unpadded (`ceil(16 * 8 / 6) = 22`).
 *
 * Exact, not a floor (owner decision, 2026-10-04): every key this deployment has ever issued came
 * from `mintLicenseKey`, so every real key is 22 characters, and a shorter or longer string can
 * only be a cut-off paste, a typo or a guess. Refusing it here stops it before the hash and the
 * D1 lookup, and it is the same check the customer portal's key field runs before it sends
 * anything (docs/design/PORTAL.md §4.17). The slug cannot contain `_`, so the split between slug
 * and secret is unambiguous even though the secret may contain `_` and `-`.
 */
export const LICENSE_KEY_SHAPE = /^pkey_([a-z0-9-]+)_([A-Za-z0-9_-]{22})$/;

/** Extract the product slug from a `pkey_<product>_<22 base64url>` license key (or null). */
export function productFromKey(key: string): string | null {
  const m = LICENSE_KEY_SHAPE.exec(key);
  return m ? (m[1] ?? null) : null;
}

/** Hash a credential for storage. With a pepper, an offline KV dump can't confirm guesses. */
export async function hashKey(value: string, pepper?: string): Promise<string> {
  if (!pepper) return sha256Hex(value);
  return hexEncode(await hmacSha256(await importHmacKey(pepper), value));
}
