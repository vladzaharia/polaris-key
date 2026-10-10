/**
 * Interactive admin sign-in (browser, cookie-based) — distinct from the SDK/CLI OIDC
 * activation in `../services/identity/oidc.ts` (which mints license tokens). Here we just prove
 * an operator's identity + groups and drop a signed session cookie.
 *
 * - `GET /manage/login`     -> 302 to the IdP authorize endpoint (PKCE, state in the
 *                             single-use store, `core/singleUse.ts`).
 * - `GET /manage/callback`  -> exchange the code, verify the ID token, gate on a platform
 *                             OR product admin group, set the session cookie, 302 to /manage/.
 *
 * The token-exchange + ID-token verification is delegated to an injectable `IdTokenVerifier`
 * so tests can drive the flow without a live IdP (production wires the jose-backed verifier).
 * The IdP config comes from `adminOidcConfig` (I-03): the console's own client (`ADMIN_OIDC_*`)
 * when it is set, else the shared platform client (`PLATFORM_OIDC_*`). Either way admin auth is
 * independent of any single product's OIDC client.
 */

import { recordPlatformSecurityEvent } from "../core/ops/securityEvents.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  ALLOWED_ID_TOKEN_ALGS,
  ID_TOKEN_CLOCK_TOLERANCE,
  ID_TOKEN_MAX_AGE,
} from "../services/identity/public.js";
import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import { hashKey } from "../platform/crypto.js";
import { clientNetwork, rateLimitOk } from "../core/rateLimit.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../core/singleUse.js";
import {
  accountRealmCookie,
  clearAccountRealmCookie,
  readCookie,
} from "../core/accounts/accountCookies.js";
import { adminOidcConfig } from "../platform/platformOidc.js";
import { brandedHtmlSecurityHeaders } from "../core/securityHeaders.js";
import { renderBrandPage } from "../core/brandHtml.js";
import { escapeHtml } from "../platform/html.js";
import { pkcePair } from "../platform/pkce.js";
import { randomToken } from "../platform/random.js";
import { hasAnyAdminGrant } from "./authz.js";
import {
  STEP_UP_MAX_AGE_SECONDS,
  buildSessionCookie,
  issueSession,
  type SessionIdentity,
} from "../core/console/session.js";

const FLOW_TTL_SECONDS = 600;
/**
 * Single-use store address (`core/singleUse.ts`, I-02) of an in-flight admin sign-in. The
 * callback `consume`s it, so two racing callbacks for one `state` cannot both be served (G15:
 * KV `get` then `delete` was not atomic).
 *
 * R12-04: the `state` used to be the key name verbatim, so anyone who could list the store
 * read live OIDC `state` values straight out of the key names — a credential dump from
 * metadata alone, with the PKCE `verifier` sitting in the value next to it. The address is the
 * `state`'s hash under `KEY_HASH_PEPPER`, so a listing is inert. Exported for tests.
 */
export async function adminFlowKey(
  state: string,
  env: Env,
): Promise<ArtefactRef> {
  return artefactRef("admin-flow", await hashKey(state, env.KEY_HASH_PEPPER));
}

interface FlowRecord {
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** Validated same-origin path to land on after the callback (see `sanitizeReturnTo`). */
  returnTo?: string;
  /** I-12: a step-up re-authentication (`prompt=login`, `max_age=0`) for the relink tool. */
  stepUp?: boolean;
  /** Hash of the `ADMIN_FLOW_COOKIE` value of the browser that started the flow. */
  bindingHash: string;
}

/** Binds an admin sign-in to the browser that started it (as the portal's I-17). */
export const ADMIN_FLOW_COOKIE = "__Host-pkey_admin_flow";

