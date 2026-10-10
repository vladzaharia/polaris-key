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
 *   resolveSyncPrincipal(device)      the device binding only (Cloud Sync's principal; U-02)
 *   isFloatingLicense(licence)        no account and no email: no account features (S-24)
 *
 * The tables are Identity's (`TABLE_OWNERS`); Core reads and writes only the subject rows, the
 * owner pointer and the binding. Subjects and the owner pointer ignore the product's Identity
 * toggle; the ONE read of it here is the bind guard in `setDeviceSubject` (PX-W17): no device of
 * an Identity-off product ever carries a binding, so S-19's holder rule can trust the column.
 *
 * ── THE ACCOUNT ID STAYS INSIDE ──────────────────────────────────────────────────────────────
 *
 * The global account id never leaves the Worker's Identity and Core code (S-16 §5.1): it is in no
 * developer-facing API, export, event, token or SDK response. The functions that take or return
 * one are for Identity and for Core's own hooks; what a developer ever sees is a `ps_…` subject.
 */

import { PAIRWISE_SUBJECT_PATTERN as PAIRWISE_SUBJECT_SOURCE } from "@polaris-key/protocol/core";
import { mintPairwiseSubject } from "../../platform/crypto.js";
import type { Db, DbStatement } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { getTokenRecord, putTokenRecord } from "../../platform/kv.js";
import { NO_LICENSE_ID, writeDeviceSubject } from "../devices.js";
import { assertIdentityBindable } from "./identityGate.js";

/** `ps_` and 22 base64url characters (plans/I-04.md §2), matched whole. Compiled from the
 *  protocol's one declaration (`@polaris-key/protocol/core`, SP-54), which the licence
 *  document's `profile.user.subject` and every SDK reader share. */
export const PAIRWISE_SUBJECT_PATTERN = new RegExp(PAIRWISE_SUBJECT_SOURCE);

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

/** {@link existingSubjectFor} for many accounts at once: account id → subject, read-only. */
export async function existingSubjectsFor(
  db: Db,
  accountIds: readonly string[],
  product: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(accountIds)];
  // D1 binds at most 100 parameters; one is the product.
  for (let i = 0; i < ids.length; i += 90) {
    const batch = ids.slice(i, i + 90);
    for (const r of await db.all<{ account_id: string; subject: string }>(
      `SELECT account_id, subject FROM account_product_subjects
        WHERE product = ? AND account_id IN (${batch.map(() => "?").join(", ")})`,
      product,
      ...batch,
    ))
      out.set(r.account_id, r.subject);
  }
  return out;
}

/** Thrown by {@link subjectFor} for an account whose erasure is under way. */
export class AccountErasingError extends Error {
  constructor() {
    super("account is being erased");
    this.name = "AccountErasingError";
  }
}

