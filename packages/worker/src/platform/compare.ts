/**
 * Constant-time equality for secrets (MACs, CSRF tokens, poll secrets).
 *
 * ONE implementation of each shape (P0-15; there were seven copies). The time taken depends on
 * the LENGTH of the inputs but never on where they first differ. Lengths are not secret here:
 * every caller compares a presented value against one of a fixed, public length (a MAC, a
 * base64url token), so unequal lengths answer `false` at once, exactly as every copy did.
 *
 * A leaf module: it imports nothing else in `src/`.
 */

/** Constant-time equality of two strings, compared by UTF-16 code unit. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Constant-time equality of two byte strings. */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
