/**
 * `distribution.feed-access-customers` (F-34.4; P0-49 runner): a package feed's access becomes
 * Public or Customers, and no principal gains access.
 *
 * WHY THIS IS SAFE. The ladder (`registry/authorize.ts`, which this job does not touch) judges a
 * read by `stricter(feed.access_mode, dist_access(deliverable).mode)`, and the entitlement flag
 * is the deliverable's OWN `dist_access` row's. On the ladder `authenticated` and `licensed` are
 * one strictness, so rewriting the one as the other changes no answer. An `entitled` feed is the
 * only case with a difference: it gated every package at `entitled` with no feed-level flag, and
 * a package with no own row held no flag, so no licence was admitted. Rewriting such a feed to
 * `licensed` alone would admit every usable licence to every package (access gained). So the
 * job first writes, for each package deliverable of that ecosystem, an own `dist_access` row at
 * `entitled` keeping the row's own flag (a null flag stays null), claimed `source = 'admin'` so a
 * resync skips it. Under `licensed` + own `entitled` row the answer is `entitled` + the same
 * flag: identical for every principal, every combination (`test/feedAccessJob.test.ts`).
 *
 *   - **Units**: products with a feed at `authenticated` or `entitled`, plus products with a
 *     Maven feed holding a stored `yankHidesFromIndex: false` (reporting only, zero changes).
 *   - **Dry run** (`plan`): per feed, the rows the apply writes, the formerly-entitled feeds
 *     (decision F4), whether the product's PS-03 open access (`openAccessOf`) turns false (E9)
 *     and the Maven feeds with a stored `false` (F9). Reads only.
 *   - **Apply**: one atomic batch per product. Ledger first (`dist_registry_access_moves`), then
 *     the own package rows, then the feeds, each statement guarded on the feed still being at
 *     the mode the plan saw. Idempotent: once moved, a feed no longer matches. The ledger insert
 *     is `OR IGNORE`, so a re-run keeps the FIRST prior state.
 *   - **Down**: restores from the ledger. A row is restored only while it still reads what the
 *     apply wrote, so an operator's later edit is never overwritten; the ledger rows then go.
 *
 * What it writes (every write only narrows or keeps): `dist_registry_access_moves` (the ledger);
 * `dist_access` (own package rows: insert at `entitled`, or raise an existing row to `entitled`
 * and `source = 'admin'`); `dist_registry_feeds.access_mode` (`authenticated`/`entitled` to
 * `licensed`). `version`, `updated_at` and timestamps of existing rows are left alone so `down`
 * is exact. New packages declared in a formerly entitled feed after the job land at Customers
 * (decision F4), not fail-closed; the dry run lists every such feed.
 */

import { bound } from "../../core/contributions.js";
import { buildHooks, type HookContext } from "../../core/hooks.js";
import type { MigrationJob } from "../../core/migrate/job.js";
import { SERVICE_SLUGS, type ServicesMap } from "../../core/services.js";
import type { Db, DbStatement } from "../../db/types.js";
import { parseJsonObject } from "../../platform/json.js";
import { openAccessOf } from "./access.js";

const MOVES = "dist_registry_access_moves";

interface FeedRow {
  ecosystem: string;
  enabled: number;
  access_mode: string;
  ext_json: string;
}

interface PackagePlan {
  deliverableId: string;
  /** `insert`: no own row; `raise`: an own row below `entitled` (or not claimed). */
  action: "insert" | "raise" | "keep";
  priorMode: string | null;
  priorSource: string | null;
}

interface FeedPlan {
  ecosystem: string;
  from: "authenticated" | "entitled";
  to: "licensed";
  enabled: boolean;
  packages: PackagePlan[];
}

export interface FeedAccessUnitPlan {
  feeds: FeedPlan[];
  /** Ecosystems of formerly `entitled` feeds: new packages there land at Customers (F4). */
  formerlyEntitled: string[];
  /** PS-03 open access is true now and turns false once the package rows are written (E9). */
  openAccessTurnsFalse: boolean;
  /** Maven feeds with a stored `yankHidesFromIndex: false`; hiding is always on after F-34.5 (F9). */
  mavenYankHidesFalse: string[];
}

async function feedsOf(db: Db, product: string): Promise<FeedRow[]> {
  return db.all<FeedRow>(
    `SELECT ecosystem, enabled, access_mode, ext_json FROM dist_registry_feeds
      WHERE product = ? ORDER BY ecosystem`,
    product,
  );
}

function yankHideOff(feed: FeedRow): boolean {
  return (
    feed.ecosystem === "maven" &&
    parseJsonObject(feed.ext_json)?.yankHidesFromIndex === false
  );
}

