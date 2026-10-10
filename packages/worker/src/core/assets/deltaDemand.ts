/**
 * Lazy-delta demand (P4-17, CONTENT §8.1's telemetry bullet; notes/S-08 §6): which (from, to)
 * payload pairs of a pack devices actually move between, counted from install telemetry.
 *
 * Devices put their recent pack installs in the `packInstalls` key of
 * `POST /<p>/devices/report` (`core/devices.ts`): at most `MAX_PACK_INSTALLS` entries
 *
 *     {pack, from, to, strategy, bytes?, durationMs?, fallbackUsed?, failureStage?}
 *
 * `from` and `to` are payload SHA-256s (a variant's `payload.sha256`), `strategy` the planner's
 * choice (`delta`, `chunk`, `file`, `full`, …). `boundedPackInstalls` keeps only well-formed
 * entries and drops unknown fields. Where the shape lives: P1-05's precedent (and P6-03's
 * `updates`) — this allowlist and the OpenAPI report schema only; `shared-protocol` is untouched
 * (the report is unsigned and the key optional, so no wire change).
 *
 * ── ON THE REQUEST PATH: COUNTERS ONLY ──────────────────────────────────────────────────────
 *
 * `recordPackInstalls` is the only thing the report handler calls: one settings read and one
 * batch of upserts into `delta_demand_devices`, keyed by (product, pack, from, to, device), so a
 * device counts once per pair however often it reports, and holds at most
 * `MAX_DEMAND_ROWS_PER_DEVICE` rows (its oldest are evicted). Nothing here reads a payload, encodes,
 * decodes or diffs a byte, and nothing enqueues: hot pairs are found by the nightly sweep and
 * new payloads by the R2 event the consumer Worker receives (`services/release/packs/deltas/`).
 * It FAILS OPEN and never throws (the snapshot is stored first): telemetry must never cost a
 * device its report.
 *
 * ── GATED TWICE ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing is counted unless the deployment's `LAZY_DELTAS` switch is on (the platform settings
 * store, A-13: the console's value unless the `[vars]` value is a hard `off`) AND the product has
 * a `lazy_delta_settings` row with `enabled = 1` (docs/RUNBOOK.md "Lazy deltas"). Both default
 * off, so deploying this changes nothing until an operator turns it on and opts a product in.
 *
 * Privacy (docs/PRIVACY.md): an entry carries a pack id, two content hashes, a strategy name and
 * optional sizes and timings — no hardware value and no user identifier beyond the device id the
 * Worker already holds (AGENTS.md rule 7). Device rows are kept for at most
 * `DEMAND_RETENTION_SECONDS` (30 days).
 */

import { isDeliverableId } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { platformSetting } from "../settings/platformRead.js";

/** At most this many `packInstalls` entries per report; the rest are dropped. */
export const MAX_PACK_INSTALLS = 8;
/** Free-text members are cut to this many characters. */
export const PACK_INSTALL_STRING_MAX = 128;
/** A pair is hot when at least this many distinct devices moved without a delta… */
export const DEFAULT_HOT_DEVICES = 25;
/** …within this window (seconds). */
export const HOT_WINDOW_SECONDS = 7 * 86400;
/** Device rows older than this are pruned, and a generated delta no device used for this long
 *  goes cold (`services/release/packs/deltas/sweep.ts`). */
export const DEMAND_RETENTION_SECONDS = 30 * 86400;
/** Deltas one product may generate per day, unless its settings say otherwise. */
export const DEFAULT_DAILY_CAP = 20;
/** Demand rows one device may hold per product; a report past it evicts the device's oldest. A
 *  device can claim any pair, so this bounds what one device can write, whatever it sends. */
export const MAX_DEMAND_ROWS_PER_DEVICE = 32;
/** The `strategy` value that is not demand: the device already had a delta. */
export const DELTA_STRATEGY = "delta";

const HEX64 = /^[0-9a-f]{64}$/;
const STRATEGY = /^[a-z][a-z0-9-]{0,31}$/;
const FREE_TEXT = /^[\x20-\x7e]+$/;

/** One validated entry, as the report snapshot stores it. */
export interface PackInstallEntry {
  pack: string;
  from: string;
  to: string;
  strategy: string;
  bytes?: number;
  durationMs?: number;
  fallbackUsed?: boolean;
  failureStage?: string;
}

const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function boundedEntry(raw: unknown): PackInstallEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (
    !isDeliverableId(e.pack) ||
    typeof e.from !== "string" ||
    !HEX64.test(e.from) ||
    typeof e.to !== "string" ||
    !HEX64.test(e.to) ||
    typeof e.strategy !== "string" ||
    !STRATEGY.test(e.strategy)
  )
    return null;
  const out: PackInstallEntry = {
    pack: e.pack,
    from: e.from,
    to: e.to,
    strategy: e.strategy,
  };
  if (count(e.bytes)) out.bytes = e.bytes;
  if (count(e.durationMs)) out.durationMs = e.durationMs;
  if (typeof e.fallbackUsed === "boolean") out.fallbackUsed = e.fallbackUsed;
  if (typeof e.failureStage === "string" && e.failureStage.length > 0) {
    const stage = e.failureStage.slice(0, PACK_INSTALL_STRING_MAX);
    if (FREE_TEXT.test(stage)) out.failureStage = stage;
  }
  return out;
}

