/**
 * Connector-agnostic state (P5-02): the two tables of migration 0041 and the writers a store
 * connector uses to reach `dist_availability`, `dist_submissions` and `dist_rollouts`.
 *
 *   - `dist_connector_objects` — the store objects a connector tracks (`upsertObject`), which the
 *     poller reconciles and where an object no release claims yet waits (`release_id` NULL).
 *   - `dist_connector_events` — every webhook delivery, now `core/stores/events.ts`.
 *
 * A connector writes availability and submissions through P2b-03's own writers with a
 * `connectorWriter` (`source` = the connector kind, actor `connector:<kind>`), and mirrors a
 * staged rollout through P2b-04's `mirrorRollout`. Nothing here opens a credential.
 */

import { parseJsonObject } from "../../../platform/json.js";
import { randomId } from "../../../platform/crypto.js";
import type { Db } from "../../../db/types.js";
import { appendAudit } from "../../../core/audit.js";
import type { AvailabilityWriter } from "../availability.js";
import type { ConnectorWriteContext } from "../../../core/stores/events.js";

// ── Audit ────────────────────────────────────────────────────────────────────────────────────

/** The audit actor of everything a connector writes on its own (a poll, a webhook). */
export function connectorActor(kind: string): string {
  return `connector:${kind}`;
}

/** Append one audit row as `connector:<kind>`. */
export async function auditConnector(
  ctx: ConnectorWriteContext,
  kind: string,
  label: string,
  action: string,
  target: { kind: string; id: string },
  summary: string,
): Promise<void> {
  await appendAudit(ctx.db, {
    product: ctx.product,
    id: randomId("aud"),
    at: ctx.now,
    actor_sub: connectorActor(kind),
    actor_name: label,
    actor_email: null,
    action,
    target_kind: target.kind,
    target_id: target.id,
    parent_id: null,
    summary,
  });
}

/** The P2b-03 writer for a connector: `source = <kind>`, audited as `connector:<kind>`. */
export function connectorWriter(
  ctx: ConnectorWriteContext,
  kind: string,
  label: string,
): AvailabilityWriter {
  return {
    source: kind,
    label,
    audit: (action, target, summary) =>
      auditConnector(ctx, kind, label, action, target, summary),
  };
}

// ── Objects ──────────────────────────────────────────────────────────────────────────────────

export interface ConnectorObjectRow {
  product: string;
  connector: string;
  object_type: string;
  object_id: string;
  outlet_id: string | null;
  release_id: string | null;
  build_id: string;
  store_state: string | null;
  state: string | null;
  ref_json: string | null;
  detail_json: string | null;
  terminal: number;
  first_seen_at: number;
  updated_at: number;
  polled_at: number | null;
}

export interface ConnectorObject {
  type: string;
  id: string;
  outletId: string | null;
  /** `null` = unresolved: no release claims this object yet. */
  releaseId: string | null;
  buildId: string;
  storeState: string | null;
  state: string | null;
  ref: Record<string, unknown>;
  detail: Record<string, unknown>;
  terminal: boolean;
}

export function objectView(row: ConnectorObjectRow) {
  return {
    type: row.object_type,
    id: row.object_id,
    outletId: row.outlet_id,
    releaseId: row.release_id,
    buildId: row.build_id,
    unresolved: row.release_id === null,
    storeState: row.store_state,
    state: row.state,
    ref: parseJsonObject(row.ref_json) ?? {},
    detail: parseJsonObject(row.detail_json) ?? {},
    terminal: row.terminal === 1,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
    polledAt: row.polled_at,
  };
}

export function getObject(
  db: Db,
  product: string,
  connector: string,
  type: string,
  id: string,
): Promise<ConnectorObjectRow | null> {
  return db.first<ConnectorObjectRow>(
    `SELECT * FROM dist_connector_objects
      WHERE product = ? AND connector = ? AND object_type = ? AND object_id = ?`,
    product,
    connector,
    type,
    id,
  );
}