/**
 * The package deliverables of the product, by ecosystem, from Release's catalog hook. Asked
 * WITHOUT regard to the product's enablement: the rows exist (and would be served) the day
 * Release is switched on, so a job that skipped them would widen access then. No Release
 * provider at all throws: the job refuses to guess.
 */
async function packageDeliverablesOf(
  ctx: { env: HookContext["env"]; db: Db; now: number },
  product: string,
): Promise<{ id: string; ecosystem: string }[]> {
  const allOn = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [s, { enabled: true }]),
  ) as ServicesMap;
  const hooks = buildHooks(bound(), allOn, {
    env: ctx.env,
    db: ctx.db,
    now: ctx.now,
    product: { slug: product } as HookContext["product"],
  });
  const catalog = hooks.releaseCatalog();
  if (!catalog)
    throw new Error(
      "feed-access-customers needs Release's catalog to list the package deliverables",
    );
  return catalog.packageDeliverables();
}

async function planUnit(
  ctx: { env: HookContext["env"]; db: Db; now: number },
  product: string,
): Promise<FeedAccessUnitPlan> {
  const { db } = ctx;
  const feeds = await feedsOf(db, product);
  const moving = feeds.filter(
    (f) => f.access_mode === "authenticated" || f.access_mode === "entitled",
  );
  const own = new Map(
    (
      await db.all<{ deliverable_id: string; mode: string; source: string }>(
        "SELECT deliverable_id, mode, source FROM dist_access WHERE product = ?",
        product,
      )
    ).map((r) => [r.deliverable_id, r]),
  );
  const declared = moving.some((f) => f.access_mode === "entitled")
    ? await packageDeliverablesOf(ctx, product)
    : [];
  const plans: FeedPlan[] = moving.map((f) => {
    const from = f.access_mode as "authenticated" | "entitled";
    const packages: PackagePlan[] =
      from === "entitled"
        ? declared
            .filter((d) => d.ecosystem === f.ecosystem)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((d) => {
              const row = own.get(d.id);
              return {
                deliverableId: d.id,
                action: !row
                  ? "insert"
                  : row.mode === "entitled" && row.source === "admin"
                    ? "keep"
                    : "raise",
                priorMode: row?.mode ?? null,
                priorSource: row?.source ?? null,
              };
            })
        : [];
    return {
      ecosystem: f.ecosystem,
      from,
      to: "licensed",
      enabled: f.enabled === 1,
      packages,
    };
  });
  const writes = plans.some((p) => p.packages.some((k) => k.action !== "keep"));
  return {
    feeds: plans,
    formerlyEntitled: plans
      .filter((p) => p.from === "entitled")
      .map((p) => p.ecosystem),
    openAccessTurnsFalse: writes && (await openAccessOf(db, product)),
    mavenYankHidesFalse: feeds.filter(yankHideOff).map((f) => f.ecosystem),
  };
}

function changesOf(plan: FeedAccessUnitPlan): number {
  return plan.feeds.reduce(
    (n, f) => n + 1 + f.packages.filter((p) => p.action !== "keep").length,
    0,
  );
}

