import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  ALLOWED_ID_TOKEN_ALGS,
  ID_TOKEN_CLOCK_TOLERANCE,
  ID_TOKEN_MAX_AGE,
} from "../idToken.js";
import {
  hashKey,
  mintOpaqueToken,
  open,
  platformOidcConfig,
  seal,
  type Db,
  type Env,
  type SealContext,
} from "../../../core/platform.js";
import {
  clearFlowCookie,
  flowBindingMatches,
  mintFlowBinding,
} from "../../../core/oidcFlow.js";
import { safeReturnUrl } from "../../../core/returnTo.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import {
  getOrCreateAccountByEmail,
  getOrCreateAccountByIdentity,
  portalAuthCapabilities,
  portalAudit,
  syncAccountLicenseLinks,
} from "./repo.js";
import {
  buildPortalClearCookie,
  buildPortalSessionCookie,
  issuePortalSession,
} from "./session.js";
import { sendMagicLink } from "./email.js";
import { portalSecurityHeaders } from "./headers.js";
import { isSameOriginNavigation } from "../../../core/platform.js";

const FLOW_TTL_SECONDS = 600;
const FLOW_PREFIX = "portal:oidc-flow:";
const MAGIC_PREFIX = "portal:magic:";

/**
 * KV keys for the portal's two sign-in credentials (B7-03 / A3-B1).
 *
 * `portal:oidc-flow:<state>` and `portal:magic:<token>` used to name the credential itself, so a
 * read-only listing of the HOT namespace was a working set of sign-in tokens — for the magic
 * link, a *bearer* one, redeemable straight into a session. R12-04 hashed exactly one of the
 * five sites it was filed against (`admin/auth.ts`); these are two more, hashed the same way:
 * `hashKey(credential, KEY_HASH_PEPPER)`, which is HMAC, so the mapping is not reversible or
 * even confirmable without the pepper.
 */
async function flowKey(state: string, env: Env): Promise<string> {
  return `${FLOW_PREFIX}${await hashKey(state, env.KEY_HASH_PEPPER)}`;
}

async function magicKey(token: string, env: Env): Promise<string> {
  return `${MAGIC_PREFIX}${await hashKey(token, env.KEY_HASH_PEPPER)}`;
}

/**
 * The AAD binding a stored magic record to the ONE token it was written for (B7-03).
 *
 * Hashing the key name stops a KV listing from yielding usable tokens; it does not stop a dump
 * of the VALUES from yielding "these addresses were sent a sign-in link", which is the second
 * half of what made this record an account-takeover primitive rather than merely a credential.
 * The address is therefore sealed under the platform KEK, exactly as identity's browser session
 * seals its device bearer, and bound to the token hash — so a blob lifted out of one record and
 * pasted into another fails the auth tag instead of redirecting an attacker's link at somebody
 * else's account.
 *
 * `_portal` as the product: the portal is platform-level and names no tenant, matching the
 * `_portal` shard the portal's own rate limits already use.
 */
function magicSealContext(tokenHash: string): SealContext {
  return {
    product: "_portal",
    kind: "product-secret",
    id: `portal-magic:${tokenHash}`,
  };
}

interface FlowRecord {
  verifier: string;
  nonce: string;
  redirectUri: string;
  returnTo?: string;
  /** `hashKey` of the `__Host-pkey_flow` cookie handed to the browser that started this flow
   *  (A3-06). See `core/oidcFlow.ts`. */
  flowHash?: string;
}

/** The magic record as CODE sees it. */
interface MagicRecord {
  email: string;
  returnTo?: string;
}

/** The magic record as KV sees it: `email` holds a `seal()` envelope, never the address. */
interface StoredMagicRecord {
  email: string;
  returnTo?: string;
}

