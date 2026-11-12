/**
 * Per-product removal (I-11, U-12.1, U-12.2): "Remove my data from <Product>" and the pass that
 * finishes it. Account erasure is `deletion.ts`; both share the registered stores' `delete`.
 *
 * Per-product removal is NOT unlinkability while a licence of that product stays attached (D25):
 * the next contact mints a fresh subject that resolves to the same licence. `alsoDetachLicenses`
 * is the "also remove the licence from my Library" choice the removal screen offers.
 */

import { accountLicenses } from "../../../core/accounts/accountSubjects.js";
import type { DbStatement } from "../../../db/types.js";
import {
  clearDeviceSubjects,
  runSubjectDeleteIsolated,
} from "../../../core/accounts/subjectHooks.js";
import { randomId } from "../../../platform/crypto.js";
import { detachLicense } from "./claim.js";
import { stmtsDeleteAccountIssuerRows } from "../issuer/lifecycle.js";
import { stmtSubjectEvent } from "./events.js";
import {
  recordSubjectErasure,
  replaySubjectErasures,
  type SubjectReplayResult,
} from "./subjectErasureLedger.js";
import type { AccountContext } from "./links.js";

/** Statements that end one (account, product) subject: its aliases, then the row itself. */
function stmtsEndSubject(
  accountId: string,
  product: string,
  subject: string,
): DbStatement[] {
  return [
    // I-41: the readable support code goes with the subject (and with any subject it absorbed).
    {
      sql: `DELETE FROM support_codes WHERE product = ?
              AND (subject = ? OR subject IN (SELECT alias FROM account_product_subject_aliases
                                               WHERE product = ? AND subject = ?))`,
      params: [product, subject, product, subject],
    },
    {
      sql: "DELETE FROM account_product_subject_aliases WHERE product = ? AND subject = ?",
      params: [product, subject],
    },
    {
      sql: "DELETE FROM account_product_subjects WHERE account_id = ? AND product = ?",
      params: [accountId, product],
    },
  ];
}

/** What {@link removeProductData} answers. */
export interface ProductRemovalResult {
  ok: boolean;
  detached: string[];
  /** Set when a store failed: the subject row stays and the resume pass finishes the removal. */
  pending?: true;
}

/**
 * "Remove my data from <Product>": end the account's pairwise subject for one product, in this
 * order (U-12.1):
 *
 *   1. WRITE-AHEAD: the removal is recorded on the subject ledger (`subjectErasureLedger.ts`,
 *      create-only, in R2, so outside D1). A record that cannot be made durable throws here with
 *      nothing changed.
 *   2. With `alsoDetachLicenses`, the product's licences leave the Library. Never replayed.
 *   3. The rest is {@link completeProductRemoval}: the device FENCE first, then the stores
 *      fault-isolated, then the commit.
 *
 * A failing store does not abort the others and does not fail the request: the answer carries
 * `pending`, the subject row stays (it is what tells the resume pass a removal is owed), and the
 * pass or the person's own retry completes it.
 */
export async function removeProductData(
  ctx: AccountContext,
  args: { accountId: string; product: string; alsoDetachLicenses: boolean },
): Promise<ProductRemovalResult> {
  const { db, env, now } = ctx;
  const row = await db.first<{ subject: string }>(
    "SELECT subject FROM account_product_subjects WHERE account_id = ? AND product = ?",
    args.accountId,
    args.product,
  );
  // WRITE-AHEAD: nothing below changes anything unless the ledger durably names the removal.
  if (row) await recordSubjectErasure(env, args.product, row.subject, now);
  const licenses = (
    await accountLicenses(db, args.accountId, args.product)
  ).map((l) => l.id);
  const detached: string[] = [];
  if (args.alsoDetachLicenses) {
    for (const licenseId of licenses) {
      // The owner's own detach (LX-26 block, ended links, token revocation, `account.license.detach`
      // in the account's history): without the block an email-assigned licence would be re-attached
      // by the very next portal request.
      if (
        (
          await detachLicense(ctx, {
            accountId: args.accountId,
            product: args.product,
            licenseId,
          })
        ).ok
      ) {
        detached.push(licenseId);
      }
    }
  }
  if (!row) return { ok: detached.length > 0, detached };
  const done = await completeProductRemoval(ctx, {
    product: args.product,
    subject: row.subject,
    licenseIds: licenses,
    detached: args.alsoDetachLicenses,
  });
  return done.pending
    ? { ok: true, detached, pending: true }
    : { ok: true, detached };
}

/**
 * The steps after the write-ahead record of a per-product removal, for a subject the ledger
 * already names (the request path, the resume pass). Every step deletes by key or is
 * create-only, so it can be repeated.
 *
 *   FENCE. The bindings of the subject and its aliases are cleared first: a device that is still
 *   bound could otherwise recreate a key ring or a Cloud Sync object while the stores are being
 *   emptied, and sign in again as the subject.
 *   STORES. Every registered store's `delete`, fault-isolated and in name order, so the key ring
 *   (the last E2E key material) goes before the Cloud Sync bytes. A failure leaves the subject row
 *   in place and answers `pending` with the store names.
 *   COMMIT. One batch: `subject.deleted`, the audit row, any binding or ring a late request
 *   created, support codes, aliases and the subject row.
 */
