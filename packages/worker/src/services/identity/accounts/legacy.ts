/**
 * The Worker half of the I-05 backfill (plans/I-04.md §6.1).
 *
 * migrations/0068_e copies the portal tables into the account model once. A Worker from before
 * I-05 may still serve for a while after the migration runs (deploy.yml applies migrations first),
 * and it writes only `portal_*`. `catchUpLegacyAccounts` repeats the same idempotent copy for those
 * late rows, from the scheduled job, and `catchUpLegacyAccount` does it for one id the moment a
 * signed portal cookie names an account the new tables do not know yet.
 *
 * `settleOwnershipConflicts` finishes §8 Q1 (owner-approved): `portal_license_links` allowed many
 * accounts per licence and `licenses.account_id` holds one. The migration picked the owner by link
 * strength; here every other account loses its link: it is emailed, its registry tokens for that
 * licence are revoked (`onLicenseOwnershipEnded`), and the change is listed in the platform audit
 * log, which is the operator report.
 */

import { onLicenseOwnershipEnded } from "../../../core/subjectHooks.js";
import { appendPlatformEvent } from "../../../core/platformEvents.js";
import type { Db } from "../../../core/platform.js";
import { getProduct } from "../../../core/data.js";
import { sendSecurityNotice } from "../portal/email.js";
import { licenseLinkSupersededNotice } from "../portal/notices.js";
import { portalAudit } from "../portal/repo.js";
import type { AccountContext } from "./links.js";

/** The copy statements of migrations/0068_e, optionally narrowed to one account id. */
function copyStatements(accountId: string | null): Array<{ sql: string; params: unknown[] }> {
  const one = accountId !== null;
  const only = (col: string) => (one ? ` AND ${col} = ?` : "");
  const p = one ? [accountId] : [];
  return [
    {
      sql: `INSERT OR IGNORE INTO accounts
              (id, status, primary_email, primary_email_verified_at, display_name,
               created_at, modified_at, last_sign_in_at)
            SELECT a.id, a.status, a.primary_email,
                   (SELECT e.verified_at FROM portal_account_emails e
                     WHERE e.account_id = a.id AND e.email = a.primary_email AND e.verified_at > 0),
                   a.display_name, a.created_at, a.modified_at, NULL
              FROM portal_accounts a
             WHERE a.id NOT IN (SELECT id FROM account_tombstones)${only("a.id")}`,
      params: p,
    },
    {
      sql: `INSERT OR IGNORE INTO account_links
              (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified,
               display_name, created_at, last_used_at)
            SELECT 'lnk_' || lower(hex(randomblob(12))), i.account_id, i.provider, '', i.subject,
                   'oidc', i.email, CASE WHEN i.email IS NULL THEN 0 ELSE 1 END, i.display_name,
                   i.created_at, i.last_seen_at
              FROM portal_account_identities i
              JOIN accounts a ON a.id = i.account_id
             WHERE 1 = 1${only("i.account_id")}`,
      params: p,
    },
    {
      sql: `INSERT OR IGNORE INTO account_links
              (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified,
               display_name, created_at, last_used_at)
            SELECT 'lnk_' || lower(hex(randomblob(12))), e.account_id, 'email', '', e.email,
                   'email', e.email, CASE WHEN e.verified_at > 0 THEN 1 ELSE 0 END, NULL,
                   e.created_at, e.verified_at
              FROM portal_account_emails e
              JOIN accounts a ON a.id = e.account_id
             WHERE 1 = 1${only("e.account_id")}`,
      params: p,
    },
    {
      sql: `UPDATE licenses
               SET account_id = (
                 SELECT l.account_id FROM portal_license_links l
                   JOIN accounts a ON a.id = l.account_id
                  WHERE l.product = licenses.product AND l.license_id = licenses.id${only("l.account_id")}
                  ORDER BY CASE l.source WHEN 'oidc' THEN 0 WHEN 'email' THEN 1
                                         WHEN 'admin' THEN 2 ELSE 3 END,
                           l.created_at, l.account_id
                  LIMIT 1)
             WHERE account_id IS NULL
               AND EXISTS (
                 SELECT 1 FROM portal_license_links l
                   JOIN accounts a ON a.id = l.account_id
                  WHERE l.product = licenses.product AND l.license_id = licenses.id${only("l.account_id")})`,
      params: one ? [accountId, accountId] : [],
    },
    {
      sql: `INSERT OR IGNORE INTO account_product_subjects (account_id, product, subject, created_at)
            SELECT account_id, product, 'ps_' || substr(lower(hex(randomblob(11))), 1, 22),
                   CAST(strftime('%s', 'now') AS INTEGER)
              FROM licenses
             WHERE account_id IS NOT NULL${only("account_id")}
             GROUP BY account_id, product`,
      params: p,
    },
  ];
}

/** Copy every portal row the new tables lack (the scheduled catch-up). Idempotent. */
export async function catchUpLegacyAccounts(db: Db): Promise<void> {
  for (const s of copyStatements(null)) await db.run(s.sql, ...(s.params as string[]));
}

/**
 * Copy one portal account the new tables lack, with its methods and licence links. Answers
 * whether the account exists afterwards. Cheap when there is nothing to copy (primary-key reads).
 */
export async function catchUpLegacyAccount(db: Db, accountId: string): Promise<boolean> {
  const legacy = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM portal_accounts WHERE id = ?",
    accountId,
  );
  if (!legacy) return false;
  for (const s of copyStatements(accountId)) await db.run(s.sql, ...(s.params as string[]));
  const row = await db.first<{ one: number }>("SELECT 1 AS one FROM accounts WHERE id = ?", accountId);
  return row !== null;
}

/**
 * §8 Q1: every account that held a portal link to a licence another account now owns loses it.
 * Bounded per run; answers how many links were settled.
 */
export async function settleOwnershipConflicts(
  ctx: AccountContext,
  limit = 200,
): Promise<number> {
  const { db, env, now } = ctx;
  const losers = await db.all<{ account_id: string; product: string; license_id: string }>(
    `SELECT l.account_id, l.product, l.license_id
       FROM portal_license_links l
       JOIN licenses x ON x.product = l.product AND x.id = l.license_id
      WHERE x.account_id IS NOT NULL AND x.account_id != l.account_id
      ORDER BY l.product, l.license_id, l.account_id
      LIMIT ?`,
    limit,
  );
  for (const loser of losers) {
    await onLicenseOwnershipEnded(db, env, {
      product: loser.product,
      licenseId: loser.license_id,
      accountId: loser.account_id,
      reason: "relinked",
      now,
    });
    const product = await getProduct(db, loser.product);
    await sendSecurityNotice(
      env,
      db,
      loser.account_id,
      null,
      licenseLinkSupersededNotice({ productName: product?.name ?? null, origin: ctx.origin }),
      now,
    ).catch(() => 0);
    await portalAudit(db, {
      accountId: loser.account_id,
      action: "account.license.superseded",
      product: loser.product,
      targetKind: "license",
      targetId: loser.license_id,
      summary: "Another account owns this license (one owner per license)",
      now,
    });
    await appendPlatformEvent(db, {
      actor: { sub: "system:identity", name: "Identity service", email: null },
      at: now,
      action: "account.license.superseded",
      target: { kind: "license", id: `${loser.product}/${loser.license_id}` },
      summary:
        "A second account lost its link to this license: a license has one owner (I-04 §8 Q1)",
    });
    await db.run(
      "DELETE FROM portal_license_links WHERE account_id = ? AND product = ? AND license_id = ?",
      loser.account_id,
      loser.product,
      loser.license_id,
    );
  }
  return losers.length;
}
