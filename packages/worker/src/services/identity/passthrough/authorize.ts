/// <reference types="@cloudflare/workers-types" />

/**
 * `GET /<p>/identity/authorize` (WIRE-CONTRACT-V4 §12.4; plans/I-27.md §2.1, plans/I-08.md §3).
 *
 * The OAuth-shaped front door of an app's sign-in. The issuer is `<origin>/<p>/identity`, the
 * client is the product's own public client (`client_id` is the product slug, PKCE S256
 * mandatory) and the person is sent to the login card, never asked for a credential here.
 *
 * ── THE ORDER OF REFUSALS ───────────────────────────────────────────────────────────────────
 *
 *   1. `client_id` and `redirect_uri` first. Until BOTH are valid nothing redirects: a bad one
 *      renders `invalid_client` or `redirect_uri_mismatch` on a branded page. A redirect to an
 *      unvalidated URI is an open redirect, so no other check may run ahead of these two.
 *   2. Every later error is `302 <redirect_uri>?error=…&state=…&iss=<issuer>` (RFC 6749 §4.1.2.1,
 *      RFC 9207), with `invalid_request` or `invalid_scope`. The code and the app's `state`
 *      are never in any other response.
 *   3. Success stores the validated request under a browser-bound handle (`request.ts`) and
 *      `303`s to the card at `<origin>/signin?request=rq_…`. The card, not this route, asks the
 *      person (Continue, Cancel); the code is delivered by the response to Continue.
 *
 * ── WHAT IS NOT TRUSTED ─────────────────────────────────────────────────────────────────────
 *
 * `login_hint` and `name_hint` prefill the card and verify nothing; a malformed hint is dropped,
 * never an error. `scope` values this platform does not know are ignored, and `openid` is
 * refused until I-21 so no relying party mistakes layer 1 for OIDC. `nonce` is kept for I-21.
 */

import {
  AUTHORIZE_SCOPES,
  AUTHORIZE_STATE_MAX,
  AUTHORIZE_STATE_MIN,
  type AuthorizeRedirectError,
} from "@polaris-key/protocol/identity";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { appSecurityHeaders } from "../../../core/securityHeaders.js";
import { ErrorCode, methodNotAllowed } from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { strictEmail } from "../../../core/strictEmail.js";
import { cardPage } from "../card/http.js";
import { cloudSyncOn } from "./client.js";
import { createSignInRequest, type AuthzRecord } from "./request.js";
import { redirectPathsOf, validateRedirectUri } from "./redirectUri.js";

/** `authorize` is a navigation that writes one record: 60 a minute per client network. */
export const AUTHORIZE_RATE = {
  bucket: "identityAuthorize",
  limit: 60,
  windowSec: 60,
};

/** The longest `nonce` kept (RFC 9207 / OIDC practice; I-21 reads it). */
export const NONCE_MAX_LENGTH = 255;

/** S256 of a verifier is 32 bytes: always 43 base64url characters. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** The issuer of the product's authorization server (RFC 8414 / RFC 9207). */
export function issuerOf(req: Request, product: { slug: string }): string {
  return `${new URL(req.url).origin}/${product.slug}/identity`;
}

/** `302 <redirect_uri>?error=…&state=…&iss=…` (RFC 6749 §4.1.2.1 with RFC 9207's `iss`). */
function errorRedirect(
  redirectUri: string,
  issuer: string,
  error: AuthorizeRedirectError,
  state: string | null,
): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state !== null) target.searchParams.set("state", state);
  target.searchParams.set("iss", issuer);
  return redirect(302, target.toString());
}

/** A redirect with the app security headers; never cached. */
export function redirect(status: 302 | 303, location: string): Response {
  const headers = appSecurityHeaders(
    new Headers({
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }),
  );
  return new Response(null, { status, headers });
}

/** The refusal pages. Terse, no developer jargon, and no way forward but "close this page". */
function invalidClientPage(): Response {
  return cardPage(401, {
    title: "App not recognised",
    heading: "App not recognised",
    body: "<p>This app isn't set up to sign people in. Contact its developer.</p>",
  });
}

function redirectMismatchPage(): Response {
  return cardPage(400, {
    title: "Return address not allowed",
    heading: "Return address not allowed",
    body: "<p>This app's return address isn't registered, so we didn't send you back. Contact its developer.</p>",
  });
}

/** The single value of a parameter; `undefined` when absent and `null` when repeated. */
function single(
  params: URLSearchParams,
  name: string,
): string | undefined | null {
  const all = params.getAll(name);
  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0]! : null;
}

/**
 * The scope a request resolves to: the intersection of what it asked for and what the product
 * grants (`profile`, `email`, and `cloudSync` while the product runs Cloud Sync). `null` is
 * `invalid_scope`: `openid`, or a request that names nothing the product grants.
 */