/** {@link subjectFor} for read paths: `null` while the account is being erased. */
export async function subjectForOrNull(
  db: Db,
  accountId: string,
  product: string,
  now: number,
): Promise<string | null> {
  try {
    return await subjectFor(db, accountId, product, now);
  } catch (e) {
    if (e instanceof AccountErasingError) return null;
    throw e;
  }
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
  // SEC-WP-04: an account being erased (`status = 'deleted'`) mints nothing new; a subject minted
  // after the erasure read its list would escape the store hooks and the `subject.deleted` event.
  if (
    await db.first(
      "SELECT 1 AS x FROM accounts WHERE id = ? AND status = 'deleted'",
      accountId,
    )
  )
    throw new AccountErasingError();
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

// ── Floating or assigned (S-24) ───────────────────────────────────────────────────────────────

/** The two columns that decide a licence's holder (S-24 D1: derived, never stored). */
export interface LicenseHolderFacts {
  account_id?: string | null;
  email?: string | null;
}

/**
 * THE floating-licence rule (S-24 R2, owner 2026-10-06): a licence is floating when it has no
 * account (`account_id IS NULL`) and no email; otherwise it is assigned (in an account, or waiting
 * for its email to be verified). A floating licence has no account features: no Cloud Sync
 * principal (`resolveSyncPrincipal`), no account override fallback (U-03). An email that is empty
 * or only spaces counts as none, exactly as SQLite's `TRIM(email) = ''` in
 * {@link floatingLicenseSql}, so a list filter and a read never disagree. Every caller asks this
 * function (or that fragment); none restates the rule.
 *
 * Older comments (I-05) say "floating" for any licence with no account. Since S-24 that is "not
 * in an account": a licence with an email and no account is assigned and waiting, not floating.
 */
export function isFloatingLicense(licence: LicenseHolderFacts): boolean {
  return (
    (licence.account_id ?? null) === null && licenseEmail(licence) === null
  );
}

/**
 * The licence's own email as the holder rule reads it: `null` when there is none or it is empty or
 * only spaces (SQLite's `TRIM(email) = ''`), else the stored value unchanged.
 */
export function licenseEmail(licence: LicenseHolderFacts): string | null {
  const email = licence.email ?? null;
  return email === null || /^ *$/.test(email) ? null : email;
}

/**
 * {@link isFloatingLicense} as a SQL predicate over the `licenses` row aliased `alias` (the list
 * filter `holder=floating`, LX-26). The same two facts, the same blank rule.
 */
export function floatingLicenseSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error("floatingLicenseSql: bad table alias");
  }
  return `(${alias}.account_id IS NULL AND (${alias}.email IS NULL OR TRIM(${alias}.email) = ''))`;
}

// ── The licence owner pointer ─────────────────────────────────────────────────────────────────

