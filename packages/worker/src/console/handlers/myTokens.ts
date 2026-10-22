/**
 * The caller's OWN personal tokens (ST-34.4): `/manage/api/me/personal-tokens`.
 *
 *   GET    /me/personal-tokens            the caller's tokens in both scopes (`packages:read`,
 *                                         `admin`): label, last four, scope, times, status. Never a
 *                                         token, a hash, an account id or who revoked it.
 *   DELETE /me/personal-tokens/<id>       revoke one of the caller's own (reason `manual`). Another
 *                                         account's id is a 404, not a 403.
 *   DELETE /me/personal-tokens/current    revoke exactly the token presented (`pkey logout`).
 *
 * The first two are SESSION rows: they carry no `personalToken` flag, so a token (personal or
 * `pkeya_`) is refused before any of this runs, and a stolen token cannot list or revoke its
 * siblings. `current` is the opposite: `personalToken` + `personalOnly`, so a session is refused
 * and the only thing it can end is the credential that called it; revoking only narrows. The
 * account is the session's `aid` (a token session carries the holder's), so a v1 cookie, which
 * names none, answers 409 `reauth`. Audited in `platform_audit` as `account_token.revoke`, actor the
 * member id, naming the label and last four characters. Revoked tokens leave this isolate's
 * 30-second registry cache at once (`forgetRegistryTokens`).
 */

import { platformAudit } from "../../core/audit.js";
import { adminJson, err, notFound } from "../../core/console/respond.js";
import {
  getAccountToken,
  listAccountTokens,
  revokeAccountToken,
  type PersonalTokenView,
} from "../../core/accounts/personalTokens.js";
import { forgetRegistryTokens } from "../../core/registry/registryTokens.js";
import type { AdminCtx } from "../routes.js";

/** A token as its owner reads it: no `revokedBy` (it would name an account). */
function ownView(v: PersonalTokenView): Omit<PersonalTokenView, "revokedBy"> {
  const { revokedBy: _revokedBy, ...rest } = v;
  return rest;
}

const reauth = (): Response =>
  err(409, "reauth", "sign in again to manage personal tokens");

/** Revoke one of `accountId`'s tokens, audit it once, and answer it as it now stands. */
async function revokeOwn(
  c: AdminCtx,
  accountId: string,
  id: string,
): Promise<Response> {
  const was = await getAccountToken(c.db, accountId, id, c.now);
  if (!was) return notFound();
  if (was.status === "revoked")
    return adminJson({ ok: true, token: ownView(was) });
  const view = await revokeAccountToken(
    c.db,
    accountId,
    id,
    c.session.sub,
    "manual",
    c.now,
  );
  if (!view) return notFound();
  forgetRegistryTokens();
  await platformAudit(
    c.db,
    c.session,
    c.now,
    "account_token.revoke",
    { kind: "account_token", id },
    `Revoked personal token “${view.label}” (…${view.hint})`,
  );
  return adminJson({ ok: true, token: ownView(view) });
}

/** `GET /me/personal-tokens`. */
export async function handleMyTokenList(c: AdminCtx): Promise<Response> {
  const accountId = c.session.aid;
  if (!accountId) return reauth();
  const tokens = await listAccountTokens(c.db, accountId, c.now);
  return adminJson({ tokens: tokens.map(ownView) });
}

/** `DELETE /me/personal-tokens/<id>`. */
export async function handleMyTokenRevoke(c: AdminCtx): Promise<Response> {
  const accountId = c.session.aid;
  if (!accountId) return reauth();
  return revokeOwn(c, accountId, c.params.id ?? "");
}

/** `DELETE /me/personal-tokens/current`: the presenting token, and only it. */
export async function handleMyTokenRevokeCurrent(
  c: AdminCtx,
): Promise<Response> {
  const accountId = c.session.aid;
  const id = c.session.tokenId;
  // The dispatcher only lets a personal token here; a missing id is a bug, refused, never guessed.
  if (!accountId || !id) return err(403, "forbidden", "no presenting token");
  return revokeOwn(c, accountId, id);
}
