/**
 * The freshness pass (P2-12.9, plans/P2-12.md §6.7): keeps a linked product's truth store close
 * to GitHub when no `release` webhook arrived. Release's `scheduled` hook calls it once per
 * product on the connector cron (every 15 minutes), so the store view never depends on a live
 * GitHub read at serving time.
 *
 * A product is DUE when
 *   - its newest `app` release was published less than 24 h ago (the window in which assets are
 *     still being uploaded, replaced or deleted), so the pass runs on every tick; or
 *   - its newest `release_health.checked_at` (subject `release` or `channel`, which every sync
 *     writes) is more than 1 h old, or there is none.
 * Counting `channel` rows keeps a repo with no releases from being due on every tick: its sync
 * still writes channel rows.
 *
 * One `syncReleaseStoreReport` per due product. At most `FRESHNESS_SYNCS_PER_TICK` run per tick
 * across all products; the rest report `deferred` and stay due. It never throws; a failed sync
 * does not move `checked_at`, so the product stays due. An `UpstreamRateLimitedError` ends the
 * tick for the product.
 */

import type { ScheduledServiceContext } from "../../core/registry.js";
import type { Db } from "../../db/types.js";
import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import { getReleaseConfig, isResolved } from "./config.js";
import type { FetchImpl } from "./githubApp.js";
import { UpstreamRateLimitedError } from "./github.js";
import { syncReleaseStoreReport } from "./sync.js";

export const FRESHNESS_SYNCS_PER_TICK = 25;
/** A release this young keeps its product due on every tick. */
export const FRESHNESS_RECENT_SECONDS = 86_400;
/** The age of the newest health check past which a product is due. */
export const FRESHNESS_STALE_SECONDS = 3_600;

export interface FreshnessReport extends Record<string, unknown> {
  freshness: "synced" | "fresh" | "deferred";
  statements: number;
  /** The sync hit GitHub's quota; the product stays due. */
  rateLimited?: true;
  /** The sync threw (never expected); the product stays due. */
  failed?: true;
}

/** The syncs a tick has spent; every product of one tick shares the same `now`. */
export interface FreshnessBudget {
  now: number;
  syncs: number;
}

let tickBudget: FreshnessBudget = { now: -1, syncs: 0 };

function budgetFor(now: number): FreshnessBudget {
  if (tickBudget.now !== now) tickBudget = { now, syncs: 0 };
  return tickBudget;
}

export async function isDue(
  db: Db,
  product: string,
  now: number,
): Promise<boolean> {
  const newest = await db.first<{ published_at: number | null }>(
    `SELECT MAX(published_at) AS published_at FROM release_metadata
      WHERE product = ? AND deliverable_id = ?`,
    product,
    APP_DELIVERABLE_ID,
  );
  if (
    newest?.published_at != null &&
    now - newest.published_at < FRESHNESS_RECENT_SECONDS
  )
    return true;
  const checked = await db.first<{ checked_at: number | null }>(
    `SELECT MAX(checked_at) AS checked_at FROM release_health
      WHERE product = ? AND subject_kind IN ('release', 'channel')`,
    product,
  );
  if (checked?.checked_at == null) return true;
  return now - checked.checked_at > FRESHNESS_STALE_SECONDS;
}

export async function releaseFreshness(
  ctx: Pick<ScheduledServiceContext, "env" | "db" | "now"> & {
    product: { slug: string };
  },
  opts: { fetchImpl?: FetchImpl; budget?: FreshnessBudget } = {},
): Promise<FreshnessReport> {
  const slug = ctx.product.slug;
  try {
    const cfg = await getReleaseConfig(ctx.db, slug);
    if (!cfg || !isResolved(cfg)) return { freshness: "fresh", statements: 0 };
    if (!(await isDue(ctx.db, slug, ctx.now)))
      return { freshness: "fresh", statements: 0 };
    const budget = opts.budget ?? budgetFor(ctx.now);
    if (budget.syncs >= FRESHNESS_SYNCS_PER_TICK)
      return { freshness: "deferred", statements: 0 };
    budget.syncs += 1;
    try {
      const out = await syncReleaseStoreReport(
        ctx.env,
        ctx.db,
        slug,
        ctx.now,
        opts.fetchImpl ?? fetch,
      );
      return { freshness: "synced", statements: out.statements };
    } catch (e) {
      if (e instanceof UpstreamRateLimitedError)
        return { freshness: "synced", statements: 0, rateLimited: true };
      return { freshness: "synced", statements: 0, failed: true };
    }
  } catch {
    return { freshness: "fresh", statements: 0, failed: true };
  }
}
