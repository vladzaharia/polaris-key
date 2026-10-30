/**
 * The console's signed session cookie: how a browser that signed in through the console IdP is
 * recognised on the next request. It is HttpOnly, HMAC-signed and carries a per-session CSRF
 * token, which every state-changing `/manage/api/*` call must echo in `X-PKey-CSRF` (a value an
 * attacker page cannot read; `SameSite=Strict` is the primary defense, the header is
 * defense-in-depth). The cookie is a compact HMAC-SHA-256 token, NOT a licence JWS: a different
 * trust domain, never Ed25519-signable by anything but the Worker.
 *
 * The cookie grants nothing by itself. Authority is the principal resolved for each request
 * (`./authz.ts`, `../rbac/principal.ts`): the root rule plus the account's stored bindings.
 *
 * Two cookie shapes exist, tried in this order by `sessionFromRequest`:
 *
 *  - v2 (`pkey.admin.v2|`, ST-30): a POINTER. It names an account (`aid`) and a session row (`sid`)
 *    and carries no groups. Every request resolves it, at most every 30 seconds, to a live
 *    `account_sessions` row of an active account (`console/consoleSession.ts`, the `consoleSubject`
 *    read in Identity), so a revoked session, or a disabled or deleted account, ends access within
 *    30 s instead of at the 8 h expiry. This is the only shape the sign-in mints.
 *  - break-glass (`pkey.admin.bg1|`, ST-30c.1): a REALM with no account. It is minted only by the
 *    explicit `/manage/login?breakGlass=1` flow, for an identity whose IdP groups carry the root
 *    group, and lives one hour (`BREAK_GLASS_TTL_SECONDS`). It names no `aid` or `sid`, so no
 *    stored binding is read for it and it cannot reach account self-service routes.
 *
 * Anything else, a cookie of the retired v1 shape included (ST-30c.8), is no session.
 *
 * Why HMAC for the cookie itself: it is server-verifiable and tamper-proof with no lookup for a
 * request that carries none; the live check above is the revocable part. Each shape has its own
 * realm tag, so a token of one never verifies as another's.
 */

import type { Env } from "../../platform/env.js";
import { importHmacKey } from "../../platform/hash.js";
import { signHmacToken, verifyHmacToken } from "../../platform/hmacToken.js";
import { randomToken } from "../../platform/random.js";
import { isAdminSessionRevoked } from "./sessionRevocation.js";
import type { Principal } from "../rbac/can.js";
import { holdsRoot } from "../rbac/principal.js";

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
   * (`mbr_…`, ST-30 slice 2b); a break-glass session: the OIDC subject.
   */
  sub: string;
  name: string;
  email: string;
  groups: string[];
  /** v2: the computed root rule for this request; break-glass computes it from its own groups. */
  root?: boolean;
  /** v2: the console link's IdP subject (the `sub` above is the member id). */
  idpSub?: string;
  /** Per-session CSRF token; the SPA must echo it in `X-PKey-CSRF` on writes. */
  csrf: string;
  /** Cookie v2 only: the account and the `account_sessions` row this request resolved through. */
  aid?: string;
  sid?: string;
  /**
   * ST-30c.1: a break-glass session (`issueBreakGlassSession`): the root rule from the IdP's
   * groups at sign-in, no account, no stored bindings, an hour long. Account self-service refuses
   * it (`console/lib/accountSession.ts`).
   */
  breakGlass?: boolean;
  /** An admin-scope personal token (`ptok_…`, ST-34.3): the credential this request presented. */
  tokenId?: string;
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
   * Never part of the cookie: no issuer writes it and no reader reads it, so only the dispatcher
   * sets it, after the cookie verifies. Handlers hand it to `writeSettings()`.
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
 * Domain-separation tags mixed into the signed message (R1-02): each realm's token is signed over
 * `tag + body`, so a token of one realm, or a portal cookie, cannot verify as another's even with
 * an identical key and body. The retired v1 tag (`pkey.admin.v1|`) is gone with its reader.
 */
/** The v2 realm tag (ST-28 §2.6). */
const ADMIN_SESSION_DOMAIN_V2 = "pkey.admin.v2|";
/** The break-glass realm tag (ST-30c.1). */
const ADMIN_SESSION_DOMAIN_BG = "pkey.admin.bg1|";

/** A break-glass session's lifetime (seconds). Code, never a setting: it is the emergency path. */
export const BREAK_GLASS_TTL_SECONDS = 60 * 60;

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
  /** The IdP subject of the console link (`/me`'s prior-subject list). */
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
// Break-glass (ST-30c.1): a realm with no account
// ---------------------------------------------------------------------------

/** The body of a break-glass cookie. Strict: no field beyond these is accepted. */
interface BreakGlassClaims {
  sub: string;
  name: string;
  email: string;
  groups: string[];
  csrf: string;
  exp: number;
  authAt: number;
  stepUpAt?: number;
  bg: true;
}

