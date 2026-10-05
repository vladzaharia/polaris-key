/**
 * Account merge with proof of both (I-05; S-16 §5.1, D21; THREAT-MODEL item 15, merge takeover).
 *
 * Link-existing-account needs a live sign-in to EACH account in one flow, both fresh (no older
 * than 5 minutes). Never by email match. Then, in one atomic batch:
 *
 *   - links, licences, sessions, product grants, passkeys and registry tokens move to the
 *     survivor; personal details fill in where the survivor has none (I-11 lets the person choose);
 *   - per product both accounts touched, the SURVIVOR's pairwise subject wins and the absorbed
 *     one becomes an alias, so a developer's records still resolve; devices bound to the absorbed
 *     subject are re-keyed; the developer gets `subject.merged` (D21);
 *   - a product only the absorbed account touched keeps its subject, now the survivor's;
 *   - the absorbed account becomes a tombstone that redirects its sessions for 30 days.
 *
 * Every registered store of account × product data re-keys first (`runSubjectMerge`): Config's
 * overrides and Cloud Sync's saves never collide silently (S-17 §5.5 owns the conflict UI).
 *
 * The same primitive completes the login card's join offer (I-07) when both sides are accounts.
 */

import type { DbStatement } from "../../../core/platform.js";
import { stmtMoveAccountLicenses } from "../../../core/accountSubjects.js";
import { runSubjectMerge } from "../../../core/subjectHooks.js";
import { randomId } from "../../../core/platform.js";
import { sendNotice, securityNoticeRecipients } from "../portal/email.js";
import { accountsMergedNotice } from "../portal/notices.js";
import { stmtSubjectEvent } from "./events.js";
import { isFresh, type AccountContext, type AccountProof } from "./links.js";
import { getAccountRow } from "./repo.js";

export type MergeResult =
  | {
      ok: true;
      products: Array<{
        product: string;
        subject: string;
        alias: string | null;
      }>;
    }
  | {
      ok: false;
      reason:
        | "step_up_required"
        | "same_account"
        | "not_found"
        | "account_disabled";
    };

