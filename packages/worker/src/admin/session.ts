/**
 * Admin-portal session: a signed, HttpOnly cookie that proves an interactive OIDC
 * sign-in whose `groups` carried either the platform-admin group or a product admin
 * group.
 *
 * The license hot path uses a bearer *token*; the admin SPA is a BROWSER, so it uses a
 * cookie instead. The cookie is a compact HMAC-SHA-256 token (NOT a license JWS — a
 * different trust domain, never Ed25519-signable by anything but the Worker) carrying
 * the verified `sub`/`name`/`email`, the granting `groups`, an expiry, and a per-session
 * **CSRF token**. Cookie auth is vulnerable to cross-site POSTs, so every state-changing
 * `/manage/api/*` call must echo that CSRF token in the `X-PKey-CSRF` header — a value an
 * attacker page cannot read (it's not in a readable cookie, and the API is same-origin
 * only). `SameSite=Strict` is the primary defense; the header is defense-in-depth
 * (double-submit by way of an unreadable secret).
 *
 * Why HMAC and not a KV-backed opaque session: it keeps admin auth stateless (no KV
 * round-trip per request, no session GC) while still being server-verifiable and
 * tamper-proof. Sessions are short-lived, so statelessness costs little.
 */

import type { Env } from "../env.js";

/** Cookie name for the admin session. Distinct prefix so it can't collide. */
export const ADMIN_COOKIE = "pkey_admin";

/** The CSRF header the SPA must echo on every mutation (double-submit). */
export const CSRF_HEADER = "X-PKey-CSRF";

/** Admin session lifetime (seconds). Short — re-auth is one redirect away. */
const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** The verified, server-trusted session claims. */
export interface AdminSession {
  /** OIDC subject — the audit actor is ALWAYS taken from here, never a request field. */
  sub: string;
  name: string;
  email: string;
  groups: string[];
  /** Per-session CSRF token; the SPA must echo it in `X-PKey-CSRF` on writes. */
  csrf: string;
  /** Epoch-seconds expiry. */
  exp: number;
}

// ---------------------------------------------------------------------------
// base64url + HMAC (kept local; identical scheme to the rest of the worker).
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(new TextEncoder().encode(s));
}

function base64UrlDecodeToString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(out);
}

/** Constant-time-ish comparison of two equal-length strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The HMAC key for session signing. Uses ONLY `ADMIN_SESSION_SECRET` and fails closed when
 * it is absent/empty — never sign or verify a session with a guessable fallback key, since
 * that would let anyone forge an admin cookie. A missing secret is a deployment error.
 */
async function sessionKey(env: Env): Promise<CryptoKey> {
  const material = env.ADMIN_SESSION_SECRET;
  if (!material) throw new Error("ADMIN_SESSION_SECRET is required");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function randomToken(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

// ---------------------------------------------------------------------------
// Issue / verify
// ---------------------------------------------------------------------------

/** Identity shape this module signs — just the bits the session carries. */
export interface SessionIdentity {
  sub: string;
  name?: string;
  email?: string;
  groups: string[];
}

/** Mint a signed session token for a verified admin identity. */
export async function issueSession(
  env: Env,
  identity: SessionIdentity,
  now: number,
): Promise<{ token: string; session: AdminSession }> {
  const session: AdminSession = {
    sub: identity.sub,
    name: identity.name ?? identity.email ?? identity.sub,
    email: identity.email ?? "",
    groups: identity.groups,
    csrf: randomToken(16),
    exp: now + SESSION_TTL_SECONDS,
  };
  const body = base64UrlEncodeString(JSON.stringify(session));
  const key = await sessionKey(env);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const token = `${body}.${base64UrlEncode(new Uint8Array(sig))}`;
  return { token, session };
}

/** Verify a session token; returns the claims, or null on any tamper/expiry. */
export async function verifySession(
  env: Env,
  token: string | null,
  now: number,
): Promise<AdminSession | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = await sessionKey(env);
  let ok: boolean;
  try {
    const expected = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    ok = safeEqual(sig, base64UrlEncode(new Uint8Array(expected)));
  } catch {
    return null;
  }
  if (!ok) return null;

  let session: AdminSession;
  try {
    session = JSON.parse(base64UrlDecodeToString(body)) as AdminSession;
  } catch {
    return null;
  }
  if (typeof session.exp !== "number" || session.exp <= now) return null;
  if (!session.sub || !Array.isArray(session.groups)) return null;
  return session;
}

// ---------------------------------------------------------------------------
// Cookie (de)serialization
// ---------------------------------------------------------------------------

/** Pull the admin session token out of a Cookie header. */
function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ADMIN_COOKIE) return rest.join("=");
  }
  return null;
}

/** Build the Set-Cookie value: HttpOnly + Secure + SameSite=Strict, path /manage. */
export function buildSessionCookie(token: string): string {
  return [
    `${ADMIN_COOKIE}=${token}`,
    "Path=/manage",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

/** Build a clearing cookie for sign-out. */
export function buildClearCookie(): string {
  return [
    `${ADMIN_COOKIE}=`,
    "Path=/manage",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; ");
}

/** Read the session out of a request's Cookie header + verify it. */
export async function sessionFromRequest(
  env: Env,
  req: Request,
  now: number,
): Promise<AdminSession | null> {
  return verifySession(env, readSessionCookie(req.headers.get("cookie")), now);
}
