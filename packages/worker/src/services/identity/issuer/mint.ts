/**
 * The issuer's tokens for one person and one client (I-21.9, I-21.10; V5 §12.13.5). Shared by the
 * code grant and the refresh grant, so the two cannot differ on what a token carries.
 *
 * RS256 under the product's issuer key (`signIssuerJwt`: `kid` and `typ` set there, `alg` pinned),
 * 600 s. The claims are only what the person granted: the caller passes the granted claims, the
 * account supplies the values (read now), and `pkey:entitlements` comes from
 * `resolveSubjectEntitlements` when that scope was granted. `nonce` is the code grant's alone.
 */

import {
  ACCESS_TOKEN_TYP,
  type IssuerTokenResponse,
  ID_TOKEN_TYP,
  ISSUER_TOKEN_TTL_SECONDS,
} from "@polaris-key/protocol/identity";
import { customerOrigin } from "../../../core/hosts.js";
import { resolveSubjectEntitlements } from "../../../core/licensing/subjectEntitlements.js";
import type { Db } from "../../../db/types.js";
import { b64urlEncode } from "../../../platform/bytes.js";
import type { Env } from "../../../platform/env.js";
import { sha256 } from "../../../platform/hash.js";
import { randomToken } from "../../../platform/random.js";
import type { AccountRow } from "../accounts/repo.js";
import { avatarUrl } from "../card/avatars.js";
import { signIssuerJwt } from "./keys.js";

/** `at_hash` (OIDC Core §3.1.3.6): the left half of SHA-256 of the access token, base64url. */
async function atHash(accessToken: string): Promise<string> {
  return b64urlEncode((await sha256(accessToken)).slice(0, 16));
}

/** The claims of a profile read now: only the granted ones, absent (never `null`) when empty. */
export function profileClaims(
  env: Env,
  req: Request,
  account: Pick<
    AccountRow,
    | "display_name"
    | "avatar_key"
    | "primary_email"
    | "primary_email_verified_at"
  >,
  granted: ReadonlySet<string>,
): Record<string, string | boolean> {
  const origin = customerOrigin(env, req) ?? new URL(req.url).origin;
  const picture = granted.has("picture") ? avatarUrl(account.avatar_key) : null;
  return {
    ...(granted.has("name") && account.display_name
      ? { name: account.display_name }
      : {}),
    ...(picture ? { picture: `${origin}${picture}` } : {}),
    ...(granted.has("email") && account.primary_email
      ? {
          email: account.primary_email,
          // True only for an address Polaris Key verified itself (IS-10).
          email_verified: account.primary_email_verified_at !== null,
        }
      : {}),
  };
}

export async function mintIssuerTokens(
  cx: { req: Request; env: Env; db: Db; slug: string; now: number },
  who: {
    clientId: string;
    account: AccountRow;
    subject: string;
    scope: readonly string[];
    claims: readonly string[];
    authTime: number;
    nonce: string | null;
  },
): Promise<{ accessToken: string; idToken: string }> {
  const { req, env, db, slug, now } = cx;
  const issuer = `${new URL(req.url).origin}/${slug}/identity`;
  const entitlements = who.scope.includes("pkey:entitlements")
    ? await resolveSubjectEntitlements(db, slug, who.subject, now)
    : null;
  const base = {
    iss: issuer,
    sub: who.subject,
    iat: now,
    exp: now + ISSUER_TOKEN_TTL_SECONDS,
    auth_time: who.authTime,
    ...(entitlements ? { "pkey:entitlements": entitlements } : {}),
  };
  const accessToken = await signIssuerJwt(
    env,
    db,
    slug,
    ACCESS_TOKEN_TYP,
    {
      ...base,
      aud: issuer,
      client_id: who.clientId,
      jti: randomToken(16),
      scope: who.scope.join(" "),
    },
    now,
  );
  const idToken = await signIssuerJwt(
    env,
    db,
    slug,
    ID_TOKEN_TYP,
    {
      ...base,
      aud: who.clientId,
      azp: who.clientId,
      ...(who.nonce ? { nonce: who.nonce } : {}),
      at_hash: await atHash(accessToken),
      ...profileClaims(env, req, who.account, new Set(who.claims)),
    },
    now,
  );
  return { accessToken, idToken };
}

/** The `200` of §12.13.4 rule 4: exactly these members, never cached. */
export function tokenResponse(
  accessToken: string,
  idToken: string,
  scope: readonly string[],
  refreshToken?: string,
): Response {
  const body: IssuerTokenResponse = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ISSUER_TOKEN_TTL_SECONDS,
    scope: scope.join(" "),
    id_token: idToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}