/**
 * Where a sign-in may land after the callback. Default (and the fallback for anything
 * suspicious) is the console itself; the only other destination is the gated docs site,
 * which is what introduced `returnTo` in the first place (docs plan N7 — an unauthenticated
 * `/docs/...` hit redirects through `/manage/login` and should come back to the page it
 * wanted, not the console home).
 *
 * The validator is deliberately an allowlist, not an escape:
 *   - must start with `/docs` or `/manage` as a whole segment (no `/docsevil`),
 *   - conservative path charset only — no `\`, `%`, `?`, `#`, whitespace or control chars,
 *     so the value cannot smuggle a scheme, a query, a fragment, or a header break,
 *   - no `//` anywhere (kills protocol-relative URLs and empty segments),
 *   - no `.`/`..` segments,
 *   - bounded length.
 * The value is carried inside the KV flow record — bound to the OIDC `state`, never
 * round-tripped through the client — and re-validated when read back (defense in depth
 * against a poisoned record).
 */
const RETURN_TO_MAX_LENGTH = 512;
const RETURN_TO_RE = /^\/(?:docs|manage)(?:\/[A-Za-z0-9\-._~/]*)?$/;
/**
 * I-12: the console routes in its hash (`/manage/#/p/<slug>/users/<subject>`), and a step-up has
 * to land back on the row it started from. Only `/manage/` may carry one, and the fragment takes
 * the same conservative charset as the path (no `?`, `%`, `#`, `\\`, whitespace or controls).
 */
const RETURN_TO_HASH_RE = /^\/manage\/#\/[A-Za-z0-9\-._~/]*$/;

