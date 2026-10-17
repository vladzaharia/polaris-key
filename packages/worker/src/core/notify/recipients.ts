/**
 * Who a platform notice goes to. A security notice goes to every verified address on the account
 * (PORTAL.md §6.3), so taking over one inbox is not enough to hide a change.
 */

import type { Db } from "../../db/types.js";
import { verifiedAccountEmails } from "../accounts/verifiedEmails.js";

/** Every verified address on the account, plus `alsoTo`, de-duplicated case-insensitively. */
export async function securityNoticeRecipients(
  db: Db,
  accountId: string,
  alsoTo: string | null | undefined,
): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const email of [
    ...(await verifiedAccountEmails(db, accountId)),
    ...(alsoTo ? [alsoTo] : []),
  ]) {
    const key = email.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, email.trim());
  }
  return [...seen.values()];
}
