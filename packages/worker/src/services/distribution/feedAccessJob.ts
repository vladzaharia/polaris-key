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
 *   - **Apply**: one atomic batch per product, in two phases a cache window apart (the ladder
 *     caches the feed row and a deliverable's mode separately, so changing both in one step lets
 *     an isolate hold the new feed beside the old mode). Phase A: the ledger, then the own
 *     package rows, each guarded on the feed still being at the mode the plan saw. Phase B: the
 *     feed, guarded in SQL on every declared package having an own `entitled` row NOW and on
 *     no job-written row being younger than the window. An entitled feed with rows to write
 *     therefore moves on a later call; the first throws `registry_cache_window` (the unit is
 *     marked failed) and applying the same report again finishes it. `authenticated` to
 *     `licensed` is a single row and moves at once. The ledger insert keeps the FIRST prior state.
 *   - **Down**: the feeds are restored first, the package rows a window later, and only where
 *     that ecosystem's feed reads `entitled` after the batch. Otherwise the rows stay, which is
 *     narrower, and the run detail says so. A row is restored only while it still reads what the
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
import type {
  MigrationContext,
  MigrationJob,
  UnitOutcome,
} from "../../core/migrate/job.js";
import { SERVICE_SLUGS, type ServicesMap } from "../../core/services.js";
import type { Db, DbStatement } from "../../db/types.js";
import { parseJsonObject } from "../../platform/json.js";
import { openAccessOf } from "./access.js";
import {
  forgetRegistrySettings,
  REGISTRY_SETTINGS_TTL_SECONDS,
} from "./registry/settings.js";

/**
 * The least time between the two phases of either direction: one cache window, plus a margin
 * for the whole-second clock the runner hands a job (an entry cached just before a write lives
 * a little past `moved_at + TTL`).
 */
export const PHASE_GAP_SECONDS = REGISTRY_SETTINGS_TTL_SECONDS + 5;

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

/** Thrown while a unit waits out the registry settings cache window; apply again to resume. */
export class RegistryCacheWindowError extends Error {
  override name = "registry_cache_window";
  constructor(
    readonly waitSeconds: number,
    what: string,
  ) {
    super(
      `${what}: wait ${waitSeconds}s for the registry settings cache, then apply again with the same report`,
    );
  }
}

/**
 * The conditions under which an entitled feed may move to `licensed`, as SQL over the feed named
 * by (product, ecosystem): it still reads `entitled`; EVERY declared package id has an own
 * `entitled` row now (not as planned: an operator edit between the plan and the batch widens
 * otherwise); and no package row the job wrote is younger than one cache window. Authenticated
 * feeds need none of the last two (one row, same strictness).
 */
function moveGuard(
  product: string,
  f: FeedPlan,
  now: number,
): { sql: string; params: (string | number)[] } {
  const feedIs = `EXISTS (SELECT 1 FROM dist_registry_feeds
                    WHERE product = ? AND ecosystem = ? AND access_mode = ?)`;
  const params: (string | number)[] = [product, f.ecosystem, f.from];
  if (f.from !== "entitled") return { sql: feedIs, params };
  return {
    sql: `${feedIs}
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j
                        LEFT JOIN dist_access a ON a.product = ? AND a.deliverable_id = j.value
                       WHERE a.mode IS NOT 'entitled')
      AND NOT EXISTS (SELECT 1 FROM ${MOVES} l
                       WHERE l.product = ? AND l.ecosystem = ? AND l.deliverable_id <> ''
                         AND l.moved_at > ?)`,
    params: [
      ...params,
      JSON.stringify(f.packages.map((p) => p.deliverableId)),
      product,
      product,
      f.ecosystem,
      now - PHASE_GAP_SECONDS,
    ],
  };
}

/**
 * Phase A (the ledger and the package rows) and, where the guard allows, phase B (the feed), in
 * one batch per product. Within one batch the rows are always younger than the window, so an
 * entitled feed with rows to write moves on a LATER call; an authenticated feed, or an entitled
 * feed whose rows were written a window ago, moves now.
 */
