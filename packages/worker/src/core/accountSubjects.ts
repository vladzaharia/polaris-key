/**
 * Core's account accessors (I-05; plans/I-04.md §6.2): the pairwise subject, the licence owner
 * pointer and the device binding.
 *
 * ── WHY THIS IS CORE ─────────────────────────────────────────────────────────────────────────
 *
 * The account is platform-level (owner, 2026-10-04): it exists for every product, whatever the
 * product's Identity toggle says. Config's account override layer (U-03) and Cloud Sync (U-05)
 * need "which subject is this" for a device or a licence, and a service may never import another
 * service (rule 6, `boundaries.test.ts`). So the three questions every one of them asks are
 * answered here, once:
 *
 *   subjectFor(account, product)      the pairwise subject, created on first contact
 *   resolveSubject(product, subject)  follows merge aliases; a deleted subject is `null`
 *   licenseOwnerSubject(licence)      the owner's subject (Config's fallback; never Cloud Sync's)
 *
 * The tables are Identity's (`TABLE_OWNERS`); Core reads and writes only the subject rows, the
 * owner pointer and the binding, and nothing here reads the product's Identity toggle.
 *
 * ── THE ACCOUNT ID STAYS INSIDE ──────────────────────────────────────────────────────────────
 *
 * The global account id never leaves the Worker's Identity and Core code (S-16 §5.1): it is in no
 * developer-facing API, export, event, token or SDK response. The functions that take or return
 * one are for Identity and for Core's own hooks; what a developer ever sees is a `ps_…` subject.
 */

import { mintPairwiseSubject } from "../crypto.js";
import type { Db, DbStatement } from "../db/types.js";
import type { Env } from "../env.js";
import { getTokenRecord, putTokenRecord } from "../kv.js";
import { writeDeviceSubject } from "./devices.js";

/** `ps_` and 22 base64url characters (plans/I-04.md §2; I-09 publishes it in the protocol). */
export const PAIRWISE_SUBJECT_PATTERN = /^ps_[A-Za-z0-9_-]{22}$/;

/** How long a merge tombstone redirects the absorbed account (S-16 §5.1: 30 days). */
export const MERGE_REDIRECT_SECONDS = 30 * 24 * 60 * 60;

// ── Pairwise subjects ─────────────────────────────────────────────────────────────────────────

/** The stored subject for (account, product), or `null` when there has been no contact yet. */
export async function existingSubjectFor(
  db: Db,
  accountId: string,
  product: string,
): Promise<string | null> {
  const row = await db.first<{ subject: string }>(
    "SELECT subject FROM account_product_subjects WHERE account_id = ? AND product = ?",
    accountId,
    product,
  );
  return row?.subject ?? null;
}

/**
 * The pairwise subject for (account, product), created on first contact: a licence of the
 * product attached, a sign-in through the product, or account × product data. Idempotent and
 * race-safe: `INSERT OR IGNORE` on the (account, product) key, then a read, so two first contacts
 * at once agree on one subject.
 */
export async function subjectFor(
  db: Db,
  accountId: string,
  product: string,
  now: number,
): Promise<string> {
  const existing = await existingSubjectFor(db, accountId, product);
  if (existing) return existing;
  // A collision on UNIQUE (product, subject) is 2^-128; the retry is for completeness only.
  for (let attempt = 0; attempt < 3; attempt++) {
    await db.run(
      `INSERT OR IGNORE INTO account_product_subjects (account_id, product, subject, created_at)
       VALUES (?, ?, ?, ?)`,
      accountId,
      product,
      mintPairwiseSubject(),
      now,
    );
    const row = await existingSubjectFor(db, accountId, product);
    if (row) return row;
  }
  throw new Error("could not mint a pairwise subject");
}

/**
 * The canonical subject a developer-held `subject` stands for today: itself while it is live, the
 * survivor's subject when it was absorbed by a merge (D21), `null` once it was deleted (per-product
 * removal or account deletion) or never existed.
 */
export async function resolveSubject(
  db: Db,
  product: string,
  subject: string,
): Promise<string | null> {
  const live = await db.first<{ subject: string }>(
    "SELECT subject FROM account_product_subjects WHERE product = ? AND subject = ?",
    product,
    subject,
  );
  if (live) return live.subject;
  const alias = await db.first<{ subject: string }>(
    `SELECT s.subject AS subject
       FROM account_product_subject_aliases a
       JOIN account_product_subjects s ON s.product = a.product AND s.subject = a.subject
      WHERE a.product = ? AND a.alias = ?`,
    product,
    subject,
  );
  return alias?.subject ?? null;
}

/**
 * The account behind a subject (live or an alias). INTERNAL: for Identity and Core hooks only; the
 * answer must never be written to a developer-facing response.
 */
export async function accountForSubject(
  db: Db,
  product: string,
  subject: string,
): Promise<string | null> {
  const canonical = await resolveSubject(db, product, subject);
  if (!canonical) return null;
  const row = await db.first<{ account_id: string }>(
    "SELECT account_id FROM account_product_subjects WHERE product = ? AND subject = ?",
    product,
    canonical,
  );
  return row?.account_id ?? null;
}