export function resolveScope(
  raw: string | undefined,
  product: Product,
): string[] | null {
  const offered = AUTHORIZE_SCOPES.filter((s) =>
    s === "cloudSync" ? cloudSyncOn(product) : true,
  );
  if (raw === undefined) return [...offered];
  const asked = raw.split(" ").filter((t) => t !== "");
  if (asked.includes("openid")) return null;
  const granted = offered.filter((s) => asked.includes(s));
  return granted.length > 0 ? [...granted] : null;
}

export async function handleAuthorize(ctx: {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
  settings?: SettingsRegistry;
}): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "GET") return methodNotAllowed();
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...AUTHORIZE_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return cardPage(429, {
      title: "Too many attempts",
      heading: "Too many attempts",
      body: "<p>Wait a minute, then try again.</p>",
    });

  const params = new URL(req.url).searchParams;

  // 1. The two values a redirect depends on. Nothing redirects until both are valid.
  const clientId = single(params, "client_id");
  if (clientId !== product.slug) return invalidClientPage();
  const verdict = validateRedirectUri(
    {
      webOrigins: product.webOrigins,
      redirectPaths: await redirectPathsOf(
        { env, db, ...(ctx.settings ? { registry: ctx.settings } : {}) },
        product.slug,
      ),
    },
    single(params, "redirect_uri") ?? undefined,
  );
  if (!verdict.ok) return redirectMismatchPage();

  // 2. Everything else answers in the redirect.
  const issuer = issuerOf(req, product);
  const stateRaw = single(params, "state");
  const echoState =
    typeof stateRaw === "string" && stateRaw.length <= AUTHORIZE_STATE_MAX
      ? stateRaw
      : null;
  const fail = (error: AuthorizeRedirectError): Response =>
    errorRedirect(verdict.uri, issuer, error, echoState);

  if (single(params, "response_type") !== "code")
    return fail(ErrorCode.InvalidRequest);
  if (
    typeof stateRaw !== "string" ||
    stateRaw.length < AUTHORIZE_STATE_MIN ||
    stateRaw.length > AUTHORIZE_STATE_MAX
  )
    return fail(ErrorCode.InvalidRequest);
  const challenge = single(params, "code_challenge");
  if (typeof challenge !== "string" || !CHALLENGE_RE.test(challenge))
    return fail(ErrorCode.InvalidRequest);
  // S256 only: `plain` and an absent method are refused, never defaulted.
  if (single(params, "code_challenge_method") !== "S256")
    return fail(ErrorCode.InvalidRequest);
  // `request_uri` is I-15's; until it ships it is not a parameter this endpoint reads.
  if (params.has("request_uri")) return fail(ErrorCode.InvalidRequest);

  const scopeRaw = single(params, "scope");
  if (scopeRaw === null) return fail(ErrorCode.InvalidRequest);
  const scope = resolveScope(scopeRaw, product);
  if (!scope) return fail(ErrorCode.InvalidScope);

  const nonce = single(params, "nonce");
  if (
    nonce === null ||
    (nonce !== undefined && nonce.length > NONCE_MAX_LENGTH)
  )
    return fail(ErrorCode.InvalidRequest);
  const purpose = single(params, "purpose");
  if (purpose !== undefined && purpose !== "signin" && purpose !== "attach")
    return fail(ErrorCode.InvalidRequest);
  const choice = single(params, "license_choice");
  if (choice !== undefined && choice !== "card" && choice !== "app")
    return fail(ErrorCode.InvalidRequest);
  const loginHint = single(params, "login_hint");
  const nameHint = single(params, "name_hint");
  if (loginHint === null || nameHint === null)
    return fail(ErrorCode.InvalidRequest);

  const authz: AuthzRecord = {
    clientId: product.slug,
    redirectUri: verdict.uri,
    state: stateRaw,
    codeChallenge: challenge,
    scope,
    nonce: nonce ?? null,
    licenseChoice: choice ?? "card",
    purpose: purpose ?? "signin",
    // Hints prefill and verify nothing: a hint that does not normalise is dropped.
    loginHint: strictEmail(loginHint),
    nameHint: normalizeDeviceLabel(nameHint),
  };

  let created: { handle: string; setCookie: string | null };
  try {
    created = await createSignInRequest(
      env,
      req,
      {
        product: product.slug,
        kind: verdict.kind,
        origin: new URL(verdict.uri).origin,
        flowRef: "authorize",
        authz,
      },
      now,
    );
  } catch {
    return fail("server_error");
  }
  const res = redirect(
    303,
    `${new URL(req.url).origin}/signin?request=${created.handle}`,
  );
  if (created.setCookie) res.headers.append("set-cookie", created.setCookie);
  return res;
}
