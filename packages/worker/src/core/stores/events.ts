/**
 * Store webhook events, shared by every store (P0-27a; moved from `connectors/state.ts`):
 * `dist_connector_events` holds every webhook delivery that passed its signature check, stored raw
 * with its outcome (`recordEvent`); the poll tick re-drives one whose follow-up failed or was cut
 * off (`eventsToRedrive`); the nightly sweep prunes old rows (`pruneEvents`). Nothing here opens
 * a credential.
 */

import type { Db } from "../../db/types.js";

export interface ConnectorWriteContext {
  db: Db;
  product: string;
  now: number;
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────

export type ConnectorEventOutcome =
  | "received"
  | "applied"
  | "stored"
  | "ignored"
  | "unresolved"
  | "failed";

/** The most of a raw payload kept. A webhook body is thin (well under 2 KiB); this only bounds
 *  what a valid-but-hostile signer could store. */
export const MAX_STORED_PAYLOAD = 16 * 1024;

/** How long a stored event is kept before the nightly maintenance sweep prunes it
 *  (`scheduled.ts`, for every product including soft-deleted and Distribution-off ones). */
export const CONNECTOR_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export interface ConnectorEventRow {
  product: string;
  connector: string;
  event_id: string;
  event_type: string;
  instance_type: string | null;
  instance_id: string | null;
  outcome: string;
  payload_json: string;
  received_at: number;
}

export function eventView(row: ConnectorEventRow) {
  return {
    id: row.event_id,
    type: row.event_type,
    instanceType: row.instance_type,
    instanceId: row.instance_id,
    outcome: row.outcome,
    receivedAt: row.received_at,
  };
}

export function eventSeen(
  db: Db,
  product: string,
  connector: string,
  eventId: string,
): Promise<{ outcome: string } | null> {
  return db.first<{ outcome: string }>(
    `SELECT outcome FROM dist_connector_events
      WHERE product = ? AND connector = ? AND event_id = ?`,
    product,
    connector,
    eventId,
  );
}

/** Store one event (raw, capped). A second delivery of an id keeps the first row's payload and
 *  moves only its outcome (a failed event redelivered by hand). */
export async function recordEvent(
  ctx: ConnectorWriteContext,
  connector: string,
  e: {
    id: string;
    type: string;
    instanceType: string | null;
    instanceId: string | null;
    outcome: ConnectorEventOutcome;
    raw: string;
  },
): Promise<void> {
  await ctx.db.run(
    `INSERT INTO dist_connector_events
       (product, connector, event_id, event_type, instance_type, instance_id, outcome,
        payload_json, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product, connector, event_id) DO UPDATE SET outcome = excluded.outcome`,
    ctx.product,
    connector,
    e.id,
    e.type.slice(0, 128),
    e.instanceType,
    e.instanceId,
    e.outcome,
    e.raw.slice(0, MAX_STORED_PAYLOAD),
    ctx.now,
  );
}

export async function setEventOutcome(
  ctx: ConnectorWriteContext,
  connector: string,
  eventId: string,
  outcome: ConnectorEventOutcome,
): Promise<void> {
  await ctx.db.run(
    `UPDATE dist_connector_events SET outcome = ?
      WHERE product = ? AND connector = ? AND event_id = ?`,
    outcome,
    ctx.product,
    connector,
    eventId,
  );
}

/**
 * Events whose follow-up never reached an outcome, for the poller to re-drive, oldest first:
 * `failed` ones, and `received` ones received at or before `receivedBefore` (the follow-up of a delivery
 * runs right after it, so a `received` row older than that was cut off). Only events received
 * since `since` are re-driven; an older one waits for a manual redelivery.
 */
export function eventsToRedrive(
  db: Db,
  product: string,
  connector: string,
  opts: { since: number; receivedBefore: number; limit: number },
): Promise<ConnectorEventRow[]> {
  return db.all<ConnectorEventRow>(
    `SELECT * FROM dist_connector_events
      WHERE product = ? AND connector = ? AND received_at >= ?
        AND instance_type IS NOT NULL AND instance_id IS NOT NULL
        AND (outcome = 'failed' OR (outcome = 'received' AND received_at <= ?))
      ORDER BY received_at, event_id
      LIMIT ?`,
    product,
    connector,
    opts.since,
    opts.receivedBefore,
    opts.limit,
  );
}

export function listEvents(
  db: Db,
  product: string,
  connector: string,
  limit = 50,
): Promise<ConnectorEventRow[]> {
  return db.all<ConnectorEventRow>(
    `SELECT * FROM dist_connector_events WHERE product = ? AND connector = ?
      ORDER BY received_at DESC, event_id LIMIT ?`,
    product,
    connector,
    limit,
  );
}

/** Delete one product's events older than the retention, bounded per call. */
export async function pruneEvents(
  db: Db,
  product: string,
  now: number,
  limit = 500,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM dist_connector_events WHERE rowid IN (
       SELECT rowid FROM dist_connector_events
        WHERE product = ? AND received_at < ? ORDER BY received_at LIMIT ?)`,
    product,
    now - CONNECTOR_EVENT_RETENTION_SECONDS,
    limit,
  );
}

/** `dist_connector_events` source names (CM-29): the stores' notification hooks record under these. */
export const APP_STORE_EVENTS = "app-store-notifications";
