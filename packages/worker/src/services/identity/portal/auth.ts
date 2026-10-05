import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  ALLOWED_ID_TOKEN_ALGS,
  ID_TOKEN_CLOCK_TOLERANCE,
  ID_TOKEN_MAX_AGE,
} from "../idToken.js";
import {
  hashKey,
  platformOidcConfig,
  randomId,
  type Db,
  type Env,
} from "../../../core/platform.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import {
  artefactRef,
  consumeArtefact,
  deleteArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import {
  normalizeEmail,
  portalIdentityIssuerKey,
  rekeyLegacyPortalIdentities,
  portalAuthCapabilities,
  portalAudit,
  recordLinkGroups,
  syncAccountLicenseLinks,
} from "./repo.js";
import { signIn, type SignInResult } from "../accounts/signIn.js";
import { EMAIL_ISSUER, rekeyLegacyAccountLinks } from "../accounts/repo.js";
import {
  buildPortalClearCookie,
  buildPortalSessionCookie,
  issuePortalSession,
} from "./session.js";
import { sendMagicLink } from "./email.js";
import { portalSecurityHeaders } from "./headers.js";
import {
  brandedHtmlSecurityHeaders,
  isSameOriginNavigation,
} from "../../../core/platform.js";
import { escapeHtml, renderBrandPage } from "../../../core/brandHtml.js";

const FLOW_TTL_SECONDS = 600;

/**
 * Single-use store address (`core/singleUse.ts`, I-02) of an in-flight portal OIDC sign-in,
 * by its `state`. Both portal credentials live there rather than in KV because KV `get` then
 * `delete` is not atomic (G15): two racing callbacks, or two clicks on one magic link, could
 * both be served. The store's `consume` hands a record out at most once.
 *
 * R12-04: both portal credentials (the OIDC `state` and the magic-link token) used to be the
 * key name verbatim, so a listing alone was a credential dump: a live `state` beside its PKCE
 * `verifier`, and a working magic-link token beside the victim's email. The address is the
 * secret's hash under `KEY_HASH_PEPPER`, so a listing stays inert.
 *
 * Exported for tests that plant or inspect a flow record.
 */
export async function portalFlowKey(
  env: Env,
  state: string,
): Promise<ArtefactRef> {
  return artefactRef("portal-flow", await hashKey(state, env.KEY_HASH_PEPPER));
}

/** Single-use store address of a pending magic link, by its token. See `portalFlowKey`. */
export async function portalMagicKey(
  env: Env,
  token: string,
): Promise<ArtefactRef> {
  return artefactRef("portal-magic", await hashKey(token, env.KEY_HASH_PEPPER));
}

interface FlowRecord {
  verifier: string;
  nonce: string;
  redirectUri: string;
  returnTo?: string;
}

interface MagicRecord {
  email: string;
  returnTo?: string;
}

/** A portal sign-in error page: the branded, script-free shell (`core/brandHtml.ts`). Every
 *  message is a hard-coded literal, escaped anyway. A retry is offered where one can help. */
