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
  KEY_RETURN_ALLOW,
  type AuthorizeRedirectError,
  type ClientKind,
} from "@polaris-key/protocol/identity";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { appSecurityHeaders } from "../../../core/securityHeaders.js";
import { readBodyText } from "../../../core/cappedBody.js";
import { ErrorCode, methodNotAllowed } from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { strictEmail } from "../../../core/strictEmail.js";
import { cardPage } from "../card/http.js";
import { appForPage, codeRefusalPage } from "../../../core/brandPage.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import { customerHostname, customerOrigin } from "../../../core/hosts.js";
import { launchGateOn } from "../../../core/settings/platformRead.js";
import { cloudSyncOn } from "./client.js";
import {
  createSignInRequest,
  type AuthzRecord,
  type NativeRequestInfo,
} from "./request.js";
import { readPushed } from "./pushedStore.js";
import { CLIENT_ID_PATTERN } from "@polaris-key/protocol/identity";
import {
  authorizeRegistered,
  registeredErrorRedirect,
} from "../issuer/authorize.js";
import { redirectPathsOf, validateRedirectUri } from "./redirectUri.js";

/** `authorize` is a navigation that writes one record: 60 a minute per client network. */
export const AUTHORIZE_RATE = {
  bucket: "identityAuthorize",
  limit: 60,
  windowSec: 60,
};

/** The longest `nonce` kept (RFC 9207 / OIDC practice; I-21 reads it). */
export const NONCE_MAX_LENGTH = 255;

const CLIENT_ID_RE = new RegExp(CLIENT_ID_PATTERN);

/** S256 of a verifier is 32 bytes: always 43 base64url characters. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** The issuer of the product's authorization server (RFC 8414 / RFC 9207). */
export function issuerOf(req: Request, product: { slug: string }): string {
  return `${new URL(req.url).origin}/${product.slug}/identity`;
}

