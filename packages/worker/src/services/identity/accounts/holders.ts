/**
 * Identity's half of the licence-holder hooks (LX-26; notes/S-24 §5.4, D2–D4), registered with
 * Core at module load (`core/licensing/licenseHolders.ts` explains the contract).
 *
 *   accountEmailVerified   an account verified an address: the email half of the portal's link
 *                          sweep, for that address (`attachWaitingLicensesByEmail`)
 *   licenseEmailAssigned   a licence was given an email (created with one, or assigned by PATCH):
 *                          it joins the account that verified the address, through
 *                          `attachLicense(…, via: "email")`
 *
 * Both obey the sweep's rules and nothing looser: only an address the account VERIFIED drives an
 * attach (R5-01), only on a product whose auto-link resolves on (custom issuers default off), an
 * owned licence is never touched, and a licence the account removed from its library is never
 * attached to it again automatically (D19). There are no placeholder accounts (D2): an address no
 * account has verified leaves the licence waiting.
 */

import { getLicense } from "../../../core/repo.js";
import { licenseEmail } from "../../../core/accounts/accountSubjects.js";
import {
  autoAttachBlockedAccounts,
  registerLicenseHolderHooks,
  type LicenseHolderContext,
} from "../../../core/licensing/licenseHolders.js";
import { normalizeEmail } from "../../../platform/email.js";
import type { Db } from "../../../db/types.js";
import {
  attachWaitingLicensesByEmail,
  autoLinkEnabled,
} from "../portal/repo.js";
import { attachLicense } from "./claim.js";
import { accountsVerifyingEmail, verifiedAccountEmails } from "./repo.js";

/**
 * The account-email hook's body: attach every licence waiting on `email`, provided the account
 * really has verified it (a caller's word is not proof; the check is one indexed read).
 */
export async function accountEmailVerified(
  db: Db,
  args: { accountId: string; email: string; now: number },
): Promise<number> {
  const address = normalizeEmail(args.email);
  if (!address) return 0;
  const verified = await verifiedAccountEmails(db, args.accountId);
  if (!verified.includes(address)) return 0;
  return attachWaitingLicensesByEmail(db, args.accountId, address, args.now);
}

/**
 * Association at creation or assignment (S-24 D3, D4). The account lookup and the read of the
 * licence's blocks run whenever the licence has an email, BEFORE anything decides the outcome, so
 * an owned licence, an auto-link-off product and an unknown address all cost the same two reads,
 * however many accounts match (no timing tell about who has an account).
 *
 * Which account: the one holding the address as an email sign-in method, when there is one (that
 * link is unique); otherwise the single account that verified it some other way. Two accounts
 * verifying the same address through providers is ambiguous, so the licence waits and the first
 * of them to be swept takes it, as before LX-26.
 */
export async function licenseEmailAssigned(
  ctx: LicenseHolderContext,
  args: { product: string; licenseId: string },
): Promise<boolean> {
  const { db } = ctx;
  const license = await getLicense(db, args.product, args.licenseId);
  const email = license ? licenseEmail(license) : null;
  if (!license || email === null) return false;
  const candidates = await accountsVerifyingEmail(db, email);
  // One read of the licence's blocks, whatever the candidates: filtered in memory below.
  const blocked = await autoAttachBlockedAccounts(
    db,
    args.product,
    args.licenseId,
  );
  if ((license.account_id ?? null) !== null) return false;
  if (!(await autoLinkEnabled(db, args.product))) return false;
  const eligible = candidates.filter((c) => !blocked.has(c.accountId));
  const chosen =
    eligible.find((c) => c.emailMethod) ??
    (eligible.length === 1 ? eligible[0] : undefined);
  if (!chosen) return false;
  const result = await attachLicense(ctx, {
    accountId: chosen.accountId,
    product: args.product,
    licenseId: args.licenseId,
    via: "email",
  });
  return result.ok && result.attached;
}

registerLicenseHolderHooks({ accountEmailVerified, licenseEmailAssigned });
