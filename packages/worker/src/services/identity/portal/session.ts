import type { Env } from "../../../core/platform.js";
import { ACCOUNT_SESSION_COOKIE } from "../../../core/accountCookies.js";

/**
 * `__Host-` prefixed for the same reason as the admin cookie (R1-08): it is the only way to
 * stop a sibling `*.plrs.im` host from planting a `Domain=`-scoped duplicate that RFC 6265
 * §5.4 orders ahead of the real one. The portal cookie is already `Path=/` with no `Domain`,
 * so the prefix costs nothing here beyond invalidating sessions issued before the deploy.
 */
export const PORTAL_COOKIE = ACCOUNT_SESSION_COOKIE;
export const PORTAL_CSRF_HEADER = "X-PKey-Portal-CSRF";

export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface PortalSession {
  accountId: string;
  name: string;
  email: string;
  csrf: string;
  exp: number;
  /** When the person signed in (unix seconds). Absent on sessions issued before PX-W5; see
   *  `portalSessionAuthenticatedAt`, which derives it from `exp` for those. */
  iat?: number;
  /** I-07: the server-side session (`account_sessions`) this cookie names, by a random id whose
   *  peppered hash is the row's key. A cookie without one, or whose row is revoked, expired or
   *  gone, is refused by the portal (`accountSessions.ts`), which is what makes a session
   *  revocable and "sign out everywhere" real. */
  sid?: string;
}

export interface PortalSessionIdentity {
  accountId: string;
  name?: string | null;
  email?: string | null;
  /** The server-side session id (`startAccountSession` mints it). */
  sid?: string;
}

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

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

function randomToken(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Domain-separation tag mixed into the signed message (R1-02) — the portal counterpart of
 * `admin/session.ts`'s `ADMIN_SESSION_DOMAIN`. See that file for the full rationale. The
 * short version: the key below may legitimately be the ADMIN key, and a shared key with no
 * realm tag meant the boundary between "anyone with an email address" and "platform
 * administrator" was a coincidence of JSON field names.
 */
const PORTAL_SESSION_DOMAIN = "pkey.portal.v1|";

function signingInput(body: string): Uint8Array {
  return new TextEncoder().encode(PORTAL_SESSION_DOMAIN + body);
}

/**
 * The fallback to `ADMIN_SESSION_SECRET` is kept — `wrangler.toml` documents
 * `PORTAL_SESSION_SECRET` as optional, and removing it would silently 500 every portal
 * session on deployments that rely on it. It is now SAFE rather than merely lucky: with
 * distinct domain tags on both sides, a token signed for one realm cannot verify in the
 * other even when the two realms share one raw key and one payload shape. Setting a separate
 * `PORTAL_SESSION_SECRET` is still preferred (it makes rotating one realm independent).
 */
async function sessionKey(env: Env): Promise<CryptoKey> {
  const material = env.PORTAL_SESSION_SECRET ?? env.ADMIN_SESSION_SECRET;
  if (!material) throw new Error("PORTAL_SESSION_SECRET is required");
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(material)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Mints a portal session. `iat` is when the holder last proved who they are, which every
 * step-up reads (`portalSessionAuthenticatedAt`). A direct sign-in proves it now, the default.
 * A session minted WITHOUT a sign-in of its own (PX-W14: a device signed in by another device's
 * approval) passes `authenticatedAt`, the approver's sign-in time, so the new session is never
 * fresher than the proof behind it; it is clamped to `now` so it can never be in the future.
 */
export async function issuePortalSession(
  env: Env,
  identity: PortalSessionIdentity,
  now: number,
  opts: { authenticatedAt?: number } = {},
): Promise<{ token: string; session: PortalSession }> {
  const iat =
    typeof opts.authenticatedAt === "number" &&
    Number.isFinite(opts.authenticatedAt)
      ? Math.min(Math.floor(opts.authenticatedAt), now)
      : now;
  const session: PortalSession = {
    accountId: identity.accountId,
    name: identity.name ?? identity.email ?? identity.accountId,
    email: identity.email ?? "",
    csrf: randomToken(16),
    exp: now + SESSION_TTL_SECONDS,
    iat,
    ...(identity.sid ? { sid: identity.sid } : {}),
  };
  const body = base64UrlEncodeString(JSON.stringify(session));
  const key = await sessionKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, signingInput(body));
  const token = `${body}.${base64UrlEncode(new Uint8Array(sig))}`;
  return { token, session };
}

export async function verifyPortalSession(
  env: Env,
  token: string | null,
  now: number,
): Promise<PortalSession | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await sessionKey(env);
  let expected: ArrayBuffer;
  try {
    expected = await crypto.subtle.sign("HMAC", key, signingInput(body));
  } catch {
    return null;
  }
  if (!safeEqual(sig, base64UrlEncode(new Uint8Array(expected)))) return null;

  let session: PortalSession;
  try {
    session = JSON.parse(base64UrlDecodeToString(body)) as PortalSession;
  } catch {
    return null;
  }
  if (!session.accountId || typeof session.exp !== "number") return null;
  if (session.exp <= now) return null;
  return session;
}

/** Reads EVERY match and fails closed on a duplicate — see `admin/session.ts` (R1-08). */
function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const values = new Set<string>();
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === PORTAL_COOKIE) values.add(rest.join("="));
  }
  if (values.size !== 1) return null;
  return values.values().next().value ?? null;
}

export function buildPortalSessionCookie(token: string): string {
  return [
    `${PORTAL_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function buildPortalClearCookie(): string {
  return [
    `${PORTAL_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export async function portalSessionFromRequest(
  env: Env,
  req: Request,
  now: number,
): Promise<PortalSession | null> {
  return verifyPortalSession(
    env,
    readSessionCookie(req.headers.get("cookie")),
    now,
  );
}

/**
 * When this session's holder last proved who they are: the sign-in that minted the cookie.
 *
 * PX-W5 uses it as the portal's step-up for the one action that hands out a new credential
 * (G7, "Get a new key"): the portal has no passkeys or re-prompt yet (S-16 I-14/I-15), so a
 * RECENT sign-in is the strongest proof of presence it can ask for, and a stolen 14-day cookie
 * that is days old cannot mint a key. A session issued before `iat` existed is dated from its
 * `exp`, which is exact because every session is issued with the same TTL.
 */
export function portalSessionAuthenticatedAt(session: PortalSession): number {
  return typeof session.iat === "number"
    ? session.iat
    : session.exp - SESSION_TTL_SECONDS;
}