/** Objects of one connector, newest first; optionally only of some types. */
export function listObjects(
  db: Db,
  product: string,
  connector: string,
  opts: { types?: readonly string[]; limit?: number } = {},
): Promise<ConnectorObjectRow[]> {
  const types = opts.types ?? [];
  return db.all<ConnectorObjectRow>(
    `SELECT * FROM dist_connector_objects
      WHERE product = ? AND connector = ?
        ${types.length ? `AND object_type IN (${types.map(() => "?").join(", ")})` : ""}
      ORDER BY updated_at DESC, object_type, object_id
      LIMIT ?`,
    product,
    connector,
    ...types,
    opts.limit ?? 200,
  );
}

/** The non-terminal objects of some types the poller should re-read, least recently read
 *  first. */
export function objectsToReconcile(
  db: Db,
  product: string,
  connector: string,
  types: readonly string[],
  limit: number,
): Promise<ConnectorObjectRow[]> {
  if (!types.length) return Promise.resolve([]);
  return db.all<ConnectorObjectRow>(
    `SELECT * FROM dist_connector_objects
      WHERE product = ? AND connector = ? AND terminal = 0
        AND object_type IN (${types.map(() => "?").join(", ")})
      ORDER BY COALESCE(polled_at, 0), object_type, object_id
      LIMIT ?`,
    product,
    connector,
    ...types,
    limit,
  );
}

/**
 * Insert or update one object. `releaseId: undefined` keeps a stored resolution (P5-08 may have
 * claimed the object since); `null` clears it. Returns whether anything a reader sees changed.
 */
export async function upsertObject(
  ctx: ConnectorWriteContext,
  connector: string,
  o: Omit<ConnectorObject, "releaseId"> & {
    releaseId: string | null | undefined;
  },
): Promise<{ changed: boolean; row: ConnectorObjectRow }> {
  const { db, product, now } = ctx;
  const existing = await getObject(db, product, connector, o.type, o.id);
  const releaseId =
    o.releaseId === undefined ? (existing?.release_id ?? null) : o.releaseId;
  const ref = JSON.stringify(o.ref);
  const detail = JSON.stringify(o.detail);
  const terminal = o.terminal ? 1 : 0;
  const changed =
    !existing ||
    existing.outlet_id !== o.outletId ||
    existing.release_id !== releaseId ||
    existing.build_id !== o.buildId ||
    existing.store_state !== o.storeState ||
    existing.state !== o.state ||
    existing.ref_json !== ref ||
    existing.detail_json !== detail ||
    existing.terminal !== terminal;
  await db.run(
    `INSERT INTO dist_connector_objects
       (product, connector, object_type, object_id, outlet_id, release_id, build_id,
        store_state, state, ref_json, detail_json, terminal, first_seen_at, updated_at, polled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product, connector, object_type, object_id) DO UPDATE SET
       outlet_id = excluded.outlet_id,
       release_id = excluded.release_id,
       build_id = excluded.build_id,
       store_state = excluded.store_state,
       state = excluded.state,
       ref_json = excluded.ref_json,
       detail_json = excluded.detail_json,
       terminal = excluded.terminal,
       updated_at = CASE WHEN ? THEN excluded.updated_at ELSE dist_connector_objects.updated_at END,
       polled_at = excluded.polled_at`,
    product,
    connector,
    o.type,
    o.id,
    o.outletId,
    releaseId,
    o.buildId,
    o.storeState,
    o.state,
    ref,
    detail,
    terminal,
    now,
    now,
    now,
    changed ? 1 : 0,
  );
  const row = (await getObject(db, product, connector, o.type, o.id))!;
  return { changed, row };
}

/**
 * Stop re-reading an object the store no longer answers for (404), or that a re-read could not
 * prove is the connector's app: `terminal = 1`, so it cannot hold the head of the reconcile
 * queue. Nothing else on the row changes, and nothing is written from it.
 */
export async function retireObject(
  ctx: ConnectorWriteContext,
  connector: string,
  type: string,
  id: string,
): Promise<void> {
  await ctx.db.run(
    `UPDATE dist_connector_objects SET terminal = 1, polled_at = ?
      WHERE product = ? AND connector = ? AND object_type = ? AND object_id = ?`,
    ctx.now,
    ctx.product,
    connector,
    type,
    id,
  );
}