/** `302 <redirect_uri>?error=…&state=…&iss=…` (RFC 6749 §4.1.2.1 with RFC 9207's `iss`). */
export function errorRedirect(
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

/**
 * The refusal pages: the catalog's copy for the code (`core.codes.*`), the app named above the
 * card, and no way forward but "close this page". Neither says which value was wrong.
 */
export async function refusalPage(
  ctx: { env: Env; db: Db; product: Product; hooks?: ServiceHooks },
  status: 400 | 401,
  code: "invalid_client" | "redirect_uri_mismatch" | "invalid_request_uri",
): Promise<Response> {
  return codeRefusalPage(status, code, await appForPage(ctx));
}

/** The single value of a parameter; `undefined` when absent and `null` when repeated. */
export function single(
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

/** A parameter source: `undefined` when absent, `null` when repeated (see {@link single}). */
export type ParamGet = (name: string) => string | undefined | null;

/**
 * The checks `authorize` and the pushed `request` share once `client_id` and `redirect_uri` are
 * valid (WIRE-CONTRACT-V5 §12.4): `response_type`, `state`, the PKCE challenge, `scope`, `nonce`,
 * `purpose`, `license_choice`, `key_return` and the hints. `error` is what the caller answers.
 */
export async function buildAuthz(
  ctx: { env: Env; db: Db; product: Product },
  get: ParamGet,
  redirectUri: string,
): Promise<
  | { ok: true; authz: AuthzRecord }
  | { ok: false; error: "invalid_request" | "invalid_scope" }
> {
  const { env, db, product } = ctx;
  const fail = (
    error: "invalid_request" | "invalid_scope",
  ): { ok: false; error: "invalid_request" | "invalid_scope" } => ({
    ok: false,
    error,
  });
  if (get("response_type") !== "code") return fail(ErrorCode.InvalidRequest);
  const stateRaw = get("state");
  if (
    typeof stateRaw !== "string" ||
    stateRaw.length < AUTHORIZE_STATE_MIN ||
    stateRaw.length > AUTHORIZE_STATE_MAX
  )
    return fail(ErrorCode.InvalidRequest);
  const challenge = get("code_challenge");
  if (typeof challenge !== "string" || !CHALLENGE_RE.test(challenge))
    return fail(ErrorCode.InvalidRequest);
  // S256 only: `plain` and an absent method are refused, never defaulted.
  if (get("code_challenge_method") !== "S256")
    return fail(ErrorCode.InvalidRequest);

  const scopeRaw = get("scope");
  if (scopeRaw === null) return fail(ErrorCode.InvalidRequest);
  const scope = resolveScope(scopeRaw, product);
  if (!scope) return fail(ErrorCode.InvalidScope);

  const nonce = get("nonce");
  if (
    nonce === null ||
    (nonce !== undefined && nonce.length > NONCE_MAX_LENGTH)
  )
    return fail(ErrorCode.InvalidRequest);
  const purpose = get("purpose");
  if (purpose !== undefined && purpose !== "signin" && purpose !== "attach")
    return fail(ErrorCode.InvalidRequest);
  const choice = get("license_choice");
  if (choice !== undefined && choice !== "card" && choice !== "app")
    return fail(ErrorCode.InvalidRequest);
  // LK-SKIP (§12.4): `allow` is the only value. It is kept only for a sign-in on a product that
  // runs License, with the launch gate on; otherwise it is dropped silently (the card offers nothing).
  const keyReturnRaw = get("key_return");
  if (keyReturnRaw === null) return fail(ErrorCode.InvalidRequest);
  if (keyReturnRaw !== undefined && keyReturnRaw !== KEY_RETURN_ALLOW)
    return fail(ErrorCode.InvalidRequest);
  const keyReturn =
    keyReturnRaw === KEY_RETURN_ALLOW &&
    (purpose ?? "signin") === "signin" &&
    product.services.license.enabled &&
    (await launchGateOn(env, db, "launch.identityKeyReturn"));
  const loginHint = get("login_hint");
  const nameHint = get("name_hint");
  if (loginHint === null || nameHint === null)
    return fail(ErrorCode.InvalidRequest);

  return {
    ok: true,
    authz: {
      clientId: product.slug,
      redirectUri,
      state: stateRaw,
      codeChallenge: challenge,
      scope,
      nonce: nonce ?? null,
      licenseChoice: choice ?? "card",
      purpose: purpose ?? "signin",
      ...(keyReturn ? { keyReturn: true as const } : {}),
      // Hints prefill and verify nothing: a hint that does not normalise is dropped.
      loginHint: strictEmail(loginHint),
      nameHint: normalizeDeviceLabel(nameHint),
    },
  };
}

/** The largest form body `authorize` reads: a request is a few hundred bytes. */
const AUTHORIZE_FORM_CAP = 8 * 1024;

/**
 * The parameters of a form `POST` to `authorize`: `application/x-www-form-urlencoded` only, at most
 * {@link AUTHORIZE_FORM_CAP} bytes. `null` for another content type, an over-long body or an
 * unreadable one.
 */
async function readAuthorizeForm(
  req: Request,
): Promise<URLSearchParams | null> {
  const type = req.headers.get("content-type")?.split(";")[0]?.trim();
  if (type?.toLowerCase() !== "application/x-www-form-urlencoded") return null;
  try {
    return new URLSearchParams(await readBodyText(req, AUTHORIZE_FORM_CAP));
  } catch {
    return null;
  }
}

export async function handleAuthorize(ctx: {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
  settings?: SettingsRegistry;
  hooks?: ServiceHooks;
}): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
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

  // A form `POST` reads its parameters from the body alone (OIDC Core §3.1.2.1): the query string
  // is ignored, so a parameter cannot be smuggled in beside the form.
  let params: URLSearchParams;
  if (req.method === "POST") {
    const form = await readAuthorizeForm(req);
    if (form === null)
      return cardPage(400, {
        title: "Sign-in request not understood",
        heading: "Sign-in request not understood",
        body: "<p>Go back to the app and try again.</p>",
      });
    params = form;
  } else params = new URL(req.url).searchParams;

  // 1. The two values a redirect depends on. Nothing redirects until both are valid.
  const clientId = single(params, "client_id");
  const registeredId =
    typeof clientId === "string" && CLIENT_ID_RE.test(clientId)
      ? clientId
      : null;
  if (clientId !== product.slug && registeredId === null)
    return refusalPage(ctx, 401, ErrorCode.InvalidClient);
  const issuer = issuerOf(req, product);

  let kind: ClientKind;
  let redirectUri: string;
  let authz: AuthzRecord;
  let native: NativeRequestInfo | undefined;
  let deviceLabel: string | null = null;
  let reqOrigin: string | null;
  if (registeredId !== null) {
    // I-21.6 (§12.13.3): a registered client. Its own checks, its own redirect URI classes.
    const reg = await authorizeRegistered(
      { db, product, issuer },
      params,
      registeredId,
      (status, code) => refusalPage(ctx, status, code),
    );
    if (!reg.ok) return reg.response;
    kind = "web";
    redirectUri = reg.redirectUri;
    authz = reg.authz;
    // Only an `https` redirect names an origin; a loopback or private-use URI returns to the device.
    reqOrigin = redirectUri.startsWith("https://")
      ? new URL(redirectUri).origin
      : null;
  } else if (params.has("request_uri")) {
    // §12.12: a pushed request replaces the whole parameter set. It is resolved first, and an
    // unknown, expired, malformed or already taken one never redirects.
    const uri = single(params, "request_uri");
    const pushed =
      typeof uri === "string"
        ? await readPushed(env, product.slug, uri, now)
        : null;
    if (!pushed) return refusalPage(ctx, 400, ErrorCode.InvalidRequestUri);
    const rec = pushed.record;
    // Any other parameter is refused in the redirect, and the record is kept.
    for (const name of new Set(params.keys()))
      if (name !== "client_id" && name !== "request_uri")
        return errorRedirect(
          rec.authz.redirectUri,
          issuer,
          ErrorCode.InvalidRequest,
          rec.authz.state,
        );
    kind = "native";
    redirectUri = rec.authz.redirectUri;
    authz = rec.authz;
    deviceLabel = rec.deviceLabel;
    native = {
      redirect: rec.redirect,
      deviceId: rec.deviceId,
      returnUri: rec.returnUri,
      par: pushed.id,
    };
    reqOrigin = rec.redirect === "claimed" ? new URL(redirectUri).origin : null;
  } else {
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
    if (!verdict.ok)
      return refusalPage(ctx, 400, ErrorCode.RedirectUriMismatch);
    kind = verdict.kind;
    redirectUri = verdict.uri;
    reqOrigin = new URL(verdict.uri).origin;

    // 2. Everything else answers in the redirect.
    const stateRaw = single(params, "state");
    const echoState =
      typeof stateRaw === "string" && stateRaw.length <= AUTHORIZE_STATE_MAX
        ? stateRaw
        : null;
    const built = await buildAuthz(ctx, (n) => single(params, n), verdict.uri);
    if (!built.ok)
      return errorRedirect(verdict.uri, issuer, built.error, echoState);
    authz = built.authz;
  }
  const fail = (error: AuthorizeRedirectError): Response =>
    authz.registered
      ? registeredErrorRedirect(redirectUri, issuer, error, authz.state)
      : errorRedirect(redirectUri, issuer, error, authz.state);

  // The card lives on the customer host once `CUSTOMER_ORIGIN` is usable (LK-04): the binder
  // cannot be set from here, so the redirect goes through the bind hop.
  const apiOrigin = new URL(req.url).origin;
  const customer =
    customerHostname(env) === null ? null : customerOrigin(env, req);
  const crossHost = customer !== null && customer !== apiOrigin;
  let created: Awaited<ReturnType<typeof createSignInRequest>>;
  try {
    created = await createSignInRequest(
      env,
      req,
      {
        product: product.slug,
        kind,
        origin: reqOrigin,
        flowRef: "authorize",
        authz,
        ...(deviceLabel ? { deviceLabel } : {}),
        ...(native ? { native } : {}),
        crossHost,
      },
      now,
    );
  } catch {
    return fail("server_error");
  }
  // Off the switch (or with the customer host the same origin) the card is on this origin.
  const origin = crossHost && created.bindToken ? customer : apiOrigin;
  const res = redirect(
    303,
    `${origin}/signin?request=${created.handle}${
      crossHost && created.bindToken ? `&bind=${created.bindToken}` : ""
    }`,
  );
  if (created.setCookie) res.headers.append("set-cookie", created.setCookie);
  return res;
}