// ── The licence owner pointer ─────────────────────────────────────────────────────────────────

/** `licenses.account_id`, or `null` for a floating (or absent) licence. INTERNAL. */
export async function licenseAccountId(
  db: Db,
  product: string,
  licenseId: string,
): Promise<string | null> {
  const row = await db.first<{ account_id: string | null }>(
    "SELECT account_id FROM licenses WHERE product = ? AND id = ?",
    product,
    licenseId,
  );
  return row?.account_id ?? null;
}

/**
 * The licence owner's pairwise subject for the licence's product, creating it on first contact;
 * `null` for a floating licence. This is the account override layer's owner fallback (U-03), and
 * it works for a product with the Identity toggle off. Cloud Sync never uses it: its principal is
 * the device binding alone (owner's final answers; S-17 §5.2).
 */
export async function licenseOwnerSubject(
  db: Db,
  product: string,
  licenseId: string,
  now: number,
): Promise<string | null> {
  const accountId = await licenseAccountId(db, product, licenseId);
  return accountId ? subjectFor(db, accountId, product, now) : null;
}

/**
 * First attach: point a FLOATING licence at `accountId`. Answers false when the licence is owned
 * (by anyone, including this account) or absent, so "an owned licence never moves by key" is a
 * property of the statement, not of a read before it.
 */
export async function attachLicenseAccount(
  db: Db,
  product: string,
  licenseId: string,
  accountId: string,
  now: number,
): Promise<boolean> {
  const changes = await db.runChanges(
    `UPDATE licenses SET account_id = ?, modified_at = ?
      WHERE product = ? AND id = ? AND account_id IS NULL`,
    accountId,
    now,
    product,
    licenseId,
  );
  return changes > 0;
}

/**
 * Move a licence from `from` (an account id, or `null` for floating) to `to` (an account, or
 * `null` to detach). Conditional on the current owner, so a concurrent change loses cleanly. The
 * owner's detach and the developer's relink (I-12) both come through here.
 */
export async function moveLicenseAccount(
  db: Db,
  product: string,
  licenseId: string,
  from: string | null,
  to: string | null,
  now: number,
): Promise<boolean> {
  const changes = await db.runChanges(
    `UPDATE licenses SET account_id = ?, modified_at = ?
      WHERE product = ? AND id = ? AND account_id IS ?`,
    to,
    now,
    product,
    licenseId,
    from,
  );
  return changes > 0;
}

/** Merge: every licence of `from` moves to `to`, in the merge batch. */
export function stmtMoveAccountLicenses(from: string, to: string): DbStatement {
  return {
    sql: "UPDATE licenses SET account_id = ? WHERE account_id = ?",
    params: [to, from],
  };
}

/** Deletion: every licence of the account becomes floating, in the deletion batch. */
export function stmtDetachAccountLicenses(accountId: string): DbStatement {
  return {
    sql: "UPDATE licenses SET account_id = NULL WHERE account_id = ?",
    params: [accountId],
  };
}

/** The licences attached to an account, optionally for one product. INTERNAL. */
export async function accountLicenses(
  db: Db,
  accountId: string,
  product?: string,
): Promise<Array<{ product: string; id: string }>> {
  return product === undefined
    ? db.all<{ product: string; id: string }>(
        "SELECT product, id FROM licenses WHERE account_id = ? ORDER BY product, id",
        accountId,
      )
    : db.all<{ product: string; id: string }>(
        "SELECT product, id FROM licenses WHERE account_id = ? AND product = ? ORDER BY id",
        accountId,
        product,
      );
}

// ── The device binding ────────────────────────────────────────────────────────────────────────

/**
 * Set the device binding on an already-bound device: an account signed in on a device that is
 * activated some other way (a key, an enrolment). Only an account sign-in through Identity calls
 * this; key entry never does (plans/I-04.md §6.2). `bound_by` is left alone, so a key-bound device
 * that later signs in is not released by a sign-out (§8 Q3). Mirrors the KV token record.
 */
export async function setDeviceSubject(
  env: Env,
  db: Db,
  product: string,
  deviceId: string,
  subject: string,
): Promise<boolean> {
  if (!PAIRWISE_SUBJECT_PATTERN.test(subject)) {
    throw new Error("setDeviceSubject: not a pairwise subject");
  }
  const device = await db.first<{ token_hash: string | null; status: string }>(
    "SELECT token_hash, status FROM devices WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
  if (!device || device.status !== "authorized") return false;
  await writeDeviceSubject(db, product, deviceId, subject);
  await mirrorTokenSubject(env, product, device.token_hash, subject);
  return true;
}

/** Keep the KV token record's `subject` in step with D1 (a cache; D1 stays the authority). */
export async function mirrorTokenSubject(
  env: Env,
  product: string,
  tokenHash: string | null,
  subject: string | null,
): Promise<void> {
  if (!tokenHash) return;
  const rec = await getTokenRecord(env, product, tokenHash);
  if (!rec) return;
  const { subject: _old, ...rest } = rec;
  void _old;
  await putTokenRecord(
    env,
    product,
    tokenHash,
    subject ? { ...rest, subject } : rest,
  );
}
