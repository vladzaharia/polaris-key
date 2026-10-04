/**
 * `release_lazy_deltas` (migration 0051): one row per pair the consumer decided — `ready` with
 * its descriptor, `refused` with a permanent reason, or `cold` once its blob ref was dropped for
 * P4-14's collector. The primary key (product, from, to, method) is the idempotency key.
 */

import type { Db } from "../../../../core/platform.js";
import type { LazyDeltaDescriptor, LazyDeltaRefusal } from "./policy.js";
import { LAZY_DELTA_METHOD } from "./policy.js";

/** The `blob_refs.ref_kind` a generated delta is held by (never dropped by the collector,
 *  `core/blobGc.ts`; only this package's cold marking drops it). */
export const LAZY_DELTA_REF_KIND = "lazy-delta";

export type LazyDeltaState = "ready" | "refused" | "cold";

export interface LazyDeltaRow {
  deliverableId: string;
  buildId: string;
  from: string;
  to: string;
  state: LazyDeltaState;
  reason: string | null;
  storageKey: string | null;
  descriptor: LazyDeltaDescriptor | null;
  createdAt: number;
}

interface Raw {
  deliverable_id: string;
  build_id: string;
  from_sha256: string;
  to_sha256: string;
  state: LazyDeltaState;
  reason: string | null;
  storage_key: string | null;
  descriptor_json: string | null;
  created_at: number;
}

function rowOf(r: Raw): LazyDeltaRow {
  let descriptor: LazyDeltaDescriptor | null = null;
  if (r.descriptor_json) {
    try {
      descriptor = JSON.parse(r.descriptor_json) as LazyDeltaDescriptor;
    } catch {
      descriptor = null;
    }
  }
  return {
    deliverableId: r.deliverable_id,
    buildId: r.build_id,
    from: r.from_sha256,
    to: r.to_sha256,
    state: r.state,
    reason: r.reason,
    storageKey: r.storage_key,
    descriptor,
    createdAt: r.created_at,
  };
}

const COLUMNS = `deliverable_id, build_id, from_sha256, to_sha256, state, reason, storage_key,
                 descriptor_json, created_at`;

/** The pair's row, or null. */
export async function lazyDeltaRow(
  db: Db,
  product: string,
  from: string,
  to: string,
): Promise<LazyDeltaRow | null> {
  const r = await db.first<Raw>(
    `SELECT ${COLUMNS} FROM release_lazy_deltas
      WHERE product = ? AND from_sha256 = ? AND to_sha256 = ? AND method = ?`,
    product,
    from,
    to,
    LAZY_DELTA_METHOD,
  );
  return r ? rowOf(r) : null;
}

/** The product's ready deltas to `to` (what a delta menu offers for that payload). */
export async function readyDeltasTo(
  db: Db,
  product: string,
  to: string,
): Promise<LazyDeltaRow[]> {
  const rows = await db.all<Raw>(
    `SELECT ${COLUMNS} FROM release_lazy_deltas
      WHERE product = ? AND to_sha256 = ? AND method = ? AND state = 'ready'
      ORDER BY created_at, from_sha256`,
    product,
    to,
    LAZY_DELTA_METHOD,
  );
  return rows.map(rowOf);
}

/** Deltas the product generated since `since` (the daily cap). */
export async function generatedSince(
  db: Db,
  product: string,
  since: number,
): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM release_lazy_deltas
      WHERE product = ? AND state IN ('ready', 'cold') AND created_at >= ?`,
    product,
    since,
  );
  return row?.n ?? 0;
}

export interface PairKey {
  product: string;
  deliverableId: string;
  buildId: string;
  from: string;
  to: string;
}

/** Record a ready delta. A row that already exists is left alone (a duplicate job). */
export async function recordReady(
  db: Db,
  key: PairKey,
  storageKey: string,
  descriptor: LazyDeltaDescriptor,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO release_lazy_deltas
       (product, deliverable_id, build_id, from_sha256, to_sha256, method, state, reason,
        storage_key, artifact_sha256, artifact_bytes, descriptor_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, from_sha256, to_sha256, method) DO NOTHING`,
    key.product,
    key.deliverableId,
    key.buildId,
    key.from,
    key.to,
    LAZY_DELTA_METHOD,
    storageKey,
    descriptor.artifact.sha256,
    descriptor.artifact.bytes,
    JSON.stringify(descriptor),
    now,
    now,
  );
}

/** Record a permanent refusal, so the pair is not encoded again every night. */
export async function recordRefused(
  db: Db,
  key: PairKey,
  reason: LazyDeltaRefusal,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO release_lazy_deltas
       (product, deliverable_id, build_id, from_sha256, to_sha256, method, state, reason,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'refused', ?, ?, ?)
     ON CONFLICT(product, from_sha256, to_sha256, method) DO NOTHING`,
    key.product,
    key.deliverableId,
    key.buildId,
    key.from,
    key.to,
    LAZY_DELTA_METHOD,
    reason,
    now,
    now,
  );
}

/** Ready deltas created before `before`, oldest first (the cold scan's candidates). */
export async function readyBefore(
  db: Db,
  product: string,
  before: number,
  limit: number,
): Promise<LazyDeltaRow[]> {
  const rows = await db.all<Raw>(
    `SELECT ${COLUMNS} FROM release_lazy_deltas
      WHERE product = ? AND state = 'ready' AND created_at < ?
      ORDER BY created_at, from_sha256 LIMIT ?`,
    product,
    before,
    limit,
  );
  return rows.map(rowOf);
}

/**
 * Mark a ready delta cold and drop the product's `lazy-delta` ref to its object, in one batch:
 * with no ref left, P4-14's mark and sweep collect the object (a delta needs only the minimum
 * grace, `core/blobGc.ts`). The row stays, so the pair is not regenerated while it stays cold;
 * the sweep revives it (`ready` again) if devices come back to it.
 */
export async function markCold(
  db: Db,
  product: string,
  row: LazyDeltaRow,
  now: number,
): Promise<void> {
  const statements = [
    {
      sql: `UPDATE release_lazy_deltas SET state = 'cold', updated_at = ?
             WHERE product = ? AND from_sha256 = ? AND to_sha256 = ? AND method = ?
               AND state = 'ready'`,
      params: [now, product, row.from, row.to, LAZY_DELTA_METHOD],
    },
  ];
  if (row.storageKey)
    statements.push({
      sql: `DELETE FROM blob_refs
             WHERE product = ? AND storage_key = ? AND ref_kind = ?`,
      params: [product, row.storageKey, LAZY_DELTA_REF_KIND],
    });
  await db.batch(statements);
}

/** Forget a cold pair (its object may be collected) so the next sweep can regenerate it. */
export async function forgetCold(
  db: Db,
  product: string,
  from: string,
  to: string,
): Promise<void> {
  await db.run(
    `DELETE FROM release_lazy_deltas
      WHERE product = ? AND from_sha256 = ? AND to_sha256 = ? AND method = ? AND state = 'cold'`,
    product,
    from,
    to,
    LAZY_DELTA_METHOD,
  );
}