function htmlError(status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>Portal sign-in</title><body><h1>${message}</h1>`,
    {
      status,
      headers: portalSecurityHeaders(
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

function mapClaims(payload: Record<string, unknown>): {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
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
  const headers = portalSecurityHeaders(
    new Headers({ location, "cache-control": "no-store" }),
  );
  headers.append("set-cookie", buildPortalSessionCookie(token));
  // The single-use flow binding has done its job by the time a session exists; retire it so a
  // stale `__Host-pkey_flow` cannot linger in the browser (A3-06). A no-op on the magic-link
  // path, which never set one.
  headers.append("set-cookie", clearFlowCookie());
  return new Response(null, { status: 302, headers });
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
  const returnTo = safeReturnUrl(req, rawReturnTo);
  if (rawReturnTo && !returnTo) return htmlError(400, "Invalid return URL.");

  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const { verifier, challenge } = await pkce();
  const redirectUri = `${url.origin}/callback`;
  // A3-06 — bind the flow to THIS browser. Every portal flow is a browser redirect (there is no
  // device/loopback arm here), so the binding is unconditional.
  const binding = await mintFlowBinding(env);
  const flow: FlowRecord = {
    verifier,
    nonce,
    redirectUri,
    returnTo,
    flowHash: binding.hash,
  };
  await env.HOT.put(await flowKey(state, env), JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });

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
        "set-cookie": binding.cookie,
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
  // A3-09 — the callback runs a token exchange and an ID-token verification for anyone who
  // names a `state`, and had no budget at all while `/login` next door did. Fails CLOSED
  // (`core/rateLimit.ts`): losing the limiter must not silently unmeter a session-minting leg.
  const ok = await rateLimitOk(
    env,
    "_portal",
    { bucket: "portalCallback", id: clientIp(req), limit: 20, windowSec: 60 },
    now,
  );
  if (!ok) return htmlError(429, "Too many sign-in attempts.");
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.oidcEnabled) {
    return htmlError(404, "OIDC sign-in is disabled.");
  }
  const key = await flowKey(state, env);
  const raw = await env.HOT.get(key);
  if (!raw) return htmlError(400, "This sign-in link has expired.");
  let flow: FlowRecord;
  try {
    flow = JSON.parse(raw) as FlowRecord;
  } catch {
    await env.HOT.delete(key);
    return htmlError(400, "This sign-in link has expired.");
  }
  await env.HOT.delete(key);
  // A3-06 — only the browser that started this flow may finish it. Same message the expired
  // arm returns, so a probe cannot tell "no such flow" from "not your flow".
  if (!(await flowBindingMatches(req, env, flow.flowHash))) {
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
  const account = await getOrCreateAccountByIdentity(
    db,
    {
      provider: "oidc",
      subject: identity.sub,
      email: identity.emailVerified ? identity.email : undefined,
      displayName: identity.name,
    },
    now,
  );
  if (account.status !== "active") return htmlError(403, "Account disabled.");
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
 * The per-TARGET magic-link budget (B5-06): 3 links per address per hour.
 *
 * The per-IP budget next door bounds one SENDER; this bounds one RECIPIENT, and only the second
 * one is a bound on the thing that actually leaves the platform. Without it, `POST
 * /api/magic/start` sent a platform-signed email to any address on earth, metered solely per
 * source IP — so an attacker rotating source addresses (trivially, and after B5-05 at the cost
 * of one IPv6 /64 per 8 sends) could fill a chosen victim's inbox with mail that authentically
 * comes from us. That is a spam-reputation and harassment vector aimed at a third party who
 * never had an account, and no amount of per-IP tightening reaches it.
 *
 * 3/hour because a legitimate user asks for one link, occasionally two (typo, or the first went
 * to spam); the fourth request inside an hour is not a person signing in.
 */
const MAGIC_TARGET_RATE_LIMIT = { limit: 3, windowSec: 3600 };

export async function handleMagicStart(
  req: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  if (req.method !== "POST")
    return authJson({ error: "method_not_allowed" }, 405);
  const now = Math.floor(Date.now() / 1000);
  const ok = await rateLimitOk(
    env,
    "_portal",
    { bucket: "portalMagic", id: clientIp(req), limit: 8, windowSec: 60 },
    now,
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
  // B5-06 — charged IN ADDITION to the per-IP budget above, and charged here: after the address
  // has been normalised (`trim().toLowerCase()`, the same normalisation the seal, the mail and
  // `getOrCreateAccountByEmail` use, so `Ada@Example.com ` cannot buy a second budget) and
  // before any of the work a send costs — the seal, the KV write and the outbound email.
  //
  // HASHED, not raw: the id becomes a key inside a Durable Object's storage, and that storage
  // outlives the request. A raw address there would turn the limiter into a durable list of
  // everyone who has ever asked for a link — exactly the record B7-03 removed from KV. `hashKey`
  // is HMAC under `KEY_HASH_PEPPER`, so the mapping is not even confirmable without the pepper.
  const targetOk = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalMagicTarget",
      id: await hashKey(email, env.KEY_HASH_PEPPER),
      ...MAGIC_TARGET_RATE_LIMIT,
    },
    now,
  );
  if (!targetOk) return authJson({ error: "rate_limited" }, 429);
  const returnTo =
    typeof body.returnTo === "string"
      ? safeReturnUrl(req, body.returnTo)
      : undefined;
  if (typeof body.returnTo === "string" && !returnTo) {
    return authJson(
      { error: "bad_request", message: "invalid return URL" },
      400,
    );
  }
  // B3-06: `mintOpaqueToken` (256 bits), not `randomId` (9 bytes = 72). This value is a BEARER
  // credential — presenting it is signing in as whoever the record names — and every sibling
  // credential on the platform is 256-bit: device tokens, browser-session cookies, the portal's
  // own download tokens. `randomId` keeps its job of minting IDs (`lic_`, `dev_`), which is what
  // 72 bits is adequate for.
  const token = mintOpaqueToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  const verifyUrl = new URL("/magic/verify", new URL(req.url).origin);
  verifyUrl.searchParams.set("token", token);
  if (returnTo) verifyUrl.searchParams.set("return_to", returnTo);
  let stored: StoredMagicRecord;
  try {
    stored = {
      email: await seal(env, email, magicSealContext(tokenHash)),
      returnTo,
    };
  } catch {
    // No usable KEK. `seal` throws rather than degrading, and the whole point is that the
    // target address is never written in the clear — so no link is minted at all.
    return authJson(
      {
        error: "misconfigured",
        message: "magic-link storage is unavailable",
      },
      503,
    );
  }
  const key = `${MAGIC_PREFIX}${tokenHash}`;
  await env.HOT.put(key, JSON.stringify(stored), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  const sent = await sendMagicLink(env, email, verifyUrl.toString());
  if (!sent) {
    await env.HOT.delete(key);
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
  // B5-11 / MG-01 — a bearer-token REDEMPTION endpoint with no budget at all, while the start
  // surface that merely sends the mail was capped at 8/min. That is the wrong way round: this
  // is the online oracle. Fails CLOSED like every other credential leg.
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalMagicVerify",
      id: clientIp(req),
      limit: 20,
      windowSec: 60,
    },
    now,
  );
  if (!ok) return htmlError(429, "Too many sign-in attempts.");
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.magicEnabled) {
    return htmlError(404, "Email sign-in is disabled.");
  }
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  const key = `${MAGIC_PREFIX}${tokenHash}`;
  const raw = await env.HOT.get(key);
  if (!raw) return htmlError(400, "This magic link has expired.");
  // Delete-on-consume, unchanged: single use, whatever happens below.
  await env.HOT.delete(key);
  let record: MagicRecord;
  try {
    const stored = JSON.parse(raw) as StoredMagicRecord;
    if (typeof stored.email !== "string") throw new Error("bad record");
    // Unsealed under the IDENTICAL context the write used. Any failure — a rotated-away KEK, a
    // blob transplanted from another record — is "this link does not resolve", which is the
    // same answer an expired one gets.
    record = {
      email: await open(env, stored.email, magicSealContext(tokenHash)),
      returnTo: stored.returnTo,
    };
  } catch {
    return htmlError(400, "This magic link has expired.");
  }
  const account = await getOrCreateAccountByEmail(db, record.email, now);
  if (account.status !== "active") return htmlError(403, "Account disabled.");
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
