/**
 * The package-feed render queue (F-03, plans/F-01.md §6.5; `registry_render_queue`, 0058_d).
 *
 * Distribution renders each ecosystem's index documents (packuments, simple pages, release
 * lists, …) into R2 when a package changes. Release is where packages change, but Release cannot
 * call Distribution (rule 6) and the descriptor hooks are read-only (`hooks.ts` rule 2). So the
 * writer enqueues here, in the SAME D1 batch as its own write — a publish, yank, unyank,
 * deprecate or channel move of a package release; Distribution's feed settings writes and
 * `packageFeeds` toggles too — and the composition root drains the queue into Distribution's
 * materialiser (F-02's framework). Core owns the table, so both services may write it.
 *
 * The queue coalesces: one row per (owner, deliverable), because a render reads the package's
 * whole current state. An enqueue on a queued row bumps its `generation`; a drain reads the
 * rows with their generations, renders, and deletes each row only if its generation is still the
 * one it read (`stmtConsumeRender`), so an enqueue that lands mid-render is never lost and a crash
 * leaves the row for the next drain.
 *
 * A row whose render fails stays queued with its `attempts` counted (`stmtRenderFailed`), and the
 * drain reads fewest-attempts first, so a package that keeps failing never holds the head of the
 * queue ahead of fresh changes; an enqueue resets the count (0058_f).
 */

import type { Env } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import { buildHooks } from "./hooks.js";
import { loadProductPublic, type ProductPublic } from "./products.js";
import type { RegistryMaterialiser, ServiceRegistry } from "./registry.js";
import { SERVICE_SLUGS } from "./services.js";

/** The `deliverable_id` of a full render: every package of the owner. */
export const RENDER_ALL = "*";

/** Why a render was asked for (free text in the table; these are the values written today). */
export type RenderReason =
  | "publish"
  | "yank"
  | "unyank"
  | "deprecate"
  | "undeprecate"
  | "channel"
  | "settings"
  | "package-feeds"
  | "rebuild";

/**
 * The statement that enqueues (or re-enqueues) a render of one package deliverable of `product`
 * (`RENDER_ALL` for all of them). Meant to ride in the writer's own batch.
 */
