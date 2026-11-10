/**
 * `authorize` for a registered client (I-21.6; V5 §12.13.3; plans/I-20.md §3.2; threats IS-3, IS-4).
 *
 * Called by `passthrough/authorize.ts` when `client_id` is of the `cl_` form. It validates the
 * request and returns the record the handle will carry, or the response to send.
 *
 * ── THE ORDER OF REFUSALS ───────────────────────────────────────────────────────────────────
 *
 *   1. The client and the redirect URI, before anything else: an unknown, disabled or other
 *      product's client (or the issuer off) renders `invalid_client`, and a `redirect_uri` that is
 *      absent, repeated or equal to none of the client's registered URIs renders
 *      `redirect_uri_mismatch` (loopback port aside, `redirect.ts`). Both are branded pages and
 *      NEVER a redirect, whatever else is wrong. Nothing below can run before them.
 *   2. Every later error is `302 <the registered redirect URI>?error=…&state=…&iss=<issuer>`
 *      (RFC 6749 §4.1.2.1, RFC 9207). The target is the registered string, never anything else
 *      the request sent; `state` is echoed only when it is a single value of at most 512
 *      characters, and a `code` is never in an error.
 *   3. Success is a handle (the caller mints it) and the `303` to the card. No code, token or
 *      `state` is in any URL it builds, and nothing is delivered in a fragment.
 *
 * ── WHAT IS NOT TRUSTED ─────────────────────────────────────────────────────────────────────
 *
 * Every parameter is read as a single value: a repeated one is `invalid_request`, so the first
 * and the last cannot disagree. The scope is the intersection of what was asked and the client's
 * registered scopes (the reserved `pkey:licenses` and `pkey:sync` are never in either). PKCE
 * `S256` is required of a `spa` and a `native` client; a `web` client sends it, a `nonce`, or
 * both; `plain`, an absent method or a malformed challenge is `invalid_request`.
 */

import {
  AUTHORIZE_STATE_MAX,
  ISSUER_SCOPES,
  type IssuerAuthorizeRedirectError,
} from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Product } from "../../../core/products.js";
import { strictEmail } from "../../../core/strictEmail.js";
import { redirect } from "../passthrough/authorize.js";
import type { AuthzRecord } from "../passthrough/request.js";
import { getActiveClient } from "./clientsRepo.js";
import { verifyIdTokenHint } from "./idTokenHint.js";
import { matchRedirectUri, withQuery } from "./redirect.js";
import { issuerServed } from "./served.js";

/** `nonce` is at most this long (§12.13.3). */
const NONCE_MAX_LENGTH = 255;
/** S256 of a verifier is 32 bytes: always 43 base64url characters. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_AGE_RE = /^[0-9]{1,10}$/;

type Param = string | undefined | null;

export type RegisteredAuthorize =
  | {
      ok: true;
      authz: AuthzRecord;
      /** The registered redirect URI the request matched. */
      redirectUri: string;
    }
  | { ok: false; response: Response };

/** The branded refusal page for a code the caller renders (`refusalPage`). */
export type RefusalPage = (
  status: 400 | 401,
  code: "invalid_client" | "redirect_uri_mismatch",
) => Promise<Response>;

