/**
 * The console's member id (ST-28 plan §2.6, ST-30 slice 2b): `"mbr_"` + the first 22 characters of
 * `base64url(HMAC-SHA-256(memberKey, accountId))`, `memberKey = HMAC-SHA-256(KEY_HASH_PEPPER, label)`.
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

/** The label the member key is derived under; changing it re-keys every id. */
const MEMBER_KEY_LABEL = "pkey/console-member-key/v1";

/**
 * `memberKey = HMAC(KEY_HASH_PEPPER, label)` and `mbr_ = HMAC(memberKey, accountId)`: the pepper
 * never keys the account id directly, so the ids are domain-separated from every other pepper use.
 * With the pepper unset the member key is `SHA-256(label)` (the unkeyed `hashKey` fallback).
 */
async function memberKey(
  env: Pick<Env, "KEY_HASH_PEPPER">,
): Promise<CryptoKey> {
  const raw = env.KEY_HASH_PEPPER
    ? await hmacSha256(
        await importHmacKey(env.KEY_HASH_PEPPER),
        MEMBER_KEY_LABEL,
      )
    : await sha256(MEMBER_KEY_LABEL);
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function memberIdFor(
  env: Pick<Env, "KEY_HASH_PEPPER">,
  accountId: string,
): Promise<string> {
  const mac = await hmacSha256(await memberKey(env), accountId);
  return MEMBER_ID_PREFIX + b64urlEncode(mac).slice(0, MEMBER_ID_CHARS);
}
