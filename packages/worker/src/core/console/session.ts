/**
 * Admin-portal session: a signed, HttpOnly cookie that proves an interactive OIDC sign-in
 * whose `groups` carried the platform-admin group. That is the only grant there is — product
 * admin groups do not exist as a privilege level (see ./authz.ts), so a session either
 * carries full platform authority or it was never issued.
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
 * ST-30 slice 2a: cookie v2 (`pkey.admin.v2|`) carries the account id and a session id instead of
 * the IdP's `sub` and `groups`. It is only a pointer: every request resolves it, at most every 30
 * seconds, to a live `account_sessions` row of an active account (`console/consoleSession.ts`, the
 * `consoleSubject` read in Identity), so a revoked session, a disabled or deleted account ends
 * access within 30 s instead of at the 8 h expiry. A v1 cookie (the IdP `sub` and `groups`, signed
 * before this deploy) is still read until it expires and is never minted by the sign-in again.
 *
 * Why HMAC for the cookie itself: it is server-verifiable and tamper-proof with no lookup for a
 * request that carries none; the live check above is the revocable part.
 */

import type { Env } from "../../platform/env.js";
import { importHmacKey } from "../../platform/hash.js";
import { signHmacToken, verifyHmacToken } from "../../platform/hmacToken.js";
import { randomToken } from "../../platform/random.js";
import { isAdminSessionRevoked } from "./sessionRevocation.js";
import type { Principal } from "../rbac/can.js";

/**
 * Cookie name for the admin session.
 *
 * `__Host-` is not decoration — it is the only cookie property a *sibling subdomain* cannot
 * defeat. Without it, anyone who controls (or has XSS on) any `*.plrs.im` host can set
 * `pkey_admin=<their token>; Domain=plrs.im; Path=/manage/api`; RFC 6265 §5.4 orders cookies
 * by descending path length, so that shadow is sent FIRST and wins (R1-08). The `__Host-`
 * prefix makes the browser refuse such a cookie outright: a `__Host-` cookie must be
 * `Secure`, must carry no `Domain`, and must be `Path=/`.
 *
 * That last requirement is why the cookie is no longer scoped to `Path=/manage`, and the
 * trade is worth taking. Path scoping was never a boundary here: R1-09 established that any
 * same-origin script reaches `/manage/api/*` with `credentials: "same-origin"` no matter how
 * the cookie is pathed, and `Path` does nothing at all against a sibling-subdomain writer —
 * which is the attack this closes. What remains is `HttpOnly` + `Secure` + `SameSite=Strict`
 * + the per-session CSRF double-submit, plus a browser-enforced guarantee that only THIS host
 * can have set the value.
 *
 * Renaming invalidates sessions issued before the deploy; admins re-auth with one redirect.
 */
export const ADMIN_COOKIE = "__Host-pkey_admin";

/** The CSRF header the SPA must echo on every mutation (double-submit). */
export const CSRF_HEADER = "X-PKey-CSRF";

/** Admin session lifetime (seconds). Short — re-auth is one redirect away. Code, never a
 *  runtime setting (A-13: a longer session would widen a session compromise). */
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const SESSION_TTL_SECONDS = ADMIN_SESSION_TTL_SECONDS;

/**
 * How stale a console session check may be (seconds, ST-28 §2.6 "Per request"): a revoked session,
 * a disabled or deleted account or a sign-out ends access within this, not at the 8 h expiry.
 * Code, never a runtime setting (a longer window would widen a revoked session's reach).
 */
export const LIVE_CHECK_SECONDS = 30;

