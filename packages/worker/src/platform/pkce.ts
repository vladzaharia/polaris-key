/**
 * PKCE (RFC 7636) for the Worker's OIDC relying-party flows: the console sign-in, product
 * sign-in, the customer portal and the hosted providers.
 *
 * ONE implementation (P0-15; there were three identical copies and a fourth `s256`). The
 * verifier is 32 random bytes as base64url (43 characters, inside RFC 7636's 43–128), and the
 * challenge is always `S256`: base64url(SHA-256(ASCII verifier)), unpadded.
 *
 * A leaf module: it imports only `platform/` siblings.
 */

import { b64urlEncode } from "./bytes.js";
import { sha256 } from "./hash.js";
import { randomToken } from "./random.js";

/** The `S256` code challenge for `verifier`. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(await sha256(verifier));
}

/** A fresh verifier and its `S256` challenge. */
export async function pkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = randomToken(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}