export function sanitizeReturnTo(raw: string | null): string | null {
  if (!raw || raw.length > RETURN_TO_MAX_LENGTH) return null;
  if (!RETURN_TO_RE.test(raw) && !RETURN_TO_HASH_RE.test(raw)) return null;
  if (raw.includes("//")) return null;
  if (raw.split(/[/#]/).some((seg) => seg === "." || seg === "..")) return null;
  return raw;
}

/** Resolved verified claims from an ID token. */
export interface IdTokenVerifier {
  /** Exchange `code` + verify the resulting ID token; return mapped claims or null. */
  verify(input: {
    code: string;
    flow: FlowRecord;
    env: Env;
  }): Promise<SessionIdentity | null>;
}

function mapClaims(payload: Record<string, unknown>): SessionIdentity {
  const groups = Array.isArray(payload.groups)
    ? (payload.groups.filter((g) => typeof g === "string") as string[])
    : [];
  const name =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name]
      .filter((s) => typeof s === "string")
      .join(" ")
      .trim() ||
    (typeof payload.email === "string" ? payload.email : "");
  return {
    sub: String(payload.sub ?? ""),
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: name || undefined,
    groups,
    ...(typeof payload.auth_time === "number" &&
    Number.isFinite(payload.auth_time)
      ? { authTime: Math.floor(payload.auth_time) }
      : {}),
  };
}

/** The production verifier: token exchange against the IdP + jose JWKS verification. */
const joseIdTokenVerifier: IdTokenVerifier = {
  async verify({ code, flow, env }) {
    const cfg = adminOidcConfig(env);
    if (!cfg) return null;
    const tokenRes = await fetch(
      `${cfg.issuer.replace(/\/$/, "")}/api/oidc/token`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: flow.redirectUri,
          client_id: cfg.clientId,
          code_verifier: flow.verifier,
          ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
        }),
      },
    );
    if (!tokenRes.ok) return null;
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) return null;
    const jwks = createRemoteJWKSet(
      new URL(`${cfg.issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
    );
    try {
      const verified = await jwtVerify(tokens.id_token, jwks, {
        issuer: cfg.issuer,
        audience: cfg.clientId,
        algorithms: ALLOWED_ID_TOKEN_ALGS,
        // Same freshness rules as the portal and product sign-ins; `exp` alone is
        // the IdP's choice.
        clockTolerance: ID_TOKEN_CLOCK_TOLERANCE,
        maxTokenAge: ID_TOKEN_MAX_AGE,
        requiredClaims: ["sub", "exp", "iat"],
      });
      const claims = verified.payload as Record<string, unknown>;
      // Reject unconditionally on a missing or mismatched nonce — a token with no nonce
      // must never satisfy the binding to this flow (replay / token-injection defense).
      if (typeof claims.nonce !== "string" || claims.nonce !== flow.nonce)
        return null;
      return mapClaims(claims);
    } catch {
      return null;
    }
  },
};

// ── handlers ──────────────────────────────────────────────────────────────────
/** A sign-in error page. HTML on the admin origin, so it carries the strict script-free CSP
 *  (R1-09): every message here is a hard-coded literal today, and it is escaped anyway, so this
 *  page can never become a script-execution primitive if that changes. */
function htmlError(status: number, message: string): Response {
  // A retry can help with an expired, unverified or rate-limited attempt; it cannot fix a
  // missing configuration (500) or a missing admin grant (403).
  const retry = status === 400 || status === 401 || status === 429;
  return new Response(
    renderBrandPage({
      title: "Console sign-in",
      surface: "console",
      heading: message,
      body: retry
        ? `<p class="actions"><a class="button" href="${escapeHtml("/manage/login")}">Sign in again</a></p>`
        : "",
    }),
    {
      status,
      headers: brandedHtmlSecurityHeaders(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        }),
      ),
    },
  );
}

/** The configured `CONSOLE_ORIGIN` (https, origin-only) when set, else the request's. */
function adminOrigin(env: Env, url: URL): string {
  try {
    const u = new URL(env.CONSOLE_ORIGIN ?? "");
    if (u.protocol === "https:" || u.hostname === "localhost") return u.origin;
  } catch {
    // unset or unusable: the request's own origin
  }
  return url.origin;
}

/** GET /manage/login — start PKCE + redirect to the IdP authorize endpoint. */
export async function handleAdminLogin(
  req: Request,
  env: Env,
): Promise<Response> {
  const ok = await rateLimitOk(
    env,
    "_admin",
    { bucket: "adminLogin", id: clientNetwork(req), limit: 20, windowSec: 60 },
    Math.floor(Date.now() / 1000),
  );
  if (!ok)
    return htmlError(
      429,
      "Too many sign-in attempts. Please wait and try again.",
    );
  const cfg = adminOidcConfig(env);
  if (!cfg) return htmlError(500, "Admin sign-in is not configured.");
  const state = randomToken(16);
  const nonce = randomToken(16);
  const { verifier, challenge } = await pkcePair();
  const url = new URL(req.url);
  const redirectUri = `${adminOrigin(env, url)}/manage/callback`;
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));
  const stepUp = url.searchParams.get("stepUp") === "1";
  const binding = randomToken(32);
  const flow: FlowRecord = {
    verifier,
    nonce,
    redirectUri,
    bindingHash: await hashKey(binding, env.KEY_HASH_PEPPER),
    ...(returnTo ? { returnTo } : {}),
    ...(stepUp ? { stepUp: true } : {}),
  };
  await putArtefact(
    env,
    await adminFlowKey(state, env),
    JSON.stringify(flow),
    FLOW_TTL_SECONDS,
  );

  const authorize = new URL(`${cfg.issuer.replace(/\/$/, "")}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", cfg.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email profile groups");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  if (stepUp) {
    // I-12: re-authenticate now, not a silent SSO. The callback checks `auth_time` when the IdP
    // sends one, so an IdP that ignores these still cannot pass off an old sign-in as fresh.
    authorize.searchParams.set("prompt", "login");
    authorize.searchParams.set("max_age", "0");
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": accountRealmCookie(
        ADMIN_FLOW_COOKIE,
        binding,
        FLOW_TTL_SECONDS,
      ),
      "cache-control": "no-store",
    },
  });
}