/**
 * Bound `packInstalls`: the first `MAX_PACK_INSTALLS` entries of an array, each validated; a
 * malformed entry is dropped, unknown fields stripped, `failureStage` cut to 128 characters.
 * Not an array, or nothing left: `undefined` (the key is dropped).
 */
export function boundedPackInstalls(
  input: unknown,
): PackInstallEntry[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: PackInstallEntry[] = [];
  for (const raw of input.slice(0, MAX_PACK_INSTALLS)) {
    const e = boundedEntry(raw);
    if (e) out.push(e);
  }
  return out.length > 0 ? out : undefined;
}

// ── The opt-in ───────────────────────────────────────────────────────────────────────────────

/**
 * The deployment's kill switch, resolved through the platform settings store (A-13,
 * `core/platformSettings.ts`): a `[vars]` value of `off` is a hard off that answers without a
 * read; otherwise a console value, then `[vars]` `on`, then off.
 */
export async function lazyDeltasOn(
  env: Pick<Env, "LAZY_DELTAS">,
  db: Db,
): Promise<boolean> {
  return (await platformSetting(env, db, "deltas.lazy.mode")) === "on";
}

export interface LazyDeltaSettings {
  enabled: boolean;
  hotDevices: number;
  dailyCap: number;
}

const OFF: LazyDeltaSettings = {
  enabled: false,
  hotDevices: DEFAULT_HOT_DEVICES,
  dailyCap: DEFAULT_DAILY_CAP,
};

/** A product's opt-in (no row: off), defaults filled. */
export async function lazyDeltaSettings(
  db: Db,
  product: string,
): Promise<LazyDeltaSettings> {
  const row = await db.first<{
    enabled: number;
    hot_devices: number | null;
    daily_cap: number | null;
  }>(
    "SELECT enabled, hot_devices, daily_cap FROM lazy_delta_settings WHERE product = ?",
    product,
  );
  if (!row) return OFF;
  return {
    enabled: row.enabled === 1,
    hotDevices: row.hot_devices ?? DEFAULT_HOT_DEVICES,
    dailyCap: row.daily_cap ?? DEFAULT_DAILY_CAP,
  };
}

/** Whether lazy deltas are on for `product`: the kill switch and the product's opt-in. */
export async function lazyDeltasEnabled(
  env: Pick<Env, "LAZY_DELTAS">,
  db: Db,
  product: string,
): Promise<LazyDeltaSettings | null> {
  if (!(await lazyDeltasOn(env, db))) return null;
  const s = await lazyDeltaSettings(db, product);
  return s.enabled ? s : null;
}

/** Every product opted in (the sweep's list); empty while the kill switch is off. */
export async function lazyDeltaProducts(
  env: Pick<Env, "LAZY_DELTAS">,
  db: Db,
): Promise<string[]> {
  if (!(await lazyDeltasOn(env, db))) return [];
  const rows = await db.all<{ product: string }>(
    `SELECT s.product FROM lazy_delta_settings s
       JOIN products p ON p.slug = s.product
      WHERE s.enabled = 1 AND p.status = 'active' AND p.deleted_at IS NULL
      ORDER BY s.product`,
  );
  return rows.map((r) => r.product);
}

// ── Ingest (the request path) ────────────────────────────────────────────────────────────────

/**
 * Count one report's `packInstalls`: one upsert per pair into `delta_demand_devices`, all in one
 * batch, keeping the latest strategy and time. Answers how many pairs it touched (0 when lazy
 * deltas are off for the product). D1 only: no queue, no blob store, no byte work. Never throws.
 */
