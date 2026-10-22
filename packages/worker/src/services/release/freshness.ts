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
 * One `syncReleaseStoreReport` per due product, its GitHub calls charged to the product's hourly
 * `releaseUpstream` budget (`meterUpstreamCalls`, like serving). At most
 * `FRESHNESS_SYNCS_PER_TICK` run per tick across all products and at most
 * `FRESHNESS_SYNCS_PER_INSTALLATION` per GitHub App installation; the rest report `deferred` and
 * stay due. Within those caps the due products with the OLDEST `checked_at` (none first) go
 * first, so a long queue is worked off rather than starved. A product whose sync failed backs
 * off (skipped for the next 2^n - 1 ticks, at most 24) so a permanently failing repository cannot hold a
 * slot. It never throws; a failed sync does not move `checked_at`, so the product stays due. A
 * GitHub quota refusal (a thrown `UpstreamRateLimitedError`, or a 403/429 answer) ends the tick
 * for the product and is reported `rateLimited`.
 *
 * The plan (who may sync this tick) is computed once, by the first product the hook visits, in
 * one query; every product of a tick shares the same `now`.
 */

import type { ScheduledServiceContext } from "../../core/registry.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { pk as kvKey } from "../../platform/kv.js";
import { parseServices } from "../../core/services.js";
import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import { getReleaseConfig, isResolved } from "./config.js";
import { meterUpstreamCalls } from "./gateway.js";
import type { FetchImpl } from "./githubApp.js";
import { UpstreamRateLimitedError } from "./github.js";
import { syncReleaseStoreReport } from "./sync.js";

export const FRESHNESS_SYNCS_PER_TICK = 25;
/** The most syncs one GitHub App installation gets in a tick (they share one hourly quota). */
export const FRESHNESS_SYNCS_PER_INSTALLATION = 8;
/** A release this young keeps its product due on every tick. */
export const FRESHNESS_RECENT_SECONDS = 86_400;
/** The age of the newest health check past which a product is due. */
export const FRESHNESS_STALE_SECONDS = 3_600;
/** The longest a failing product backs off, in ticks of 15 minutes. */
const BACKOFF_MAX_TICKS = 24;
const TICK_SECONDS = 900;

export interface FreshnessReport extends Record<string, unknown> {
  freshness: "synced" | "fresh" | "deferred";
  statements: number;
  /** The sync hit GitHub's quota; the product stays due. */
  rateLimited?: true;
  /** The sync wrote nothing or threw; the product stays due and backs off. */
  failed?: true;
  /** Deferred because an earlier failure put the product in back-off. */
  backoff?: true;
}

/** A tick's plan: the products allowed to sync, shared by every product of the tick. */
export interface FreshnessBudget {
  now: number;
  /** The database the plan was read from; a tick's products share one handle. */
  db?: Db;
  plan: Set<string> | null;
}

let tickBudget: FreshnessBudget = { now: -1, plan: null };

function budgetFor(now: number, db: Db): FreshnessBudget {
  if (tickBudget.now !== now || tickBudget.db !== db)
    tickBudget = { now, db, plan: null };
  return tickBudget;
}

/**
 * Due by the two rules. A `published_at` in the future is not a release age: it is ignored by
 * the 24-h rule (only the hour rule applies), so a bad date cannot keep a product due for ever.
 */
export function dueBy(
  newestPublishedAt: number | null,
  checkedAt: number | null,
  now: number,
): boolean {
  if (newestPublishedAt != null) {
    const age = now - newestPublishedAt;
    if (age >= 0 && age < FRESHNESS_RECENT_SECONDS) return true;
  }
  if (checkedAt == null) return true;
  return now - checkedAt > FRESHNESS_STALE_SECONDS;
}

export async function isDue(
  db: Db,
  product: string,
  now: number,
): Promise<boolean> {
  const row = await db.first<{ p: number | null; c: number | null }>(
    `SELECT (SELECT MAX(published_at) FROM release_metadata
              WHERE product = ? AND deliverable_id = ?) AS p,
            (SELECT MAX(checked_at) FROM release_health
              WHERE product = ? AND subject_kind IN ('release', 'channel')) AS c`,
    product,
    APP_DELIVERABLE_ID,
    product,
  );
  return dueBy(row?.p ?? null, row?.c ?? null, now);
}

interface Backoff {
  n: number;
  until: number;
}

const backoffKey = (product: string) => kvKey(product, "freshness", "backoff");

async function readBackoff(env: Env, product: string): Promise<Backoff | null> {
  try {
    const raw = await env.HOT.get(backoffKey(product));
    return raw ? (JSON.parse(raw) as Backoff) : null;
  } catch {
    return null;
  }
}