function applyStatements(
  product: string,
  plan: FeedAccessUnitPlan,
  now: number,
): DbStatement[] {
  const out: DbStatement[] = [];
  for (const f of plan.feeds) {
    // 1. The ledger, first: the feed row's prior mode, then each package row's prior state. A
    //    row raised again (an operator lowered it after phase A) keeps its first prior state and
    //    restarts its window.
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
        sql: `INSERT INTO ${MOVES}
                (product, ecosystem, deliverable_id, from_feed_mode, had_row, prior_mode,
                 prior_entitlement, prior_source, moved_at)
              SELECT f.product, f.ecosystem, ?, f.access_mode, a.product IS NOT NULL, a.mode,
                     a.entitlement, a.source, ?
                FROM dist_registry_feeds f
                LEFT JOIN dist_access a ON a.product = f.product AND a.deliverable_id = ?
               WHERE f.product = ? AND f.ecosystem = ? AND f.access_mode = 'entitled'
              ON CONFLICT (product, ecosystem, deliverable_id) DO UPDATE SET moved_at = excluded.moved_at`,
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
    // 3. The feed, under the guard. Its ledger row is stamped first by the same guard (neither
    //    statement changes what the guard reads), so the stamp says "this job moved it".
    const g = moveGuard(product, f, now);
    out.push({
      sql: `UPDATE ${MOVES} SET feed_moved_at = ?
             WHERE product = ? AND ecosystem = ? AND deliverable_id = '' AND feed_moved_at IS NULL
               AND ${g.sql}`,
      params: [now, product, f.ecosystem, ...g.params],
    });
    out.push({
      sql: `UPDATE dist_registry_feeds SET access_mode = 'licensed'
             WHERE product = ? AND ecosystem = ? AND access_mode = ? AND ${g.sql}`,
      params: [product, f.ecosystem, f.from, ...g.params],
    });
  }
  return out;
}

interface MoveRow {
  ecosystem: string;
  deliverable_id: string;
  from_feed_mode: string;
  had_row: number;
  prior_mode: string | null;
  prior_source: string | null;
  moved_at: number;
  feed_moved_at: number | null;
  feed_restored_at: number | null;
}

async function movesOf(db: Db, product: string): Promise<MoveRow[]> {
  return db.all<MoveRow>(
    `SELECT ecosystem, deliverable_id, from_feed_mode, had_row, prior_mode, prior_source,
            moved_at, feed_moved_at, feed_restored_at
       FROM ${MOVES} WHERE product = ? ORDER BY ecosystem, deliverable_id`,
    product,
  );
}

async function applyUnit(
  ctx: MigrationContext,
  unit: string,
  reported: unknown,
): Promise<UnitOutcome> {
  const { db, now } = ctx;
  const plan = await planUnit(ctx, unit);
  if (plan.feeds.length === 0)
    // Nothing left to move. A unit this job already moved (a call killed after its write, or
    // resumed after the wait) still answers its ledger size, so `down` finds it.
    return { changes: (await movesOf(db, unit)).length };
  await db.batch(applyStatements(unit, plan, now));
  forgetRegistrySettings(unit);
  const after = new Map(
    (await feedsOf(db, unit)).map((r) => [r.ecosystem, r.access_mode]),
  );
  const moved = plan.feeds.filter((f) => after.get(f.ecosystem) !== f.from);
  const waiting = plan.feeds.filter((f) => after.get(f.ecosystem) === f.from);
  if (waiting.length > 0) {
    const ledger = await movesOf(db, unit);
    const youngest = Math.max(
      ...ledger
        .filter(
          (m) =>
            m.deliverable_id !== "" &&
            waiting.some((w) => w.ecosystem === m.ecosystem),
        )
        .map((m) => m.moved_at),
      now,
    );
    throw new RegistryCacheWindowError(
      Math.max(1, youngest + PHASE_GAP_SECONDS - now),
      `${waiting.map((w) => w.ecosystem).join(", ")}: package rows written, feed not yet moved`,
    );
  }
  // The apply re-plans (the report was read earlier): name every feed it moved that the dry run
  // the operator read did not list, so the F4 owner confirmation sees them.
  const listed = new Set(
    ((reported as FeedAccessUnitPlan | null)?.feeds ?? []).map(
      (f) => `${f.ecosystem}:${f.from}`,
    ),
  );
  const notInReport = moved
    .filter((f) => !listed.has(`${f.ecosystem}:${f.from}`))
    .map((f) => `${f.ecosystem} (${f.from})`);
  return {
    changes:
      moved.length +
      plan.feeds.reduce(
        (n, f) => n + f.packages.filter((p) => p.action !== "keep").length,
        0,
      ),
    detail: {
      moved: moved.map((f) => ({ ecosystem: f.ecosystem, from: f.from })),
      ...(notInReport.length > 0 ? { notInReport } : {}),
    },
  };
}

