/**
 * Account → Packages: the person's own `pkeyp_` tokens (F-33, plans/I-27.md §2.5).
 *
 *   GET    /api/me/tokens            the account's tokens (newest first, revoked and expired
 *                                    included until purged), the limits and the registry origin
 *   POST   /api/me/tokens            {label, scope?, expiresInDays?} mint one; the plaintext is in
 *                                    this answer only
 *   DELETE /api/me/tokens/:tokenId   revoke one of the account's own
 *
 * The store is Core's (`core/accounts/personalTokens.ts`). A token is the person's, not a
 * licence's: it reads every package the account may read, which the registry host works out per
 * request, so nothing here names a product. Minting needs the session, the CSRF header (the
 * router checks it for every mutation), the fresh-sign-in gate and the `portalPersonalToken`
 * budget (per account, fail closed). The portal mints `packages:read` only: the `admin` scope is
 * `pkey login`'s, through the device login (ST-34). Audited `portal.personal_token.create` and
 * `.revoke` in `portal_audit`, with the label and hint, never the token.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { ErrorCode } from "../../../core/errors.js";
import { registryOrigin } from "../../../core/hosts.js";
import {
  MAX_LIVE_PERSONAL_TOKENS,
  PACKAGES_READ_SCOPE,
  PERSONAL_TOKEN_DAYS,
  PERSONAL_TOKEN_LABEL_MAX,
  PERSONAL_TOKEN_MIN_DAYS,
  listAccountTokens,
  mintAccountToken,
  revokeAccountToken,
} from "../../../core/accounts/personalTokens.js";
import { forgetRegistryTokens } from "../../../core/registry/registryTokens.js";
import { REGISTRY_TOKEN_USERNAME } from "../../../core/registry/registryVocabulary.js";
import {
  err,
  notFound,
  portalJson,
  readBody,
  requireActionRateLimit,
} from "./api.js";
import { portalAudit } from "./repo.js";
import type { PortalSession } from "./session.js";
import { portalStepUpGate } from "./stepUpGate.js";

export async function handlePersonalTokens(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  /** The path after `/api/me/tokens`. */
  rest: string[],
  now: number,
): Promise<Response> {
  const accountId = session.accountId;
  if (rest.length > 1) return notFound();
  if (rest.length === 1) {
    if (req.method !== "DELETE") return err(405, "method_not_allowed");
    const view = await revokeAccountToken(
      db,
      accountId,
      rest[0]!,
      `portal:${accountId}`,
      "manual",
      now,
    );
    if (!view) return notFound();
    // This isolate's 30-second resolution cache; other isolates' entries expire within 30 s.
    forgetRegistryTokens();
    await portalAudit(db, {
      accountId,
      action: "portal.personal_token.revoke",
      targetKind: "account_token",
      targetId: view.id,
      summary: `Revoked personal token “${view.label}” (…${view.hint})`,
      now,
    });
    return portalJson({ ok: true, view });
  }
  if (req.method === "GET")
    return portalJson({
      registryOrigin: registryOrigin(env),
      username: REGISTRY_TOKEN_USERNAME,
      tokens: await listAccountTokens(db, accountId, now),
      limits: {
        minDays: PERSONAL_TOKEN_MIN_DAYS,
        maxDays: PERSONAL_TOKEN_DAYS[PACKAGES_READ_SCOPE].max,
        defaultDays: PERSONAL_TOKEN_DAYS[PACKAGES_READ_SCOPE].default,
        labelMax: PERSONAL_TOKEN_LABEL_MAX,
        perAccount: MAX_LIVE_PERSONAL_TOKENS,
      },
    });
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const stale = portalStepUpGate(session, now);
  if (stale) return stale;
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalPersonalToken",
    now,
    20,
    undefined,
    3600,
  );
  if (limited) return limited;
  const body = await readBody(req);
  // The portal mints `packages:read` and nothing else: an `admin` scope here is refused, not
  // ignored, so a client that asks for more learns it did not get it.
  const scope = body.scope === undefined ? PACKAGES_READ_SCOPE : body.scope;
  if (scope !== PACKAGES_READ_SCOPE)
    return portalJson(
      {
        error: ErrorCode.BadRequest,
        message: "invalid personal token",
        reason: "invalid_token",
        fields: ["scope"],
      },
      422,
    );
  const res = await mintAccountToken(
    env,
    db,
    {
      accountId,
      label: typeof body.label === "string" ? body.label : "",
      scope,
      ...(typeof body.expiresInDays === "number"
        ? { expiresInDays: body.expiresInDays }
        : {}),
      createdBy: `portal:${accountId}`,
    },
    now,
  );
  if (!res.ok)
    return portalJson(
      {
        error: ErrorCode.BadRequest,
        message: res.message,
        reason: res.reason,
        ...(res.fields ? { fields: res.fields } : {}),
      },
      res.status,
    );
  await portalAudit(db, {
    accountId,
    action: "portal.personal_token.create",
    targetKind: "account_token",
    targetId: res.view.id,
    summary: `Created personal token “${res.view.label}” (…${res.view.hint}), ${res.view.scope}`,
    now,
  });
  return portalJson({ ok: true, token: res.token, view: res.view }, 201);
}
