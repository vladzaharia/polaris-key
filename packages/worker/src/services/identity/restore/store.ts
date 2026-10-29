/**
 * The silent-restore keys (I-49.4; plans/I-49-slices.md D-1..D-3, D-9; V5 §12.11.8).
 *
 * A restore key is one row per (product, device) in `identity_restore_keys`: a public id
 * (`rk_…`), the HMAC of a secret (`rs_…`) the enrolling device keeps in its platform backup, the
 * pairwise subject it was signed in as, and two dates. The secret is returned once by `mintRestoreKey`
 * and never stored or logged; only `HMAC(KEY_HASH_PEPPER, "restore:" + secret)` is.
 *
 * ── THE RULES THIS FILE HOLDS ───────────────────────────────────────────────────────────────
 *
 * - The lookup and the consume compare-and-set are keyed on id AND product AND secret_hash. A row
 *   of another product is `null` and never consumed; a wrong secret is `null` and never consumes.
 * - The HMAC of the presented secret is computed FIRST, for a row that exists or not, so a missing
 *   id costs what a wrong secret costs. The comparison is constant time.
 * - A row is used once: `consumeRestoreKey` deletes it with one conditional statement and a
 *   caller wins only when exactly one row changed (a replay or a race loses).
 * - "Current" (`checkRestoreKey`) means the row belongs to the CALLING device and was minted under
 *   90 days ago. Anything else mints again, which replaces the device's row.
 * - At most 10 rows per (product, subject); the oldest by `checked_at` goes.
 * - Every revocation here runs whatever the launch gate, the `identity.restore` setting or the
 *   Identity toggle say: only enrolling and redeeming are gated, and they check the gate BEFORE
 *   calling this file. Nothing in this file reads a gate.
 * - A device that signed in by restore is recorded in `identity_restore_origins`
 *   (`markRestoreOrigin`). Removing such a device deletes EVERY restore row of its subject.
 *
 * Both tables are Identity's (`TABLE_OWNERS`) and registered as the subject store
 * `identity.restore` (`subjectStore.ts`).
 */

import { randomToken } from "../../../platform/random.js";
import { hashKey } from "../../../platform/crypto.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import type { Db, DbStatement } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";

/** `rk_` + 22 base64url characters: the row's public id. */
export const RESTORE_ID_PATTERN = /^rk_[A-Za-z0-9_-]{22}$/;
/** `rs_` + 43 base64url characters: the 32 random bytes the device keeps. */
export const RESTORE_SECRET_PATTERN = /^rs_[A-Za-z0-9_-]{43}$/;

/** At most this many rows per (product, subject). */
export const RESTORE_KEY_CAP = 10;
/** A check calls a row current only while it was minted under this long ago (90 days). */
export const RESTORE_CURRENT_SECONDS = 90 * 86_400;
/** A row nobody checked for this long is dead: redeeming refuses it and the sweep deletes it (D-9). */
export const RESTORE_IDLE_SECONDS = 180 * 86_400;

/** Domain separation, so a restore hash is never a hash of another credential. */
const HASH_DOMAIN = "restore:";

/** The hash a missing row is compared against: same length as a real one, never matches. */
const NO_ROW_HASH = "0".repeat(64);

export interface RestoreKeyRow {
  id: string;
  product: string;
  device_id: string;
  subject: string;
  secret_hash: string;
  created_at: number;
  checked_at: number;
}

/** The peppered hash of a restore secret, as stored. */
export function hashRestoreSecret(env: Env, secret: string): Promise<string> {
  return hashKey(HASH_DOMAIN + secret, env.KEY_HASH_PEPPER);
}

// ── Enrol ───────────────────────────────────────────────────────────────────────────────────

/**
 * Mint this device's restore key, replacing its previous row. Returns the id and the secret, which
 * the caller hands to the device once. Rows over the cap for the subject are dropped, oldest
 * `checked_at` first, in the same batch.
 */