async function ledgerCount(db: Db, product: string): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${MOVES} WHERE product = ?`,
    product,
  );
  return row?.n ?? 0;
}

function applyStatements(
  product: string,
  plan: FeedAccessUnitPlan,
  now: number,
): DbStatement[] {
  const out: DbStatement[] = [];
  for (const f of plan.feeds) {
    // 1. The ledger, first: the feed row's prior mode, then each package row's prior state.
    out.push({
      sql: `INSERT OR IGNORE INTO ${MOVES}
              (product, ecosystem, deliverable_id, from_feed_mode, had_row, prior_mode,
               prior_entitlement, prior_source, moved_at)
            SELECT product, ecosystem, '', access_mode, 1, NULL, NULL, NULL, ?
              FROM dist_registry_feeds
             WHERE product = ? AND ecosystem = ? AND access_mode = ?`,
      params: [now, product, f.ecosystem, f.from],
    });
    for (const p of f.packages.filter((k) => k.action !== "keep")) {
      out.push({
        sql: `INSERT OR IGNORE INTO ${MOVES}
                (product, ecosystem, deliverable_id, from_feed_mode, had_row, prior_mode,
                 prior_entitlement, prior_source, moved_at)
              SELECT f.product, f.ecosystem, ?, f.access_mode, a.product IS NOT NULL, a.mode,
                     a.entitlement, a.source, ?
                FROM dist_registry_feeds f
                LEFT JOIN dist_access a ON a.product = f.product AND a.deliverable_id = ?
               WHERE f.product = ? AND f.ecosystem = ? AND f.access_mode = 'entitled'`,
        params: [p.deliverableId, now, p.deliverableId, product, f.ecosystem],
      });
    }
    // 2. The own package rows: entitled, the flag kept (a new row has none), claimed by the
    //    operator side so a resync leaves them. Only while the feed is still entitled.
    for (const p of f.packages.filter((k) => k.action !== "keep")) {
      out.push({
        sql: `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
              SELECT ?, ?, 'entitled', NULL, 'admin', ?
               WHERE EXISTS (SELECT 1 FROM dist_registry_feeds
                              WHERE product = ? AND ecosystem = ? AND access_mode = 'entitled')
              ON CONFLICT (product, deliverable_id) DO UPDATE SET
                mode = 'entitled', source = 'admin'`,
        params: [product, p.deliverableId, now, product, f.ecosystem],
      });
    }
    // 3. The feed. Last, so every guard above still saw the old mode.
    out.push({
      sql: `UPDATE dist_registry_feeds SET access_mode = 'licensed'
             WHERE product = ? AND ecosystem = ? AND access_mode = ?`,
      params: [product, f.ecosystem, f.from],
    });
  }
  return out;
}

function downStatements(product: string): DbStatement[] {
  const row = (col: string) =>
    `(SELECT l.${col} FROM ${MOVES} l
       WHERE l.product = dist_access.product AND l.deliverable_id = dist_access.deliverable_id)`;
  return [
    // A row that existed goes back to its prior mode and source (the flag was never changed),
    // only while it still reads what the apply wrote.
    {
      sql: `UPDATE dist_access SET mode = ${row("prior_mode")}, source = ${row("prior_source")}
             WHERE product = ? AND mode = 'entitled' AND source = 'admin'
               AND deliverable_id IN (SELECT deliverable_id FROM ${MOVES}
                                       WHERE product = ? AND had_row = 1 AND deliverable_id <> '')`,
      params: [product, product],
    },
    // A row the job created goes, unless an operator has since given it a flag.
    {
      sql: `DELETE FROM dist_access
             WHERE product = ? AND mode = 'entitled' AND source = 'admin' AND entitlement IS NULL
               AND deliverable_id IN (SELECT deliverable_id FROM ${MOVES}
                                       WHERE product = ? AND had_row = 0 AND deliverable_id <> '')`,
      params: [product, product],
    },
    // The feed, only while it still reads `licensed` (an operator's later change stands).
    {
      sql: `UPDATE dist_registry_feeds
               SET access_mode = (SELECT l.from_feed_mode FROM ${MOVES} l
                                   WHERE l.product = dist_registry_feeds.product
                                     AND l.ecosystem = dist_registry_feeds.ecosystem
                                     AND l.deliverable_id = '')
             WHERE product = ? AND access_mode = 'licensed'
               AND EXISTS (SELECT 1 FROM ${MOVES} l
                            WHERE l.product = dist_registry_feeds.product
                              AND l.ecosystem = dist_registry_feeds.ecosystem
                              AND l.deliverable_id = '')`,
      params: [product],
    },
    { sql: `DELETE FROM ${MOVES} WHERE product = ?`, params: [product] },
  ];
}

export const feedAccessCustomersJob: MigrationJob = {
  id: "distribution.feed-access-customers",
  summary:
    "Move package feeds from Authenticated/Entitled to Customers without widening any read",
  async units({ db }) {
    const rows = await db.all<{
      product: string;
      access_mode: string;
      ext_json: string;
      ecosystem: string;
    }>(
      `SELECT product, ecosystem, access_mode, ext_json FROM dist_registry_feeds
        ORDER BY product`,
    );
    const out = new Set<string>();
    for (const r of rows)
      if (
        r.access_mode === "authenticated" ||
        r.access_mode === "entitled" ||
        yankHideOff({ ...r, enabled: 1 })
      )
        out.add(r.product);
    return [...out];
  },
  async plan(ctx, unit) {
    const plan = await planUnit(ctx, unit);
    return { changes: changesOf(plan), detail: plan };
  },
  async apply(ctx, unit) {
    const plan = await planUnit(ctx, unit);
    if (plan.feeds.length === 0) return 0;
    const before = await ledgerCount(ctx.db, unit);
    await ctx.db.batch(applyStatements(unit, plan, ctx.now));
    return (await ledgerCount(ctx.db, unit)) - before;
  },
  async down(ctx, unit) {
    const n = await ledgerCount(ctx.db, unit);
    if (n === 0) return 0;
    await ctx.db.batch(downStatements(unit));
    return n;
  },
};