/** Validate an `authorize` request whose `client_id` is a registered client's. */
export async function authorizeRegistered(
  ctx: { db: Db; product: Product; issuer: string },
  params: URLSearchParams,
  clientId: string,
  refusal: RefusalPage,
): Promise<RegisteredAuthorize> {
  const { db, product, issuer } = ctx;
  const stop = async (
    response: Promise<Response>,
  ): Promise<RegisteredAuthorize> => ({
    ok: false,
    response: await response,
  });

  // 1. The client and the redirect URI. Nothing redirects until both are valid.
  const client = (await issuerServed(db, product.slug))
    ? await getActiveClient(db, product.slug, clientId)
    : null;
  if (!client) return stop(refusal(401, "invalid_client"));
  const presented = single(params, "redirect_uri");
  const redirectUri =
    typeof presented === "string"
      ? matchRedirectUri(client.redirectUris, presented, client.type)
      : null;
  if (redirectUri === null) return stop(refusal(400, "redirect_uri_mismatch"));

  // From here on, every error goes to the registered redirect URI.
  const stateRaw = single(params, "state");
  const state =
    typeof stateRaw === "string" && stateRaw.length <= AUTHORIZE_STATE_MAX
      ? stateRaw
      : null;
  const err = (e: {
    error: IssuerAuthorizeRedirectError;
  }): RegisteredAuthorize => ({
    ok: false,
    response: registeredErrorRedirect(redirectUri, issuer, e.error, state),
  });

  // 2. Request objects are not served. A pushed request is the own client's.
  if (params.has("request")) return err({ error: "request_not_supported" });
  if (params.has("request_uri"))
    return err({ error: "request_uri_not_supported" });

  if (stateRaw === null || (typeof stateRaw === "string" && state === null))
    return err({ error: "invalid_request" });

  const responseType = single(params, "response_type");
  if (responseType === undefined || responseType === null)
    return err({ error: "invalid_request" });
  if (responseType !== "code")
    return err({ error: "unsupported_response_type" });
  const mode = single(params, "response_mode");
  if (mode === null || (mode !== undefined && mode !== "query"))
    return err({ error: "invalid_request" });

  const scopeRaw = single(params, "scope");
  if (scopeRaw === null) return err({ error: "invalid_request" });
  const asked = (scopeRaw ?? "").split(" ").filter((t) => t !== "");
  if (!asked.includes("openid")) return err({ error: "invalid_scope" });
  const scope = ISSUER_SCOPES.filter(
    (s) => asked.includes(s) && client.scopes.includes(s),
  );
  if (!scope.includes("openid")) return err({ error: "invalid_scope" });

  const pkce = pkceOf(
    single(params, "code_challenge"),
    single(params, "code_challenge_method"),
  );
  if (pkce === "invalid") return err({ error: "invalid_request" });
  const nonce = single(params, "nonce");
  if (
    nonce === null ||
    (nonce !== undefined && nonce.length > NONCE_MAX_LENGTH)
  )
    return err({ error: "invalid_request" });
  // A public client must use PKCE; a confidential one needs PKCE or a nonce (RFC 9700 §2.1.1).
  if (pkce === null && (client.type !== "web" || !nonce))
    return err({ error: "invalid_request" });

  const prompt = promptOf(single(params, "prompt"));
  if (prompt === "invalid") return err({ error: "invalid_request" });
  const maxAgeRaw = single(params, "max_age");
  if (
    maxAgeRaw === null ||
    (maxAgeRaw !== undefined && !MAX_AGE_RE.test(maxAgeRaw))
  )
    return err({ error: "invalid_request" });

  let hintSub: string | null = null;
  const hint = single(params, "id_token_hint");
  if (hint === null) return err({ error: "invalid_request" });
  if (hint !== undefined) {
    hintSub = await verifyIdTokenHint(
      db,
      product.slug,
      issuer,
      client.clientId,
      hint,
    );
    if (hintSub === null) return err({ error: "invalid_request" });
  }
  const loginHint = single(params, "login_hint");
  if (loginHint === null) return err({ error: "invalid_request" });

  return {
    ok: true,
    redirectUri,
    authz: {
      clientId: client.clientId,
      redirectUri,
      state: stateRaw ?? null,
      codeChallenge: pkce,
      scope,
      nonce: nonce ? nonce : null,
      licenseChoice: "card",
      purpose: "signin",
      loginHint: strictEmail(loginHint),
      nameHint: null,
      registered: {
        type: client.type,
        prompt,
        maxAge: maxAgeRaw === undefined ? null : Number(maxAgeRaw),
        hintSub,
      },
    },
  };
}

/** `302 <redirect_uri>?error=…&state=…&iss=…`, onto the registered string (V5 §12.13.3 rule 1). */
export function registeredErrorRedirect(
  redirectUri: string,
  issuer: string,
  error: IssuerAuthorizeRedirectError,
  state: string | null,
): Response {
  return redirect(
    302,
    withQuery(redirectUri, {
      error,
      ...(state !== null ? { state } : {}),
      iss: issuer,
    }),
  );
}

function single(params: URLSearchParams, name: string): Param {
  const all = params.getAll(name);
  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0]! : null;
}

/** The challenge, `null` when neither member was sent, `"invalid"` for any malformed pair. */
function pkceOf(challenge: Param, method: Param): string | null | "invalid" {
  if (challenge === undefined && method === undefined) return null;
  if (typeof challenge !== "string" || method !== "S256") return "invalid";
  return CHALLENGE_RE.test(challenge) ? challenge : "invalid";
}

/** `prompt`: the recognised values; `none` with another is `invalid_request`. */
function promptOf(
  raw: Param,
): { none: boolean; login: boolean; consent: boolean } | "invalid" {
  if (raw === null) return "invalid";
  const tokens = new Set((raw ?? "").split(" ").filter((t) => t !== ""));
  const none = tokens.has("none");
  const login = tokens.has("login");
  const consent = tokens.has("consent");
  if (none && (login || consent)) return "invalid";
  return { none, login, consent };
}
