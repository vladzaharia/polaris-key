/**
 * Account deletion, per-product removal and disable (I-05; S-16 §5.1 and §5.5, D25, D27).
 *
 * Deletion and per-product removal call every registered store's `delete` (Cloud Sync, Config)
 * BEFORE the subject row goes, so each store can still resolve what it holds; then the device
 * binding is cleared and the developer hears `subject.deleted`, carrying the licence ids, through
 * the pull feed. Licences are the developer's commercial records: deletion DETACHES them (they
 * become floating) and leaves developer-set buyer columns to the developer (D27; the DPA wording
 * is pending a legal review, I-19).
 *
 * Per-product removal is NOT unlinkability while a licence of that product stays attached (D25):
 * the next contact mints a fresh subject that resolves to the same licence. `alsoDetachLicenses`
 * is the "also remove the licence from my Library" choice the removal screen offers.
 */

import {
  accountLicenses,
  stmtDetachAccountLicenses,
} from "../../../core/accountSubjects.js";
import { randomId, type DbStatement } from "../../../core/platform.js";
import { stmtRevokeAccountRegistryTokens } from "../../../core/registryTokens.js";
import {
  clearDeviceSubjects,
  onLicenseOwnershipEnded,
  runSubjectDelete,
} from "../../../core/subjectHooks.js";
import { portalAudit } from "../portal/repo.js";
import { stmtSubjectEvent } from "./events.js";
import { endLicenseLinks, moveLicenseOwnerEndingLinks } from "./legacy.js";
import type { AccountContext } from "./links.js";
import { getAccountRow } from "./repo.js";

