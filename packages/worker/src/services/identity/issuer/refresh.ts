/**
 * The `refresh_token` grant of a registered client (I-21.10; V5 §12.13.4 rule 2, §12.13.7; IS-5).
 *
 * A refresh token is opaque and stored only as a peppered hash. Every use rotates it: the presented
 * token is spent and a new one joins its family. A spent token presented again revokes the whole
 * family with no grace (audit `identity.refresh.reuse`). A token ends 30 days after its last use and
 * a family 90 days after it opened.
 *
 * Another client's token is `unauthorized_client` and nothing is revoked, so a client cannot burn a
 * stranger's family. Before a LIVE token is spent, everything it depends on is checked again, and a
 * failure is `invalid_grant` that spends nothing: the client is active and the issuer on (the
 * authentication above), the redirect URI and the scopes the family was issued for are still
 * registered, the account and its subject are live, and the client grant still exists and still
 * COVERS the scope (a person who changed or removed it changes what the next token carries). The new
 * tokens carry the same `sub`, `aud`, `azp` and `auth_time`, no `nonce`, and only the claims the grant
 * holds now. `scope` may narrow, never widen, and keeps `openid`.
 */

import {
  ISSUER_REFRESH_TOKEN_PATTERN,
  type IssuerClaim,
} from "@polaris-key/protocol/identity";
import { appendAudit } from "../../../core/audit.js";
import { existingSubjectFor } from "../../../core/accounts/accountSubjects.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import { ErrorCode } from "../../../core/errors.js";
import { randomId } from "../../../platform/crypto.js";
import { getAccountRow } from "../accounts/repo.js";
import { oauth } from "../passthrough/oauthHttp.js";
import type { IssuerTokenCx } from "./clientAuth.js";
import type { ClientRecord } from "./clientsRepo.js";
import { claimsForCode, grantCovers } from "./coverage.js";
import { getClientGrant, touchClientGrant } from "./grantsRepo.js";
import { mintIssuerTokens, tokenResponse } from "./mint.js";
import {
  findRefreshToken,
  refreshEnded,
  rotateRefreshToken,
} from "./refreshRepo.js";
import { stillRegistered } from "./registration.js";

const TOKEN_RE = new RegExp(ISSUER_REFRESH_TOKEN_PATTERN);

const words = (s: string): string[] => s.split(" ").filter((t) => t !== "");

export async function handleRefreshGrant(
  cx: IssuerTokenCx,
  client: ClientRecord,
): Promise<Response> {
  const { env, db, slug, now, form } = cx;
  const token = form.get("refresh_token");
  if (!token)
    return oauth(400, ErrorCode.InvalidRequest, "refresh_token is required.");
  if (!TOKEN_RE.test(token)) return oauth(400, ErrorCode.InvalidGrant);
  const row = await findRefreshToken(env, db, slug, token);
  if (!row) return oauth(400, ErrorCode.InvalidGrant);
  // Another client's token: refused, and nothing is revoked or spent.
  if (row.clientId !== client.clientId)
    return oauth(400, ErrorCode.UnauthorizedClient);

  // `scope` may narrow the granted scope and must keep `openid`; absent keeps it.
  const granted = words(row.scope);
  const asked = form.get("scope");
  const scope = asked === undefined ? granted : words(asked);
  if (!scope.includes("openid") || !scope.every((s) => granted.includes(s)))
    return oauth(400, ErrorCode.InvalidScope);

  let claims: IssuerClaim[] = [];
  let live: {
    subject: string;
    account: NonNullable<Awaited<ReturnType<typeof getAccountRow>>>;
  } | null = null;
  const usable =
    row.revokedAt === null && row.spentAt === null && !refreshEnded(row, now);
  if (usable) {
    // Everything this token depends on, checked before it is spent. A failure spends nothing.
    const account = await getAccountRow(db, row.accountId);
    const subject = account
      ? await existingSubjectFor(db, row.accountId, slug)
      : null;
    const grant = await getClientGrant(
      db,
      slug,
      row.accountId,
      client.clientId,
    );
    if (
      !stillRegistered(client, row.redirectUri, granted) ||
      !account ||
      account.status !== "active" ||
      !subject ||
      (await erasureVerdict(env, now, account.id)) !== "clear" ||
      !grant ||
      !grantCovers(grant, scope, client.claims.required)
    )
      return oauth(400, ErrorCode.InvalidGrant);
    claims = claimsForCode(grant, scope);
    live = { subject, account };
  }

  const rotated = await rotateRefreshToken(
    env,
    db,
    { product: slug, clientId: client.clientId, token, scope: scope.join(" ") },
    now,
  );
  if (!rotated.ok) {
    if (rotated.reason === "reuse")
      await appendAudit(db, {
        product: slug,
        id: randomId("aud"),
        at: now,
        actor_sub: null,
        actor_name: null,
        actor_email: null,
        action: "identity.refresh.reuse",
        target_kind: "client",
        target_id: client.clientId,
        parent_id: null,
        summary:
          "A spent refresh token was presented again; its family was revoked",
      });
    return oauth(
      400,
      rotated.reason === "wrong_client"
        ? ErrorCode.UnauthorizedClient
        : ErrorCode.InvalidGrant,
    );
  }
  // A token that was not live when checked cannot have been rotated, so `live` is set here.
  if (!live) return oauth(400, ErrorCode.InvalidGrant);
  const { accessToken, idToken } = await mintIssuerTokens(cx, {
    clientId: client.clientId,
    account: live.account,
    subject: live.subject,
    scope,
    claims,
    authTime: rotated.row.authTime,
    nonce: null,
  });
  await touchClientGrant(db, slug, row.accountId, client.clientId, now);
  return tokenResponse(accessToken, idToken, scope, rotated.token);
}
