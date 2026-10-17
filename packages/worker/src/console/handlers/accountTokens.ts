/**
 * The Superadmin's roster of people's personal tokens (F-33): `/manage/api/account-tokens[/<id>]`.
 *
 *   GET    /account-tokens        every account's `pkeyp_` tokens: label, last four, scope, times,
 *                                 status and whose they are. Never a token or a hash.
 *   DELETE /account-tokens/<id>   revoke one (reason `admin`).
 *
 * Platform rows (`./routes.ts`, area `platform`), reachable only by a SESSION: the rows name no
 * `tokenScope`, so a token principal is refused before any of this runs. A Superadmin cannot MINT
 * a person's token; the person does, in Account → Packages. Revoke is immediate on this isolate
 * and within 30 seconds on the others (the registry host's resolution cache). Audited in
 * `platform_audit` as `account_token.revoke`, naming the token's label, last four and account id,
 * never the token.
 */

import { platformAudit } from "../../core/audit.js";
import { adminJson, notFound } from "../../core/console/respond.js";
import {
  listAllAccountTokens,
  revokeAccountTokenAsAdmin,
} from "../../core/accounts/personalTokens.js";
import { forgetRegistryTokens } from "../../core/registry/registryTokens.js";
import type { AdminCtx } from "../routes.js";

/** `GET /account-tokens`. */
export async function handleAccountTokenList(c: AdminCtx): Promise<Response> {
  return adminJson({ tokens: await listAllAccountTokens(c.db, c.now) });
}

/** `DELETE /account-tokens/<id>`. */
export async function handleAccountTokenRevoke(c: AdminCtx): Promise<Response> {
  const id = c.params.id ?? "";
  const was = (await listAllAccountTokens(c.db, c.now)).find(
    (t) => t.id === id,
  );
  const view = await revokeAccountTokenAsAdmin(c.db, id, "admin", c.now);
  if (!view) return notFound();
  forgetRegistryTokens();
  // Already revoked: answer it as it stands, and write no second audit row.
  if (was?.status !== "revoked")
    await platformAudit(
      c.db,
      c.session,
      c.now,
      "account_token.revoke",
      { kind: "account_token", id },
      `Revoked personal token “${view.label}” (…${view.hint}) of account ${view.accountId}`,
    );
  return adminJson({ ok: true, token: view });
}