/** Statements that end one (account, product) subject: its aliases, then the row itself. */
function stmtsEndSubject(
  accountId: string,
  product: string,
  subject: string,
): DbStatement[] {
  return [
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

/**
 * "Remove my data from <Product>": end the account's pairwise subject for one product. Registered
 * stores delete first, devices signed in with it lose the binding, and the developer gets
 * `subject.deleted`. With `alsoDetachLicenses` the product's licences leave the Library too.
 */
export async function removeProductData(
  ctx: AccountContext,
  args: { accountId: string; product: string; alsoDetachLicenses: boolean },
): Promise<{ ok: boolean; detached: string[] }> {
  const { db, env, now } = ctx;
  const row = await db.first<{ subject: string }>(
    "SELECT subject FROM account_product_subjects WHERE account_id = ? AND product = ?",
    args.accountId,
    args.product,
  );
  const licenses = (
    await accountLicenses(db, args.accountId, args.product)
  ).map((l) => l.id);
  const detached: string[] = [];
  if (args.alsoDetachLicenses) {
    for (const licenseId of licenses) {
      // No portal link survives the detach (see endLicenseLinks): §8 Q1 losers settle here.
      await endLicenseLinks(ctx, args.product, licenseId, [args.accountId]);
      if (
        await moveLicenseOwnerEndingLinks(
          ctx,
          args.product,
          licenseId,
          args.accountId,
          null,
        )
      ) {
        detached.push(licenseId);
        await onLicenseOwnershipEnded(db, env, {
          product: args.product,
          licenseId,
          accountId: args.accountId,
          reason: "detached",
          now,
        });
      }
    }
  }
  if (!row) return { ok: detached.length > 0, detached };
  await runSubjectDelete(
    { db, env, now },
    { product: args.product, subject: row.subject },
  );
  await clearDeviceSubjects(
    db,
    env,
    { kind: "subject", product: args.product, subject: row.subject },
    "product_removed",
  );
  await db.batch([
    stmtSubjectEvent(
      {
        type: "subject.deleted",
        product: args.product,
        subject: row.subject,
        licenseIds: licenses,
        detached: args.alsoDetachLicenses,
      },
      now,
    ),
    ...stmtsEndSubject(args.accountId, args.product, row.subject),
  ]);
  await portalAudit(db, {
    accountId: args.accountId,
    action: "account.product.remove",
    product: args.product,
    targetKind: "product",
    targetId: args.product,
    summary: args.alsoDetachLicenses
      ? "Removed product data and its licenses from the library"
      : "Removed product data",
    now,
  });
  return { ok: true, detached };
}

/**
 * Erase an account (right to erasure; S-16 §5.5). Stores delete first, every binding is cleared,
 * the developer of each product gets `subject.deleted` with the licence ids, licences detach and
 * their registry tokens are revoked, and every row naming the person goes: links, subjects and
 * aliases, sessions, grants, passkeys, the account, and the pre-I-05 `portal_*` rows (so a Worker
 * rollback cannot resurrect them). What remains is an id-only tombstone (a restore from backup can
 * re-apply the deletion) and one `portal.account.delete` receipt with no email, name or product.
 */
export async function deleteAccount(
  ctx: AccountContext,
  accountId: string,
): Promise<{ ok: boolean }> {
  const { db, env, now } = ctx;
  if (!(await getAccountRow(db, accountId))) return { ok: false };
  await db.run(
    "UPDATE accounts SET status = 'deleted', deleted_at = ?, modified_at = ? WHERE id = ?",
    now,
    now,
    accountId,
  );
  const subjects = await db.all<{ product: string; subject: string }>(
    "SELECT product, subject FROM account_product_subjects WHERE account_id = ? ORDER BY product",
    accountId,
  );
  const licenses = await accountLicenses(db, accountId);
  for (const s of subjects) {
    await runSubjectDelete(
      { db, env, now },
      { product: s.product, subject: s.subject },
    );
  }
  await clearDeviceSubjects(
    db,
    env,
    { kind: "account", accountId },
    "account_deleted",
  );
  for (const l of licenses) {
    // Every portal link to a licence that is about to float ends first, other accounts' too
    // (§8 Q1 losers settled inline), so the scheduled catch-up cannot re-point it at one of them.
    await endLicenseLinks(ctx, l.product, l.id, [accountId]);
    await onLicenseOwnershipEnded(db, env, {
      product: l.product,
      licenseId: l.id,
      accountId,
      reason: "account_deleted",
      now,
    });
  }
  const stmts: DbStatement[] = [];
  for (const s of subjects) {
    stmts.push(
      stmtSubjectEvent(
        {
          type: "subject.deleted",
          product: s.product,
          subject: s.subject,
          licenseIds: licenses
            .filter((l) => l.product === s.product)
            .map((l) => l.id),
          detached: true,
        },
        now,
      ),
      ...stmtsEndSubject(accountId, s.product, s.subject),
    );
  }
  stmts.push(
    // Belt and braces for a link a pre-I-05 Worker wrote since the loop above: none survives.
    {
      sql: `DELETE FROM portal_license_links
             WHERE EXISTS (SELECT 1 FROM licenses x
                            WHERE x.account_id = ? AND x.product = portal_license_links.product
                              AND x.id = portal_license_links.license_id)`,
      params: [accountId],
    },
    stmtDetachAccountLicenses(accountId),
    {
      sql: "DELETE FROM account_links WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM account_product_grants WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM account_sessions WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM account_passkeys WHERE account_id = ?",
      params: [accountId],
    },
    // I-12: the relink history keeps its pairwise subjects (the developer's record) and loses the
    // account id; undoing a relink away from this account then leaves the licence floating.
    {
      sql: "UPDATE license_relinks SET from_account_id = NULL WHERE from_account_id = ?",
      params: [accountId],
    },
    {
      sql: "UPDATE license_relinks SET to_account_id = NULL WHERE to_account_id = ?",
      params: [accountId],
    },
    { sql: "DELETE FROM accounts WHERE id = ?", params: [accountId] },
    {
      sql: `INSERT OR REPLACE INTO account_tombstones (id, email_hash, merged_into, deleted_at)
            VALUES (?, NULL, NULL, ?)`,
      params: [accountId, now],
    },
    {
      sql: "DELETE FROM portal_account_emails WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM portal_account_identities WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM portal_license_links WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM portal_audit WHERE account_id = ?",
      params: [accountId],
    },
    { sql: "DELETE FROM portal_accounts WHERE id = ?", params: [accountId] },
    // F-21: every registry token this account minted, on every product, stops now.
    stmtRevokeAccountRegistryTokens(accountId, now),
    {
      sql: `INSERT INTO portal_audit
              (id, account_id, at, action, product, target_kind, target_id, summary)
            VALUES (?, ?, ?, 'portal.account.delete', NULL, 'account', ?, ?)`,
      params: [
        randomId("paud"),
        accountId,
        now,
        accountId,
        "Portal account erased at the account holder's request",
      ],
    },
  );
  await db.batch(stmts);
  return { ok: true };
}

/** Disable an account (operator or abuse action): it cannot sign in, and every binding clears. */
export async function disableAccount(
  ctx: AccountContext,
  accountId: string,
): Promise<{ ok: boolean }> {
  const { db, env, now } = ctx;
  const changes = await db.runChanges(
    "UPDATE accounts SET status = 'disabled', modified_at = ? WHERE id = ? AND status = 'active'",
    now,
    accountId,
  );
  if (changes === 0) return { ok: false };
  // Mirrored into the pre-I-05 table, so a Worker rollback does not re-enable the account.
  await db.run(
    "UPDATE portal_accounts SET status = 'disabled', modified_at = ? WHERE id = ?",
    now,
    accountId,
  );
  await clearDeviceSubjects(
    db,
    env,
    { kind: "account", accountId },
    "account_disabled",
  );
  await portalAudit(db, {
    accountId,
    action: "account.disable",
    targetKind: "account",
    targetId: accountId,
    summary: "Account disabled",
    now,
  });
  return { ok: true };
}
