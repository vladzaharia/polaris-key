/// <reference types="@cloudflare/workers-types" />

import type { Db } from "../../../db/types.js";
import { getAccountRow } from "../accounts/repo.js";
import { platformSubjectLink } from "../accounts/platformMigration.js";
import { autoLinkEnabled } from "../portal/repo.js";

/**
 * The account an APP-MODE device-code sign-in settles for (WIRE-CONTRACT-V5 §12.10.1), or `null`
 * when the flow is card mode in every respect (the legacy chooser, then the identity's own licence).
 * Only a `provider: platform` product's sign-in is the platform IdP's, so only it can name an
 * account: the one the callback's claim signed this subject in to (`claimAccount`, I-17), else the
 * one the subject is already linked to when auto-linking resolves on (the legacy chooser's rule).
 * The account must be active. Read-only.
 */
export async function appModeAccount(
  db: Db,
  product: string,
  provider: string | null,
  issuer: string,
  sub: string,
  claimAccount: string | undefined,
): Promise<string | null> {
  if ((provider ?? "platform") !== "platform") return null;
  let accountId: string | null = claimAccount ?? null;
  if (accountId === null) {
    if (!(await autoLinkEnabled(db, product))) return null;
    const link = await platformSubjectLink(db, issuer, sub);
    if (!link || link.kind !== "oidc") return null;
    accountId = link.account_id;
  }
  const account = await getAccountRow(db, accountId);
  return account && account.status === "active" ? account.id : null;
}
