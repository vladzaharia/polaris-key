/**
 * `POST /<p>/identity/token` for a registered client (I-21.9; V5 §12.13.4; threats IS-4, IS-6,
 * IS-12). Called by `passthrough/token.ts` when the request names a `cl_` client, in its header or
 * its body. The own client's grants never get here, and this never reads `X-PKey-Device`.
 *
 * ── CLIENT AUTHENTICATION (§12.13.2) ────────────────────────────────────────────────────────
 *
 * A `web` client sends exactly one of `client_secret_basic` and `client_secret_post`; both, neither,
 * a wrong or revoked secret, or a `client_id` that differs between the header and the body is `401
 * invalid_client` (`WWW-Authenticate: Basic` after a `Basic` attempt). A `spa` or `native` client
 * sends `client_id` in the body and no secret anywhere. A secret is hashed and compared against every
 * live secret in constant time whether or not the client exists, so an unknown client, a client with
 * no secret and a wrong secret cost the same (`verifyClientSecret`). Authentication happens BEFORE
 * the code is touched: a stranger cannot burn a code, and a `web` client's nonce-only code still
 * needs its secret.
 *
 * ── THE CODE ────────────────────────────────────────────────────────────────────────────────
 *
 * Redeemed with one atomic consume against a proof: the hash of the challenge the verifier derives,
 * or, when no `code_verifier` was sent, the fixed no-challenge proof. A code issued with a challenge
 * therefore refuses a missing verifier, a code issued without one refuses any verifier, and either
 * mismatch ends the code. The fixed string can never be the SHA-256 of a verifier and a verifier
 * that is not 43 to 128 unreserved characters never reaches the store, so presenting the string
 * itself as a verifier is `invalid_grant` too. Then the client and the `redirect_uri` (exact,
 * constant time) are compared with what the code was issued for, and the account, its subject, the
 * client and its grant are re-checked: the code is 60 s old at most.
 *
 * ── THE TOKENS ──────────────────────────────────────────────────────────────────────────────
 *
 * RS256 under the product's issuer key (`signIssuerJwt`: `kid` and `typ` set there, `alg` pinned),
 * 600 s. Claims are only what the person granted: the code carries them, the account supplies the
 * values, `pkey:entitlements` comes from `resolveSubjectEntitlements`. A refresh token only with
 * `offline_access`. Every answer is `no-store`.
 *
 * `refresh_token` is `refresh.ts`'s. A code presented again after its redemption revokes the family it
 * opened (`familyOfCode`; RFC 6749 §4.1.2, IS-4). A code issued without a challenge is redeemed by a
 * `web` client alone, so a public client cannot downgrade itself to it.
 */

