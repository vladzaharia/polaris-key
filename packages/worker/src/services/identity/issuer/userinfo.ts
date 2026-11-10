/**
 * `GET` or `POST <issuer>/userinfo` (I-21.11; V5 §12.13.8; threats IS-6, IS-9). A holder of an
 * access token reads the claims the person granted, LIVE: the answer is the account's profile now,
 * limited to the granted claims the token's scope reaches, never the token's own copy.
 *
 * The token is a bearer `at+jwt` in `Authorization: Bearer` or, on a `POST`, an `access_token` form
 * member (not both). It is verified as §12.13.5 says: `alg` exactly RS256, the key chosen by `kid`
 * from THIS product's key set alone, `typ` `at+jwt` (an `id_token`, a `pkeyt_` device token and every
 * other string are refused), `iss` and `aud` this issuer, `exp` not passed (no skew), and `openid` in
 * the scope. Then the client must still be active, the issuer on, the person's account and subject
 * live, and their client grant still exist and cover the scope: Disconnect makes the very next call
 * fail. Every refusal is one `401` with `WWW-Authenticate: Bearer error="invalid_token"` and says
 * nothing about why. Answers are `no-store`; a `spa` client's origins may read them.
 */

import { compactVerify, createLocalJWKSet, decodeProtectedHeader } from "jose";
import {
  ACCESS_TOKEN_TYP,
  ISSUER_TOKEN_ALG,
  type UserInfoResponse,
} from "@polaris-key/protocol/identity";
import { existingSubjectFor } from "../../../core/accounts/accountSubjects.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import { methodNotAllowed } from "../../../core/errors.js";
import { resolveSubjectEntitlements } from "../../../core/licensing/subjectEntitlements.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { getAccountRow } from "../accounts/repo.js";
import { readForm } from "../passthrough/oauthHttp.js";
import { scopedCors } from "./clientAuth.js";
import { getActiveClient } from "./clientsRepo.js";
import { claimsForCode } from "./coverage.js";
import { getClientGrant } from "./grantsRepo.js";
import { issuerJwks } from "./keys.js";
import { profileClaims } from "./mint.js";
import { stillRegistered } from "./registration.js";
import { issuerServed } from "./served.js";

/** `userinfo`: 120 a minute per client network, failing closed. */
export const USERINFO_RATE = {
  bucket: "identityIssuerUserinfo",
  limit: 120,
  windowSec: 60,
};

/** The longest access token read. */
const MAX_TOKEN_LENGTH = 8192;

const noStore = (res: Response): Response => {
  res.headers.set("cache-control", "no-store");
  res.headers.set("pragma", "no-cache");
  return res;
};

/** A bearer failure (RFC 6750 §3.1). The body is the same whatever was wrong. */
function invalidToken(): Response {
  return noStore(
    new Response(JSON.stringify({ error: "invalid_token" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer error="invalid_token"',
      },
    }),
  );
}

/** The bearer token of a request: `null` when absent, `"invalid"` when two methods or a bad form. */
async function presented(req: Request): Promise<string | null | "invalid"> {
  const header = req.headers.get("authorization");
  const bearer = header ? /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] : null;
  let member: string | undefined;
  if (req.method === "POST" && !bearer) {
    const form = await readForm(req);
    if (form === null) return "invalid";
    member = form.get("access_token");
  }
  if (header && !bearer) return "invalid";
  return bearer ?? member ?? null;
}

export async function handleUserinfo(
  req: Request,
  env: Env,
  db: Db,
  slug: string,
  now: number,
): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  if (!(await issuerServed(db, slug))) return null;
  if (
    !(await rateLimitOk(
      env,
      slug,
      { ...USERINFO_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return noStore(
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      }),
    );
  const token = await presented(req);
  if (token === null)
    return noStore(
      new Response(null, {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      }),
    );
  if (token === "invalid" || token.length > MAX_TOKEN_LENGTH)
    return invalidToken();

  const issuer = `${new URL(req.url).origin}/${slug}/identity`;
  let claims: Record<string, unknown>;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== ISSUER_TOKEN_ALG || header.typ !== ACCESS_TOKEN_TYP)
      return invalidToken();
    const keys = createLocalJWKSet(await issuerJwks(db, slug));
    const { payload } = await compactVerify(token, keys, {
      algorithms: [ISSUER_TOKEN_ALG],
    });
    claims = JSON.parse(new TextDecoder().decode(payload)) as Record<
      string,
      unknown
    >;
  } catch {
    return invalidToken();
  }
  const { iss, aud, exp, sub, client_id: clientId, scope } = claims;
  if (
    iss !== issuer ||
    aud !== issuer ||
    typeof exp !== "number" ||
    exp <= now ||
    typeof sub !== "string" ||
    typeof clientId !== "string" ||
    typeof scope !== "string"
  )
    return invalidToken();
  const scopes = scope.split(" ").filter((s) => s !== "");
  if (!scopes.includes("openid")) return invalidToken();

  const client = await getActiveClient(db, slug, clientId);
  if (!client || !stillRegistered(client, null, scopes)) return invalidToken();
  // The subject names the account for this product; the account and grant must be live now.
  const account = await db.first<{ account_id: string }>(
    "SELECT account_id FROM account_product_subjects WHERE product = ? AND subject = ?",
    slug,
    sub,
  );
  const row = account ? await getAccountRow(db, account.account_id) : null;
  if (
    !row ||
    row.status !== "active" ||
    (await existingSubjectFor(db, row.id, slug)) !== sub ||
    (await erasureVerdict(env, now, row.id)) !== "clear"
  )
    return invalidToken();
  const grant = await getClientGrant(db, slug, row.id, client.clientId);
  if (!grant) return invalidToken();

  const granted = new Set(claimsForCode(grant, scopes));
  const body: UserInfoResponse = {
    sub,
    ...profileClaims(env, req, row, granted),
    // Only while the grant still has that line (a token outlives a narrowed grant).
    ...(scopes.includes("pkey:entitlements") &&
    grant.scopes.includes("pkey:entitlements")
      ? {
          "pkey:entitlements": await resolveSubjectEntitlements(
            db,
            slug,
            sub,
            now,
          ),
        }
      : {}),
  };
  return scopedCors(
    noStore(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
    client,
  );
}
