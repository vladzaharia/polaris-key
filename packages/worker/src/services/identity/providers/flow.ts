/**
 * The login card's provider sign-in routes (I-06): root portal paths under the reserved `login`
 * slug, platform-level and never behind a product's Identity toggle (owner, 2026-10-04).
 *
 *   GET  /login/<provider>              start: record the flow, 302 to the provider
 *   GET  /login/google/callback         Google's redirect (code, state, iss)
 *   POST /login/apple/callback          Apple's form_post (code, state, user?)
 *   GET  /login/steam/callback          Steam's OpenID 2.0 positive assertion (state in return_to)
 *   POST /login/apple/notifications     Apple's server-to-server events
 *
 * **The flow.** One record per sign-in in the single-use store (`signin-flow`), addressed by the
 * peppered hash of its `state` (so a listing is inert, as for the portal's own flows) and
 * consumed atomically by the first callback that presents it. It records which provider it was
 * started for, and a callback on another provider's path is refused: per-provider redirect URIs
 * plus that check are the mix-up defence, with RFC 9207 `iss` on top where the provider sends it.
 *
 * **Browser binding without a Lax cookie.** Apple's form_post is a cross-site top-level POST, on
 * which a `SameSite=Lax` cookie is not sent, so the flow is FOUND by `state` alone, server-side.
 * The flow is still BOUND to the browser that started it: start sets `__Host-pkey_signin`, a
 * random value whose hash the record holds, as `SameSite=None; Secure; HttpOnly` with a ten-minute
 * life, which every browser sends on a top-level navigation, cross-site POST included. A callback
 * whose cookie does not match is refused, so an attacker cannot complete their own provider sign-in
 * in a victim's browser (login CSRF, which would hand the victim's later licence activations to
 * the attacker's account). The cookie carries no session and opens nothing by itself.
 *
 * **The hand-off.** A verified identity goes to `signIn(verifiedIdentity)` with the provider's
 * email and whether the provider verified it. I-07 replaces the direct session with the
 * interstitial (email confirmation, join offer, first-consent name); until then this answers
 * exactly as the portal's OIDC callback does.
 */

