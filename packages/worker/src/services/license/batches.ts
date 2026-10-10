/**
 * Licence batches (LX-28; notes/S-24 §5.6, §6.1, §7.1, D10): up to 500 floating licences created
 * in one labelled batch, the batch read back with how many of its keys were used, and **Disable
 * unused keys** for a batch whose keys leaked.
 *
 * ── ONE BATCH, A FIXED NUMBER OF STATEMENTS ─────────────────────────────────────────────────
 *
 * A batch commits all or nothing: the batch row, every licence, every licence's first key and the
 * audit row go in ONE D1 batch. Two statements per licence would be over 1,000 statements at 500
 * licences, and D1 bounds the queries one invocation may run (1,000 on the paid plan, 50 on the
 * free one). So the licences and the keys are each ONE `INSERT … SELECT … FROM json_each(?)`
 * over a JSON array bound as a single parameter (the pattern `core/assets/blobGc.ts` uses for its id
 * lists): the batch is four statements whatever the count, each well inside D1's 100 bound
 * parameters, and the arrays well inside its 2 MB value limit (about 45 KB at 500 licences).
 *
 * ── NO PLAINTEXT KEY IS STORED ──────────────────────────────────────────────────────────────
 *
 * The statements carry key HASHES only (`hashKey`, peppered), exactly as a single create does. The
 * plaintext keys exist in the create answer and nowhere else: not in `license_batches`, not in the
 * audit row, not in a log (the Worker has no console logging, R12). A batch's keys cannot be
 * downloaded again.
 *
 * ── USED ────────────────────────────────────────────────────────────────────────────────────
 *
 * A licence is "used" once a device has ever been bound to it: a `devices` row names it, whatever
 * that device's status now, or one of its keys has ever been presented successfully (an
 * activation or a browser key session stamps `keys_index.last_used_at`, which stays when the
 * device later moves to another licence). Adding a key to an account in the portal binds no
 * device, so it does not count. Disable unused keys disables exactly the active licences of the
 * batch that are not used, in one conditional UPDATE committed in one batch with its audit row
 * (which records the count): the check and the write are one statement, so a licence whose device
 * was bound before it runs is never disabled.
 */

import type { Db, DbParam, DbStatement } from "../../db/types.js";
import {
  licenseEventSourceSql,
  licenseTargetSetSql,
} from "../../core/licensing/lifecycleWrites.js";

/** The most licences one batch creates. Measured at 500 on D1 (`test-workerd/licenseBatches`). */
export const MAX_BATCH_COUNT = 500;

/** The longest batch label, in characters (code points). */
export const MAX_BATCH_LABEL = 80;

/** A `license_batches` row. */
export interface LicenseBatchRow {
  product: string;
  id: string;
  label: string;
  count: number;
  tier_id: string | null;
  created_by: string;
  created_at: number;
}

/** A batch with its live counts, as every batch read answers it. */
export interface LicenseBatchView {
  id: string;
  label: string;
  /** How many licences the batch created. */
  count: number;
  tier: string | null;
  createdBy: string;
  createdAt: number;
  /** Licences of the batch that have ever had a device bound. */
  used: number;
  /** Active licences of the batch never used: what Disable unused keys would disable. */
  unused: number;
  /** Licences of the batch that are disabled, used or not. */
  disabled: number;
}

/** The terms every licence of one batch is created with. */
export interface BatchLicenseTerms {
  tierId: string;
  expiresAt: number | null;
  maxOfflineDays: number | null;
  channelsJson: string | null;
  minVersion: string | null;
  maxVersion: string | null;
  deviceLimit: number | null;
}

/** One licence of a batch, as the statements write it: its id and its first key's hash. */
export interface BatchLicenseKey {
  licenseId: string;
  keyHash: string;
}

/**
 * "A device has ever been bound to this licence", as a SQL predicate over the `licenses` row
 * aliased `alias` (see the module comment). Binds no parameter.
 */
export function licenseEverBoundSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error("licenseEverBoundSql: bad table alias");
  }
  return `(EXISTS (SELECT 1 FROM devices d
      WHERE d.product = ${alias}.product AND d.license_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM keys_index k
      WHERE k.product = ${alias}.product AND k.license_id = ${alias}.id
        AND k.last_used_at IS NOT NULL))`;
}

