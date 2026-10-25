/**
 * Console passkey sign-in and passkey step-up (ST-30c.5; ST-28 SM-1, SM-5; checklist item 14).
 *
 *   POST /manage/login/passkey/options {stepUp?, returnTo?}   a challenge for THIS browser
 *   POST /manage/login/passkey/verify  {response}             the assertion: opens a v2 session
 *
 * Same-origin JSON only, 30 a minute per network (the two share one budget, as the portal's do).
 * The ceremony is bound to the browser by `__Host-pkey_console_passkey`, a cookie of its own: the
 * portal's passkey cookie can neither start nor finish a console sign-in, nor the reverse. Login
 * CSRF is closed three ways: a cross-site request is refused before anything is read or spent
 * (Fetch Metadata / Origin, JSON content type), the cookie is `SameSite=Strict`, and a verify
 * finishes only the challenge issued to the browser presenting that cookie.
 *
 * Identity decides who the passkey is (`consolePasskeySignIn`: I-16 verification, SM-1, the
 * account and erasure checks, the step-up account rule). This module is the console's gate on
 * top of it, exactly the one the console-IdP callback applies: ST-31.8 `convertInvites` (via
 * "passkey": SM-6/SM-7 limit what a passkey may bootstrap), then a grant is required, and a root
 * rule that no longer holds sends an operator back to the company account. A session row that
 * ends without a grant is ended before any cookie exists.
 */

import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import { clientNetwork, rateLimitOk } from "../core/rateLimit.js";
import {
  clearAccountRealmCookie,
  readCookie,
} from "../core/accounts/accountCookies.js";
import { readGuardedJsonObject } from "../core/accounts/browserRequestGuard.js";
import { recordPlatformSecurityEvent } from "../core/ops/securityEvents.js";
import { can, PLATFORM, resolvePrincipal } from "./authz.js";
import {
  ADMIN_COOKIE,
  buildSessionCookie,
  issueSessionV2,
} from "../core/console/session.js";
import {
  consoleVerifiedPrimaryEmail,
  consolePasskeyOptions,
  consolePasskeySignIn,
  endConsoleSession,
} from "../services/identity/public.js";
import {
  consoleHintCookie,
  consoleRefusalCopy,
  loginHint,
  sanitizeReturnTo,
} from "./auth.js";
import { resolveConsoleCaller } from "./api.js";
import { convertInvites } from "./inviteConversion.js";

/** Binds a console passkey ceremony to the browser that asked for it. */
export const CONSOLE_PASSKEY_COOKIE = "__Host-pkey_console_passkey";
/** Options and verify together, per client network per minute. */
export const CONSOLE_PASSKEY_PER_NETWORK_MINUTE = 30;
/** The ceremony lives as long as the browser's prompt (`PASSKEY_CEREMONY_TTL_SECONDS`). */
const CEREMONY_COOKIE_TTL_SECONDS = 5 * 60;
/** An assertion is a few KiB. */
const MAX_BODY_BYTES = 64 * 1024;

/** The copy when a root-only operator's console-IdP assertion is no longer fresh. */
export const SIGN_IN_WITH_IDP_FIRST = "Sign in with Pocket ID first";

function ceremonyCookie(secret: string): string {
  return [
    `${CONSOLE_PASSKEY_COOKIE}=${secret}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${CEREMONY_COOKIE_TTL_SECONDS}`,
  ].join("; ");
}

const clearCeremonyCookie = (): string =>
  clearAccountRealmCookie(CONSOLE_PASSKEY_COOKIE);

