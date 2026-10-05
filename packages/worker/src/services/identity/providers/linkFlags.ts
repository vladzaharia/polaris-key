/**
 * Flags a provider puts on a sign-in method after it was linked (I-06; migration 0069). Only
 * Sign in with Apple reports such events today (`apple.ts`, `verifyAppleNotification`).
 *
 * A flag never deletes the link: removing a sign-in method stays the person's own step-up action
 * with its last-method guard (I-05). Each change is audited on the account.
 */

import type { Db } from "../../../core/platform.js";
import { findLink } from "../accounts/repo.js";
import { portalAudit } from "../portal/repo.js";
import { APPLE_ISSUER_KEY } from "./apple.js";

export type AppleLinkFlag =
  | "consent_revoked"
  | "account_deleted"
  | "email_disabled";

const FLAG_SUMMARY: Record<AppleLinkFlag, string> = {
  consent_revoked: "Apple reported that sign-in consent was revoked",
  account_deleted: "Apple reported that the Apple ID was deleted",
  email_disabled:
    "Apple reported that the private-relay address stopped forwarding",
};

/** The link of the login card's Apple subject `sub`, or `null`. */
async function appleLink(db: Db, sub: string) {
  return findLink(db, {
    issuerKey: APPLE_ISSUER_KEY,
    tenantScope: "",
    subject: sub,
  });
}

/** Flag the Apple link of `sub`. Answers the link id, or `null` when no account holds it. An
 *  `account_deleted` flag is final and is never replaced by a lesser one. */
export async function flagAppleLink(
  db: Db,
  sub: string,
  flag: AppleLinkFlag,
  now: number,
): Promise<string | null> {
  const link = await appleLink(db, sub);
  if (!link) return null;
  const changed = await db.runChanges(
    `UPDATE account_links SET provider_flag = ?
      WHERE id = ? AND (provider_flag IS NULL OR provider_flag NOT IN (?, 'account_deleted'))`,
    flag,
    link.id,
    flag,
  );
  if (changed > 0) {
    await portalAudit(db, {
      accountId: link.account_id,
      action: "account.link.flagged",
      targetKind: "link",
      targetId: link.id,
      summary: FLAG_SUMMARY[flag],
      now,
    });
  }
  return link.id;
}

/** Clear `flag` from a link (by id, or by Apple subject) when that is the flag it carries. */
export async function clearAppleLinkFlag(
  db: Db,
  target: { linkId: string } | { subject: string },
  flag: Exclude<AppleLinkFlag, "account_deleted">,
  now: number,
): Promise<string | null> {
  const link =
    "linkId" in target
      ? await db.first<{ id: string; account_id: string }>(
          "SELECT id, account_id FROM account_links WHERE id = ?",
          target.linkId,
        )
      : await appleLink(db, target.subject);
  if (!link) return null;
  const changed = await db.runChanges(
    "UPDATE account_links SET provider_flag = NULL WHERE id = ? AND provider_flag = ?",
    link.id,
    flag,
  );
  if (changed > 0) {
    await portalAudit(db, {
      accountId: link.account_id,
      action: "account.link.unflagged",
      targetKind: "link",
      targetId: link.id,
      summary:
        flag === "consent_revoked"
          ? "Signed in with Apple again after consent was revoked"
          : "Apple reported that the private-relay address forwards again",
      now,
    });
  }
  return link.id;
}
