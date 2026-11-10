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
 * `refresh_token` is I-21.10's: until then it is `unsupported_grant_type`.
 */

import {
  ACCESS_TOKEN_TYP,
  ID_TOKEN_TYP,
  ISSUER_TOKEN_TTL_SECONDS,
  RESTORE_GRANT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  type IssuerTokenResponse,
} from "@polaris-key/protocol/identity";
import { appendAudit } from "../../../core/audit.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import {
  accountForSubject,
  resolveSubject,
} from "../../../core/accounts/accountSubjects.js";
import { CLIENT_CORS_HEADER } from "../../../core/cors.js";
import { customerOrigin } from "../../../core/hosts.js";
import { resolveSubjectEntitlements } from "../../../core/licensing/subjectEntitlements.js";
import { ErrorCode } from "../../../core/errors.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import type { Db } from "../../../db/types.js";
import { sha256, sha256B64url } from "../../../platform/hash.js";
import {
  b64urlEncode,
  base64DecodeEitherAlphabet,
} from "../../../platform/bytes.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import { randomId } from "../../../platform/crypto.js";
import type { Env } from "../../../platform/env.js";
import { randomToken } from "../../../platform/random.js";
import { getAccountRow } from "../accounts/repo.js";
import { avatarUrl } from "../card/avatars.js";
import {
  NO_CHALLENGE_PROOF,
  redeemAuthorizationCode,
} from "../passthrough/code.js";
import { oauth } from "../passthrough/oauthHttp.js";
import {
  getActiveClient,
  listClients,
  verifyClientSecret,
  type ClientRecord,
} from "./clientsRepo.js";
import { getClientGrant, touchClientGrant } from "./grantsRepo.js";
import { issueRefreshFamily } from "./refreshRepo.js";
import { signIssuerJwt } from "./keys.js";
import { issuerServed } from "./served.js";

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** Per client (not per network): a registered client's own budget at `token`, failing closed. */
export const CLIENT_TOKEN_RATE = {
  bucket: "identityIssuerToken",
  limit: 60,
  windowSec: 60,
};

export interface IssuerTokenCx {
  req: Request;
  env: Env;
  db: Db;
  slug: string;
  now: number;
  form: Map<string, string>;
}

/** The `client_id` and secret of an `Authorization: Basic` header, or `null` when it is not one. */
function basicOf(
  req: Request,
): { id: string; secret: string } | "malformed" | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header.trim());
  if (!m) return "malformed";
  try {
    const raw = new TextDecoder().decode(base64DecodeEitherAlphabet(m[1]!));
    const at = raw.indexOf(":");
    if (at < 0) return "malformed";
    // RFC 6749 §2.3.1: both halves are form-urlencoded before they are joined.
    return {
      id: decodeURIComponent(raw.slice(0, at).replace(/\+/g, " ")),
      secret: decodeURIComponent(raw.slice(at + 1).replace(/\+/g, " ")),
    };
  } catch {
    return "malformed";
  }
}

/** The client id this request names (header or body), for the caller's dispatch. */
export function namedClientId(
  req: Request,
  form: Map<string, string>,
): string | null {
  const basic = basicOf(req);
  if (basic && basic !== "malformed") return basic.id;
  return form.get("client_id") ?? null;
}

/** The origins a `spa` client's redirect URIs are on: who may read its token answer. */
export function clientCorsOrigins(client: ClientRecord | null): string {
  if (!client || client.type !== "spa") return "";
  const origins = new Set<string>();
  for (const uri of client.redirectUris)
    if (uri.startsWith("https://")) origins.add(new URL(uri).origin);
  return [...origins].join(" ");
}

/** Mark a response with who may read it cross-origin; the dispatcher turns it into CORS headers. */
function withCors(res: Response, client: ClientRecord | null): Response {
  res.headers.set(CLIENT_CORS_HEADER, clientCorsOrigins(client));
  return res;
}

const invalidClient = (basic: boolean): Response => {
  const res = oauth(401, ErrorCode.InvalidClient);
  if (basic) res.headers.set("www-authenticate", 'Basic realm="polaris-key"');
  return res;
};

type Authed =
  | { ok: true; client: ClientRecord }
  | { ok: false; response: Response };