function json(
  body: unknown,
  status = 200,
  cookies: readonly string[] = [],
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

const badRequest = (message: string): Response =>
  json({ error: "bad_request", message }, 400);

/** Every sign-in that did not prove a console passkey answers this one shape. */
const refused = (): Response =>
  json(
    {
      error: "unauthorized",
      message:
        "That passkey didn’t work. Try again, or use another way to sign in.",
    },
    401,
    [clearCeremonyCookie()],
  );

const expired = (): Response =>
  json(
    {
      error: "signin_expired",
      message: "This passkey request has expired. Start again.",
    },
    400,
    [clearCeremonyCookie()],
  );

const forbidden = (reason: string, message: string): Response =>
  json({ error: "forbidden", reason, message }, 403, [clearCeremonyCookie()]);

/** The `aid` of the caller's live console account session, or `null` (none, or break-glass). */
async function currentAccount(
  env: Env,
  db: Db,
  req: Request,
  now: number,
): Promise<string | null> {
  const cookie = readCookie(req.headers.get("cookie"), ADMIN_COOKIE);
  if (!cookie) return null;
  // The one sanctioned cookie reader (`resolveConsoleCaller`); a grant-less session is still a session.
  const session = (await resolveConsoleCaller(env, db, req, now))?.session;
  return session && !session.breakGlass && session.aid ? session.aid : null;
}

/** Dispatch `POST /manage/login/passkey/<step>`. */
export async function handleConsolePasskey(
  req: Request,
  env: Env,
  db: Db,
  step: "options" | "verify",
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const allowed = await rateLimitOk(
    env,
    "_admin",
    {
      bucket: "adminPasskey",
      id: clientNetwork(req),
      limit: CONSOLE_PASSKEY_PER_NETWORK_MINUTE,
      windowSec: 60,
    },
    now,
  );
  if (!allowed) return json({ error: "rate_limited" }, 429);
  // Before anything is read, spent or minted: a cross-site or non-JSON request is refused whole.
  const body = await readGuardedJsonObject(req, MAX_BODY_BYTES);
  if (!body) return badRequest("invalid json");
  return step === "options"
    ? options(req, env, db, body, now)
    : verify(req, env, db, body, now);
}

async function options(
  req: Request,
  env: Env,
  db: Db,
  body: Record<string, unknown>,
  now: number,
): Promise<Response> {
  if (body.stepUp !== undefined && typeof body.stepUp !== "boolean")
    return badRequest("invalid stepUp");
  let returnTo: string | undefined;
  if (body.returnTo !== undefined && body.returnTo !== null) {
    const clean =
      typeof body.returnTo === "string"
        ? sanitizeReturnTo(body.returnTo)
        : null;
    if (!clean) return badRequest("invalid return URL");
    returnTo = clean;
  }
  let stepUpFor: string | undefined;
  if (body.stepUp === true) {
    // A step-up re-proves the person already signed in: there must be a live account session.
    const aid = await currentAccount(env, db, req, now);
    if (!aid)
      return json({ error: "unauthorized", message: "Sign in first." }, 401);
    stepUpFor = aid;
  }
  const made = await consolePasskeyOptions(
    env,
    req,
    { ...(stepUpFor ? { stepUpFor } : {}), ...(returnTo ? { returnTo } : {}) },
    now,
  );
  if (!made)
    return json(
      {
        error: "auth_method_disabled",
        message: "Passkey sign-in is unavailable here.",
      },
      404,
    );
  return json({ options: made.options, expiresIn: made.expiresIn }, 200, [
    ceremonyCookie(made.secret),
  ]);
}

async function verify(
  req: Request,
  env: Env,
  db: Db,
  body: Record<string, unknown>,
  now: number,
): Promise<Response> {
  const secret = readCookie(req.headers.get("cookie"), CONSOLE_PASSKEY_COOKIE);
  if (!secret) return expired();
  const result = await consolePasskeySignIn(
    env,
    db,
    req,
    {
      secret,
      response: body.response,
      currentAid: await currentAccount(env, db, req, now),
    },
    now,
  );
  if (result.status !== "ok") {
    if (result.reason === "expired") return expired();
    await recordPlatformSecurityEvent(db, {
      action: "admin.signin.refused",
      summary: `Admin passkey sign-in refused (${result.reason})`,
      now,
    });
    if (result.reason === "invalid") return refused();
    if (result.reason === "method") {
      const copy = consoleRefusalCopy("method");
      return forbidden("method", `${copy.title}. ${copy.lede}`);
    }
    if (result.reason === "step_up_account")
      return forbidden(
        "step_up_account",
        "Use a passkey of the account you’re signed in with.",
      );
    const copy = consoleRefusalCopy("account");
    return forbidden("account", `${copy.title}. ${copy.lede}`);
  }

  // Invites addressed to this account's verified address become its bindings now (SM-6/SM-7 limit
  // what a passkey may bootstrap), then the post-gate: no grant, no cookie.
  await convertInvites(env, db, now, {
    accountId: result.accountId,
    assertedEmail: await consoleVerifiedPrimaryEmail(db, result.accountId),
    via: "passkey",
  });
  const member = await resolvePrincipal(
    env,
    db,
    {
      sub: result.subject.sub,
      groups: result.subject.groups,
      root: result.subject.root,
      accountId: result.accountId,
    },
    now,
  );
  if (!can(member, PLATFORM, "console", "view")) {
    await endConsoleSession(env, db, result.sid, now);
    await recordPlatformSecurityEvent(db, {
      action: "admin.signin.refused",
      sub: result.subject.sub,
      summary: result.rootStale
        ? "Admin passkey sign-in refused: the company account must sign in first"
        : "Admin passkey sign-in refused: no administrator grant",
      now,
    });
    return result.rootStale
      ? forbidden(
          "idp_first",
          `${SIGN_IN_WITH_IDP_FIRST}. Your access needs a recent sign-in with your company account.`,
        )
      : forbidden("no_grant", "Ask a Superadmin to add you.");
  }

  // `authAt` is this sign-in. `stepUpAt` only when the SAME account answered a step-up.
  const { token } = await issueSessionV2(
    env,
    {
      aid: result.accountId,
      sid: result.sid,
      name: result.subject.name,
      email: result.subject.email,
      authTime: now,
      stepUp: result.stepUp,
    },
    now,
  );
  await recordPlatformSecurityEvent(db, {
    action: "admin.signin",
    sub: result.subject.sub,
    summary: "passkey",
    now,
  });
  const hint = loginHint(result.subject.email || null);
  return json(
    {
      status: "signed_in",
      next: sanitizeReturnTo(result.returnTo) ?? "/manage/",
    },
    200,
    [
      buildSessionCookie(token),
      clearCeremonyCookie(),
      ...(hint ? [consoleHintCookie(hint)] : []),
    ],
  );
}