/** The verified, server-trusted session claims. */
export interface AdminSession {
  /**
   * The audit actor, ALWAYS taken from here, never a request field. A v2 session: the member id
   * (`mbr_…`, ST-30 slice 2b); a v1 session: the OIDC subject.
   */
  sub: string;
  name: string;
  email: string;
  groups: string[];
  /** v2: the computed root rule for this request; absent on a v1 session (groups only). */
  root?: boolean;
  /** v2: the console link's IdP subject (the `sub` above is the member id). */
  idpSub?: string;
  /** Per-session CSRF token; the SPA must echo it in `X-PKey-CSRF` on writes. */
  csrf: string;
  /** Cookie v2 only: the account and the `account_sessions` row this request resolved through. */
  aid?: string;
  sid?: string;
  /** Epoch-seconds expiry. */
  exp: number;
  /**
   * I-12: when the operator last authenticated interactively (epoch seconds): the IdP's
   * `auth_time` when it sent one, else the callback time. The relink tool's step-up reads it. A
   * session minted before this field existed has none, and counts as not stepped up.
   */
  authAt?: number;
  /**
   * When the operator re-authenticated through a `prompt=login` step-up flow that the
   * IdP proved with `auth_time`. An ordinary sign-in never sets it, so only an explicit step-up
   * satisfies `isSteppedUp`.
   */
  stepUpAt?: number;
  /**
   * ST-29: the principal the console dispatcher resolved for THIS request (`console/routes.ts`).
   * Never part of the cookie: `issueSession` does not write it and `verifySession` drops it, so
   * only the dispatcher sets it, after the cookie verifies. Handlers hand it to `writeSettings()`.
   */
  principal?: Principal;
}

/** I-12 (S-16 §5.4 item 9): the relink tool needs an operator sign-in no older than this. */
export const STEP_UP_MAX_AGE_SECONDS = 5 * 60;

/** True when the session's interactive sign-in is recent enough for a step-up action. */
export function isSteppedUp(session: AdminSession, now: number): boolean {
  return (
    typeof session.stepUpAt === "number" &&
    session.stepUpAt <= now + 60 &&
    now - session.stepUpAt <= STEP_UP_MAX_AGE_SECONDS
  );
}

// ---------------------------------------------------------------------------
// Key + realm tag. The token format itself is `platform/hmacToken.ts` (shared with the portal
// session; P0-15), and it is byte-for-byte the format this file used to implement locally.
// ---------------------------------------------------------------------------

/**
 * The HMAC key for session signing. Uses ONLY `ADMIN_SESSION_SECRET` and fails closed when
 * it is absent/empty — never sign or verify a session with a guessable fallback key, since
 * that would let anyone forge an admin cookie. A missing secret is a deployment error.
 */
async function sessionKey(env: Env): Promise<CryptoKey> {
  const material = env.ADMIN_SESSION_SECRET;
  if (!material) throw new Error("ADMIN_SESSION_SECRET is required");
  return importHmacKey(material);
}

/**
 * Domain-separation tag mixed into the signed message (R1-02).
 *
 * The admin and portal realms once shared a raw key (the portal fell back to
 * `ADMIN_SESSION_SECRET`; that fallback is gone). Before this tag, the only thing stopping a portal
 * cookie (obtainable by anyone with an email address) from being replayed as an admin cookie
 * was that the two JSON bodies happened to carry different field names: add a `sub` and a
 * `groups` array to `PortalSession` — both natural next features — and the realms collapse.
 *
 * Signing `"pkey.admin.v1|" + body` instead of `body` makes the realms cryptographically
 * distinct regardless of payload shape: a portal token's signature is over a different
 * message, so it cannot verify here even with an identical key and an identical body. The
 * `.v1` allows a future rotation of the scheme itself.
 */
const ADMIN_SESSION_DOMAIN = "pkey.admin.v1|";
/** The v2 realm tag (ST-28 §2.6): a v1 token's signature is over a different message. */
const ADMIN_SESSION_DOMAIN_V2 = "pkey.admin.v2|";

// ---------------------------------------------------------------------------
// Issue / verify
// ---------------------------------------------------------------------------

/** Identity shape this module signs — just the bits the session carries. */
export interface SessionIdentity {
  sub: string;
  name?: string;
  email?: string;
  groups: string[];
  /** The `email_verified` claim was `true` (the account keeps an unverified address as nothing). */
  emailVerified?: boolean;
  /** The ID token's `auth_time` (epoch seconds), when the IdP sent one. */
  authTime?: number;
  /** The callback ran a step-up flow and the IdP proved a fresh `auth_time`. */
  stepUp?: boolean;
}

