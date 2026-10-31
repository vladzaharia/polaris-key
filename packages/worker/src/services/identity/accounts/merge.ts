/**
 * Account merge with proof of both (I-05; S-16 §5.1, D21; THREAT-MODEL item 15, merge takeover).
 *
 * Link-existing-account needs a live sign-in to EACH account in one flow, both fresh (no older
 * than 5 minutes). Never by email match. Then, in one atomic batch:
 *
 *   - links, licences, sessions, product grants, terms acceptances, passkeys and registry tokens
 *     move to the survivor; personal details fill in where the survivor has none (I-11 lets the
 *     person choose);
 *   - per product both accounts touched, the SURVIVOR's pairwise subject wins and the absorbed
 *     one becomes an alias, so a developer's records still resolve; devices bound to the absorbed
 *     subject are re-keyed; the developer gets `subject.merged` (D21);
 *   - a product only the absorbed account touched keeps its subject, now the survivor's;
 *   - the absorbed account becomes a tombstone that redirects its sessions for 30 days.
 *
 * Every registered store of account × product data re-keys first (`runSubjectMerge`): Config's
 * overrides and Cloud Sync's saves never collide silently (S-17 §5.5 owns the conflict UI).
 *
 * The same primitive completes the login card's join offer (I-07) when both sides are accounts,
 * and the account page's Link an existing account (PX-W12, `portal/link.ts`).
 *
 * PX-W12: every join is undoable for 72 hours (`mergeUndo.ts`). The batch also writes an
 * `account_merges` row with a snapshot of what moved, and no join involves an account that can
 * still undo a join of its own (`merge_pending`), so each undo stays possible and exact.
 *
 * I-11: no join involves an account with a scheduled deletion (`deletion_pending`). The request is
 * the holder's explicit, cancellable decision about ONE account: absorbing that account would
 * cascade the request away with its row (the intent lost, and an undo could not bring it back),
 * and joining another account into it would put that account's data under a deadline its holder
 * never chose. The person cancels the request (Keep my account) and joins afterwards. The check
 * is repeated inside the batch, so a request scheduled between the check and the commit aborts
 * the join instead of vanishing with the absorbed row.
 */

import type { DbStatement } from "../../../db/types.js";
import { stmtMoveAccountLicenses } from "../../../core/accounts/accountSubjects.js";
import {
  stmtMoveAccountTokens,
  stmtRevokeAccountAdminTokens,
} from "../../../core/accounts/personalTokens.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import { stmtsMoveAccountAutoAttachBlocks } from "../../../core/licensing/licenseHolders.js";
import { runSubjectMerge } from "../../../core/accounts/subjectHooks.js";
import { notifyDeviceChange } from "../../../core/devices/lifecycle.js";
import { randomId } from "../../../platform/crypto.js";
import { sendNotice } from "../../../core/notify/send.js";
import { securityNoticeRecipients } from "../../../core/notify/recipients.js";
import { accountsMergedNotice } from "../../../core/notify/templates.js";
import { stmtSubjectEvent } from "./events.js";
import { hasScheduledAccountDeletion } from "./lifecycle.js";
import { isFresh, type AccountContext, type AccountProof } from "./links.js";
import {
  MERGE_UNDO_SECONDS,
  captureMergeSnapshot,
  hasUndoableMerge,
  stmtRecordMerge,
} from "./mergeUndo.js";
import { getAccountRow, stmtClearConsoleStrength } from "./repo.js";
import { stmtsMoveTermsAcceptances } from "./terms.js";