async function noteOutcome(
  env: Env,
  product: string,
  now: number,
  ok: boolean,
  prior: Backoff | null,
): Promise<void> {
  try {
    if (ok) {
      if (prior) await env.HOT.delete(backoffKey(product));
      return;
    }
    const n = (prior?.n ?? 0) + 1;
    const ticks = Math.min(2 ** n - 1, BACKOFF_MAX_TICKS);
    const until = now + (ticks + 1) * TICK_SECONDS - 1;
    await env.HOT.put(backoffKey(product), JSON.stringify({ n, until }), {
      expirationTtl: Math.max(60, ticks * TICK_SECONDS),
    });
  } catch {
    /* a lost marker only costs a retry on the next tick */
  }
}

/**
 * Who may sync this tick: the due, linked, Release-enabled products not in back-off, oldest
 * `checked_at` first (never-checked first), within the per-installation and global caps.
 */
async function planTick(env: Env, db: Db, now: number): Promise<Set<string>> {
  const rows = await db.all<{
    product: string;
    inst: number;
    services_json: string | null;
    p: number | null;
    c: number | null;
  }>(
    `SELECT rc.product AS product, rc.gh_installation_id AS inst, pr.services_json AS services_json,
            (SELECT MAX(published_at) FROM release_metadata m
              WHERE m.product = rc.product AND m.deliverable_id = ?) AS p,
            (SELECT MAX(checked_at) FROM release_health h
              WHERE h.product = rc.product AND h.subject_kind IN ('release', 'channel')) AS c
       FROM release_config rc JOIN products pr ON pr.slug = rc.product
      WHERE COALESCE(pr.status, 'active') != 'deleted'
        AND rc.gh_owner IS NOT NULL AND rc.gh_repo IS NOT NULL
        AND rc.gh_installation_id IS NOT NULL`,
    APP_DELIVERABLE_ID,
  );
  const due = rows
    .filter(
      (r) =>
        parseServices(r.services_json).services.release.enabled &&
        dueBy(r.p, r.c, now),
    )
    .sort(
      (a, b) => (a.c ?? -1) - (b.c ?? -1) || (a.product < b.product ? -1 : 1),
    );
  const plan = new Set<string>();
  const perInstallation = new Map<number, number>();
  for (const r of due) {
    if (plan.size >= FRESHNESS_SYNCS_PER_TICK) break;
    if ((perInstallation.get(r.inst) ?? 0) >= FRESHNESS_SYNCS_PER_INSTALLATION)
      continue;
    const backoff = await readBackoff(env, r.product);
    if (backoff && now < backoff.until) continue;
    plan.add(r.product);
    perInstallation.set(r.inst, (perInstallation.get(r.inst) ?? 0) + 1);
  }
  return plan;
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
    const budget = opts.budget ?? budgetFor(ctx.now, ctx.db);
    budget.plan ??= await planTick(ctx.env, ctx.db, ctx.now);
    if (!budget.plan.has(slug)) {
      const backoff = await readBackoff(ctx.env, slug);
      return {
        freshness: "deferred",
        statements: 0,
        ...(backoff && ctx.now < backoff.until
          ? { backoff: true as const }
          : {}),
      };
    }
    const prior = await readBackoff(ctx.env, slug);
    let limited = false;
    const base: FetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
    const metered = meterUpstreamCalls(ctx.env, slug, ctx.now, base);
    // The sync swallows its own errors, so the quota refusal is observed here.
    const observed: FetchImpl = async (input, init) => {
      try {
        const res = await metered(input, init);
        if (res.status === 429) limited = true;
        return res;
      } catch (e) {
        if (e instanceof UpstreamRateLimitedError) limited = true;
        throw e;
      }
    };
    try {
      const out = await syncReleaseStoreReport(
        ctx.env,
        ctx.db,
        slug,
        ctx.now,
        observed,
      );
      const ok = out.statements > 0 && !limited;
      await noteOutcome(ctx.env, slug, ctx.now, ok, prior);
      return {
        freshness: "synced",
        statements: out.statements,
        ...(limited ? { rateLimited: true as const } : {}),
        ...(!ok ? { failed: true as const } : {}),
      };
    } catch (e) {
      await noteOutcome(ctx.env, slug, ctx.now, false, prior);
      if (e instanceof UpstreamRateLimitedError || limited)
        return {
          freshness: "synced",
          statements: 0,
          rateLimited: true,
          failed: true,
        };
      return { freshness: "synced", statements: 0, failed: true };
    }
  } catch {
    return { freshness: "fresh", statements: 0, failed: true };
  }
}