import {
  RESTORE_GRANT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from "@polaris-key/protocol/identity";
import { appendAudit } from "../../../core/audit.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import {
  accountForSubject,
  resolveSubject,
} from "../../../core/accounts/accountSubjects.js";
import { ErrorCode } from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import type { Db } from "../../../db/types.js";
import { sha256B64url } from "../../../platform/hash.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import { randomId } from "../../../platform/crypto.js";
import { getAccountRow } from "../accounts/repo.js";
import {
  NO_CHALLENGE_PROOF,
  redeemAuthorizationCode,
} from "../passthrough/code.js";
import { oauth } from "../passthrough/oauthHttp.js";
import {
  authenticate,
  clientCorsOrigins,
  CONFIDENTIAL_TOKEN_RATE,
  PUBLIC_TOKEN_RATE,
  scopedCors,
  type IssuerTokenCx,
} from "./clientAuth.js";
import { listClients } from "./clientsRepo.js";
import { getClientGrant, touchClientGrant } from "./grantsRepo.js";
import { mintIssuerTokens, tokenResponse } from "./mint.js";
import { handleRefreshGrant } from "./refresh.js";
import {
  familyOfCode,
  hashAuthCode,
  issueRefreshFamily,
  revokeRefreshFamily,
} from "./refreshRepo.js";
import { stillRegistered } from "./registration.js";
import { issuerServed } from "./served.js";

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export async function handleIssuerToken(cx: IssuerTokenCx): Promise<Response> {
  const { req, env, db, slug, now, form } = cx;
  const auth = await authenticate(cx);
  if (!auth.ok) return scopedCors(auth.response, null);
  const { client } = auth;
  const out = (res: Response): Response => scopedCors(res, client);
  const budget =
    client.type === "web"
      ? { ...CONFIDENTIAL_TOKEN_RATE, id: client.clientId }
      : {
          ...PUBLIC_TOKEN_RATE,
          id: `${client.clientId}:${clientNetwork(req)}`,
        };
  if (!(await rateLimitOk(env, slug, budget, now)))
    return out(
      oauth(429, "rate_limited", undefined, { retryAfter: budget.windowSec }),
    );

  const grant = form.get("grant_type");
  if (!grant)
    return out(oauth(400, ErrorCode.InvalidRequest, "grant_type is required."));
  // The token-exchange and restore grants are the own client's alone (§12.13.4 rule 3).
  if (grant === TOKEN_EXCHANGE_GRANT_TYPE || grant === RESTORE_GRANT_TYPE)
    return out(oauth(400, ErrorCode.UnauthorizedClient));
  if (grant === "refresh_token")
    return out(await handleRefreshGrant(cx, client));
  if (grant !== "authorization_code")
    return out(oauth(400, ErrorCode.UnsupportedGrantType));

  const code = form.get("code");
  const redirectUri = form.get("redirect_uri");
  const verifier = form.get("code_verifier");
  if (!code || !redirectUri)
    return out(
      oauth(
        400,
        ErrorCode.InvalidRequest,
        "code and redirect_uri are required.",
      ),
    );
  // A malformed code or verifier cannot be a real one: refused without touching the store.
  if (
    !CODE_RE.test(code) ||
    (verifier !== undefined && !VERIFIER_RE.test(verifier))
  )
    return out(oauth(400, ErrorCode.InvalidGrant));
  // A code with no challenge is a confidential client's: a public one must prove possession.
  if (verifier === undefined && client.type !== "web")
    return out(oauth(400, ErrorCode.InvalidGrant));

  const record = await redeemAuthorizationCode(
    env,
    slug,
    code,
    verifier === undefined ? NO_CHALLENGE_PROOF : await sha256B64url(verifier),
  );
  if (!record || !record.registered) {
    // A code that opened a family and is presented again: the family is revoked (IS-4).
    const opened = await familyOfCode(env, db, slug, client.clientId, code);
    if (opened) {
      await revokeRefreshFamily(db, slug, opened, now);
      await appendAudit(db, {
        product: slug,
        id: randomId("aud"),
        at: now,
        actor_sub: null,
        actor_name: null,
        actor_email: null,
        action: "identity.refresh.code_reuse",
        target_kind: "client",
        target_id: client.clientId,
        parent_id: null,
        summary:
          "An authorization code was presented again; its refresh family was revoked",
      });
    }
    return out(oauth(400, ErrorCode.InvalidGrant));
  }
  const claims = record.registered;
  if (record.clientId !== client.clientId)
    return out(oauth(400, ErrorCode.InvalidGrant));
  if (!constantTimeEqual(redirectUri, record.redirectUri))
    return out(oauth(400, ErrorCode.InvalidGrant));
  // The developer may have edited the client since Continue.
  if (!stillRegistered(client, record.redirectUri, record.scope))
    return out(oauth(400, ErrorCode.InvalidGrant));

  // The code is 60 s old at most: the person, the client and the grant may not be what they were.
  const subject = await resolveSubject(db, slug, record.subject);
  const accountId = subject ? await accountForSubject(db, slug, subject) : null;
  const account = accountId ? await getAccountRow(db, accountId) : null;
  if (
    !subject ||
    !account ||
    account.status !== "active" ||
    account.id !== record.accountId ||
    (await erasureVerdict(env, now, account.id)) !== "clear"
  )
    return out(oauth(400, ErrorCode.InvalidGrant));
  if (!(await getClientGrant(db, slug, account.id, client.clientId)))
    return out(oauth(400, ErrorCode.InvalidGrant));

  const { accessToken, idToken } = await mintIssuerTokens(cx, {
    clientId: client.clientId,
    account,
    subject,
    scope: record.scope,
    claims: claims.claims,
    authTime: claims.authTime,
    nonce: record.nonce,
  });
  const refresh = record.scope.includes("offline_access")
    ? await issueRefreshFamily(
        env,
        db,
        {
          product: slug,
          clientId: client.clientId,
          accountId: account.id,
          scope: record.scope.join(" "),
          claims: claims.claims,
          authTime: claims.authTime,
          redirectUri: record.redirectUri,
          codeHash: await hashAuthCode(env, code),
        },
        now,
      )
    : null;
  await touchClientGrant(db, slug, account.id, client.clientId, now);
  await appendAudit(db, {
    product: slug,
    id: randomId("aud"),
    at: now,
    actor_sub: subject,
    actor_name: null,
    actor_email: null,
    action: "identity.client.token",
    target_kind: "client",
    target_id: client.clientId,
    parent_id: null,
    summary: `Tokens issued to a registered client (${refresh ? "with" : "without"} a refresh token)`,
  });
  return out(tokenResponse(accessToken, idToken, record.scope, refresh?.token));
}

/**
 * The origins a preflight to the issuer's `token` allows beyond the product's `web.origins`: those
 * its active `spa` clients' redirect URIs are on (§12.13.4). A preflight carries no client, so this is
 * the union; the answer itself is scoped to one client (`clientCorsOrigins`). Empty while the issuer
 * is off, so a product that never turned it on has no extra origin.
 */
export async function issuerPreflightOrigins(
  db: Db,
  slug: string,
): Promise<string[]> {
  if (!(await issuerServed(db, slug))) return [];
  const out = new Set<string>();
  for (const client of await listClients(db, slug))
    if (client.status === "active")
      for (const o of clientCorsOrigins(client).split(" "))
        if (o !== "") out.add(o);
  return [...out];
}