/**
 * Down, two phases a cache window apart so the feed and a package's mode never change in one
 * step: (1) each feed the job moved goes back to its prior mode (only while it still reads
 * `licensed`), stamped `feed_restored_at`; (2) a window later, the package rows. The rows are
 * restored or deleted only where that ecosystem's feed reads `entitled` after phase 1. Where it
 * reads anything else (the operator chose Public, or moved it since) the rows stay: an
 * `entitled` row under another feed mode is narrower, never wider, than the state before the
 * apply, and restoring them could widen past what the operator now has.
 */
async function downUnit(
  ctx: MigrationContext,
  unit: string,
): Promise<UnitOutcome> {
  const { db, now } = ctx;
  let ledger = await movesOf(db, unit);
  if (ledger.length === 0) return { changes: 0 };
  const total = ledger.length;
  const feedRows = ledger.filter((m) => m.deliverable_id === "");
  const phase1: DbStatement[] = [];
  for (const m of feedRows.filter((r) => r.feed_restored_at === null)) {
    if (m.feed_moved_at !== null)
      phase1.push({
        sql: `UPDATE dist_registry_feeds SET access_mode = ?
               WHERE product = ? AND ecosystem = ? AND access_mode = 'licensed'`,
        params: [m.from_feed_mode, unit, m.ecosystem],
      });
    phase1.push({
      sql: `UPDATE ${MOVES} SET feed_restored_at = ?
             WHERE product = ? AND ecosystem = ? AND deliverable_id = ''`,
      params: [now, unit, m.ecosystem],
    });
  }
  if (phase1.length > 0) {
    await db.batch(phase1);
    forgetRegistrySettings(unit);
    ledger = await movesOf(db, unit);
  }
  const modes = new Map(
    (await feedsOf(db, unit)).map((r) => [r.ecosystem, r.access_mode]),
  );
  const restoredAt = new Map(
    ledger
      .filter((m) => m.deliverable_id === "")
      .map((m) => [m.ecosystem, m.feed_restored_at ?? now]),
  );
  const phase2: DbStatement[] = [];
  const restored: string[] = [];
  const left: string[] = [];
  const waiting: number[] = [];
  for (const eco of [...new Set(ledger.map((m) => m.ecosystem))]) {
    const rows = ledger.filter(
      (m) => m.ecosystem === eco && m.deliverable_id !== "",
    );
    const entitledNow = modes.get(eco) === "entitled";
    if (rows.length > 0 && entitledNow) {
      const due = (restoredAt.get(eco) ?? now) + PHASE_GAP_SECONDS;
      if (due > now) {
        waiting.push(due - now);
        continue; // this ecosystem's ledger stays for the next call
      }
      for (const m of rows)
        phase2.push(
          m.had_row === 1
            ? {
                // A row that existed goes back to its prior mode and source (the flag was never
                // changed), only while it still reads what the apply wrote.
                sql: `UPDATE dist_access SET mode = ?, source = ?
                       WHERE product = ? AND deliverable_id = ? AND mode = 'entitled' AND source = 'admin'`,
                params: [m.prior_mode, m.prior_source, unit, m.deliverable_id],
              }
            : {
                // A row the job created goes, unless an operator has since given it a flag.
                sql: `DELETE FROM dist_access
                       WHERE product = ? AND deliverable_id = ? AND mode = 'entitled'
                         AND source = 'admin' AND entitlement IS NULL`,
                params: [unit, m.deliverable_id],
              },
        );
      restored.push(eco);
    } else if (rows.length > 0) left.push(eco);
    phase2.push({
      sql: `DELETE FROM ${MOVES} WHERE product = ? AND ecosystem = ?`,
      params: [unit, eco],
    });
  }
  if (phase2.length > 0) {
    await db.batch(phase2);
    forgetRegistrySettings(unit);
  }
  if (waiting.length > 0)
    throw new RegistryCacheWindowError(
      Math.max(1, Math.min(...waiting)),
      "feeds restored, package rows not yet",
    );
  return {
    changes: total,
    detail: {
      restoredRows: restored,
      ...(left.length > 0
        ? {
            rowsKept: left,
            note: "the feed no longer reads entitled, so the package rows were left at entitled (narrower than before the apply)",
          }
        : {}),
    },
  };
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
  apply: (ctx, unit, reported) => applyUnit(ctx, unit, reported),
  down: (ctx, unit) => downUnit(ctx, unit),
};
