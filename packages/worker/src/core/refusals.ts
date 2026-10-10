/**
 * The refusal log (UX-15, docs/design/EXPERIENCE.md §0.9): one `license_refusals` row each time
 * `authorizeDevice` (`core/authz.ts`) turns a device away, so the console can name the last
 * refusal on a licence ("Mara tried to activate Studio Laptop 4 min ago"), facet the licence list
 * by "refused at least one activation in the last 7 days", and compute a refusal spike rate.
 *
 * ── THREE RULES THIS MODULE KEEPS ───────────────────────────────────────────────────────────
 *
 * 1. OFF THE RESPONSE PATH. `logRefusal` hands the write to the request's `waitUntil` when the
 *    caller has one (the Worker's `fetch` path), so a refused device gets its answer without
 *    waiting on D1. Without one (Node tests, the transcript recorder, a caller that has not been
 *    given the runtime's `waitUntil`) it runs the write inline, exactly as `ServiceContext`
 *    documents. Either way the write is total: it never throws and never changes the refusal the
 *    device receives.
 * 2. BOUNDED. A device retrying in a loop folds into one row per device, licence and reason per
 *    `REFUSAL_DEBOUNCE_SECONDS`, in the same statement as the insert. The nightly sweep deletes
 *    rows older than `REFUSAL_RETENTION_SECONDS`.
 * 3. PLAIN TEXT. The label is customer-influenced (a device name, a reported platform, a
 *    User-Agent). It is stripped of control and format characters and cut to
 *    `REFUSAL_LABEL_MAX` characters before it is written; the console renders it as text.
 *
 * The table is Core's (`TABLE_OWNERS.core`): the refusal site is Core's, and the readers are the
 * admin API (`admin/handlers/refusals.ts`) and, later, the attention model.
 */

import type { Db } from "../db/types.js";
import { randomId } from "../crypto.js";
import { sha256Hex } from "../platform/hash.js";

/** How long a refusal row is kept: 30 days. The facet looks back 7, the spike rate 7 + today. */
export const REFUSAL_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** Repeats of one device, licence and reason inside this window write no new row. */
export const REFUSAL_DEBOUNCE_SECONDS = 60;

/** The longest label stored, in characters (the portal's device-name limit, PX-W5). */
export const REFUSAL_LABEL_MAX = 64;

/** Why an activation was refused. Mirrors `AuthzError` plus the licence-usability check, and
 *  the key-entry refusals of PX-W9 (`key_entry_limit`) and I-09 (`license_owned`), both from
 *  `core/keyEntries.ts` and logged by the two key-entry routes. */
export type RefusalReason =
  | "device_limit"
  | "hardware_mismatch"
  | "fingerprint_required"
  | "license_unusable"
  | "key_entry_limit"
  | "license_owned";

/** What the refusal site knows about the device it turned away. */
export interface RefusalInput {
  product: string;
  licenseId: string;
  deviceId: string;
  reason: RefusalReason;
  at: number;
  /** Reported metadata, used for the label when the device has no name of its own. */
  platform?: string | null;
  arch?: string | null;
  userAgent?: string | null;
}

export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Plain display text: control, format and line/paragraph separators removed (no bidirectional
 * override can make one label render as another), whitespace collapsed, at most
 * `REFUSAL_LABEL_MAX` code points. `null` when nothing printable is left.
 */
export function sanitizeRefusalLabel(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, REFUSAL_LABEL_MAX).join("").trim();
}

/** The label to store when the device has no name: "macOS arm64", else its User-Agent. */
export function fallbackRefusalLabel(input: RefusalInput): string | null {
  const platform = [input.platform, input.arch]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ");
  return (
    sanitizeRefusalLabel(platform) ?? sanitizeRefusalLabel(input.userAgent)
  );
}

/** SHA-256 of the device id, hex, first 32 characters. */
export async function refusalDeviceHash(deviceId: string): Promise<string> {
  return (await sha256Hex(deviceId)).slice(0, 32);
}

/**
 * Write one refusal row, unless the same device was refused for the same reason on the same
 * licence inside the debounce window (the `NOT EXISTS`, in the insert itself). The device's own
 * name (`devices.label`, when it has a row) wins over the fallback label; both are sanitized
 * here, because not every path that writes `devices.label` holds it to 64 plain characters.
 * Returns whether a row was written. Throws on a database error; `logRefusal` is the total wrapper.
 */
