/// <reference types="@cloudflare/workers-types" />

/**
 * The hosted-asset pull consumer (HA-05; notes/S-20 §6.3), composed here because it joins Core's
 * ingest (`core/hostedAssetPulls.ts`) to Release's GitHub App installation token
 * (`services/release/assetSource.ts`), and only the composition root may import both.
 *
 * Each message is one slot's pull, or one slot's ladder retry (a ready copy whose variants an
 * ingest could not build, rebuilt from the stored original). A refused pull (a guard, a 404, a
 * non-image) or a failed ladder is recorded on the slot's row with back-off and ACKNOWLEDGED:
 * retrying it through the queue would only hammer the source or the Images binding. A transient
 * store race is retried after a minute; an unexpected throw (D1 unavailable) is retried by the
 * queue and, past `max_retries`, lands in `pkey-assets-dlq-<env>`. Messages are processed one
 * after another: a batch is at most ten, each I/O-bound.
 */

import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import {
  processAssetPull,
  processLadderRetry,
  readAssetLadderMessage,
  readAssetPullMessage,
} from "./core/hostedAssetPulls.js";
import type { FetchImpl } from "./core/safeFetch.js";
import { loadProductPublic } from "./core/products.js";
import { resolveRepoAssetSource } from "./services/release/assetSource.js";
import { syncManifestListingAssets } from "./services/distribution/listing/manifestAssets.js";

/** The queue this consumer serves (`pkey-assets-<env>`); anything else is not ours. */
export const ASSET_QUEUE_PREFIX = "pkey-assets-";

export async function handleAssetQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  db: Db,
  /** Test seam: the fetch every pull and GitHub call goes through. */
  fetchImpl?: FetchImpl,
  clock: () => number = () => Math.floor(Date.now() / 1000),
): Promise<void> {
  for (const message of batch.messages) {
    const msg =
      readAssetPullMessage(message.body) ??
      readAssetLadderMessage(message.body);
    if (!msg || !batch.queue.startsWith(ASSET_QUEUE_PREFIX)) {
      // Not a message this build understands: retrying it can never succeed.
      message.ack();
      continue;
    }
    const now = clock();
    const ctx = { env, db, now, ...(fetchImpl ? { fetchImpl } : {}) };
    try {
      if ("kind" in msg) {
        // A ladder retry: its outcome (and back-off) is on the row; never a queue retry.
        await processLadderRetry(ctx, msg);
        message.ack();
        continue;
      }
      const outcome = await processAssetPull(
        ctx,
        msg,
        (product, path, commit) =>
          resolveRepoAssetSource(
            env,
            db,
            product,
            path,
            commit,
            now,
            fetchImpl ?? fetch,
          ),
      );
      if (outcome === "retry") message.retry({ delaySeconds: 60 });
      else message.ack();
      // HA-07: a listing slot's new copy reaches Distribution's store-facing rows at once
      // (`listing/manifestAssets.ts`). Best-effort and after the ack: the pull is done whatever
      // happens here, and Distribution's connector cron runs the same idempotent sync.
      if (outcome === "ready" && msg.slot.startsWith("listing."))
        await syncListingArt(db, msg.product, now);
    } catch {
      message.retry();
    }
  }
}

/** The manifest listing rows of one product, when it runs Distribution (never throws). */
async function syncListingArt(
  db: Db,
  product: string,
  now: number,
): Promise<void> {
  try {
    const loaded = await loadProductPublic(db, product);
    if (!loaded?.services.distribution.enabled) return;
    await syncManifestListingAssets(db, product, now);
  } catch {
    // The connector cron reconciles within 15 minutes.
  }
}
