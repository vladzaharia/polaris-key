/**
 * What the server may know about a sealed value (WIRE-CONTRACT-V5 §13.3, §13.10.4): the shape of
 * its `pkey-sync-value/1` envelope and nothing else. It never decodes the payload.
 *
 *   envelope  canonical base64url (no padding, no stray bits), byte 0 equal to 1, and
 *             `(length - 49) mod 64 = 0` with at least one padded block of payload.
 *   charge    budgets (256 keys, 64 KiB, 8 KiB) are charged on `envelopeBytes - 113`
 *             (`SYNC_E2E_OVERHEAD_BYTES`), so they keep their meaning; the quota charges the
 *             stored bytes (the string as kept).
 */

import {
  SYNC_BLINDED_NAME_PATTERN,
  SYNC_E2E_OVERHEAD_BYTES,
  SYNC_ENVELOPE_FIXED_BYTES,
  SYNC_ENVELOPE_PAD_BLOCK,
} from "@polaris-key/protocol/sync";

const BLINDED = new RegExp(SYNC_BLINDED_NAME_PATTERN);
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A blinded name (`x:` and 43 base64url characters): a person-chosen name, hidden (§13.10.3). */
export const isBlinded = (s: unknown): s is string =>
  typeof s === "string" && BLINDED.test(s);

/** The decoded length of a canonical base64url string of `n` characters; `null` when impossible. */
function decodedLength(n: number): number | null {
  const rem = n % 4;
  if (rem === 1) return null;
  return Math.floor(n / 4) * 3 + (rem === 0 ? 0 : rem - 1);
}

/**
 * The envelope's byte length when `ct` is a well-shaped `pkey-sync-value/1` envelope, else `null`.
 * Canonical means the last character carries no bits beyond the final byte.
 */
export function envelopeBytes(ct: unknown): number | null {
  if (typeof ct !== "string" || ct.length === 0) return null;
  const n = decodedLength(ct.length);
  if (n === null) return null;
  if (n < SYNC_ENVELOPE_FIXED_BYTES + SYNC_ENVELOPE_PAD_BLOCK) return null;
  if ((n - SYNC_ENVELOPE_FIXED_BYTES) % SYNC_ENVELOPE_PAD_BLOCK !== 0)
    return null;
  for (const ch of ct) if (!ALPHABET.includes(ch)) return null;
  // The unused low bits of the last character must be zero (canonical form).
  const rem = ct.length % 4;
  if (rem !== 0) {
    const last = ALPHABET.indexOf(ct[ct.length - 1] as string);
    const spare = rem === 2 ? 0b1111 : 0b11;
    if ((last & spare) !== 0) return null;
  }
  // Byte 0 is the version: the first character carries its six high bits.
  const first = ALPHABET.indexOf(ct[0] as string);
  const second = ALPHABET.indexOf(ct[1] as string);
  const byte0 = (first << 2) | (second >> 4);
  return byte0 === 1 ? n : null;
}

/**
 * The key id of a well-shaped envelope: the lowercase hex of its bytes 1 to 16 (§13.10.4). The
 * first 24 characters decode to exactly 18 bytes, so no padding is needed. `undefined` for a
 * string too short to hold one (the shape check refuses those first).
 */
export function envelopeKid(ct: string): string | undefined {
  if (ct.length < 24) return undefined;
  const bin = atob(ct.slice(0, 24).replace(/-/g, "+").replace(/_/g, "/"));
  let out = "";
  for (let i = 1; i <= 16; i++)
    out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

/** What a budget charges for a sealed value: the envelope less its fixed overhead. */
export const budgetBytes = (ct: string): number =>
  Math.max(0, (decodedLength(ct.length) ?? 0) - SYNC_E2E_OVERHEAD_BYTES);
