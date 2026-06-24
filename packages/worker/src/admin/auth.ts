/**
 * Interactive admin sign-in (browser, cookie-based) — distinct from the SDK/CLI OIDC
 * enrollment in ../oidc.ts (which mints license tokens). Here we just prove an operator's
 * identity + groups and drop a signed session cookie.
 *
 * - `GET /admin/login`     -> 302 to the IdP authorize endpoint (PKCE, state in KV).
 * - `GET /admin/callback`  -> exchange the code, verify the ID token, gate on a platform
 *                             OR product admin group, set the session cookie, 302 to /admin/.
 *
 * The token-exchange + ID-token verification is delegated to an injectable `IdTokenVerifier`
 * so tests can drive the flow without a live IdP (production wires the jose-backed verifier).
 * The platform IdP config comes from env vars (ADMIN_OIDC_*), keeping admin auth independent
 * of any single product's OIDC client.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { listProducts } from "../repo.js";
import { clientIp, rateLimitOk } from "../rateLimit.js";
import { hasAnyAdminGrant } from "./authz.js";
import { buildSessionCookie, issueSession, type SessionIdentity } from "./session.js";

const FLOW_TTL_SECONDS = 600;
const ADMIN_FLOW_PREFIX = "admin:flow:";

interface FlowRecord {
  verifier: string;
  nonce: string;
  redirectUri: string;
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

// ── base64url / PKCE ──────────────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(randomBytes(32));
  const digest = await crypto.subtle.digest("SHA-256", toAB(new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

function adminIssuer(env: Env): string | undefined {
  return typeof env.ADMIN_OIDC_ISSUER === "string" ? env.ADMIN_OIDC_ISSUER : undefined;
}
function adminClientId(env: Env): string | undefined {
  return typeof env.ADMIN_OIDC_CLIENT_ID === "string" ? env.ADMIN_OIDC_CLIENT_ID : undefined;
}

function mapClaims(payload: Record<string, unknown>): SessionIdentity {
  const groups = Array.isArray(payload.groups)
    ? (payload.groups.filter((g) => typeof g === "string") as string[])
    : [];
  const name =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name].filter((s) => typeof s === "string").join(" ").trim() ||
    (typeof payload.email === "string" ? payload.email : "");
  return {
    sub: String(payload.sub ?? ""),
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: name || undefined,
    groups,
  };
}

/** The production verifier: token exchange against the IdP + jose JWKS verification. */
export const joseIdTokenVerifier: IdTokenVerifier = {
  async verify({ code, flow, env }) {
    const issuer = adminIssuer(env);
    const clientId = adminClientId(env);
    if (!issuer || !clientId) return null;
    const clientSecret =
      typeof env.ADMIN_OIDC_CLIENT_SECRET === "string" ? env.ADMIN_OIDC_CLIENT_SECRET : undefined;
    const tokenRes = await fetch(`${issuer.replace(/\/$/, "")}/api/oidc/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirectUri,
        client_id: clientId,
        code_verifier: flow.verifier,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
    });
    if (!tokenRes.ok) return null;
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) return null;
    const jwks = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/.well-known/jwks.json`));
    try {
      const verified = await jwtVerify(tokens.id_token, jwks, {
        issuer,
        audience: clientId,
        algorithms: ["RS256", "ES256", "EdDSA"],
      });
      const claims = verified.payload as Record<string, unknown>;
      // Reject unconditionally on a missing or mismatched nonce — a token with no nonce
      // must never satisfy the binding to this flow (replay / token-injection defense).
      if (typeof claims.nonce !== "string" || claims.nonce !== flow.nonce) return null;
      return mapClaims(claims);
    } catch {
      return null;
    }
  },
};

// ── handlers ──────────────────────────────────────────────────────────────────
function htmlError(status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>Sign-in</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h1>${message}</h1>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** GET /admin/login — start PKCE + redirect to the IdP authorize endpoint. */
export async function handleAdminLogin(req: Request, env: Env): Promise<Response> {
  const ok = await rateLimitOk(
    env,
    "_admin",
    { bucket: "adminLogin", id: clientIp(req), limit: 20, windowSec: 60 },
    Math.floor(Date.now() / 1000),
  );
  if (!ok) return htmlError(429, "Too many sign-in attempts. Please wait and try again.");
  const issuer = adminIssuer(env);
  const clientId = adminClientId(env);
  if (!issuer || !clientId) return htmlError(500, "Admin sign-in is not configured.");
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const { verifier, challenge } = await pkce();
  const redirectUri = `${new URL(req.url).origin}/admin/callback`;
  const flow: FlowRecord = { verifier, nonce, redirectUri };
  await env.HOT.put(`${ADMIN_FLOW_PREFIX}${state}`, JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });

  const authorize = new URL(`${issuer.replace(/\/$/, "")}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email profile groups");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return new Response(null, { status: 302, headers: { location: authorize.toString() } });
}

/** GET /admin/callback — verify, gate on an admin group, set the session cookie. */
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
    { bucket: "adminCallback", id: clientIp(req), limit: 20, windowSec: 60 },
    Math.floor(Date.now() / 1000),
  );
  if (!ok) return htmlError(429, "Too many sign-in attempts. Please wait and try again.");
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return htmlError(400, "Missing authorization code.");
  const raw = await env.HOT.get(`${ADMIN_FLOW_PREFIX}${state}`);
  if (!raw) return htmlError(400, "This sign-in link has expired. Try again.");
  const flow = JSON.parse(raw) as FlowRecord;
  await env.HOT.delete(`${ADMIN_FLOW_PREFIX}${state}`);

  const identity = await verifier.verify({ code, flow, env });
  if (!identity || !identity.sub) return htmlError(401, "Sign-in could not be verified.");

  const products = await listProducts(db);
  if (!hasAnyAdminGrant(env, identity.groups, products)) {
    return htmlError(403, "Your account is not an administrator of any product.");
  }

  const { token } = await issueSession(env, identity, now);
  return new Response(null, {
    status: 302,
    headers: { location: "/admin/", "set-cookie": buildSessionCookie(token) },
  });
}
