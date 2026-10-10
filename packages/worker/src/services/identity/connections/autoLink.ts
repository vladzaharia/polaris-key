/**
 * Auto-link through a verified domain (I-30; plans/I-27.md, Owner decisions Q1, 2026-10-08).
 *
 * The owner's 2026-10-04 rule "never join by email match" is narrowed to exactly this case, and
 * no other:
 *
 *   - the identity came through a PLATFORM connection (never a product connection);
 *   - the connection vouches for the address: it is inside one of the connection's DNS-verified
 *     domains and the ID token says `email_verified` (`connectionVouchesForEmail`);
 *   - the identity has no link yet;
 *   - the address is verified on EXACTLY ONE account, and that account is active.
 *
 * Then the identity is linked to that account, the account's addresses are emailed ("<label>
 * was added as a way to sign in"), and the link is audited (`account.link.auto`). Every other
 * case keeps the join offer, with its proof of both identities, at the email gate.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Connection } from "../../../core/oidc/connections.js";
import { onAccountEmailVerified } from "../../../core/licensing/licenseHolders.js";
import {
  accountsVerifyingEmail,
  findLink,
  getAccountRow,
  insertLink,
} from "../accounts/repo.js";
import { portalAudit } from "../portal/repo.js";
import { sendSecurityNotice } from "../portal/email.js";
import { signInMethodAddedNotice } from "../portal/notices.js";

export interface AutoLinkInput {
  connection: Connection;
  issuerKey: string;
  subject: string;
  /** The address the connection vouched for (already checked by the caller). */
  email: string;
  displayName: string | null;
  origin: string;
}

/**
 * Link the identity to the one account that verified its address, when Q1's conditions hold.
 * Answers the account id it linked to, or `null` (nothing written).
 */
export async function autoLinkThroughDomain(
  env: Env,
  db: Db,
  input: AutoLinkInput,
  now: number,
): Promise<string | null> {
  if (input.connection.scope !== "platform") return null;
  if (input.connection.status !== "active") return null;
  const existing = await findLink(db, {
    issuerKey: input.issuerKey,
    tenantScope: "",
    subject: input.subject,
  });
  if (existing) return null;
  const holders = await accountsVerifyingEmail(db, input.email);
  if (holders.length !== 1) return null;
  const account = await getAccountRow(db, holders[0]!.accountId);
  if (!account || account.status !== "active") return null;
  const inserted = await insertLink(
    db,
    account.id,
    {
      issuerKey: input.issuerKey,
      tenantScope: "",
      subject: input.subject,
      kind: "oidc",
      email: input.email,
      emailVerified: true,
      displayName: input.displayName,
      amr: [`connection:${input.connection.id}`],
    },
    now,
  );
  const link = await findLink(db, {
    issuerKey: input.issuerKey,
    tenantScope: "",
    subject: input.subject,
  });
  // Lost a race to another insert: the UNIQUE key decided, and it may not be this account.
  if (!inserted || !link || link.account_id !== account.id) return null;
  await portalAudit(db, {
    accountId: account.id,
    action: "account.link.auto",
    targetKind: "link",
    targetId: link.id,
    summary: `Connected ${input.connection.label} through a verified domain`,
    now,
  });
  await onAccountEmailVerified(db, account.id, input.email, now);
  await sendSecurityNotice(
    env,
    db,
    account.id,
    account.primary_email,
    signInMethodAddedNotice({
      method: input.connection.label,
      origin: input.origin,
    }),
    now,
  );
  return account.id;
}