/**
 * Mint a v1 token (IdP `sub` + `groups` in the cookie). The sign-in no longer does: it mints v2
 * (`issueSessionV2`). This stays so the reader's v1 branch, which honours cookies signed before
 * the deploy until they expire, has a minter to be tested with. Delete both with the v1 reader
 * once the last v1 cookie has expired (8 h after the deploy).
 */
export async function issueSession(
  env: Env,
  identity: SessionIdentity,
  now: number,
): Promise<{ token: string; session: AdminSession }> {
  const authAt =
    typeof identity.authTime === "number" && identity.authTime <= now
      ? identity.authTime
      : now;
  const session: AdminSession = {
    sub: identity.sub,
    name: identity.name ?? identity.email ?? identity.sub,
    email: identity.email ?? "",
    groups: identity.groups,
    csrf: randomToken(16),
    exp: now + SESSION_TTL_SECONDS,
    // A future auth_time is clock skew or a lie; never let it extend a step-up window.
    authAt,
    ...(identity.stepUp && typeof identity.authTime === "number"
      ? { stepUpAt: authAt }
      : {}),
  };
  const token = await signHmacToken(
    await sessionKey(env),
    ADMIN_SESSION_DOMAIN,
    session,
  );
  return { token, session };
}

/** Verify a session token; returns the claims, or null on any tamper/expiry. */
export async function verifySession(
  env: Env,
  token: string | null,
  now: number,
): Promise<AdminSession | null> {
  const payload = await verifyHmacToken(token, ADMIN_SESSION_DOMAIN, () =>
    sessionKey(env),
  );
  if (payload === undefined) return null;
  const session = payload as AdminSession;
  if (typeof session.exp !== "number" || session.exp <= now) return null;
  if (!session.sub || !Array.isArray(session.groups)) return null;
  // The principal is resolved per request, never carried: a cookie body naming one is ignored.
  delete session.principal;
  // A v1 cookie names no account: stored bindings (ST-31.2) are read for a v2 session only.
  delete session.aid;
  delete session.sid;
  return session;
}

// ---------------------------------------------------------------------------
// Cookie v2 (ST-30): account id + session id, resolved on every request
// ---------------------------------------------------------------------------

/** What a v2 cookie says. Nothing in it is trusted for authority: `aid` and `sid` only point. */
export interface ConsoleCookieClaims {
  aid: string;
  sid: string;
  name: string;
  email: string;
  csrf: string;
  exp: number;
  authAt: number;
  stepUpAt?: number;
}

/** The account's current console identity, as Identity reads it (`consoleSubject`). */
export interface ResolvedConsoleSubject {
  /** The member id (`mbr_…`, `memberId.ts`): the audit actor, the limiter key, what `/me` shows. */
  sub: string;
  /** The IdP subject of the console link. Only for ending a v1 cookie's sign-out mark. */
  idpSub: string;
  name: string;
  email: string;
  /** The groups the console IdP last asserted, while that assertion is fresh (empty otherwise). */
  groups: string[];
  /** The computed root rule (`rootRuleHolds`) for this request. */
  root: boolean;
}

/** Resolves a v2 cookie to its live subject, or `null` when it no longer holds. */
export type LiveSubject = (
  claims: ConsoleCookieClaims,
) => Promise<ResolvedConsoleSubject | null>;

/** Mint a v2 cookie for a session Identity just opened (`aid` + `sid`). */
export async function issueSessionV2(
  env: Env,
  input: {
    aid: string;
    sid: string;
    name: string;
    email: string;
    authTime?: number;
    stepUp?: boolean;
  },
  now: number,
): Promise<{ token: string; claims: ConsoleCookieClaims }> {
  const authAt =
    typeof input.authTime === "number" && input.authTime <= now
      ? input.authTime
      : now;
  const claims: ConsoleCookieClaims = {
    aid: input.aid,
    sid: input.sid,
    name: input.name,
    email: input.email,
    csrf: randomToken(16),
    exp: now + SESSION_TTL_SECONDS,
    authAt,
    ...(input.stepUp && typeof input.authTime === "number"
      ? { stepUpAt: authAt }
      : {}),
  };
  const token = await signHmacToken(
    await sessionKey(env),
    ADMIN_SESSION_DOMAIN_V2,
    claims,
  );
  return { token, claims };
}

