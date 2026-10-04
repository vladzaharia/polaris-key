/// <reference types="@cloudflare/workers-types" />
/**
 * The lazy-delta consumer Worker (P4-17, notes/S-08 §6.2): its own script, deployed from
 * `wrangler.deltas.toml` as `polaris-key-deltas-<env>`, built from the same
 * `services/release/packs/deltas/` code as the request Worker. It has a `queue` handler and
 * nothing else — no routes, no `fetch`, no cron — so no request and no second encode ever shares
 * its isolate's 128 MB (`max_batch_size = 1`, `max_concurrency = 1`).
 *
 * It is the ONLY module that imports the encoder (`@polaris-key/zstd-wasm/encoder`, whose
 * `zenc.wasm` arrives as a compiled `WebAssembly.Module`); `test/deltaConsumer.test.ts` asserts no
 * other source file does, so the request Worker's bundle cannot encode, decode or diff a payload.
 */

import { patchFrom } from "@polaris-key/zstd-wasm/encoder";
import type { Env } from "./env.js";
import { D1Db } from "./db/d1.js";
import { refreshPlatformSettings } from "./core/platformSettings.js";
import {
  handleDeltaBatch,
  type DeltaConsumerDeps,
} from "./services/release/packs/deltas/consumer.js";

/** The consumer's bindings: the request Worker's D1 and blob store, and the queue it drains
 *  (bound again as a producer, to fan an R2 event out into pair jobs). */
export type DeltasEnv = Pick<
  Env,
  "DB" | "BLOBS" | "DELTA_QUEUE" | "LAZY_DELTAS" | "LAZY_DELTA_MAX_BYTES"
>;

/** The injected dependencies of one invocation (exported for the workerd lane). */
export function consumerDeps(env: DeltasEnv, now: number): DeltaConsumerDeps {
  if (!env.BLOBS)
    throw new Error("the lazy-delta consumer needs the BLOBS binding");
  return {
    env,
    db: new D1Db(env.DB),
    bucket: env.BLOBS,
    queue: env.DELTA_QUEUE,
    now,
    encode: patchFrom,
  };
}

export default {
  async queue(batch: MessageBatch<unknown>, env: DeltasEnv): Promise<void> {
    // A-13: `LAZY_DELTAS` and `LAZY_DELTA_MAX_BYTES` resolve through the platform settings store
    // (the same `platform_settings` rows the request Worker reads), read fresh per invocation.
    await refreshPlatformSettings(env, new D1Db(env.DB));
    await handleDeltaBatch(batch, (now) => consumerDeps(env, now));
  },
} satisfies ExportedHandler<DeltasEnv>;