/** Authenticate the client (§12.13.2). Every failure is the same `401 invalid_client`. */
async function authenticate(cx: IssuerTokenCx): Promise<Authed> {
  const { req, env, db, slug, now, form } = cx;
  const basic = basicOf(req);
  const attempted = basic !== null;
  const fail = (): Authed => ({
    ok: false,
    response: invalidClient(attempted),
  });
  if (basic === "malformed") return fail();
  const bodyId = form.get("client_id");
  const bodySecret = form.get("client_secret");
  const id = basic ? basic.id : bodyId;
  if (!id) return fail();
  // The header and the body must agree when both name a client.
  if (basic && bodyId !== undefined && bodyId !== basic.id) return fail();
  const client = (await issuerServed(db, slug))
    ? await getActiveClient(db, slug, id)
    : null;
  const secret = basic ? basic.secret : bodySecret;
  // Both methods at once is refused whatever they say.
  if (basic && bodySecret !== undefined) return fail();
  if (client?.type === "web") {
    // Exactly one method, and a live secret. Verified (hashed and compared) even when absent, so
    // an unknown client and a wrong secret cost the same.
    const ok = await verifyClientSecret(env, db, slug, id, secret ?? "", now);
    return client && secret !== undefined && ok ? { ok: true, client } : fail();
  }
  // Unknown client: spend the same hash a real one would, then refuse.
  if (!client) {
    await verifyClientSecret(env, db, slug, id, secret ?? "", now);
    return fail();
  }
  // A public client holds no secret: one sent anywhere is refused, so it cannot be mistaken for one.
  if (secret !== undefined || attempted) return fail();
  return { ok: true, client };
}

/** `at_hash` (OIDC Core §3.1.3.6): the left half of SHA-256 of the access token, base64url. */
async function atHash(accessToken: string): Promise<string> {
  return b64urlEncode((await sha256(accessToken)).slice(0, 16));
}

export async function handleIssuerToken(cx: IssuerTokenCx): Promise<Response> {
  const { req, env, db, slug, now, form } = cx;
  const auth = await authenticate(cx);
  if (!auth.ok) return withCors(auth.response, null);
  const { client } = auth;
  const out = (res: Response): Response => withCors(res, client);
  if (
    !(await rateLimitOk(
      env,
      slug,
      { ...CLIENT_TOKEN_RATE, id: client.clientId },
      now,
    ))
  )
    return out(
      oauth(429, "rate_limited", undefined, {
        retryAfter: CLIENT_TOKEN_RATE.windowSec,
      }),
    );

  const grant = form.get("grant_type");
  if (!grant)
    return out(oauth(400, ErrorCode.InvalidRequest, "grant_type is required."));
  // The token-exchange and restore grants are the own client's alone (§12.13.4 rule 3).
  if (grant === TOKEN_EXCHANGE_GRANT_TYPE || grant === RESTORE_GRANT_TYPE)
    return out(oauth(400, ErrorCode.UnauthorizedClient));
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

  const record = await redeemAuthorizationCode(
    env,
    slug,
    code,
    verifier === undefined ? NO_CHALLENGE_PROOF : await sha256B64url(verifier),
  );
  const claims = record?.registered;
  if (!record || !claims) return out(oauth(400, ErrorCode.InvalidGrant));
  if (record.clientId !== client.clientId)
    return out(oauth(400, ErrorCode.InvalidGrant));
  if (!constantTimeEqual(redirectUri, record.redirectUri))
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
  const grantRow = await getClientGrant(db, slug, account.id, client.clientId);
  if (!grantRow) return out(oauth(400, ErrorCode.InvalidGrant));

  const issuer = `${new URL(req.url).origin}/${slug}/identity`;
  const scope = record.scope.join(" ");
  const granted = new Set(claims.claims);
  const entitlements = record.scope.includes("pkey:entitlements")
    ? await resolveSubjectEntitlements(db, slug, subject, now)
    : null;
  const origin = customerOrigin(env, req) ?? new URL(req.url).origin;
  const picture = granted.has("picture") ? avatarUrl(account.avatar_key) : null;
  const profile = {
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
  const base = {
    iss: issuer,
    sub: subject,
    iat: now,
    exp: now + ISSUER_TOKEN_TTL_SECONDS,
  };
  const accessToken = await signIssuerJwt(
    env,
    db,
    slug,
    ACCESS_TOKEN_TYP,
    {
      ...base,
      aud: issuer,
      client_id: client.clientId,
      jti: randomToken(16),
      scope,
      auth_time: claims.authTime,
      ...(entitlements ? { "pkey:entitlements": entitlements } : {}),
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
      aud: client.clientId,
      azp: client.clientId,
      auth_time: claims.authTime,
      ...(record.nonce ? { nonce: record.nonce } : {}),
      at_hash: await atHash(accessToken),
      ...profile,
      ...(entitlements ? { "pkey:entitlements": entitlements } : {}),
    },
    now,
  );
  const refresh = record.scope.includes("offline_access")
    ? await issueRefreshFamily(
        env,
        db,
        {
          product: slug,
          clientId: client.clientId,
          accountId: account.id,
          scope,
          claims: claims.claims,
          authTime: claims.authTime,
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
  const body: IssuerTokenResponse = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ISSUER_TOKEN_TTL_SECONDS,
    scope,
    id_token: idToken,
    ...(refresh ? { refresh_token: refresh.token } : {}),
  };
  return out(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    }),
  );
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