/** Verify a v2 token's signature and shape; no lookup. `null` on any tamper or expiry. */
async function verifyClaimsV2(
  env: Env,
  token: string | null,
  now: number,
): Promise<ConsoleCookieClaims | null> {
  const payload = await verifyHmacToken(token, ADMIN_SESSION_DOMAIN_V2, () =>
    sessionKey(env),
  );
  if (payload === undefined || payload === null || typeof payload !== "object")
    return null;
  const c = payload as Partial<ConsoleCookieClaims>;
  if (
    typeof c.exp !== "number" ||
    c.exp <= now ||
    typeof c.aid !== "string" ||
    !c.aid ||
    typeof c.sid !== "string" ||
    !c.sid ||
    typeof c.csrf !== "string" ||
    typeof c.authAt !== "number"
  )
    return null;
  return {
    aid: c.aid,
    sid: c.sid,
    name: typeof c.name === "string" ? c.name : "",
    email: typeof c.email === "string" ? c.email : "",
    csrf: c.csrf,
    exp: c.exp,
    authAt: c.authAt,
    ...(typeof c.stepUpAt === "number" ? { stepUpAt: c.stepUpAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cookie (de)serialization
// ---------------------------------------------------------------------------

/**
 * Pull the admin session token out of a Cookie header.
 *
 * Reads EVERY match, not the first. Taking the first was the other half of R1-08: the browser
 * sends the longest-path cookie first, so an attacker-planted duplicate is exactly what a
 * first-match parser picks up. Two different values for one session cookie is never a
 * legitimate state — with `__Host-` the browser will not even produce one — so ambiguity is
 * resolved by failing closed rather than by choosing a winner.
 */
function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const values = new Set<string>();
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ADMIN_COOKIE) values.add(rest.join("="));
  }
  if (values.size !== 1) return null;
  return values.values().next().value ?? null;
}

/** The attributes `__Host-` requires (`Secure`, no `Domain`, `Path=/`) plus SameSite/HttpOnly. */
const ADMIN_COOKIE_ATTRS = ["Path=/", "HttpOnly", "Secure", "SameSite=Strict"];

/** Build the Set-Cookie value: `__Host-` prefixed, HttpOnly + Secure + SameSite=Strict. */
export function buildSessionCookie(token: string): string {
  return [
    `${ADMIN_COOKIE}=${token}`,
    ...ADMIN_COOKIE_ATTRS,
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

/** Build a clearing cookie for sign-out. Attributes must match, or the browser keeps it. */
export function buildClearCookie(): string {
  return [`${ADMIN_COOKIE}=`, ...ADMIN_COOKIE_ATTRS, "Max-Age=0"].join("; ");
}

/**
 * Read the session out of a request's Cookie header + verify it.
 *
 * A v2 cookie is a pointer: `live` (the console layer's cached `consoleSubject` read) says whether
 * it still holds and who it is today. Without `live` a v2 cookie is refused, so a caller that
 * cannot ask (no database) fails closed. A v1 cookie is read as before, for the 8 h it can still
 * live after the deploy, and checked against the sign-out mark.
 */
export async function sessionFromRequest(
  env: Env,
  req: Request,
  now: number,
  live?: LiveSubject,
): Promise<AdminSession | null> {
  const token = readSessionCookie(req.headers.get("cookie"));
  const claims = await verifyClaimsV2(env, token, now);
  if (claims) {
    if (!live) return null;
    const subject = await live(claims);
    if (!subject) return null;
    return {
      sub: subject.sub,
      name: subject.name || claims.name || subject.email || subject.sub,
      email: subject.email || claims.email,
      groups: subject.groups,
      root: subject.root,
      idpSub: subject.idpSub,
      csrf: claims.csrf,
      exp: claims.exp,
      authAt: claims.authAt,
      ...(claims.stepUpAt !== undefined ? { stepUpAt: claims.stepUpAt } : {}),
      aid: claims.aid,
      sid: claims.sid,
    };
  }
  const session = await verifySession(env, token, now);
  if (!session) return null;
  // Sign-out is server-side.
  return (await isAdminSessionRevoked(env, session)) ? null : session;
}