export async function recordRefusal(
  db: Db,
  input: RefusalInput,
): Promise<boolean> {
  const hash = await refusalDeviceHash(input.deviceId);
  const device = await db.first<{ label: string | null }>(
    "SELECT label FROM devices WHERE product = ? AND device_id = ?",
    input.product,
    input.deviceId,
  );
  const label =
    sanitizeRefusalLabel(device?.label) ?? fallbackRefusalLabel(input);
  const changed = await db.runChanges(
    `INSERT INTO license_refusals
       (product, id, license_id, at, reason, device_label, device_hash)
     SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM license_refusals
         WHERE product = ? AND license_id = ? AND device_hash = ? AND reason = ?
           AND at > ?)`,
    input.product,
    randomId("ref"),
    input.licenseId,
    input.at,
    input.reason,
    label,
    hash,
    input.product,
    input.licenseId,
    hash,
    input.reason,
    input.at - REFUSAL_DEBOUNCE_SECONDS,
  );
  return changed > 0;
}

/**
 * Log a refusal off the response path. Never throws, never rejects: a failed write is dropped
 * (the refusal itself has already been decided), and the device's answer is unchanged.
 */
export async function logRefusal(
  db: Db,
  input: RefusalInput,
  waitUntil?: WaitUntil,
): Promise<void> {
  const work = recordRefusal(db, input).then(
    () => undefined,
    () => undefined,
  );
  if (waitUntil) {
    waitUntil(work);
    return;
  }
  await work;
}

// ── reads ────────────────────────────────────────────────────────────────────────────────

export interface RefusalRow {
  id: string;
  license_id: string;
  at: number;
  reason: string;
  device_label: string | null;
  device_hash: string;
}

/** Newest first, at or after `since`, optionally for one licence. */
export async function listRefusals(
  db: Db,
  product: string,
  opts: { since: number; licenseId?: string | null; limit: number },
): Promise<RefusalRow[]> {
  if (opts.licenseId) {
    return db.all<RefusalRow>(
      `SELECT id, license_id, at, reason, device_label, device_hash
         FROM license_refusals
        WHERE product = ? AND license_id = ? AND at >= ?
        ORDER BY at DESC, rowid DESC
        LIMIT ?`,
      product,
      opts.licenseId,
      opts.since,
      opts.limit,
    );
  }
  return db.all<RefusalRow>(
    `SELECT id, license_id, at, reason, device_label, device_hash
       FROM license_refusals
      WHERE product = ? AND at >= ?
      ORDER BY at DESC, rowid DESC
      LIMIT ?`,
    product,
    opts.since,
    opts.limit,
  );
}

export interface RefusingLicense {
  licenseId: string;
  count: number;
  devices: number;
  lastAt: number;
}

/**
 * Every licence with at least one refusal at or after `since` (the Refusing devices facet), with
 * its refusal count, distinct devices refused and the time of the latest. Bounded by `limit`,
 * latest first.
 */
export async function listRefusingLicenses(
  db: Db,
  product: string,
  opts: { since: number; licenseId?: string | null; limit: number },
): Promise<RefusingLicense[]> {
  const rows = await db.all<{
    license_id: string;
    n: number;
    devices: number;
    last_at: number;
  }>(
    `SELECT license_id, COUNT(*) AS n, COUNT(DISTINCT device_hash) AS devices,
            MAX(at) AS last_at
       FROM license_refusals
      WHERE product = ? AND at >= ?${opts.licenseId ? " AND license_id = ?" : ""}
      GROUP BY license_id
      ORDER BY last_at DESC, license_id
      LIMIT ?`,
    product,
    opts.since,
    ...(opts.licenseId ? [opts.licenseId] : []),
    opts.limit,
  );
  return rows.map((r) => ({
    licenseId: r.license_id,
    count: Number(r.n),
    devices: Number(r.devices),
    lastAt: Number(r.last_at),
  }));
}

/** Delete up to `limit` of one product's rows older than `cutoff`; answers how many went. */
export async function pruneRefusals(
  db: Db,
  product: string,
  cutoff: number,
  limit: number,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM license_refusals
      WHERE rowid IN (
        SELECT rowid FROM license_refusals WHERE product = ? AND at < ? LIMIT ?
      )`,
    product,
    cutoff,
    limit,
  );
}
