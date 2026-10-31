/// <reference types="@cloudflare/workers-types" />

/**
 * The push's limits (U-05.14; THREAT-MODEL T6, "Cloud Sync push limits").
 *
 *   - `syncPushDevice`: 60 pushes a minute per device.
 *   - `syncPushProduct`: 2,000 a second per product (`CLOUD_SYNC_CEILINGS.perProduct.pushesPerSecond`),
 *     counted over `SYNC_LIMITER_SHARDS` limiter objects named `sync:product:<p>:<0-7>`. The shard is
 *     the caller's subject hash, so one person's pushes always meet one counter, and a product's
 *     rate is spread over eight objects instead of serialising through one. Each shard allows its
 *     eighth of the rate; subjects hash evenly, so the product total holds.
 *
 * Both counters live in the product's shard for the caller's subject (the device bucket too:
 * one person's devices share one object, and no `sync:*` traffic touches the product's own
 * credential limiter). Both fail OPEN (L10, `FAIL_MODE` in `core/rateLimit.ts`): the caller is
 * authenticated, the client's journal survives a 429 either way, and the Cloud Sync object bounds
 * the work per person.
 *
 * `pushLimited` is the first thing the push does after the kill switch: a limited push costs the
 * trust check, the body read, the classification, the aggregate read and the object nothing. It
 * charges the device first, so a device over its own limit never spends the product's budget.
 */

import { CLOUD_SYNC_CEILINGS } from "@polaris-key/catalog";
import {
  SYNC_CHUNK_REQUESTS_PER_MINUTE,
  SYNC_FILE_TRANSFERS_PER_HOUR,
} from "@polaris-key/protocol/sync";
import type { Env } from "../../platform/env.js";
import { rateLimitOk, shardIndex } from "../../core/rateLimit.js";
import { wireError } from "../../core/errors.js";

export const SYNC_LIMITER_SHARDS = 8;
export const SYNC_PUSH_DEVICE_LIMIT = 60;
export const SYNC_PUSH_DEVICE_WINDOW_SEC = 60;
export const SYNC_PUSH_PRODUCT_WINDOW_SEC = 1;
export const SYNC_PULL_DEVICE_LIMIT = 120;
export const SYNC_PULL_DEVICE_WINDOW_SEC = 60;
/** U-10 (§13.8.2): file transfers (`begin` and a whole-file `GET`) per device an hour. */
export const SYNC_FILES_DEVICE_WINDOW_SEC = 3600;
/** U-10 (§13.8.2): part, chunk, status and ranged-`GET` requests per device a minute. */
export const SYNC_PARTS_DEVICE_WINDOW_SEC = 60;

/** The limiter object name for a caller: `sync:product:<p>:<0-7>`, by subject hash. */
export function syncLimiterShard(product: string, subject: string): string {
  return `sync:product:${product}:${shardIndex(subject, SYNC_LIMITER_SHARDS)}`;
}

function limited(windowSec: number, now: number): Response {
  const res = wireError(429, "rate_limited");
  // Seconds left in the fixed window the counter is in (at least 1).
  res.headers.set(
    "retry-after",
    String(Math.max(1, windowSec - (now % windowSec))),
  );
  return res;
}

/** A `429 rate_limited` Response when the push is over a limit, else null. */
export async function pushLimited(
  env: Env,
  product: string,
  subject: string,
  deviceId: string,
  now: number,
): Promise<Response | null> {
  const shard = syncLimiterShard(product, subject);
  if (
    !(await rateLimitOk(
      env,
      shard,
      {
        bucket: "syncPushDevice",
        id: deviceId,
        limit: SYNC_PUSH_DEVICE_LIMIT,
        windowSec: SYNC_PUSH_DEVICE_WINDOW_SEC,
      },
      now,
    ))
  )
    return limited(SYNC_PUSH_DEVICE_WINDOW_SEC, now);
  if (
    !(await rateLimitOk(
      env,
      shard,
      {
        bucket: "syncPushProduct",
        id: product,
        limit: Math.ceil(
          CLOUD_SYNC_CEILINGS.perProduct.pushesPerSecond / SYNC_LIMITER_SHARDS,
        ),
        windowSec: SYNC_PUSH_PRODUCT_WINDOW_SEC,
      },
      now,
    ))
  )
    return limited(SYNC_PUSH_PRODUCT_WINDOW_SEC, now);
  return null;
}

/** A `429 rate_limited` Response when the device pulls too often (120 a minute), else null. */
export async function pullLimited(
  env: Env,
  product: string,
  subject: string,
  deviceId: string,
  now: number,
): Promise<Response | null> {
  const ok = await rateLimitOk(
    env,
    syncLimiterShard(product, subject),
    {
      bucket: "syncPull",
      id: deviceId,
      limit: SYNC_PULL_DEVICE_LIMIT,
      windowSec: SYNC_PULL_DEVICE_WINDOW_SEC,
    },
    now,
  );
  return ok ? null : limited(SYNC_PULL_DEVICE_WINDOW_SEC, now);
}

/**
 * A `429 rate_limited` Response when the device has used its 30 file transfers of the hour (a
 * `begin`, or a whole-file `GET`), else null (U-10, §13.8.2). Fails open, like the push: the caller
 * is authenticated, and the person's object bounds the work.
 */
export async function filesLimited(
  env: Env,
  product: string,
  subject: string,
  deviceId: string,
  now: number,
): Promise<Response | null> {
  const ok = await rateLimitOk(
    env,
    syncLimiterShard(product, subject),
    {
      bucket: "syncFilesDevice",
      id: deviceId,
      limit: SYNC_FILE_TRANSFERS_PER_HOUR,
      windowSec: SYNC_FILES_DEVICE_WINDOW_SEC,
    },
    now,
  );
  return ok ? null : limited(SYNC_FILES_DEVICE_WINDOW_SEC, now);
}

/**
 * A `429 rate_limited` Response when the device is over 600 part, chunk, status or ranged-`GET`
 * requests a minute, else null (U-10, §13.8.2). Fails open, as `filesLimited` does.
 */
export async function partsLimited(
  env: Env,
  product: string,
  subject: string,
  deviceId: string,
  now: number,
): Promise<Response | null> {
  const ok = await rateLimitOk(
    env,
    syncLimiterShard(product, subject),
    {
      bucket: "syncParts",
      id: deviceId,
      limit: SYNC_CHUNK_REQUESTS_PER_MINUTE,
      windowSec: SYNC_PARTS_DEVICE_WINDOW_SEC,
    },
    now,
  );
  return ok ? null : limited(SYNC_PARTS_DEVICE_WINDOW_SEC, now);
}