/** `licenses.account_id`, or `null` for an unattached (or absent) licence. INTERNAL. */
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
 * `null` to detach), as one compare-and-set statement: conditional on the current owner, so a
 * concurrent change loses cleanly. The caller puts it in the same batch as its own writes
 * (Identity ends the licence's portal links atomically with the move); the owner's detach and
 * the developer's relink (I-12) both come through here.
 */
export function stmtMoveLicenseAccount(
  product: string,
  licenseId: string,
  from: string | null,
  to: string | null,
  now: number,
): DbStatement {
  return {
    sql: `UPDATE licenses SET account_id = ?, modified_at = ?
      WHERE product = ? AND id = ? AND account_id IS ?`,
    params: [to, now, product, licenseId, from],
  };
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

// ── The Cloud Sync principal (U-02) ──────────────────────────────────────────────────────────

/** A device's Cloud Sync principal: the product and the pairwise subject signed in on it. */
export interface SyncPrincipal {
  product: string;
  subject: string;
}

/**
 * The Cloud Sync principal of a device (U-02; plans/U-01.md §6.1, S-17 §5.2): the binding
 * `devices.subject` alone, after one check against the subject table. Cloud Sync needs sign-in
 * (owner, 2026-10-04, final answers), so there is NO licence-owner fallback: a device with no
 * binding (key-activated, floating licence, never signed in) has no principal and Cloud Sync
 * answers `account_required`. A merge alias resolves to the surviving subject (D21); a deleted
 * subject, a malformed value and a device that is not authorized all resolve to `null`. So does a
 * device whose licence is floating ({@link isFloatingLicense}; S-24, owner 2026-10-06): a
 * floating licence has no account features, whatever binding the device carries.
 *
 * And so does a device whose binding belongs to an account the licence was REMOVED from
 * (S-24 D19, lead decision of 2026-10-06, PX-23): "Remove from my library" keeps the licence's
 * email, so the licence is assigned and waiting rather than floating, but for the removing
 * account's devices the effect is the same as floating. LX-26's auto-attach block
 * (`license_auto_attach_blocks`, which `detachLicense` and a developer's move away write) marks
 * the (licence, account) pair; while the licence is not in that account, a device bound to that
 * account's subject has no principal. Re-adding the key (or a move back) lifts the block, and the
 * principal returns with it. A block for the account that holds the licence again is inert here,
 * as it is for the sweeps. Devices bound to any other account are unaffected.
 *
 * The licence check runs for every device that names a licence. A device whose `license_id`
 * names a licence row that does not exist (deleted, or never written) resolves to `null` too: an
 * unknown licence is not evidence of an assigned one, so the answer fails closed. A device that
 * names NO licence (`NO_LICENSE_ID`, the empty string) has no licence to be floating, so the
 * check does not apply: that is a device on a product with License off, and equally a keyless
 * device registered on a License-on product whose `registration` is `"open"` (S-24 decides
 * floating from a licence's facts; a licence-less device has none). Its principal is its binding,
 * like any other device's.
 *
 * The caller passes the D1 row `validateDeviceToken` returned, never a KV token record (a cache)
 * and never anything the request carried: no route accepts a subject or an account id.
 * `license_id` is required (as on `DeviceRow`), so a partial object cannot skip the floating
 * check by leaving it out.
 */
export async function resolveSyncPrincipal(
  db: Db,
  device: {
    product: string;
    status: string;
    license_id: string;
    subject?: string | null;
  },
): Promise<SyncPrincipal | null> {
  if (device.status !== "authorized") return null;
  const bound = device.subject ?? null;
  if (!bound || !PAIRWISE_SUBJECT_PATTERN.test(bound)) return null;
  // S-24 (owner, 2026-10-06): a floating licence has no account features, Cloud Sync included,
  // even when a binding survives on the device (a detach keeps it; it is hidden, not cleared).
  let licence: LicenseHolderFacts | null = null;
  if (device.license_id !== NO_LICENSE_ID) {
    licence = await db.first<LicenseHolderFacts>(
      "SELECT account_id, email FROM licenses WHERE product = ? AND id = ?",
      device.product,
      device.license_id,
    );
    // A missing licence row fails closed (see above).
    if (!licence || isFloatingLicense(licence)) return null;
  }
  const subject = await resolveSubject(db, device.product, bound);
  if (!subject) return null;
  // S-24 D19 (lead, 2026-10-06): removed from this subject's account's library, the licence is
  // floating for that account's devices.
  if (
    licence &&
    (await removedFromSubjectAccount(
      db,
      device.product,
      device.license_id,
      subject,
      licence.account_id ?? null,
    ))
  )
    return null;
  return { product: device.product, subject };
}

/**
 * Does LX-26's auto-attach block keep this licence out of the account behind `subject` (the
 * canonical subject {@link resolveSubject} answered)? One read over Core's
 * `license_auto_attach_blocks`; `core/licensing/licenseHolders.ts` owns its writes, and the read is written
 * out here because that module imports this one. A block for the account that holds the licence
 * again (`holder`) is inert and answers false.
 */
async function removedFromSubjectAccount(
  db: Db,
  product: string,
  licenseId: string,
  subject: string,
  holder: string | null,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one
       FROM license_auto_attach_blocks b
       JOIN account_product_subjects s
         ON s.account_id = b.account_id AND s.product = b.product
      WHERE b.product = ? AND b.license_id = ? AND s.subject = ?
        AND b.account_id IS NOT ?`,
    product,
    licenseId,
    subject,
    holder,
  );
  return row !== null;
}

// ── The device binding ────────────────────────────────────────────────────────────────────────

/**
 * Set the device binding on an already-bound device: an account signed in on a device that is
 * activated some other way (a key, an enrolment). Only an account sign-in through Identity calls
 * this; key entry never does (plans/I-04.md §6.2). `bound_by` is left alone, so a key-bound device
 * that later signs in is not released by a sign-out (§8 Q3). Mirrors the KV token record.
 * Throws `IdentityDisabledBindError` while the product's Identity is off (PX-W17).
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
  await assertIdentityBindable(db, product);
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