export function htmlError(status: number, message: string): Response {
  const retry = status === 400 || status === 401 || status === 429;
  return new Response(
    renderBrandPage({
      title: "Sign-in",
      eyebrow: "Polaris Key account",
      heading: message,
      body: retry
        ? `<p class="actions"><a class="button" href="${escapeHtml("/")}">Back to sign-in</a></p>`
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

function authJson(body: unknown, status = 200): Response {
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

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(randomBytes(32));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    toAB(new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function safeReturnTo(
  req: Request,
  raw: string | null,
): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    const here = new URL(req.url);
    if (parsed.origin !== here.origin) return undefined;
    if (parsed.pathname.startsWith("/manage")) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function mapClaims(payload: Record<string, unknown>): {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  groups?: string[];
} {
  const email =
    typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
  const emailVerified = payload.email_verified === true;
  const name =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name]
      .filter((s) => typeof s === "string")
      .join(" ")
      .trim() ||
    (emailVerified ? email : "");
  return {
    sub: String(payload.sub ?? ""),
    email,
    emailVerified,
    name: name || undefined,
    // PX-W10: kept so Discover can evaluate a product's `groupRoleMap` for this account. The
    // same filter the product sign-in applies (`oidc.ts` `mapClaims`): strings only; no claim
    // at all is "not known", not "no groups".
    groups: Array.isArray(payload.groups)
      ? payload.groups.filter((g): g is string => typeof g === "string")
      : undefined,
  };
}

async function issueRedirectSession(
  env: Env,
  db: Db,
  account: {
    id: string;
    display_name: string | null;
    primary_email: string | null;
  },
  now: number,
  location: string,
): Promise<Response> {
  const { token } = await issuePortalSession(
    env,
    {
      accountId: account.id,
      name: account.display_name,
      email: account.primary_email,
    },
    now,
  );
  return new Response(null, {
    status: 302,
    headers: {
      ...Object.fromEntries(
        portalSecurityHeaders(
          new Headers({
            location,
            "set-cookie": buildPortalSessionCookie(token),
            "cache-control": "no-store",
          }),
        ),
      ),
    },
  });
}

export async function handlePortalLogin(
  req: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  const ok = await rateLimitOk(
    env,
    "_portal",
    { bucket: "portalLogin", id: clientIp(req), limit: 20, windowSec: 60 },
    Math.floor(Date.now() / 1000),
  );
  if (!ok) return htmlError(429, "Too many sign-in attempts.");
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.oidcEnabled) {
    return htmlError(404, "OIDC sign-in is disabled.");
  }
  const cfg = platformOidcConfig(env);
  if (!cfg) return htmlError(500, "Portal OIDC is not configured.");

  const url = new URL(req.url);
  const rawReturnTo = url.searchParams.get("return_to");
  const returnTo = safeReturnTo(req, rawReturnTo);
  if (rawReturnTo && !returnTo) return htmlError(400, "Invalid return URL.");

  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const { verifier, challenge } = await pkce();
  const redirectUri = `${url.origin}/callback`;
  const flow: FlowRecord = { verifier, nonce, redirectUri, returnTo };
  await putArtefact(
    env,
    await portalFlowKey(env, state),
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
  return new Response(null, {
    status: 302,
    headers: portalSecurityHeaders(
      new Headers({
        location: authorize.toString(),
        "cache-control": "no-store",
      }),
    ),
  });
}

export async function handlePortalCallback(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return htmlError(400, "Missing authorization code.");
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.oidcEnabled) {
    return htmlError(404, "OIDC sign-in is disabled.");
  }
  // Atomic and single-use: of two racing callbacks for one `state`, one gets the flow.
  const raw = await consumeArtefact(env, await portalFlowKey(env, state));
  if (!raw) return htmlError(400, "This sign-in link has expired.");
  let flow: FlowRecord;
  try {
    flow = JSON.parse(raw) as FlowRecord;
  } catch {
    return htmlError(400, "This sign-in link has expired.");
  }

  const cfg = platformOidcConfig(env);
  if (!cfg) return htmlError(500, "Portal OIDC is not configured.");
  const tokenRes = await fetch(
    `${cfg.issuer.replace(/\/$/, "")}/api/oidc/token`,
    {
      method: "POST",
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
  if (!tokenRes.ok) return htmlError(502, "OIDC token exchange failed.");
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token)
    return htmlError(502, "OIDC token response was invalid.");

  const jwks = createRemoteJWKSet(
    new URL(`${cfg.issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
  );
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokens.id_token, jwks, {
      issuer: cfg.issuer,
      audience: cfg.clientId,
      algorithms: ALLOWED_ID_TOKEN_ALGS,
      // Freshness is ours to enforce: `exp` is entirely the IdP's choice, so a token minted
      // long before this exchange must not be replayable into a sign-in (R8-05d).
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE,
      maxTokenAge: ID_TOKEN_MAX_AGE,
    });
    claims = verified.payload as Record<string, unknown>;
    if (typeof claims.nonce !== "string" || claims.nonce !== flow.nonce) {
      throw new Error("nonce mismatch");
    }
  } catch {
    return htmlError(401, "Sign-in could not be verified.");
  }

  const identity = mapClaims(claims);
  if (!identity.sub) return htmlError(401, "Sign-in could not be verified.");
  // Keyed by issuer (S-16 G14). Re-key any pre-I-01 rows first, so the lookup finds them.
  const issuerKey = portalIdentityIssuerKey(cfg.issuer);
  await rekeyLegacyPortalIdentities(db, issuerKey);
  await rekeyLegacyAccountLinks(db, issuerKey);
  // I-05: every front door ends in one `signIn(verifiedIdentity)`.
  const result = await signIn(
    db,
    {
      issuerKey,
      subject: identity.sub,
      kind: "oidc",
      email: identity.emailVerified ? identity.email : null,
      emailVerified: Boolean(identity.emailVerified && identity.email),
      displayName: identity.name ?? null,
    },
    now,
  );
  const refused = signInRefusal(result);
  if (refused) return refused;
  const signedIn = result as Extract<SignInResult, { status: "signed_in" }>;
  const account = signedIn.account;
  // PX-W10: the platform IdP's `groups` claim, kept on this link for Discover (NULL = not sent).
  await recordLinkGroups(db, signedIn.linkId, identity.groups);
  await syncAccountLicenseLinks(db, account.id, now);
  await portalAudit(db, {
    accountId: account.id,
    action: "portal.login.oidc",
    summary: "Signed in with OIDC",
    now,
  });
  return issueRedirectSession(env, db, account, now, flow.returnTo ?? "/");
}

/**
 * The page a sign-in that did not complete answers with. A join offer (an unknown identity whose
 * verified email another account already uses) is never resolved silently: the login card (I-07)
 * offers to join once the person proves the other account; until it lands, the page says so and
 * names nobody.
 */
export function signInRefusal(result: SignInResult): Response | null {
  switch (result.status) {
    case "signed_in":
      return result.account.status === "active"
        ? null
        : htmlError(403, "Account disabled.");
    case "join_offer":
      return htmlError(
        409,
        "A Polaris Key account already uses this email address. Sign in with the method you used before. Adding another sign-in method to an account is not available yet; until it is, contact the product's support if you can no longer use that method.",
      );
    case "refused":
      return result.reason === "account_disabled"
        ? htmlError(403, "Account disabled.")
        : htmlError(401, "Sign-in could not be verified.");
  }
}

export async function handleMagicStart(
  req: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  if (req.method !== "POST")
    return authJson({ error: "method_not_allowed" }, 405);
  const ok = await rateLimitOk(
    env,
    "_portal",
    { bucket: "portalMagic", id: clientIp(req), limit: 8, windowSec: 60 },
    Math.floor(Date.now() / 1000),
  );
  if (!ok) return authJson({ error: "rate_limited" }, 429);
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.magicEnabled) {
    return authJson(
      { error: "auth_method_disabled", message: "email sign-in is disabled" },
      404,
    );
  }

  let body: { email?: unknown; returnTo?: unknown };
  try {
    body = (await req.json()) as { email?: unknown; returnTo?: unknown };
  } catch {
    return authJson({ error: "bad_request", message: "invalid json" }, 400);
  }
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return authJson(
      { error: "bad_request", message: "valid email required" },
      422,
    );
  }
  const returnTo =
    typeof body.returnTo === "string"
      ? safeReturnTo(req, body.returnTo)
      : undefined;
  if (typeof body.returnTo === "string" && !returnTo) {
    return authJson(
      { error: "bad_request", message: "invalid return URL" },
      400,
    );
  }
  const token = randomId("magic");
  const verifyUrl = new URL("/magic/verify", new URL(req.url).origin);
  verifyUrl.searchParams.set("token", token);
  if (returnTo) verifyUrl.searchParams.set("return_to", returnTo);
  const record: MagicRecord = { email, returnTo };
  const magicKey = await portalMagicKey(env, token);
  await putArtefact(env, magicKey, JSON.stringify(record), FLOW_TTL_SECONDS);
  const sent = await sendMagicLink(
    env,
    db,
    email,
    verifyUrl.toString(),
    Math.floor(Date.now() / 1000),
  );
  if (!sent) {
    await deleteArtefact(env, magicKey);
    return authJson(
      {
        error: "email_not_configured",
        message: "portal email is not configured",
      },
      503,
    );
  }
  return authJson({ ok: true });
}

export async function handleMagicVerify(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return htmlError(400, "Missing magic-link token.");
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.magicEnabled) {
    return htmlError(404, "Email sign-in is disabled.");
  }
  // Atomic and single-use: two clicks (or a prefetcher and a click) cannot both sign in.
  const raw = await consumeArtefact(env, await portalMagicKey(env, token));
  if (!raw) return htmlError(400, "This magic link has expired.");
  let record: MagicRecord;
  try {
    record = JSON.parse(raw) as MagicRecord;
  } catch {
    return htmlError(400, "This magic link has expired.");
  }
  const result = await signIn(
    db,
    {
      issuerKey: EMAIL_ISSUER,
      subject: normalizeEmail(record.email),
      kind: "email",
    },
    now,
  );
  const refused = signInRefusal(result);
  if (refused) return refused;
  const account = (result as Extract<SignInResult, { status: "signed_in" }>)
    .account;
  await syncAccountLicenseLinks(db, account.id, now);
  await portalAudit(db, {
    accountId: account.id,
    action: "portal.login.magic",
    summary: "Signed in with email magic link",
    now,
  });
  return issueRedirectSession(env, db, account, now, record.returnTo ?? "/");
}

/**
 * `POST /logout` (preferred) or a same-origin top-level `GET` navigation.
 *
 * R1-03: this used to be an unconditional `GET` that returned a clearing `Set-Cookie` with no
 * token of any kind, and the portal cookie is `SameSite=Lax` — so
 * `<img src="https://key.plrs.im/logout">` on any site was a working logout-CSRF. `POST` is
 * the correct method and is accepted unconditionally — and the portal SPA now uses it: the
 * sign-out control in `packages/admin/src/portal/App.tsx` is a form POST, not a link. `GET`
 * survives only as a compatibility bridge for a browser holding a cached older bundle, and
 * even then it is constrained to a genuine same-origin top-level navigation, which refuses
 * both the `<img>` and the cross-site-link shapes. It can be dropped once no stale bundles
 * are in circulation.
 */
export function handlePortalLogout(req: Request): Response {
  if (req.method !== "POST" && !isSameOriginNavigation(req)) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: portalSecurityHeaders(
        new Headers({ "cache-control": "no-store" }),
      ),
    });
  }
  return new Response(null, {
    status: 302,
    headers: portalSecurityHeaders(
      new Headers({
        location: "/",
        "set-cookie": buildPortalClearCookie(),
        "cache-control": "no-store",
      }),
    ),
  });
}