export function stmtEnqueuePackageRender(
  product: string,
  deliverableId: string,
  reason: RenderReason,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO registry_render_queue (product, deliverable_id, reason, enqueued_at, generation)
          VALUES (?, ?, ?, ?, 1)
          ON CONFLICT(product, deliverable_id) DO UPDATE SET
            reason = excluded.reason,
            enqueued_at = excluded.enqueued_at,
            generation = registry_render_queue.generation + 1,
            attempts = 0`,
    params: [product, deliverableId, reason, now],
  };
}

/** Enqueue one render on its own (a writer with no batch of its own to ride in). */
export async function enqueuePackageRender(
  db: Db,
  product: string,
  deliverableId: string,
  reason: RenderReason,
  now: number,
): Promise<void> {
  const s = stmtEnqueuePackageRender(product, deliverableId, reason, now);
  await db.run(s.sql, ...s.params);
}

export interface QueuedRender {
  product: string;
  deliverableId: string;
  reason: string;
  enqueuedAt: number;
  generation: number;
  /** Failed renders of this row since it was last enqueued. */
  attempts: number;
}

/**
 * The next queued renders, at most `limit` (the drain's batch): rows that have failed least
 * first, then oldest first, so failing rows sit behind fresh ones and cannot block the head.
 */
export async function readRenderQueue(
  db: Db,
  limit: number,
): Promise<QueuedRender[]> {
  const rows = await db.all<{
    product: string;
    deliverable_id: string;
    reason: string;
    enqueued_at: number;
    generation: number;
    attempts: number;
  }>(
    `SELECT product, deliverable_id, reason, enqueued_at, generation, attempts
       FROM registry_render_queue
      ORDER BY attempts ASC, enqueued_at ASC, product ASC, deliverable_id ASC
      LIMIT ?`,
    limit,
  );
  return rows.map((r) => ({
    product: r.product,
    deliverableId: r.deliverable_id,
    reason: r.reason,
    enqueuedAt: r.enqueued_at,
    generation: r.generation,
    attempts: r.attempts,
  }));
}

/** Delete a rendered row, only if nothing re-enqueued it since the drain read `generation`. */
export function stmtConsumeRender(q: QueuedRender): DbStatement {
  return {
    sql: `DELETE FROM registry_render_queue
           WHERE product = ? AND deliverable_id = ? AND generation = ?`,
    params: [q.product, q.deliverableId, q.generation],
  };
}

/**
 * Count a failed render on a row, only if nothing re-enqueued it since the drain read
 * `generation` (a re-enqueue already reset the count and names a new state).
 */
export function stmtRenderFailed(q: QueuedRender): DbStatement {
  return {
    sql: `UPDATE registry_render_queue SET attempts = attempts + 1
           WHERE product = ? AND deliverable_id = ? AND generation = ?`,
    params: [q.product, q.deliverableId, q.generation],
  };
}

// ── The drain (feed-adapter contract: the consumer F-02 and F-03 each left to the other) ──────

/** The most rows one drain reads (one request's `waitUntil`, or one cron tick). */
export const DRAIN_BATCH = 100;

/** The most packages one cron tick's self-check re-renders across every owner (§6.5). */
export const SELF_CHECK_BUDGET = 50;

/** The one enabled service that renders the feeds for `product`, or `null`. */
function materialiserFor(
  registry: ServiceRegistry,
  product: ProductPublic,
): RegistryMaterialiser | null {
  for (const slug of SERVICE_SLUGS) {
    const d = registry.get(slug);
    if (d?.registryMaterialiser && product.services[slug]?.enabled)
      return d.registryMaterialiser;
  }
  return null;
}

/** What a drain reports: rows rendered, products that failed, rows dropped (nothing to render). */
export interface RenderDrainReport {
  rendered: number;
  failed: number;
  dropped: number;
}

/**
 * Drain the render queue: read up to `limit` rows, oldest first, and hand each owner's rows to
 * the enabled service's `registryMaterialiser` (Distribution's). A row whose owner is gone, or
 * has no renderer enabled, renders nothing and is dropped (a later `packageFeeds` or settings
 * write enqueues again). A product whose render throws keeps its rows for the next drain; the
 * others still run. Idempotent and safe to run concurrently: a row is deleted only while its
 * `generation` is the one read (`stmtConsumeRender`).
 */
export async function drainRenderQueue(
  registry: ServiceRegistry,
  ctx: { env: Env; db: Db; now: number },
  opts: { limit?: number } = {},
): Promise<RenderDrainReport> {
  const report: RenderDrainReport = { rendered: 0, failed: 0, dropped: 0 };
  const rows = await readRenderQueue(ctx.db, opts.limit ?? DRAIN_BATCH);
  const byProduct = new Map<string, QueuedRender[]>();
  for (const r of rows) {
    const list = byProduct.get(r.product);
    if (list) list.push(r);
    else byProduct.set(r.product, [r]);
  }
  const consumed = new Set<QueuedRender>();
  const consume = async (row: QueuedRender): Promise<void> => {
    const s = stmtConsumeRender(row);
    await ctx.db.run(s.sql, ...s.params);
    consumed.add(row);
  };
  // Every row of a product the drain did not consume failed: count it, so it moves behind fresh
  // rows. Best effort; a write that fails here only leaves the row where it was.
  const countFailures = async (
    list: readonly QueuedRender[],
  ): Promise<void> => {
    for (const row of list) {
      if (consumed.has(row)) continue;
      const s = stmtRenderFailed(row);
      await ctx.db.run(s.sql, ...s.params).catch(() => undefined);
    }
  };
  for (const [slug, list] of byProduct) {
    try {
      const product = await loadProductPublic(ctx.db, slug);
      const materialiser = product ? materialiserFor(registry, product) : null;
      if (!product || !materialiser) {
        for (const row of list) await consume(row);
        report.dropped += list.length;
        continue;
      }
      const hooks = buildHooks(registry, product.services, {
        env: ctx.env,
        db: ctx.db,
        product,
        now: ctx.now,
      });
      const out = await materialiser.drain(
        { env: ctx.env, db: ctx.db, product, now: ctx.now, hooks },
        list,
        consume,
      );
      report.rendered += out.rendered;
      report.failed += out.failed;
      await countFailures(list);
    } catch {
      report.failed += 1;
      await countFailures(list);
    }
  }
  return report;
}

/**
 * The cron's self-check (§6.5): for each of `slugs`, ask the enabled renderer to re-render the
 * packages whose stored stamp differs from D1, `budget` packages at most across all of them.
 * Fault-isolated per product. Answers how many it re-rendered and which products failed.
 */
export async function selfCheckRenders(
  registry: ServiceRegistry,
  ctx: { env: Env; db: Db; now: number },
  slugs: readonly string[],
  budget: number = SELF_CHECK_BUDGET,
): Promise<{ rerendered: number; failures: Record<string, string> }> {
  let left = budget;
  const failures: Record<string, string> = {};
  for (const slug of slugs) {
    if (left <= 0) break;
    try {
      const product = await loadProductPublic(ctx.db, slug);
      const materialiser = product ? materialiserFor(registry, product) : null;
      if (!product || !materialiser) continue;
      const hooks = buildHooks(registry, product.services, {
        env: ctx.env,
        db: ctx.db,
        product,
        now: ctx.now,
      });
      left -= await materialiser.selfCheck(
        { env: ctx.env, db: ctx.db, product, now: ctx.now, hooks },
        left,
      );
    } catch (e) {
      failures[slug] = e instanceof Error ? e.message : String(e);
    }
  }
  return { rerendered: budget - left, failures };
}

export const ENQUEUE_SQL = /^\s*INSERT\s+INTO\s+registry_render_queue\b/i;

/**
 * `db`, watched for render enqueues: `enqueued()` answers whether any statement run through it
 * wrote `registry_render_queue` (`stmtEnqueuePackageRender`). `dispatch.ts` wraps the request's
 * database with it so a drain runs after exactly the requests that enqueued, and costs the rest
 * nothing.
 */
export function watchRenderEnqueues(db: Db): { db: Db; enqueued(): boolean } {
  let seen = false;
  const look = (sql: string) => {
    if (!seen && ENQUEUE_SQL.test(sql)) seen = true;
  };
  const watched: Db = {
    all: (sql, ...params) => db.all(sql, ...params),
    first: (sql, ...params) => db.first(sql, ...params),
    run: (sql, ...params) => {
      look(sql);
      return db.run(sql, ...params);
    },
    runChanges: (sql, ...params) => {
      look(sql);
      return db.runChanges(sql, ...params);
    },
    batch: (statements) => {
      for (const s of statements) look(s.sql);
      return db.batch(statements);
    },
    ...(db.batchChanges
      ? {
          batchChanges: (statements: DbStatement[]) => {
            for (const s of statements) look(s.sql);
            return db.batchChanges!(statements);
          },
        }
      : {}),
  };
  return { db: watched, enqueued: () => seen };
}
