import type { Db } from "../../db/types.js";

/**
 * Every address this account has verified: its verified email sign-in methods, the
 * provider-verified email of any link, and the primary email once verified. The licence claim
 * rule (an email-carrying licence attaches only to an account that verified that email) and the
 * security-notice fan-out both read this one list. {@link accountsVerifyingEmail} is its inverse
 * and must stay in step: change what "verified" means here and change it there too
 * (`test/surfaces/console/licenseHolders.test.ts` pins the two agree).
 */
export async function verifiedAccountEmails(
  db: Db,
  accountId: string,
): Promise<string[]> {
  const rows = await db.all<{ email: string }>(
    `SELECT email FROM account_links
      WHERE account_id = ? AND email IS NOT NULL AND email_verified = 1
     UNION
     SELECT primary_email AS email FROM accounts
      WHERE id = ? AND primary_email IS NOT NULL AND primary_email_verified_at IS NOT NULL
     ORDER BY email`,
    accountId,
    accountId,
  );
  return rows.map((r) => r.email);
}
