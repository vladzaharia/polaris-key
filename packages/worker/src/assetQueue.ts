/// <reference types="@cloudflare/workers-types" />

/**
 * The hosted-asset pull consumer (HA-05; notes/S-20 §6.3), composed here because it joins Core's
 * ingest (`core/hostedAssetPulls.ts`) to Release's GitHub App installation token
 * (`services/release/assetSource.ts`), and only the composition root may import both.
 *
 * Each message is one slot's pull. A refused pull (a guard, a 404, a non-image) is recorded on the
 * slot's row with back-off and ACKNOWLEDGED: retrying it through the queue would only hammer the
 * source. A transient store race is retried after a minute; an unexpected throw (D1 unavailable)
 * is retried by the queue and, past `max_retries`, lands in `pkey-assets-dlq-<env>`. Messages are
 * processed one after another: a batch is at most ten pulls, each I/O-bound.
 */

import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import {
  processAssetPull,
  readAssetPullMessage,
} from "./core/hostedAssetPulls.js";
import type { FetchImpl } from "./core/safeFetch.js";
import { resolveRepoAssetSource } from "./services/release/assetSource.js";

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
    const msg = readAssetPullMessage(message.body);
    if (!msg || !batch.queue.startsWith(ASSET_QUEUE_PREFIX)) {
      // Not a pull this build understands: retrying it can never succeed.
      message.ack();
      continue;
    }
    const now = clock();
    try {
      const outcome = await processAssetPull(
        {
          env,
          db,
          now,
          ...(fetchImpl ? { fetchImpl } : {}),
        },
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
    } catch {
      message.retry();
    }
  }
}
