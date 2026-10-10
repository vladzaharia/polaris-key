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
 * so tests can drive the flow without a live IdP. Production wires the one relying-party client
 * (`core/oidc/client.ts`, I-30): discovery, the gated fetch, `createLocalJWKSet`, RFC 9207.
 * The IdP config comes from `adminOidcConfig` (I-03): the console's own client (`ADMIN_OIDC_*`)
 * when it is set, else the shared platform client (`PLATFORM_OIDC_*`). Either way admin auth is
 * independent of any single product's OIDC client.
 */

import { recordPlatformSecurityEvent } from "../core/ops/securityEvents.js";
import {
  authorizationUrl,
  discover,
  issuerRelyingParty,
  newFlowSecrets,
  redeemAuthorizationCode,
} from "../core/oidc/client.js";
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
import { randomToken } from "../platform/random.js";
import { can, PLATFORM, resolvePrincipal } from "./authz.js";
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
    /** RFC 9207: the authorization response's `iss`, when the IdP sent one. */
    iss?: string | null;
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

/** The console IdP as a relying party of the one client (I-30), or `null` when unset. */
function consoleRelyingParty(env: Env) {
  const cfg = adminOidcConfig(env);
  return cfg ? issuerRelyingParty("console-idp", cfg) : null;
}

/**
 * The production verifier: the one relying-party client redeems the code (discovery, RFC 9207
 * `iss`, the gated token request) and verifies the ID token (gated JWKS, `createLocalJWKSet`,
 * exact `aud`/`azp`, freshness, this flow's nonce).
 */
const clientIdTokenVerifier: IdTokenVerifier = {
  async verify({ code, iss, flow, env }) {
    const rp = consoleRelyingParty(env);
    if (!rp) return null;
    try {
      const { claims } = await redeemAuthorizationCode(rp, {
        code,
        iss: iss ?? null,
        redirectUri: flow.redirectUri,
        codeVerifier: flow.verifier,
        nonce: flow.nonce,
      });
      // A token with no nonce never satisfies the binding to this flow (replay defence).
      if (typeof claims.nonce !== "string") return null;
      return mapClaims(claims as Record<string, unknown>);
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
  const rp = consoleRelyingParty(env);
  if (!rp) return htmlError(500, "Admin sign-in is not configured.");
  let discovered;
  try {
    discovered = await discover(rp);
  } catch {
    return htmlError(502, "Sign-in isn't working right now. Try again later.");
  }
  const { state, nonce, verifier, challenge } = await newFlowSecrets();
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

  const authorize = authorizationUrl(discovered, rp, {
    redirectUri,
    scope: "openid email profile groups",
    state,
    nonce,
    codeChallenge: challenge,
    // I-12: a step-up re-authenticates now, not a silent SSO. The callback checks `auth_time`
    // when the IdP sends one, so an IdP that ignores these still cannot pass off an old sign-in.
    extra: stepUp ? { prompt: "login", max_age: "0" } : undefined,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize,
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
  verifier: IdTokenVerifier = clientIdTokenVerifier,
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

  const identity = await verifier.verify({
    code,
    iss: url.searchParams.get("iss"),
    flow,
    env,
  });
  if (!identity || !identity.sub) {
    await recordPlatformSecurityEvent(db, {
      action: "admin.signin.failed",
      summary: "Admin sign-in: ID token could not be verified",
      now,
    });
    return htmlError(401, "Sign-in could not be verified.");
  }

  // The sign-in gate is the console's membership check (ST-29): the principal this identity
  // resolves to must hold at least one grant. Today the only grant is the root rule (the
  // platform admin group), so this admits exactly who it always did.
  const principal = await resolvePrincipal(
    env,
    db,
    { sub: identity.sub, groups: identity.groups },
    now,
  );
  if (!can(principal, PLATFORM, "console", "view")) {
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
