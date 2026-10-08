/**
 * Cryptographically random bytes and the token shapes built from them.
 *
 * ONE implementation (P0-15). Every random value the Worker mints for a security purpose (an
 * OIDC `state` or `nonce`, a CSRF token, a session id, a poll secret, an AES-GCM IV) comes from
 * `crypto.getRandomValues` through here, so a reviewer has one place to check.
 *
 * A leaf module: it imports only `platform/` siblings.
 */

import { b64urlEncode, hexEncode } from "./bytes.js";

/** `n` bytes from the platform CSPRNG. */
export function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/** `byteLength` random bytes as unpadded base64url (`ceil(byteLength * 4 / 3)` characters). */
export function randomToken(byteLength: number): string {
  return b64urlEncode(randomBytes(byteLength));
}

/** `byteLength` random bytes as lower-case hex (`2 * byteLength` characters). */
export function randomHex(byteLength: number): string {
  return hexEncode(randomBytes(byteLength));
}
