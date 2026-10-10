/**
 * The nightly lazy-delta sweep (P4-17), one product at a time from `src/scheduled.ts`'s
 * maintenance tick. For each opted-in product:
 *
 *   1. refresh its demand (`core/deltaDemand.ts`: prune device rows past 30 days, rebuild the
 *      7-day aggregate);
 *   2. enqueue the hot pairs that have no row yet, after the same policy the consumer applies
 *      (so a pair below the threshold, with a CI delta, over the cap or past the daily cap is
 *      never queued). A cold pair that turned hot again is forgotten and re-queued;
 *   3. mark cold every ready delta older than 30 days that no device reported in 30 days, and
 *      drop its `lazy-delta` ref, so P4-14's collector reclaims the object.
 *
 * The sweep never reads a payload: the queue's consumer Worker does the byte work.
 */

import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../env.js";
import {
  DEMAND_RETENTION_SECONDS,
  hotPairs,
  lazyDeltaSettings,
  pairSeenSince,
  refreshDemand,
} from "../../../../core/deltaDemand.js";
import { pairMessage } from "./messages.js";
import { shouldQueue } from "./policy.js";
import { platformSetting } from "../../../../core/platformSettings.js";
import { ciDeltaFroms, findPair } from "./records.js";
import {
  forgetCold,
  generatedSince,
  lazyDeltaRow,
  markCold,
  readyBefore,
} from "./store.js";

/** Hot pairs one product's sweep considers, hottest first. */
export const SWEEP_PAIRS = 50;
/** Ready deltas one product's cold scan reads. */
export const COLD_SCAN = 200;

export interface LazyDeltaSweepResult {
  demandRows: number;
  queued: number;
  cold: number;
}

export async function sweepLazyDeltas(
  env: Pick<Env, "DELTA_QUEUE" | "LAZY_DELTA_MAX_BYTES">,
  db: Db,
  product: string,
  now: number,
): Promise<LazyDeltaSweepResult> {
  const settings = await lazyDeltaSettings(db, product);
  const demandRows = await refreshDemand(db, product, now);
  let queued = 0;
  const queue = env.DELTA_QUEUE;
  if (queue && settings.enabled) {
    const maxBytes = await platformSetting(env, db, "LAZY_DELTA_MAX_BYTES");
    let budget =
      settings.dailyCap - (await generatedSince(db, product, now - 86400));
    for (const p of await hotPairs(
      db,
      product,
      settings.hotDevices,
      SWEEP_PAIRS,
    )) {
      if (budget <= 0) break;
      const row = await lazyDeltaRow(db, product, p.from, p.to);
      if (row && row.state !== "cold") continue;
      const pair = await findPair(db, product, p.deliverableId, p.from, p.to);
      if (!pair) continue;
      const verdict = shouldQueue({
        from: {
          sha256: p.from,
          size: pair.from.variant.payload.size,
          codec: pair.from.variant.full.codec,
        },
        to: {
          sha256: p.to,
          size: pair.to.variant.payload.size,
          codec: pair.to.variant.full.codec,
          layout: pair.to.variant.files.layout,
          ciDeltaFroms: ciDeltaFroms(pair.to.variant),
        },
        devices: p.devices,
        hotDevices: settings.hotDevices,
        maxBytes,
        generatedToday: settings.dailyCap - budget,
        dailyCap: settings.dailyCap,
      });
      if (!verdict.ok) continue;
      if (row) await forgetCold(db, product, p.from, p.to);
      await queue.send(pairMessage(product, p.deliverableId, p.from, p.to));
      queued++;
      budget--;
    }
  }
  let cold = 0;
  const since = now - DEMAND_RETENTION_SECONDS;
  for (const row of await readyBefore(db, product, since, COLD_SCAN)) {
    if (await pairSeenSince(db, product, row.from, row.to, since)) continue;
    await markCold(db, product, row, now);
    cold++;
  }
  return { demandRows, queued, cold };
}
