/// <reference types="@cloudflare/workers-types" />

/**
 * "This product's Cloud Sync objects are being erased" (U-05.13; THREAT-MODEL, product deletion).
 *
 * The console's delete runs the bounded purge BEFORE the product's status flips, and a big product
 * takes several runs. Meanwhile a device still authenticates, and a push would create an object
 * the purge already erased (the object reads no D1, so it cannot tell). The first purge run sets
 * this flag; the push route refuses while it is set, before it calls the object.
 *
 * It lives in KV (`pk()`-scoped, no new table), with a TTL that every purge run renews: an
 * abandoned delete lets writes resume after an hour. KV is eventually consistent, so a push in
 * another location can still land for up to about a minute after the first run starts (stated in
 * the threat model); the directory row such an object writes is guarded on the product being live
 * (U-05.9), and an object that finds its product erased at its next alarm erases itself. A KV read that fails refuses the push
 * (retryable): the flag's absence is never assumed.
 */

import type { Env } from "../../platform/env.js";
import { pk } from "../../platform/kv.js";

/** Seconds the flag outlives the last purge run. */
export const PURGE_FLAG_TTL_SECONDS = 3600;

const keyOf = (product: string): string => pk(product, "sync-purging", "1");

/** Set (or renew) the flag. Throws when KV does: no erasure starts without it. */
export async function markProductPurging(
  env: Pick<Env, "HOT">,
  product: string,
): Promise<void> {
  await env.HOT.put(keyOf(product), "1", {
    expirationTtl: PURGE_FLAG_TTL_SECONDS,
  });
}

/**
 * Drop the flag once the purge has finished, so a slug re-created within the hour is not refused.
 * Best effort: a failed delete leaves the TTL to lapse. A push that lands after this on a stale
 * view of the product is erased by the object's own alarm (it finds the product not live).
 */
export async function clearProductPurging(
  env: Pick<Env, "HOT">,
  product: string,
): Promise<void> {
  try {
    await env.HOT.delete(keyOf(product));
  } catch {
    // The TTL ends it (no logging in src, R12).
  }
}

/** `true` while a purge is running; throws when KV cannot answer (the caller refuses). */
export async function productIsPurging(
  env: Pick<Env, "HOT">,
  product: string,
): Promise<boolean> {
  return (await env.HOT.get(keyOf(product))) !== null;
}
