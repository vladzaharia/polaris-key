/**
 * Who a platform notice goes to. A security notice goes to every verified address on the account
 * (PORTAL.md §6.3), so taking over one inbox is not enough to hide a change.
 */

import type { Db } from "../../db/types.js";
import { verifiedAccountEmails } from "../accounts/verifiedEmails.js";

/** Extra recipients: one address, or several (a link made in an app also tells the linked address). */
export type AlsoTo =
  | string
  | null
  | undefined
  | readonly (string | null | undefined)[];

/** Every verified address on the account, plus `alsoTo`, de-duplicated case-insensitively. */
export async function securityNoticeRecipients(
  db: Db,
  accountId: string,
  alsoTo: AlsoTo,
): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const email of [
    ...(await verifiedAccountEmails(db, accountId)),
    ...(Array.isArray(alsoTo) ? alsoTo : alsoTo ? [alsoTo] : []).filter(
      (a): a is string => typeof a === "string" && a !== "",
    ),
  ]) {
    const key = email.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, email.trim());
  }
  return [...seen.values()];
}