const BG_KEYS: ReadonlySet<string> = new Set([
  "sub",
  "name",
  "email",
  "groups",
  "csrf",
  "exp",
  "authAt",
  "stepUpAt",
  "bg",
]);

/**
 * Mint a break-glass cookie for an identity whose groups the caller has already checked for the
 * root group. `stepUpAt` is set only when the IdP proved a fresh `auth_time`.
 */
export async function issueBreakGlassSession(
  env: Env,
  identity: SessionIdentity,
  now: number,
): Promise<{ token: string; session: AdminSession }> {
  const proved =
    typeof identity.authTime === "number" && identity.authTime <= now;
  const authAt = proved ? (identity.authTime as number) : now;
  const claims: BreakGlassClaims = {
    sub: identity.sub,
    name: identity.name ?? identity.email ?? identity.sub,
    email: identity.email ?? "",
    // N2 (ST-30c.2): only the group `holdsRoot` reads, never the IdP's whole list, so the cookie
    // stays small in an emergency and carries no more than it must. `holdsRoot` is re-checked
    // against the env on every request.
    groups: env.PLATFORM_ADMIN_GROUP
      ? identity.groups.filter((g) => g === env.PLATFORM_ADMIN_GROUP)
      : [],
    csrf: randomToken(16),
    exp: now + BREAK_GLASS_TTL_SECONDS,
    authAt,
    ...(proved ? { stepUpAt: authAt } : {}),
    bg: true,
  };
  const token = await signHmacToken(
    await sessionKey(env),
    ADMIN_SESSION_DOMAIN_BG,
    claims,
  );
  return {
    token,
    session: {
      sub: claims.sub,
      name: claims.name,
      email: claims.email,
      groups: claims.groups,
      csrf: claims.csrf,
      exp: claims.exp,
      authAt,
      ...(proved ? { stepUpAt: authAt } : {}),
      breakGlass: true,
    },
  };
}

/** Verify a break-glass token's signature and exact shape; no lookup. `null` on anything else. */
async function verifyBreakGlass(
  env: Env,
  token: string | null,
  now: number,
): Promise<BreakGlassClaims | null> {
  const payload = await verifyHmacToken(token, ADMIN_SESSION_DOMAIN_BG, () =>
    sessionKey(env),
  );
  if (
    payload === undefined ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    return null;
  if (Object.keys(payload).some((k) => !BG_KEYS.has(k))) return null;
  const c = payload as Partial<BreakGlassClaims>;
  if (
    c.bg !== true ||
    typeof c.sub !== "string" ||
    !c.sub ||
    typeof c.name !== "string" ||
    typeof c.email !== "string" ||
    !Array.isArray(c.groups) ||
    c.groups.some((g) => typeof g !== "string") ||
    typeof c.csrf !== "string" ||
    !c.csrf ||
    typeof c.exp !== "number" ||
    !Number.isFinite(c.exp) ||
    c.exp <= now ||
    // A body that outlives the realm's lifetime was not minted by this code.
    c.exp > now + BREAK_GLASS_TTL_SECONDS ||
    typeof c.authAt !== "number" ||
    !Number.isFinite(c.authAt) ||
    (c.stepUpAt !== undefined &&
      (typeof c.stepUpAt !== "number" || !Number.isFinite(c.stepUpAt)))
  )
    return null;
  return c as BreakGlassClaims;
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

/** The cookie of a break-glass session: the same attributes, an hour long. */
export function buildBreakGlassCookie(token: string): string {
  return [
    `${ADMIN_COOKIE}=${token}`,
    ...ADMIN_COOKIE_ATTRS,
    `Max-Age=${BREAK_GLASS_TTL_SECONDS}`,
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
 * cannot ask (no database) fails closed. A break-glass cookie (ST-30c.1) is checked against the
 * sign-out mark. Any other value, a retired v1 cookie included, is no session.
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
  const bg = await verifyBreakGlass(env, token, now);
  if (bg) {
    const session: AdminSession = {
      sub: bg.sub,
      name: bg.name,
      email: bg.email,
      groups: bg.groups,
      // The root rule from the groups the IdP asserted at this sign-in, which the one-hour realm
      // bounds; the group removed from the env roots no one on the next request.
      root: holdsRoot(env, bg.groups),
      csrf: bg.csrf,
      exp: bg.exp,
      authAt: bg.authAt,
      ...(bg.stepUpAt !== undefined ? { stepUpAt: bg.stepUpAt } : {}),
      breakGlass: true,
    };
    return (await isAdminSessionRevoked(env, session, BREAK_GLASS_TTL_SECONDS))
      ? null
      : session;
  }
  return null;
}
