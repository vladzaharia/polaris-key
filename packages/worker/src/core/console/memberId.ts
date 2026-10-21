/**
 * The console's member id (ST-28 plan §2.6, ST-30 slice 2b): `"mbr_"` + the first 22 characters of
 * `base64url(HMAC-SHA-256(KEY_HASH_PEPPER, "console-member|" + accountId))`.
 *
 * It is the audit actor of a console write (`actor_sub`), the limiter key and the id `/me` shows,
 * so the account id itself never reaches a console body, an audit row or a limiter key. It is
 * one-way (nothing decodes it): to find the person behind an id, compute the id of each candidate
 * account and compare. With the pepper unset it follows `hashKey`'s fallback (an unkeyed SHA-256),
 * like every other peppered hash; production sets the pepper.
 *
 * Rotating the pepper re-keys every id (and every other hash that uses it); old audit rows keep
 * the IdP `sub`, `actor_name` and `actor_email`, which attribute them without the id.
 */

import type { Env } from "../../platform/env.js";
import { b64urlEncode } from "../../platform/bytes.js";
import { hmacSha256, importHmacKey, sha256 } from "../../platform/hash.js";

export const MEMBER_ID_PREFIX = "mbr_";
const MEMBER_ID_CHARS = 22;

/** True for a string shaped like a member id (a filter value, a stored actor). */
export function isMemberId(value: string): boolean {
  return /^mbr_[A-Za-z0-9_-]{22}$/.test(value);
}

export async function memberIdFor(
  env: Pick<Env, "KEY_HASH_PEPPER">,
  accountId: string,
): Promise<string> {
  const message = `console-member|${accountId}`;
  const mac = env.KEY_HASH_PEPPER
    ? await hmacSha256(await importHmacKey(env.KEY_HASH_PEPPER), message)
    : await sha256(message);
  return MEMBER_ID_PREFIX + b64urlEncode(mac).slice(0, MEMBER_ID_CHARS);
}