export async function mintRestoreKey(
  env: Env,
  db: Db,
  args: { product: string; deviceId: string; subject: string; now: number },
): Promise<{ restoreId: string; secret: string }> {
  const restoreId = `rk_${randomToken(16)}`;
  const secret = `rs_${randomToken(32)}`;
  const secretHash = await hashRestoreSecret(env, secret);
  const { product, deviceId, subject, now } = args;
  await db.batch([
    {
      sql: "DELETE FROM identity_restore_keys WHERE product = ? AND device_id = ?",
      params: [product, deviceId],
    },
    {
      sql: `INSERT INTO identity_restore_keys
              (id, product, device_id, subject, secret_hash, created_at, checked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [restoreId, product, deviceId, subject, secretHash, now, now],
    },
    // The newest rows stay; the new row has the greatest rowid, so it wins every tie.
    {
      sql: `DELETE FROM identity_restore_keys
             WHERE product = ? AND subject = ?
               AND id NOT IN (
                 SELECT id FROM identity_restore_keys
                  WHERE product = ? AND subject = ?
                  ORDER BY checked_at DESC, rowid DESC LIMIT ?)`,
      params: [product, subject, product, subject, RESTORE_KEY_CAP],
    },
  ]);
  return { restoreId, secret };
}

/**
 * Is `restoreId` this device's live row for the subject? True bumps `checked_at`. The row must
 * belong to the calling device (not merely the subject) and have been minted under 90 days ago;
 * anything else is false and the caller mints again.
 */
export async function checkRestoreKey(
  db: Db,
  args: {
    product: string;
    deviceId: string;
    subject: string;
    restoreId: string;
    now: number;
  },
): Promise<boolean> {
  if (!RESTORE_ID_PATTERN.test(args.restoreId)) return false;
  const changed = await db.runChanges(
    `UPDATE identity_restore_keys SET checked_at = ?
      WHERE id = ? AND product = ? AND subject = ? AND device_id = ?
        AND created_at > ? AND checked_at > ?`,
    args.now,
    args.restoreId,
    args.product,
    args.subject,
    args.deviceId,
    args.now - RESTORE_CURRENT_SECONDS,
    args.now - RESTORE_IDLE_SECONDS,
  );
  return changed === 1;
}

// ── Redeem ──────────────────────────────────────────────────────────────────────────────────

/**
 * Use a restore key once. `null` for every failure, with no way to tell them apart: a bad shape,
 * an unknown id, another product's id, a wrong secret, a row idle past 180 days, or a lost race.
 * Only a right secret on this product's live row is consumed, with one conditional delete; the
 * caller proceeds only on a non-null answer. The row's subject and the enrolling device come back
 * for the caller's account resolution.
 */
export async function consumeRestoreKey(
  env: Env,
  db: Db,
  args: {
    product: string;
    restoreId: string;
    secret: string;
    now: number;
  },
): Promise<{ subject: string; deviceId: string } | null> {
  // A secret is a fixed, public length; anything longer is not worth hashing.
  if (args.secret.length > 128) return null;
  // The HMAC first, whether or not the row exists: a lookup leaks no timing.
  const presented = await hashRestoreSecret(env, args.secret);
  const row = await db.first<RestoreKeyRow>(
    "SELECT * FROM identity_restore_keys WHERE id = ? AND product = ?",
    args.restoreId,
    args.product,
  );
  const stored = row?.secret_hash ?? NO_ROW_HASH;
  const equal = constantTimeEqual(presented, stored);
  if (
    !row ||
    !equal ||
    !RESTORE_ID_PATTERN.test(args.restoreId) ||
    !RESTORE_SECRET_PATTERN.test(args.secret) ||
    row.checked_at <= args.now - RESTORE_IDLE_SECONDS
  )
    return null;
  const won = await db.runChanges(
    "DELETE FROM identity_restore_keys WHERE id = ? AND product = ? AND secret_hash = ?",
    args.restoreId,
    args.product,
    presented,
  );
  return won === 1 ? { subject: row.subject, deviceId: row.device_id } : null;
}

/**
 * Record that a device signed in by restore (the grant calls it after `bindAndAnswer`), so that
 * removing it later revokes every restore row of the subject. Idempotent.
 */
export async function markRestoreOrigin(
  db: Db,
  args: { product: string; deviceId: string; subject: string; now: number },
): Promise<void> {
  await db.run(
    `INSERT INTO identity_restore_origins (product, device_id, subject, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (product, device_id)
       DO UPDATE SET subject = excluded.subject, created_at = excluded.created_at`,
    args.product,
    args.deviceId,
    args.subject,
    args.now,
  );
}

// ── Revoke (never gated) ────────────────────────────────────────────────────────────────────

/**
 * This device's row and its restore-origin mark go: sign-out, `DELETE restore`, an unbind.
 * Idempotent. Returns how many key rows went.
 */
export async function revokeDeviceRestore(
  db: Db,
  product: string,
  deviceId: string,
): Promise<number> {
  const [keys] = (await runCounted(db, [
    {
      sql: "DELETE FROM identity_restore_keys WHERE product = ? AND device_id = ?",
      params: [product, deviceId],
    },
    {
      sql: "DELETE FROM identity_restore_origins WHERE product = ? AND device_id = ?",
      params: [product, deviceId],
    },
  ])) as [number, number];
  return keys;
}

/**
 * Every restore row of the subject for the product, and every origin mark: removing the app from
 * Connected apps, a deletion, and the removal of a device that signed in by restore.
 */
export async function revokeSubjectRestore(
  db: Db,
  product: string,
  subject: string,
): Promise<number> {
  const [keys] = (await runCounted(db, [
    {
      sql: "DELETE FROM identity_restore_keys WHERE product = ? AND subject = ?",
      params: [product, subject],
    },
    {
      sql: "DELETE FROM identity_restore_origins WHERE product = ? AND subject = ?",
      params: [product, subject],
    },
  ])) as [number, number];
  return keys;
}

/**
 * The operator's incident action: every restore row and origin mark of one product. Idempotent.
 * Returns the number of key rows removed; nothing else about the product changes.
 */
export async function purgeProductRestore(
  db: Db,
  product: string,
): Promise<number> {
  const [keys] = (await runCounted(db, [
    {
      sql: "DELETE FROM identity_restore_keys WHERE product = ?",
      params: [product],
    },
    {
      sql: "DELETE FROM identity_restore_origins WHERE product = ?",
      params: [product],
    },
  ])) as [number, number];
  return keys;
}

/**
 * The device-lifecycle rule (`restoreListener.ts`): a device was removed. Its own row goes, and
 * when it had signed in by restore, so does every restore row of its subject.
 */
export async function revokeRemovedDevice(
  db: Db,
  product: string,
  deviceId: string,
): Promise<void> {
  const origin = await db.first<{ subject: string }>(
    "SELECT subject FROM identity_restore_origins WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
  await revokeDeviceRestore(db, product, deviceId);
  if (origin) await revokeSubjectRestore(db, product, origin.subject);
}

/**
 * A device is bound to `subject`: rows it enrolled under another subject no longer describe it.
 */
export async function dropRowsOfOtherSubject(
  db: Db,
  product: string,
  deviceId: string,
  subject: string,
): Promise<void> {
  await db.batch([
    {
      sql: "DELETE FROM identity_restore_keys WHERE product = ? AND device_id = ? AND subject <> ?",
      params: [product, deviceId, subject],
    },
    {
      sql: "DELETE FROM identity_restore_origins WHERE product = ? AND device_id = ? AND subject <> ?",
      params: [product, deviceId, subject],
    },
  ]);
}

/**
 * One bounded pass of the 180-day sweep (D-9): rows nobody checked, and origin marks that old.
 * Returns the number removed, for `rec.drain`.
 */
export async function sweepRestoreKeys(
  db: Db,
  product: string,
  now: number,
  limit = 500,
): Promise<number> {
  const cutoff = now - RESTORE_IDLE_SECONDS;
  const keys = await db.runChanges(
    `DELETE FROM identity_restore_keys
      WHERE rowid IN (
        SELECT rowid FROM identity_restore_keys
         WHERE product = ? AND checked_at < ? LIMIT ?)`,
    product,
    cutoff,
    limit,
  );
  const origins = await db.runChanges(
    `DELETE FROM identity_restore_origins
      WHERE rowid IN (
        SELECT rowid FROM identity_restore_origins
         WHERE product = ? AND created_at < ? LIMIT ?)`,
    product,
    cutoff,
    limit,
  );
  return keys + origins;
}

/** Each statement's changed-row count, in order (one atomic batch on the real engines). */
async function runCounted(
  db: Db,
  statements: DbStatement[],
): Promise<number[]> {
  if (db.batchChanges) return db.batchChanges(statements);
  const out: number[] = [];
  for (const s of statements) out.push(await db.runChanges(s.sql, ...s.params));
  return out;
}
