/**
 * The package-feed render queue (F-03, plans/F-01.md §6.5; `registry_render_queue`, 0055_d).
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
 */

import type { Db, DbStatement } from "../db/types.js";

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
            generation = registry_render_queue.generation + 1`,
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
}

/** The oldest queued renders, at most `limit` (the drain's batch). */
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
  }>(
    `SELECT product, deliverable_id, reason, enqueued_at, generation
       FROM registry_render_queue
      ORDER BY enqueued_at ASC, product ASC, deliverable_id ASC
      LIMIT ?`,
    limit,
  );
  return rows.map((r) => ({
    product: r.product,
    deliverableId: r.deliverable_id,
    reason: r.reason,
    enqueuedAt: r.enqueued_at,
    generation: r.generation,
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
