/**
 * Realm-tagged HMAC-SHA-256 tokens: the signed-cookie format of the console session
 * (`core/console/session.ts`) and the customer-portal session (`services/identity/portal/session.ts`).
 *
 * ── FORMAT (frozen: changing a byte signs every operator and customer out) ─────────────────
 *
 *   token = body "." mac
 *   body  = base64url(UTF-8(JSON.stringify(payload)))                 unpadded
 *   mac   = base64url(HMAC-SHA-256(key, UTF-8(domain + body)))       unpadded
 *
 * `domain` is the realm's separation tag (`pkey.admin.v1|`, `pkey.portal.v1|`; R1-02). Each
 * realm has its own secret (`ADMIN_SESSION_SECRET`, `PORTAL_SESSION_SECRET`; neither falls back
 * to the other), and the tag additionally keeps a token minted for one from verifying in the
 * other, whatever the payload shape.
 * Each realm keeps its own tag, key and payload checks; only the mechanism lives here (P0-15).
 * `test/platformPrimitives.test.ts` pins a token of each realm minted before the move.
 *
 * A leaf module: it imports only `platform/` siblings.
 */

import {
  b64urlDecodeUtf8,
  b64urlEncode,
  b64urlEncodeUtf8,
  utf8Encode,
} from "./bytes.js";
import { constantTimeEqual } from "./compare.js";
import { hmacSha256 } from "./hash.js";

function signingInput(domain: string, body: string): Uint8Array {
  return utf8Encode(domain + body);
}

/** Sign `payload` (JSON-serialisable) for the realm `domain`. */
export async function signHmacToken(
  key: CryptoKey,
  domain: string,
  payload: unknown,
): Promise<string> {
  const body = b64urlEncodeUtf8(JSON.stringify(payload));
  const mac = await hmacSha256(key, signingInput(domain, body));
  return `${body}.${b64urlEncode(mac)}`;
}

/**
 * The payload of a token whose MAC verifies for the realm `domain`, as parsed JSON (the caller
 * checks its shape and expiry), or `undefined` for anything else: no token, no `.`, an empty
 * body, a MAC mismatch, a body that does not decode or parse.
 *
 * `key` is called only once a token is present and well-formed, so a request without a cookie
 * never touches the secret. A realm whose secret is unset cannot have authentic tokens, so it
 * fails closed too: `key()` throwing is `undefined`, the same answer as a bad MAC.
 */
export async function verifyHmacToken(
  token: string | null,
  domain: string,
  key: () => Promise<CryptoKey>,
): Promise<unknown> {
  if (!token) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expected: Uint8Array;
  try {
    // Inside the `try`: a realm whose secret is unset makes `key()` throw, and "there is no
    // secret" must refuse exactly like "the signature is wrong", not raise into the gate that
    // called this.
    const k = await key();
    expected = await hmacSha256(k, signingInput(domain, body));
  } catch {
    return undefined;
  }
  if (!constantTimeEqual(mac, b64urlEncode(expected))) return undefined;
  try {
    return JSON.parse(b64urlDecodeUtf8(body)) as unknown;
  } catch {
    return undefined;
  }
}