export async function mergeAccounts(
  ctx: AccountContext,
  args: { survivor: AccountProof; absorbed: AccountProof },
): Promise<MergeResult> {
  const { db, env, now } = ctx;
  const { survivor: sp, absorbed: ap } = args;
  if (sp.accountId === ap.accountId)
    return { ok: false, reason: "same_account" };
  // Proof of BOTH, both fresh: one stale proof is no proof (S-16 §5.4 item 15).
  if (!isFresh(sp, now) || !isFresh(ap, now)) {
    return { ok: false, reason: "step_up_required" };
  }
  const survivor = await getAccountRow(db, sp.accountId);
  const absorbed = await getAccountRow(db, ap.accountId);
  if (!survivor || !absorbed) return { ok: false, reason: "not_found" };
  if (survivor.status !== "active" || absorbed.status !== "active") {
    return { ok: false, reason: "account_disabled" };
  }
  const S = survivor.id;
  const A = absorbed.id;

  // Everyone on either account hears about it; read before the absorbed rows move.
  const recipients = [
    ...new Set([
      ...(await securityNoticeRecipients(db, S, survivor.primary_email)),
      ...(await securityNoticeRecipients(db, A, absorbed.primary_email)),
    ]),
  ];

  const absorbedSubjects = await db.all<{ product: string; subject: string }>(
    "SELECT product, subject FROM account_product_subjects WHERE account_id = ? ORDER BY product",
    A,
  );
  const survivorSubjects = new Map(
    (
      await db.all<{ product: string; subject: string }>(
        "SELECT product, subject FROM account_product_subjects WHERE account_id = ?",
        S,
      )
    ).map((r) => [r.product, r.subject]),
  );

  // Re-key account × product data BEFORE the subject rows change, while both still resolve.
  for (const row of absorbedSubjects) {
    const to = survivorSubjects.get(row.product);
    if (to) {
      await runSubjectMerge(
        { db, env, now },
        { product: row.product, from: row.subject, to },
      );
    }
  }

  const products: Array<{
    product: string;
    subject: string;
    alias: string | null;
  }> = [];
  const stmts: DbStatement[] = [
    {
      sql: "UPDATE account_links SET account_id = ? WHERE account_id = ?",
      params: [S, A],
    },
    stmtMoveAccountLicenses(A, S),
  ];
  for (const row of absorbedSubjects) {
    const to = survivorSubjects.get(row.product);
    if (!to) {
      // Only the absorbed account knew this product: its subject simply becomes the survivor's.
      stmts.push({
        sql: "UPDATE account_product_subjects SET account_id = ? WHERE account_id = ? AND product = ?",
        params: [S, A, row.product],
      });
      products.push({
        product: row.product,
        subject: row.subject,
        alias: null,
      });
      continue;
    }
    stmts.push(
      {
        sql: `INSERT OR REPLACE INTO account_product_subject_aliases (product, alias, subject, merged_at)
              VALUES (?, ?, ?, ?)`,
        params: [row.product, row.subject, to, now],
      },
      // An earlier merge's aliases of the absorbed subject follow it to the survivor.
      {
        sql: "UPDATE account_product_subject_aliases SET subject = ? WHERE product = ? AND subject = ?",
        params: [to, row.product, row.subject],
      },
      {
        sql: "DELETE FROM account_product_subjects WHERE account_id = ? AND product = ?",
        params: [A, row.product],
      },
      {
        sql: "UPDATE devices SET subject = ? WHERE product = ? AND subject = ?",
        params: [to, row.product, row.subject],
      },
      stmtSubjectEvent(
        {
          type: "subject.merged",
          product: row.product,
          subject: to,
          alias: row.subject,
        },
        now,
      ),
    );
    products.push({ product: row.product, subject: to, alias: row.subject });
  }
  stmts.push(
    // Grants: the survivor's own consent wins where both gave one. The consented scope (PX-W13,
    // `scope_hash`) moves with it, so a merge never re-asks for a consent already given.
    {
      sql: `INSERT OR IGNORE INTO account_product_grants
              (account_id, product, claims_json, granted_at, modified_at, scope_hash)
            SELECT ?, product, claims_json, granted_at, modified_at, scope_hash
              FROM account_product_grants WHERE account_id = ?`,
      params: [S, A],
    },
    {
      sql: "DELETE FROM account_product_grants WHERE account_id = ?",
      params: [A],
    },
    {
      sql: "UPDATE account_sessions SET account_id = ? WHERE account_id = ?",
      params: [S, A],
    },
    {
      sql: "UPDATE account_passkeys SET account_id = ? WHERE account_id = ?",
      params: [S, A],
    },
    {
      sql: "UPDATE registry_tokens SET portal_account_id = ? WHERE portal_account_id = ?",
      params: [S, A],
    },
    // Personal details fill in where the survivor has none.
    {
      sql: `UPDATE accounts SET
              display_name = COALESCE(display_name, (SELECT display_name FROM accounts WHERE id = ?)),
              avatar_key = COALESCE(avatar_key, (SELECT avatar_key FROM accounts WHERE id = ?)),
              locale = COALESCE(locale, (SELECT locale FROM accounts WHERE id = ?)),
              primary_email_verified_at = CASE WHEN primary_email IS NULL
                THEN (SELECT primary_email_verified_at FROM accounts WHERE id = ?)
                ELSE primary_email_verified_at END,
              primary_email = COALESCE(primary_email, (SELECT primary_email FROM accounts WHERE id = ?)),
              modified_at = ?
            WHERE id = ?`,
      params: [A, A, A, A, A, now, S],
    },
    {
      sql: `INSERT OR REPLACE INTO account_tombstones (id, email_hash, merged_into, deleted_at)
            VALUES (?, NULL, ?, ?)`,
      params: [A, S, now],
    },
    { sql: "DELETE FROM accounts WHERE id = ?", params: [A] },
    // The pre-I-05 tables: the absorbed account's rows go (a rollback re-creates the survivor's
    // from the moved links and licences, scripts/rollback/0068_accounts.down.sql).
    {
      sql: "DELETE FROM portal_account_identities WHERE account_id = ?",
      params: [A],
    },
    {
      sql: "DELETE FROM portal_account_emails WHERE account_id = ?",
      params: [A],
    },
    {
      sql: "DELETE FROM portal_license_links WHERE account_id = ?",
      params: [A],
    },
    { sql: "DELETE FROM portal_accounts WHERE id = ?", params: [A] },
    {
      sql: `INSERT INTO portal_audit (id, account_id, at, action, product, target_kind, target_id, summary)
            VALUES (?, ?, ?, 'account.merge', NULL, 'account', ?, ?)`,
      params: [
        randomId("paud"),
        S,
        now,
        A,
        "Joined another Polaris Key account into this one",
      ],
    },
  );
  await db.batch(stmts);

  const message = accountsMergedNotice({ origin: ctx.origin });
  for (const to of recipients) {
    // A notice that does not go out never undoes the merge (it already committed).
    await sendNotice(env, db, to, message, now).catch(() => false);
  }
  return { ok: true, products };
}
