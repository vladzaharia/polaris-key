import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { clientIp, rateLimitOk } from "../rateLimit.js";
import { platformOidcConfig } from "../platformOidc.js";
import { randomId } from "../crypto.js";
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

const FLOW_TTL_SECONDS = 600;
const ALLOWED_ID_TOKEN_ALGS = ["RS256", "ES256", "EdDSA"];
const FLOW_PREFIX = "portal:oidc-flow:";
const MAGIC_PREFIX = "portal:magic:";

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

function safeReturnTo(req: Request, raw: string | null): string | undefined {
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
  await env.HOT.put(`${FLOW_PREFIX}${state}`, JSON.stringify(flow), {
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
  const raw = await env.HOT.get(`${FLOW_PREFIX}${state}`);
  if (!raw) return htmlError(400, "This sign-in link has expired.");
  const flow = JSON.parse(raw) as FlowRecord;
  await env.HOT.delete(`${FLOW_PREFIX}${state}`);

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
  await env.HOT.put(`${MAGIC_PREFIX}${token}`, JSON.stringify(record), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  const sent = await sendMagicLink(env, email, verifyUrl.toString());
  if (!sent) {
    await env.HOT.delete(`${MAGIC_PREFIX}${token}`);
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
  const raw = await env.HOT.get(`${MAGIC_PREFIX}${token}`);
  if (!raw) return htmlError(400, "This magic link has expired.");
  await env.HOT.delete(`${MAGIC_PREFIX}${token}`);
  const record = JSON.parse(raw) as MagicRecord;
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

export function handlePortalLogout(): Response {
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