/** GET /manage/callback — verify, gate on an admin group, set the session cookie. */
export async function handleAdminCallback(
  req: Request,
  env: Env,
  db: Db,
  now: number,
  verifier: IdTokenVerifier = joseIdTokenVerifier,
): Promise<Response> {
  const ok = await rateLimitOk(
    env,
    "_admin",
    {
      bucket: "adminCallback",
      id: clientNetwork(req),
      limit: 20,
      windowSec: 60,
    },
    Math.floor(Date.now() / 1000),
  );
  if (!ok)
    return htmlError(
      429,
      "Too many sign-in attempts. Please wait and try again.",
    );
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return htmlError(400, "Missing authorization code.");
  // Only the browser that started the flow may finish it, checked
  // before the single-use consume so another browser cannot burn the flow either.
  const flowKey = await adminFlowKey(state, env);
  const peeked = await getArtefact(env, flowKey);
  let peekedFlow: FlowRecord | null = null;
  try {
    peekedFlow = peeked ? (JSON.parse(peeked) as FlowRecord) : null;
  } catch {
    peekedFlow = null;
  }
  const binding = readCookie(req.headers.get("cookie"), ADMIN_FLOW_COOKIE);
  if (
    !peekedFlow?.bindingHash ||
    !binding ||
    (await hashKey(binding, env.KEY_HASH_PEPPER)) !== peekedFlow.bindingHash
  )
    return htmlError(400, "This sign-in link has expired. Try again.");
  const raw = await consumeArtefact(env, flowKey);
  if (!raw) return htmlError(400, "This sign-in link has expired. Try again.");
  let flow: FlowRecord;
  try {
    flow = JSON.parse(raw) as FlowRecord;
  } catch {
    return htmlError(400, "This sign-in link has expired. Try again.");
  }

  const identity = await verifier.verify({ code, flow, env });
  if (!identity || !identity.sub) {
    await recordPlatformSecurityEvent(db, {
      action: "admin.signin.failed",
      summary: "Admin sign-in: ID token could not be verified",
      now,
    });
    return htmlError(401, "Sign-in could not be verified.");
  }

  // Admin authority is platform-wide, so the gate needs no product list — the `listProducts`
  // read that used to feed the (ignored) `_products` parameter is gone.
  if (!hasAnyAdminGrant(env, identity.groups)) {
    await recordPlatformSecurityEvent(db, {
      action: "admin.signin.refused",
      sub: identity.sub,
      summary: "Admin sign-in refused: no administrator grant",
      now,
    });
    return htmlError(
      403,
      "Your account is not an administrator of any product.",
    );
  }

  // A step-up must be a fresh authentication. An IdP that answered `prompt=login` with an old
  // sign-in (its `auth_time` says so) is refused here rather than minting a session that would
  // fail the relink tool's check a moment later with no explanation.
  if (
    flow.stepUp &&
    typeof identity.authTime === "number" &&
    now - identity.authTime > STEP_UP_MAX_AGE_SECONDS
  ) {
    return htmlError(
      401,
      "Your sign-in provider did not ask you to sign in again. Sign out of it, then try again.",
    );
  }

  // Only a step-up flow whose ID token carries `auth_time` records a step-up.
  const { token } = await issueSession(
    env,
    { ...identity, stepUp: flow.stepUp === true },
    now,
  );
  await recordPlatformSecurityEvent(db, {
    action: "admin.signin",
    sub: identity.sub,
    summary: flow.stepUp ? "Admin sign-in (step-up)" : "Admin sign-in",
    now,
  });
  // Re-validated on read: the flow record is server-written, but a defense-in-depth re-check
  // costs nothing and keeps "the callback only ever redirects to an allowlisted path" a local
  // property of this function rather than a cross-file invariant.
  const location = sanitizeReturnTo(flow.returnTo ?? null) ?? "/manage/";
  return new Response(null, {
    status: 302,
    headers: new Headers([
      ["location", location],
      ["set-cookie", buildSessionCookie(token)],
      ["set-cookie", clearAccountRealmCookie(ADMIN_FLOW_COOKIE)],
      ["cache-control", "no-store"],
    ]),
  });
}