export type MergeResult =
  | {
      ok: true;
      products: Array<{
        product: string;
        subject: string;
        alias: string | null;
      }>;
      /** The join's undo handle (`account_merges.id`), and until when it can be undone. */
      mergeId: string;
      undoUntil: number;
    }
  | {
      ok: false;
      reason:
        | "step_up_required"
        | "same_account"
        | "not_found"
        | "account_disabled"
        /** Either account joined another less than 72 hours ago, and that join can still be
         *  undone: wait until it no longer can. */
        | "merge_pending"
        /** Either account has a scheduled deletion (I-11): cancel it first, then join. */
        | "deletion_pending";
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
  // I-11: a join never involves an account the erasure ledger holds (a D1 restore brings one back
  // as `active`, and absorbing it would move erased data into a live account); a ledger that
  // cannot be read refuses the same way.
  if ((await erasureVerdict(env, now, survivor.id, absorbed.id)) !== "clear") {
    return { ok: false, reason: "account_disabled" };
  }
  const S = survivor.id;
  const A = absorbed.id;
  // Either side could still undo a join of its own: absorbing A would lose that undo, and
  // absorbing into S would hand this join's data and aliases to S's earlier absorbed account if
  // S's join were undone.
  if (
    (await hasUndoableMerge(db, A, now)) ||
    (await hasUndoableMerge(db, S, now))
  ) {
    return { ok: false, reason: "merge_pending" };
  }
  // A scheduled deletion belongs to ONE account and rides that account's id: refuse before anything
  // moves, whichever side it is on (see the header).
  if (await hasScheduledAccountDeletion(db, S, A)) {
    return { ok: false, reason: "deletion_pending" };
  }

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

  // PX-W12: what is about to move, so the join can be undone for 72 hours. Read before any
  // store re-keys, so the devices list is the absorbed account's own.
  const mergeId = randomId("amrg");
  const snapshot = await captureMergeSnapshot(
    db,
    S,
    A,
    absorbedSubjects.map((r) => ({
      product: r.product,
      subject: r.subject,
      aliasOf: survivorSubjects.get(r.product) ?? null,
    })),
  );

  // Re-key account × product data BEFORE the subject rows change, while both still resolve.
  // `skipped` counts the items a store left out of the join, for the audit row below.
  let skipped = 0;
  for (const row of absorbedSubjects) {
    const to = survivorSubjects.get(row.product);
    if (to) {
      skipped += (
        await runSubjectMerge(
          { db, env, now },
          { product: row.product, from: row.subject, to },
        )
      ).skipped;
    }
  }

  // The devices the batch re-binds to the survivor's subject, read before it moves them: each is
  // announced as `bound` once the batch has committed (the device lifecycle, R-7).
  const rebound: Array<{ product: string; deviceId: string; subject: string }> =
    [];
  for (const row of absorbedSubjects) {
    const to = survivorSubjects.get(row.product);
    if (!to) continue;
    const bound = await db.all<{ device_id: string }>(
      "SELECT device_id FROM devices WHERE product = ? AND subject = ?",
      row.product,
      row.subject,
    );
    for (const d of bound)
      rebound.push({
        product: row.product,
        deviceId: d.device_id,
        subject: to,
      });
  }

  const products: Array<{
    product: string;
    subject: string;
    alias: string | null;
  }> = [];
  const stmts: DbStatement[] = [
    // The deletion check above, atomic with the join: a request scheduled since then (another
    // session of either account) inserts a row with a NULL in a NOT NULL column and aborts the
    // whole batch, instead of cascading away with the absorbed account or riding the survivor's
    // deadline.
    {
      sql: `INSERT INTO account_merges (id, survivor_id, absorbed_id, merged_at, undo_until)
            SELECT ?, NULL, NULL, 0, 0
             WHERE EXISTS (SELECT 1 FROM account_deletions WHERE account_id IN (?, ?))`,
      params: [`${mergeId}:guard`, S, A],
    },
    // ST-30: a merge ends the absorbed account's console eligibility. Its links move to the
    // survivor, and a strong console-IdP link must not carry the operator's access with it: the
    // person signs in through the console IdP once more, which marks the link again (SM-3(c)). The
    // survivor's own links are untouched. Same batch, so it is all or nothing with the move.
    stmtClearConsoleStrength(A),
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
    // PX-W15: terms the absorbed account accepted stay accepted; the survivor's row wins for a
    // version both accepted.
    ...stmtsMoveTermsAcceptances(S, A),
    {
      sql: "UPDATE account_sessions SET account_id = ? WHERE account_id = ?",
      params: [S, A],
    },
    {
      sql: "UPDATE account_passkeys SET account_id = ? WHERE account_id = ?",
      params: [S, A],
    },
    // PX-W16: the absorbed account's pictures move with the links that use them; whatever the
    // survivor ends up not using goes in the nightly sweep.
    {
      sql: "UPDATE account_avatars SET account_id = ? WHERE account_id = ?",
      params: [S, A],
    },
    {
      sql: "UPDATE registry_tokens SET portal_account_id = ? WHERE portal_account_id = ?",
      params: [S, A],
    },
    // ST-34 D-12: an admin token resolves to the roles of the account that holds it, so it must
    // never take on the survivor's. It is revoked here, BEFORE the move, and stays on A (the move
    // skips the admin scope). A restored backup cannot revive it: the row is revoked.
    stmtRevokeAccountAdminTokens(A, now, "merge"),
    // F-33: the absorbed account's packages tokens become the survivor's.
    stmtMoveAccountTokens(A, S),
    // I-12: a relink's undo moves the licence back to the account it came from, which is now S.
    {
      sql: "UPDATE license_relinks SET from_account_id = ? WHERE from_account_id = ?",
      params: [S, A],
    },
    {
      sql: "UPDATE license_relinks SET to_account_id = ? WHERE to_account_id = ?",
      params: [S, A],
    },
    // LX-26 (S-24 D19): a licence the absorbed account removed stays out of the survivor too.
    ...stmtsMoveAccountAutoAttachBlocks(A, S),
    // PS-04: the absorbed account's library entries join the survivor's; the survivor's own entry
    // for a product (its earlier add) wins.
    {
      sql: `INSERT OR IGNORE INTO library_entries (account_id, product, via, added_at)
            SELECT ?, product, via, added_at FROM library_entries WHERE account_id = ?`,
      params: [S, A],
    },
    {
      sql: "DELETE FROM library_entries WHERE account_id = ?",
      params: [A],
    },
    // Personal details fill in where the survivor has none. So does the WebAuthn user handle
    // (I-16): a survivor without one takes the absorbed account's, so the passkeys that moved
    // over and the next one added share one "Polaris Key" entry in an authenticator.
    // A picture the survivor chose explicitly is never filled in: Initials (PX-W16) is a null
    // `avatar_key` with an explicit `picture` in `details_source_json`, and it stays Initials.
    // The birth date (I-33) fills in with its source, as one pair.
    {
      sql: `UPDATE accounts SET
              display_name = COALESCE(display_name, (SELECT display_name FROM accounts WHERE id = ?)),
              avatar_key = CASE
                WHEN (CASE WHEN json_valid(details_source_json)
                        THEN json_extract(details_source_json, '$.picture.explicit') END) = 1
                  THEN avatar_key
                ELSE COALESCE(avatar_key, (SELECT avatar_key FROM accounts WHERE id = ?)) END,
              locale = COALESCE(locale, (SELECT locale FROM accounts WHERE id = ?)),
              primary_email_verified_at = CASE WHEN primary_email IS NULL
                THEN (SELECT primary_email_verified_at FROM accounts WHERE id = ?)
                ELSE primary_email_verified_at END,
              primary_email = COALESCE(primary_email, (SELECT primary_email FROM accounts WHERE id = ?)),
              passkey_user_handle = COALESCE(passkey_user_handle, (SELECT passkey_user_handle FROM accounts WHERE id = ?)),
              birthdate_source = CASE WHEN birthdate IS NULL
                THEN (SELECT birthdate_source FROM accounts WHERE id = ?)
                ELSE birthdate_source END,
              birthdate = COALESCE(birthdate, (SELECT birthdate FROM accounts WHERE id = ?)),
              modified_at = ?
            WHERE id = ?`,
      params: [A, A, A, A, A, A, A, A, now, S],
    },
    {
      sql: `INSERT OR REPLACE INTO account_tombstones (id, email_hash, merged_into, deleted_at)
            VALUES (?, NULL, ?, ?)`,
      params: [A, S, now],
    },
    { sql: "DELETE FROM accounts WHERE id = ?", params: [A] },
    {
      sql: `INSERT INTO portal_audit (id, account_id, at, action, product, target_kind, target_id, summary)
            VALUES (?, ?, ?, 'account.merge', NULL, 'account', ?, ?)`,
      params: [
        randomId("paud"),
        S,
        now,
        A,
        skipped > 0
          ? `Joined another Polaris Locker account into this one (${skipped} synced ${skipped === 1 ? "item" : "items"} not carried over)`
          : "Joined another Polaris Locker account into this one",
      ],
    },
    stmtRecordMerge(mergeId, S, A, snapshot, now),
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    // The guard at the head of the batch tripped: a deletion was scheduled after the check.
    if (await hasScheduledAccountDeletion(db, S, A)) {
      return { ok: false, reason: "deletion_pending" };
    }
    throw e;
  }

  // Listeners hear it after the commit, so a service that keeps state per device (Cloud Connect's
  // roster) reads the devices where they now are. Total: a listener never fails the merge.
  for (const d of rebound)
    await notifyDeviceChange(
      { db, env, now },
      {
        product: d.product,
        deviceId: d.deviceId,
        kind: "bound",
        subject: d.subject,
      },
    );

  const undoUntil = now + MERGE_UNDO_SECONDS;
  const message = accountsMergedNotice({ origin: ctx.origin, undoUntil });
  for (const to of recipients) {
    // A notice that does not go out never undoes the merge (it already committed).
    await sendNotice(env, db, to, message, now).catch(() => false);
  }
  return { ok: true, products, mergeId, undoUntil };
}