import { hashKey, type Db, type Env } from "../../../core/platform.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import { readCappedText } from "../../../core/readCapped.js";
import {
  artefactRef,
  consumeArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import { signIn, type SignInResult } from "../accounts/signIn.js";
import { htmlError, safeReturnTo, signInRefusal } from "../portal/auth.js";
import { portalSecurityHeaders } from "../portal/headers.js";
import {
  portalAudit,
  portalAuthCapabilities,
  syncAccountLicenseLinks,
} from "../portal/repo.js";
import {
  buildPortalSessionCookie,
  issuePortalSession,
} from "../portal/session.js";
import {
  appleAuthorizeUrl,
  completeAppleSignIn,
  verifyAppleNotification,
  type AppleNotificationType,
} from "./apple.js";
import {
  isSignInProviderKind,
  resolveSignInClient,
  type SignInProviderKind,
} from "./config.js";
import { discoverProvider, ProviderVerifyError } from "./discovery.js";
import { completeGoogleSignIn, googleAuthorizeUrl } from "./google.js";
import { ProviderNetworkError, type ProviderFetch } from "./net.js";
import {
  clearAppleLinkFlag,
  flagAppleLink,
  type AppleLinkFlag,
} from "./linkFlags.js";
import { completeSteamSignIn, steamAuthorizeUrl } from "./steam.js";
import type { ProviderSignInResult } from "./types.js";

const FLOW_TTL_SECONDS = 600;
const FORM_MAX_BYTES = 16 * 1024;

/** The browser-binding cookie. `__Host-`: Secure, Path=/, no Domain. */
export const SIGNIN_BIND_COOKIE = "__Host-pkey_signin";

const PROVIDER_LABEL: Record<SignInProviderKind, string> = {
  google: "Google",
  apple: "Apple",
  steam: "Steam",
};

/** The method each provider's callback arrives with. */
const CALLBACK_METHOD: Record<SignInProviderKind, "GET" | "POST"> = {
  google: "GET",
  apple: "POST",
  steam: "GET",
};

export interface SignInFlowRecord {
  provider: SignInProviderKind;
  nonce: string;
  /** Google only: the PKCE verifier. */
  verifier?: string;
  /** The exact redirect URI (OIDC) or `openid.return_to` (Steam) this flow sent. */
  redirectUri: string;
  returnTo?: string;
  /** Peppered hash of the browser-binding cookie's value. */
  bindingHash: string;
}

/** Single-use store address of a provider flow, by its `state`. Exported for tests. */
export async function signInFlowKey(
  env: Env,
  state: string,
): Promise<ArtefactRef> {
  return artefactRef("signin-flow", await hashKey(state, env.KEY_HASH_PEPPER));
}

/** Test seam: the outbound fetch every provider call uses. */
export interface ProviderRouteOptions {
  now: number;
  fetch?: ProviderFetch;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(n = 32): string {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return b64url(new Uint8Array(digest));
}

function bindCookie(value: string): string {
  return [
    `${SIGNIN_BIND_COOKIE}=${value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=None",
    `Max-Age=${FLOW_TTL_SECONDS}`,
  ].join("; ");
}

function clearBindCookie(): string {
  return [
    `${SIGNIN_BIND_COOKIE}=`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=None",
    "Max-Age=0",
  ].join("; ");
}

function readBindCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SIGNIN_BIND_COOKIE) return rest.join("=") || null;
  }
  return null;
}

function redirect(
  location: string,
  status: 302 | 303,
  cookies: string[],
): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, {
    status,
    headers: portalSecurityHeaders(headers),
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: portalSecurityHeaders(
      new Headers({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      }),
    ),
  });
}

/** `GET /login/<provider>`. */
export async function handleProviderStart(
  req: Request,
  env: Env,
  db: Db,
  kind: SignInProviderKind,
  opts: ProviderRouteOptions,
): Promise<Response> {
  if (req.method !== "GET") return htmlError(405, "Method not allowed.");
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalProviderStart",
      id: clientIp(req),
      limit: 20,
      windowSec: 60,
    },
    opts.now,
  );
  if (!ok) return htmlError(429, "Too many sign-in attempts.");
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled) return htmlError(404, "Sign-in is not available.");
  const label = PROVIDER_LABEL[kind];
  const client = await resolveSignInClient(env, kind);
  if (!client) return htmlError(404, `Sign in with ${label} is not available.`);

  const url = new URL(req.url);
  const rawReturnTo = url.searchParams.get("return_to");
  const returnTo = safeReturnTo(req, rawReturnTo);
  if (rawReturnTo && !returnTo) return htmlError(400, "Invalid return URL.");

  const state = randomToken(24);
  const nonce = randomToken(24);
  const binding = randomToken(32);
  let location: string;
  let record: SignInFlowRecord;
  try {
    if (client.kind === "steam") {
      // Steam carries no state parameter of its own: ours rides in the signed return URL.
      const redirectUri = `${url.origin}/login/steam/callback?state=${state}`;
      record = {
        provider: kind,
        nonce,
        redirectUri,
        returnTo,
        bindingHash: "",
      };
      location = steamAuthorizeUrl({
        returnTo: redirectUri,
        realm: url.origin,
      });
    } else {
      const redirectUri = `${url.origin}/login/${kind}/callback`;
      const discovered = await discoverProvider(client.kind, {
        fetch: opts.fetch,
      });
      if (client.kind === "google") {
        const verifier = randomToken(32);
        record = {
          provider: kind,
          nonce,
          verifier,
          redirectUri,
          returnTo,
          bindingHash: "",
        };
        location = googleAuthorizeUrl(client, discovered, {
          redirectUri,
          state,
          nonce,
          codeChallenge: await s256(verifier),
        });
      } else {
        if (!discovered.responseModes.includes("form_post")) {
          throw new ProviderVerifyError("apple does not offer form_post");
        }
        record = {
          provider: kind,
          nonce,
          redirectUri,
          returnTo,
          bindingHash: "",
        };
        location = appleAuthorizeUrl(client, discovered, {
          redirectUri,
          state,
          nonce,
        });
      }
    }
  } catch {
    return htmlError(502, `${label} sign-in is unavailable right now.`);
  }
  record.bindingHash = await hashKey(binding, env.KEY_HASH_PEPPER);
  await putArtefact(
    env,
    await signInFlowKey(env, state),
    JSON.stringify(record),
    FLOW_TTL_SECONDS,
  );
  return redirect(location, 302, [bindCookie(binding)]);
}

/** The callback's parameters, from the query (GET) or the capped form body (Apple's POST). */
async function callbackParams(
  req: Request,
  kind: SignInProviderKind,
): Promise<URLSearchParams | null> {
  if (CALLBACK_METHOD[kind] === "GET") return new URL(req.url).searchParams;
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return null;
  }
  try {
    const text = await readCappedText(
      req as unknown as Response,
      FORM_MAX_BYTES,
      () => new Error("form too large"),
    );
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

/** `GET|POST /login/<provider>/callback`. */
export async function handleProviderCallback(
  req: Request,
  env: Env,
  db: Db,
  kind: SignInProviderKind,
  opts: ProviderRouteOptions,
): Promise<Response> {
  if (req.method !== CALLBACK_METHOD[kind]) {
    return htmlError(405, "Method not allowed.");
  }
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalProviderCallback",
      id: clientIp(req),
      limit: 20,
      windowSec: 60,
    },
    opts.now,
  );
  if (!ok) return htmlError(429, "Too many sign-in attempts.");
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled) return htmlError(404, "Sign-in is not available.");
  const label = PROVIDER_LABEL[kind];

  const params = await callbackParams(req, kind);
  if (!params) return htmlError(400, "This sign-in response was malformed.");
  // Steam's state rides in the return URL's own query, beside the openid.* fields.
  const state = params.get("state");
  if (!state) return htmlError(400, "This sign-in link has expired.");
  // Atomic and single-use: of two racing callbacks for one state, one gets the flow. A
  // cancelled or failed provider response still burns it.
  const raw = await consumeArtefact(env, await signInFlowKey(env, state));
  if (!raw) return htmlError(400, "This sign-in link has expired.");
  let flow: SignInFlowRecord;
  try {
    flow = JSON.parse(raw) as SignInFlowRecord;
  } catch {
    return htmlError(400, "This sign-in link has expired.");
  }
  // Mix-up defence: a state minted for one provider is never redeemed on another's callback.
  if (flow.provider !== kind) {
    return htmlError(400, "This sign-in link has expired.");
  }
  const binding = readBindCookie(req);
  if (
    !binding ||
    (await hashKey(binding, env.KEY_HASH_PEPPER)) !== flow.bindingHash
  ) {
    return htmlError(
      400,
      "This sign-in was started in another browser. Start again here.",
    );
  }
  if (params.get("error") || params.get("openid.mode") === "cancel") {
    return htmlError(400, `Sign in with ${label} was cancelled.`);
  }

  let result: ProviderSignInResult;
  try {
    result = await completeProvider(env, kind, flow, params, opts);
  } catch (err) {
    if (err instanceof ProviderNetworkError) {
      return htmlError(502, `${label} sign-in is unavailable right now.`);
    }
    return htmlError(401, "Sign-in could not be verified.");
  }

  const signedIn = await signIn(db, result.identity, opts.now);
  const refused = signInRefusal(signedIn);
  if (refused) return refused;
  const done = signedIn as Extract<SignInResult, { status: "signed_in" }>;
  if (kind === "apple") {
    // Signing in again with Apple is a fresh consent: a revoked-consent flag no longer holds.
    await clearAppleLinkFlag(
      db,
      { linkId: done.linkId },
      "consent_revoked",
      opts.now,
    );
  }
  await syncAccountLicenseLinks(db, done.account.id, opts.now);
  await portalAudit(db, {
    accountId: done.account.id,
    action: `portal.login.${kind}`,
    targetKind: "link",
    targetId: done.linkId,
    summary: `Signed in with ${label}`,
    now: opts.now,
  });
  const { token } = await issuePortalSession(
    env,
    {
      accountId: done.account.id,
      name: done.account.display_name,
      email: done.account.primary_email,
    },
    opts.now,
  );
  // 303 after Apple's POST, so the browser follows with a GET.
  return redirect(flow.returnTo ?? "/", kind === "apple" ? 303 : 302, [
    buildPortalSessionCookie(token),
    clearBindCookie(),
  ]);
}

async function completeProvider(
  env: Env,
  kind: SignInProviderKind,
  flow: SignInFlowRecord,
  params: URLSearchParams,
  opts: ProviderRouteOptions,
): Promise<ProviderSignInResult> {
  const client = await resolveSignInClient(env, kind);
  if (!client) throw new ProviderVerifyError(`${kind} is not configured`);
  if (client.kind === "steam") {
    return completeSteamSignIn(
      client,
      params,
      { returnTo: flow.redirectUri, nowSec: opts.now },
      { fetch: opts.fetch },
    );
  }
  const code = params.get("code");
  if (!code) throw new ProviderVerifyError("no authorization code");
  const discovered = await discoverProvider(client.kind, { fetch: opts.fetch });
  if (client.kind === "google") {
    if (!flow.verifier) throw new ProviderVerifyError("flow has no verifier");
    return completeGoogleSignIn(
      client,
      discovered,
      {
        code,
        iss: params.get("iss"),
        redirectUri: flow.redirectUri,
        codeVerifier: flow.verifier,
        nonce: flow.nonce,
      },
      { fetch: opts.fetch },
    );
  }
  return completeAppleSignIn(
    client,
    discovered,
    {
      code,
      iss: params.get("iss"),
      redirectUri: flow.redirectUri,
      nonce: flow.nonce,
      user: params.get("user"),
    },
    { fetch: opts.fetch, nowSec: opts.now },
  );
}

const NOTIFICATION_FLAG: Record<AppleNotificationType, AppleLinkFlag | null> = {
  "consent-revoked": "consent_revoked",
  "account-delete": "account_deleted",
  "email-disabled": "email_disabled",
  "email-enabled": null,
};

/** `POST /login/apple/notifications`: Apple's server-to-server events. */
export async function handleAppleNotifications(
  req: Request,
  env: Env,
  db: Db,
  opts: ProviderRouteOptions,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "appleNotifications",
      id: clientIp(req),
      limit: 120,
      windowSec: 60,
    },
    opts.now,
  );
  if (!ok) return json({ error: "rate_limited" }, 429);
  const client = await resolveSignInClient(env, "apple");
  if (!client) return json({ error: "not_found" }, 404);
  let payload: unknown;
  try {
    const text = await readCappedText(
      req as unknown as Response,
      FORM_MAX_BYTES,
      () => new Error("too large"),
    );
    payload = (JSON.parse(text) as { payload?: unknown }).payload;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (typeof payload !== "string") return json({ error: "bad_request" }, 400);
  let event: Awaited<ReturnType<typeof verifyAppleNotification>>;
  try {
    const discovered = await discoverProvider("apple", { fetch: opts.fetch });
    event = await verifyAppleNotification(client, discovered, payload, {
      fetch: opts.fetch,
    });
  } catch (err) {
    if (err instanceof ProviderNetworkError) {
      // Apple retries on a non-2xx: let it, rather than dropping an event we could not check.
      return json({ error: "unavailable" }, 503);
    }
    return json({ error: "unauthorized" }, 401);
  }
  const flag = NOTIFICATION_FLAG[event.type];
  const linkId = flag
    ? await flagAppleLink(db, event.sub, flag, opts.now)
    : await clearAppleLinkFlag(
        db,
        { subject: event.sub },
        "email_disabled",
        opts.now,
      );
  return json({ ok: true, matched: linkId !== null }, 200);
}

/** Route `/login/<provider>[/<step>]`. Unknown providers and steps are the page's not-found. */
export async function handleProviderSignInPath(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  opts: ProviderRouteOptions,
): Promise<Response> {
  const m = path.match(/^\/login\/([a-z]+)(?:\/(callback|notifications))?$/);
  const kind = m?.[1];
  if (!m || !isSignInProviderKind(kind)) {
    return htmlError(404, "Sign-in is not available.");
  }
  switch (m[2]) {
    case undefined:
      return handleProviderStart(req, env, db, kind, opts);
    case "callback":
      return handleProviderCallback(req, env, db, kind, opts);
    case "notifications":
      if (kind === "apple") return handleAppleNotifications(req, env, db, opts);
  }
  return htmlError(404, "Sign-in is not available.");
}
