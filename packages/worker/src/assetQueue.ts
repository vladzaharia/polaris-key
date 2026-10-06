/// <reference types="@cloudflare/workers-types" />

/**
 * The hosted-asset pull consumer (HA-05; notes/S-20 §6.3), composed here because it joins Core's
 * ingest (`core/hostedAssetPulls.ts`) to Release's GitHub App installation token
 * (`services/release/assetSource.ts`), and only the composition root may import both.
 *
 * Each message is one slot's pull, one slot's ladder retry (a ready copy whose variants an
 * ingest could not build, rebuilt from the stored original), or one release file's mirror
 * (HA-08, `services/release/mirror.ts`: a GitHub or external release file copied into the blob
 * store and given an `r2` location). A refused pull (a guard, a 404, a non-image), a failed
 * ladder or a refused mirror (a digest or size mismatch, corrupted bytes) is recorded on its row
 * with back-off and ACKNOWLEDGED: retrying it through the queue would only hammer the source, the
 * Images binding or GitHub. A transient store race is retried after a minute; an unexpected throw
 * (D1 unavailable) is retried by the queue and, past `max_retries`, lands in
 * `pkey-assets-dlq-<env>`. Messages are processed one after another: a batch is at most ten, each
 * I/O-bound. Pulls and ladder retries go first; mirrors follow, and none starts once
 * `MIRROR_BATCH_BUDGET_MS` of the batch is spent, which keeps a batch inside the consumer's
 * 15-minute wall clock however large its release files.
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
import {
  processReleaseMirror,
  readReleaseMirrorMessage,
  type ReleaseMirrorMessage,
} from "./services/release/mirror.js";
import { syncManifestListingAssets } from "./services/distribution/listing/manifestAssets.js";

/** The queue this consumer serves (`pkey-assets-<env>`); anything else is not ours. */
export const ASSET_QUEUE_PREFIX = "pkey-assets-";

/**
 * How long into a batch a mirror may still START (HA-08). A queue consumer has a 15-minute wall
 * clock, and one release file's pull may take up to `SAFE_FETCH_FILE_TIMEOUT_MS` (10 minutes):
 * pulls and ladder retries run first, and no mirror starts once this much of the batch is spent,
 * so a batch ends within about 4 + 10 minutes. A mirror not started is retried after a minute;
 * its job row's hold and the nightly backfill cover it even if the queue gives up on it.
 */
export const MIRROR_BATCH_BUDGET_MS = 4 * 60_000;

export async function handleAssetQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  db: Db,
  /** Test seam: the fetch every pull and GitHub call goes through. */
  fetchImpl?: FetchImpl,
  clock: () => number = () => Math.floor(Date.now() / 1000),
  /** Test seam: milliseconds since the batch started. */
  elapsedMs?: () => number,
): Promise<void> {
  const startedAt = Date.now();
  const elapsed = elapsedMs ?? (() => Date.now() - startedAt);
  const ours = batch.queue.startsWith(ASSET_QUEUE_PREFIX);
  const mirrors: { message: Message<unknown>; mirror: ReleaseMirrorMessage }[] =
    [];

  // Pass 1: pulls and ladder retries (each bounded by `safeFetch`'s 30 s), acked as each
  // finishes. Mirrors wait for pass 2, so a long release file never holds a pull back.
  for (const message of batch.messages) {
    const mirror = readReleaseMirrorMessage(message.body);
    if (mirror && ours) {
      mirrors.push({ message, mirror });
      continue;
    }
    const msg =
      readAssetPullMessage(message.body) ??
      readAssetLadderMessage(message.body);
    if (!msg || !ours) {
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

  // Pass 2: release-file mirrors, one after another, none started past the batch budget.
  for (const { message, mirror } of mirrors) {
    if (elapsed() >= MIRROR_BATCH_BUDGET_MS) {
      message.retry({ delaySeconds: 60 });
      continue;
    }
    const now = clock();
    try {
      const outcome = await processReleaseMirror(
        { env, db, now, ...(fetchImpl ? { fetchImpl } : {}) },
        mirror,
      );
      if (outcome === "retry") message.retry({ delaySeconds: 60 });
      else message.ack();
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