export async function completeProductRemoval(
  ctx: AccountContext,
  args: {
    product: string;
    subject: string;
    /** The licence ids the developer is told about; read from the account when absent. */
    licenseIds?: string[];
    detached?: boolean;
  },
): Promise<{ removed: boolean; pending?: true; failedStores?: string[] }> {
  const { db, env, now } = ctx;
  const { product, subject } = args;
  const row = await db.first<{ account_id: string }>(
    "SELECT account_id FROM account_product_subjects WHERE product = ? AND subject = ?",
    product,
    subject,
  );
  if (!row) return { removed: false };
  await clearDeviceSubjects(
    db,
    env,
    { kind: "subject", product, subject },
    "product_removed",
  );
  const failed = await runSubjectDeleteIsolated(
    { db, env, now },
    { product, subject },
  );
  if (failed.length > 0)
    return {
      removed: false,
      pending: true,
      failedStores: failed.map((f) => f.store),
    };
  const licenseIds =
    args.licenseIds ??
    (await accountLicenses(db, row.account_id, product)).map((l) => l.id);
  const detached = args.detached ?? false;
  // A sign-in that raced the fence may have bound a device again: clear it once more, then close
  // the same gap inside the commit.
  await clearDeviceSubjects(
    db,
    env,
    { kind: "subject", product, subject },
    "product_removed",
  );
  // ONE batch. The guarded event and audit run while the subject row still exists (the row goes
  // later in the same batch), so two completions record them once. The binding and key ring
  // statements make the commit leave nothing behind that a late rebind or ring write created
  // after the stores ran.
  await db.batch([
    stmtSubjectDeletedOnce(
      row.account_id,
      { product, subject, licenseIds, detached },
      now,
    ),
    stmtAuditOnce(
      row.account_id,
      product,
      subject,
      detached
        ? "Removed product data and its licenses from the library"
        : "Removed product data",
      now,
    ),
    {
      sql: `UPDATE devices SET subject = NULL
             WHERE product = ? AND subject IS NOT NULL
               AND (subject = ? OR subject IN (
                 SELECT alias FROM account_product_subject_aliases WHERE product = ? AND subject = ?))`,
      params: [product, subject, product, subject],
    },
    ...["keyring_wraps", "keyring_adopted", "keyrings"].map((t) => ({
      sql: `DELETE FROM ${t} WHERE product = ? AND subject = ?`,
      params: [product, subject],
    })),
    // I-21.15: the account's client grants and refresh families for the product go with its subject.
    ...stmtsDeleteAccountIssuerRows(row.account_id, product),
    ...stmtsEndSubject(row.account_id, product, subject),
  ]);
  return { removed: true };
}

/**
 * One bounded pass over the per-product removal ledger (`subjectErasureLedger.ts`): every removal
 * that is owed (a store failed on the request, or a restore brought the rows back) is completed
 * through {@link completeProductRemoval}, and old entries whose subject is gone are swept. With
 * `objects` and a `product` it also runs the stores' deletes for ledger subjects D1 no longer has
 * (after a Durable Object point-in-time restore). Run by both cron ticks.
 */
export function replaySubjectRemovals(
  ctx: AccountContext,
  opts: { objects?: boolean; product?: string } = {},
): Promise<SubjectReplayResult> {
  return replaySubjectErasures(
    ctx,
    (a) => completeProductRemoval(ctx, a),
    opts,
  );
}

/** The account's `account.product.remove` history row, written only while the subject row exists. */
function stmtAuditOnce(
  accountId: string,
  product: string,
  subject: string,
  summary: string,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO portal_audit
            (id, account_id, at, action, product, target_kind, target_id, summary)
          SELECT ?, ?, ?, 'account.product.remove', ?, 'product', ?, ?
           WHERE EXISTS (SELECT 1 FROM account_product_subjects
                          WHERE account_id = ? AND product = ? AND subject = ?)`,
    params: [
      randomId("paud"),
      accountId,
      now,
      product,
      product,
      summary,
      accountId,
      product,
      subject,
    ],
  };
}

/** `subject.deleted`, written only while the subject row still exists, so two completions of the
 *  same removal tell the developer once. */
function stmtSubjectDeletedOnce(
  accountId: string,
  e: {
    product: string;
    subject: string;
    licenseIds: string[];
    detached: boolean;
  },
  now: number,
): DbStatement {
  const ev = stmtSubjectEvent({ type: "subject.deleted", ...e }, now);
  return {
    sql: ev.sql.replace(
      /VALUES \(\?, \?, \?, \?, \?, \?\)/,
      `SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM account_product_subjects WHERE account_id = ? AND product = ? AND subject = ?)`,
    ),
    params: [...ev.params, accountId, e.product, e.subject],
  };
}