/**
 * The statements that create a batch: its row, its licences (floating, `origin = 'admin'`, active,
 * `batch_id` set) and each licence's first key, as `INSERT … SELECT … FROM json_each(?)`. The
 * caller appends its audit row and runs them as ONE `db.batch`.
 */
export function createBatchStatements(
  batch: LicenseBatchRow,
  terms: BatchLicenseTerms,
  licenses: readonly BatchLicenseKey[],
): DbStatement[] {
  const { product, id: batchId, created_by: actor, created_at: now } = batch;
  const overrides = JSON.stringify({
    config: {},
    secrets: {},
    entitlements: {},
  });
  return [
    {
      sql: `INSERT INTO license_batches (product, id, label, count, tier_id, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        product,
        batchId,
        batch.label,
        batch.count,
        batch.tier_id,
        actor,
        now,
      ],
    },
    {
      // Floating by construction: no `sub`, no `name`, no `email`, no account (S-24 D1).
      sql: `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id,
              activated_at, expires_at, max_offline_days, overrides_json, channels_json,
              min_version, max_version, origin, enroll_hwid, device_limit, batch_id,
              modified_by, modified_at)
            SELECT ?, j.value, 'active', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'admin',
              NULL, ?, ?, ?, ?
              FROM json_each(?) AS j`,
      params: [
        product,
        terms.tierId,
        now,
        terms.expiresAt,
        terms.maxOfflineDays,
        overrides,
        terms.channelsJson,
        terms.minVersion,
        terms.maxVersion,
        terms.deviceLimit,
        batchId,
        actor,
        now,
        JSON.stringify(licenses.map((l) => l.licenseId)),
      ],
    },
    {
      sql: `INSERT INTO keys_index (product, key_hash, license_id, status, label, created_at,
              created_by, last_used_at)
            SELECT ?, json_extract(j.value, '$.keyHash'), json_extract(j.value, '$.licenseId'),
              'active', 'Initial key', ?, ?, NULL
              FROM json_each(?) AS j`,
      params: [
        product,
        now,
        actor,
        JSON.stringify(
          licenses.map((l) => ({ licenseId: l.licenseId, keyHash: l.keyHash })),
        ),
      ],
    },
  ];
}

const BATCH_VIEW_SQL = `SELECT b.id, b.label, b.count, b.tier_id, b.created_by, b.created_at,
    COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND ${licenseEverBoundSql("l")} THEN 1 ELSE 0 END), 0)
      AS used,
    COALESCE(SUM(CASE WHEN l.status = 'active' AND NOT ${licenseEverBoundSql("l")}
      THEN 1 ELSE 0 END), 0) AS unused,
    COALESCE(SUM(CASE WHEN l.status = 'disabled' THEN 1 ELSE 0 END), 0) AS disabled
  FROM license_batches b
  LEFT JOIN licenses l ON l.product = b.product AND l.batch_id = b.id
  WHERE b.product = ?`;

interface BatchViewRow {
  id: string;
  label: string;
  count: number;
  tier_id: string | null;
  created_by: string;
  created_at: number;
  used: number;
  unused: number;
  disabled: number;
}

function shapeBatch(r: BatchViewRow): LicenseBatchView {
  return {
    id: r.id,
    label: r.label,
    count: r.count,
    tier: r.tier_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    used: r.used,
    unused: r.unused,
    disabled: r.disabled,
  };
}

/** The batch list's page size when the caller names none (LX-30). */
export const BATCH_PAGE_DEFAULT = 100;
/** The largest page the batch list answers. */
export const BATCH_PAGE_MAX = 500;

/** A page of the batch list: newest first, and the cursor to the next page (`null`: the last). */
export interface LicenseBatchPage {
  batches: LicenseBatchView[];
  nextCursor: string | null;
}

/** The list cursor: `<created_at>.<id>` of the last batch of the page, opaque to the caller. */
function encodeBatchCursor(b: LicenseBatchView): string {
  return `${b.createdAt}.${b.id}`;
}

/** A cursor back to its position; `null` when it is not one this module wrote. */
export function decodeBatchCursor(
  raw: string,
): { createdAt: number; id: string } | null {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{1,64})$/.exec(raw);
  return m ? { createdAt: Number(m[1]), id: m[2]! } : null;
}

/**
 * The product's batches with their counts, newest first (`created_at DESC, id DESC`), one page at
 * a time (LX-30, for products with many batches). `after` is a decoded cursor.
 */
export async function listLicenseBatches(
  db: Db,
  product: string,
  page: { limit?: number; after?: { createdAt: number; id: string } } = {},
): Promise<LicenseBatchPage> {
  const limit = page.limit ?? BATCH_PAGE_DEFAULT;
  const after = page.after;
  const rows = await db.all<BatchViewRow>(
    `${BATCH_VIEW_SQL}
      ${after ? "AND (b.created_at < ? OR (b.created_at = ? AND b.id < ?))" : ""}
      GROUP BY b.product, b.id
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ?`,
    product,
    ...(after ? [after.createdAt, after.createdAt, after.id] : []),
    limit + 1,
  );
  const batches = rows.slice(0, limit).map(shapeBatch);
  const last = batches[batches.length - 1];
  return {
    batches,
    nextCursor: rows.length > limit && last ? encodeBatchCursor(last) : null,
  };
}

/** One batch with its counts, or `null` when the product has no such batch. */
export async function getLicenseBatch(
  db: Db,
  product: string,
  batchId: string,
): Promise<LicenseBatchView | null> {
  const row = await db.first<BatchViewRow>(
    `${BATCH_VIEW_SQL} AND b.id = ?
      GROUP BY b.product, b.id`,
    product,
    batchId,
  );
  return row ? shapeBatch(row) : null;
}

/** How many active licences of the batch were never used: what Disable unused keys disables. */
export async function countUnusedBatchLicenses(
  db: Db,
  product: string,
  batchId: string,
): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM licenses
      WHERE product = ? AND batch_id = ? AND status = 'active'
        AND NOT ${licenseEverBoundSql("licenses")}`,
    product,
    batchId,
  );
  return row?.n ?? 0;
}