export async function recordPackInstalls(
  env: Pick<Env, "LAZY_DELTAS">,
  db: Db,
  product: string,
  deviceId: string,
  entries: readonly PackInstallEntry[],
  now: number,
): Promise<number> {
  try {
    if (entries.length === 0) return 0;
    if (!(await lazyDeltasEnabled(env, db, product))) return 0;
    const seen = new Set<string>();
    const statements: DbStatement[] = [];
    for (const e of entries) {
      if (e.from === e.to) continue;
      const key = `${e.pack}|${e.from}|${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      statements.push({
        sql: `INSERT INTO delta_demand_devices
                (product, deliverable_id, from_sha256, to_sha256, device_id, strategy, seen_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(product, deliverable_id, from_sha256, to_sha256, device_id)
              DO UPDATE SET strategy = excluded.strategy,
                            seen_at = MAX(delta_demand_devices.seen_at, excluded.seen_at)`,
        params: [product, e.pack, e.from, e.to, deviceId, e.strategy, now],
      });
    }
    if (statements.length === 0) return 0;
    const upserts = statements.length;
    // Keep the device's newest rows only: the request path's writes stay bounded per device.
    statements.push({
      sql: `DELETE FROM delta_demand_devices
             WHERE product = ? AND device_id = ? AND rowid NOT IN (
               SELECT rowid FROM delta_demand_devices
                WHERE product = ? AND device_id = ?
                ORDER BY seen_at DESC, rowid DESC LIMIT ?)`,
      params: [
        product,
        deviceId,
        product,
        deviceId,
        MAX_DEMAND_ROWS_PER_DEVICE,
      ],
    });
    await db.batch(statements);
    return upserts;
  } catch {
    return 0;
  }
}

// ── Reads (the sweep and the consumer) ───────────────────────────────────────────────────────

/**
 * The nightly upkeep for one product: prune device rows past retention, then rebuild its
 * `delta_demand` aggregate over the hot window (devices that moved WITHOUT a delta). Answers the
 * rows pruned plus the aggregate rows written.
 */
export async function refreshDemand(
  db: Db,
  product: string,
  now: number,
): Promise<number> {
  const pruned = await db.runChanges(
    "DELETE FROM delta_demand_devices WHERE product = ? AND seen_at < ?",
    product,
    now - DEMAND_RETENTION_SECONDS,
  );
  const windowStart = now - HOT_WINDOW_SECONDS;
  await db.batch([
    { sql: "DELETE FROM delta_demand WHERE product = ?", params: [product] },
    {
      sql: `INSERT INTO delta_demand
              (product, deliverable_id, from_sha256, to_sha256, devices, window_start, last_seen)
            SELECT product, deliverable_id, from_sha256, to_sha256, COUNT(*), ?, MAX(seen_at)
              FROM delta_demand_devices
             WHERE product = ? AND seen_at >= ? AND strategy <> ?
             GROUP BY product, deliverable_id, from_sha256, to_sha256`,
      params: [windowStart, product, windowStart, DELTA_STRATEGY],
    },
  ]);
  const written = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM delta_demand WHERE product = ?",
    product,
  );
  return pruned + (written?.n ?? 0);
}

export interface DemandPair {
  deliverableId: string;
  from: string;
  to: string;
  devices: number;
}

/** The product's hottest pairs from the last aggregate, at least `minDevices` each. */
export async function hotPairs(
  db: Db,
  product: string,
  minDevices: number,
  limit: number,
): Promise<DemandPair[]> {
  const rows = await db.all<{
    deliverable_id: string;
    from_sha256: string;
    to_sha256: string;
    devices: number;
  }>(
    `SELECT deliverable_id, from_sha256, to_sha256, devices FROM delta_demand
      WHERE product = ? AND devices >= ?
      ORDER BY devices DESC, deliverable_id, from_sha256, to_sha256
      LIMIT ?`,
    product,
    minDevices,
    limit,
  );
  return rows.map((r) => ({
    deliverableId: r.deliverable_id,
    from: r.from_sha256,
    to: r.to_sha256,
    devices: r.devices,
  }));
}

/** Distinct devices that moved from → to without a delta since `since` (the live count). */
export async function pairDemand(
  db: Db,
  product: string,
  deliverableId: string,
  from: string,
  to: string,
  since: number,
): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM delta_demand_devices
      WHERE product = ? AND deliverable_id = ? AND from_sha256 = ? AND to_sha256 = ?
        AND seen_at >= ? AND strategy <> ?`,
    product,
    deliverableId,
    from,
    to,
    since,
    DELTA_STRATEGY,
  );
  return row?.n ?? 0;
}

/**
 * The installed base of a pack: payloads at least `minDevices` distinct devices moved TO since
 * `since` (by any strategy), hottest first. A new payload's likely bases (the R2 event's join):
 * the devices that last moved to X are sitting on X.
 */
export async function installedBase(
  db: Db,
  product: string,
  deliverableId: string,
  minDevices: number,
  since: number,
  limit: number,
): Promise<{ payload: string; devices: number }[]> {
  const rows = await db.all<{ to_sha256: string; n: number }>(
    `SELECT to_sha256, COUNT(*) AS n FROM delta_demand_devices
      WHERE product = ? AND deliverable_id = ? AND seen_at >= ?
      GROUP BY to_sha256 HAVING COUNT(*) >= ?
      ORDER BY n DESC, to_sha256 LIMIT ?`,
    product,
    deliverableId,
    since,
    minDevices,
    limit,
  );
  return rows.map((r) => ({ payload: r.to_sha256, devices: r.n }));
}

/** Distinct devices that moved TO `payload` since `since` (by any strategy): the devices now
 *  sitting on it, the basis of an R2 event's fan-out. */
export async function payloadDevices(
  db: Db,
  product: string,
  deliverableId: string,
  payload: string,
  since: number,
): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM delta_demand_devices
      WHERE product = ? AND deliverable_id = ? AND to_sha256 = ? AND seen_at >= ?`,
    product,
    deliverableId,
    payload,
    since,
  );
  return row?.n ?? 0;
}

/** Whether any device reported the pair (by any strategy, a delta included) since `since`. */
export async function pairSeenSince(
  db: Db,
  product: string,
  from: string,
  to: string,
  since: number,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one FROM delta_demand_devices
      WHERE product = ? AND from_sha256 = ? AND to_sha256 = ? AND seen_at >= ? LIMIT 1`,
    product,
    from,
    to,
    since,
  );
  return row !== null;
}
