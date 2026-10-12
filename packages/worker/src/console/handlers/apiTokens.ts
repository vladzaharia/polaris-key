/**
 * The admin API-token roster: `/manage/api/tokens[/<id>]`.
 *
 *   GET    /tokens        the roster. Never a secret, never a hash.
 *   POST   /tokens        mint. The plaintext appears in THIS response and nowhere else, ever.
 *   DELETE /tokens/<id>   revoke.
 *
 * Platform rows (`./routes.ts`, area `platform`, minting behind a step-up), and reachable only by
 * a SESSION: the rows name no `tokenScope`, so the dispatcher refuses a token principal before
 * any of this runs. Minting a credential is an interactive, attributable act. The credential
 * itself (scopes, hashing, validation) is `../apiTokens.ts`.
 *
 * Mint and revoke are audited in `platform_audit` (`api_token.create`, `api_token.revoke`): the
 * actor is the operator's verified session, and the entry records which token, never the secret
 * or anything derived from it. Every USE of a token is audited under the product it acted on
 * (`api_token.used`, `../apiTokens.ts`). The roster row keeps the rest of the lifecycle:
 * `created_at`, `expires_at`, `revoked_at` and `last_used_at`, with a revoked row kept rather
 * than deleted so the history survives.
 */

import { SECONDS_PER_DAY } from "@polaris-key/protocol";
import { ErrorCode } from "../../core/errors.js";
import { platformAudit } from "../../core/console/audit.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
} from "../../core/console/respond.js";
import { hashKey, mintAdminApiToken, randomId } from "../../platform/crypto.js";
import {
  ADMIN_API_SCOPES,
  MAX_ADMIN_API_TOKENS,
  MAX_TOKEN_DAYS,
  apiTokenView,
  countLiveApiTokens,
  getApiToken,
  insertApiToken,
  isAdminApiScope,
  listApiTokens,
  revokeApiToken,
  type AdminApiScope,
  type AdminApiTokenRow,
} from "../apiTokens.js";
import type { AdminCtx } from "../routes.js";

/** `GET /tokens`. */
export async function handleApiTokenList(c: AdminCtx): Promise<Response> {
  const rows = await listApiTokens(c.db);
  return adminJson({ tokens: rows.map((row) => apiTokenView(row, c.now)) });
}

/** `POST /tokens`: `{label, expiresInDays, scopes?}`. */
export async function handleApiTokenMint(c: AdminCtx): Promise<Response> {
  const body = await readBody(c.req);
  const fields: string[] = [];

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 200) fields.push("label");

  // Mandatory, and bounded at both ends. There is no default: a machine credential's lifetime is
  // the one decision the person minting it has to make consciously, and a form field that
  // defaults to something is not that decision.
  const days =
    typeof body.expiresInDays === "number" ? body.expiresInDays : NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS)
    fields.push("expiresInDays");

  // Omitted means every scope this build knows about, which is one. Stated explicitly so a future
  // second scope does not silently widen tokens that an older console minted.
  const requested =
    body.scopes === undefined ? [...ADMIN_API_SCOPES] : body.scopes;
  if (
    !Array.isArray(requested) ||
    requested.length === 0 ||
    !requested.every(isAdminApiScope)
  )
    fields.push("scopes");

  if (fields.length > 0)
    return err(422, ErrorCode.BadRequest, "invalid token request", { fields });

  if ((await countLiveApiTokens(c.db, c.now)) >= MAX_ADMIN_API_TOKENS)
    return err(
      409,
      ErrorCode.BadRequest,
      `at most ${MAX_ADMIN_API_TOKENS} live admin API tokens; revoke one first`,
    );

  const scopes = [...new Set(requested as AdminApiScope[])].sort();
  const secret = mintAdminApiToken();
  const row: AdminApiTokenRow = {
    id: randomId("apitok"),
    token_hash: await hashKey(secret, c.env.KEY_HASH_PEPPER),
    label,
    scopes_json: JSON.stringify(scopes),
    created_at: c.now,
    expires_at: c.now + days * SECONDS_PER_DAY,
    last_used_at: null,
    revoked_at: null,
  };
  await insertApiToken(c.db, row);
  const view = apiTokenView(row, c.now);
  await platformAudit(
    c.db,
    c.session,
    c.now,
    "api_token.create",
    { kind: "api_token", id: row.id },
    `Minted admin API token ${label} (${row.id}) for ${scopes.join(", ")}, valid ${days} days`,
    { after: view },
  );
  // The ONLY response that will ever carry the plaintext. `GET /tokens` cannot reproduce it
  // (nothing stored can), which is what makes "shown once" a fact about the system rather than a
  // convention the console happens to follow.
  return adminJson({ ok: true, token: view, secret }, 201);
}

/** `DELETE /tokens/<id>`. */
export async function handleApiTokenRevoke(c: AdminCtx): Promise<Response> {
  const id = c.params.id ?? "";
  const row = await getApiToken(c.db, id);
  if (!row) return notFound();
  if ((await revokeApiToken(c.db, id, c.now)) === 0)
    return err(409, ErrorCode.BadRequest, "token is already revoked", { id });
  const before = apiTokenView(row, c.now);
  const after = apiTokenView({ ...row, revoked_at: c.now }, c.now);
  await platformAudit(
    c.db,
    c.session,
    c.now,
    "api_token.revoke",
    { kind: "api_token", id },
    `Revoked admin API token ${row.label} (${id})`,
    { before, after },
  );
  return adminJson({ ok: true, token: after });
}