/**
 * "The batch still has exactly `expected` unused active licences", as a `when` condition for the
 * audit row of a Disable unused keys (`auditStatementFor`). It is the first statement of the
 * batch, so it reads the state the UPDATE will change.
 */
export function unusedCountIs(
  product: string,
  batchId: string,
  expected: number,
): { sql: string; params: DbParam[] } {
  return {
    sql: `(SELECT COUNT(*) FROM licenses
        WHERE product = ? AND batch_id = ? AND status = 'active'
          AND NOT ${licenseEverBoundSql("licenses")}) = ?`,
    params: [product, batchId, expected],
  };
}

/**
 * Disable every active licence of the batch that was never used, in one conditional UPDATE that
 * runs only when the statement before it in the batch (the guarded audit row) wrote its row
 * (`changes()`, as `core/platformSettings.ts` guards its audit rows). Nothing runs between the two
 * inside one batch, so the UPDATE disables exactly the count the audit row records. LX-12: each
 * is revoked through the lifecycle (`ended_reason` `revoked`); revoke moves only an active
 * licence, so the source predicate is the `status = 'active'` this always had.
 */
export function disableUnusedAfterAuditStatement(
  product: string,
  batchId: string,
  actor: string,
  now: number,
): DbStatement {
  return {
    sql: `UPDATE licenses SET ${licenseTargetSetSql("revoke")}, modified_by = ?, modified_at = ?
      WHERE product = ? AND batch_id = ? AND ${licenseEventSourceSql("revoke")}
        AND NOT ${licenseEverBoundSql("licenses")}
        AND changes() = 1`,
    params: [actor, now, product, batchId],
  };
}

/**
 * The device tokens on licences of the batch that this disable-unused wrote (same actor, same
 * second), for the caller to purge from KV. Normally empty: an unused licence has no device. It
 * catches a device bound in the instant between the UPDATE's check and its write.
 */
export async function batchDisabledDeviceTokens(
  db: Db,
  product: string,
  batchId: string,
  actor: string,
  now: number,
): Promise<string[]> {
  const rows = await db.all<{ token_hash: string }>(
    `SELECT d.token_hash FROM devices d
       JOIN licenses l ON l.product = d.product AND l.id = d.license_id
      WHERE l.product = ? AND l.batch_id = ? AND l.status = 'disabled'
        AND l.modified_by = ? AND l.modified_at = ? AND d.token_hash IS NOT NULL`,
    product,
    batchId,
    actor,
    now,
  );
  return rows.map((r) => r.token_hash);
}
