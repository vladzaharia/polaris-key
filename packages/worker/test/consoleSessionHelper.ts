/**
 * ST-30c.7: how worker tests sign an operator in. They used to mint v1 cookies (`issueSession`:
 * the IdP `sub` and `groups` in the cookie). The console now reads v2, so a test lands the
 * identity through `consoleSignIn` (the account, link and session row the callback opens) and
 * mints the v2 cookie for it, as the callback does.
 *
 * The principal is resolved from the database per request, so `session.sub` is the member id
 * (`mbr_…`), not the IdP subject, and groups reach a request only through the link's stored
 * assertion. `consoleTestSession` configures the console IdP on `env` when the test left it unset.
 */
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import {
  ADMIN_COOKIE,
  issueBreakGlassSession,
  issueSessionV2,
  type SessionIdentity,
} from "../src/core/console/session.js";
import { memberIdFor } from "../src/core/console/memberId.js";
import { adminOidcConfig } from "../src/platform/platformOidc.js";
import { consoleSignIn } from "../src/services/identity/public.js";
import { portalIdentityIssuerKey } from "../src/services/identity/portal/repo.js";

const TEST_ISSUER = "https://id.example";

export interface ConsoleTestSession {
  /** The cookie value. */
  token: string;
  /** The `Cookie` header value: `<cookie name>=<token>`. */
  cookie: string;
  /** The CSRF token the cookie carries (send as `x-csrf-token`). */
  csrf: string;
  /** What a v1 `issueSession` returned as `session`, for the fields tests read. */
  session: {
    /** The member id (the audit actor), as the console resolves the principal. */
    sub: string;
    name: string;
    email: string;
    csrf: string;
    groups: string[];
    exp: number;
    authAt: number;
    stepUpAt?: number;
  };
}

/** Make the console IdP resolvable (the live check reads it) without touching a test's own. */
function ensureConsoleIdp(env: Env): void {
  if (adminOidcConfig(env)) return;
  env.PLATFORM_OIDC_ISSUER = TEST_ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
}

/** Sign `identity` in as an operator when its groups hold the platform-admin group. */
export async function consoleTestSession(
  env: Env,
  db: Db,
  identity: SessionIdentity,
  now: number,
): Promise<ConsoleTestSession> {
  ensureConsoleIdp(env);
  const operator =
    !!env.PLATFORM_ADMIN_GROUP &&
    identity.groups.includes(env.PLATFORM_ADMIN_GROUP);
  const signedIn = await consoleSignIn(
    env,
    db,
    {
      sub: identity.sub,
      email: identity.email ?? null,
      emailVerified: identity.emailVerified ?? identity.email !== undefined,
      displayName: identity.name ?? null,
      groups: identity.groups,
    },
    { operator },
    now,
  );
  if (signedIn.status !== "ok")
    throw new Error(
      `consoleTestSession: sign-in refused (${signedIn.reason}) for ${identity.sub}`,
    );
  const { token, claims } = await issueSessionV2(
    env,
    {
      aid: signedIn.accountId,
      sid: signedIn.sid,
      name: signedIn.name,
      email: signedIn.email || identity.email || "",
      ...(identity.authTime !== undefined
        ? { authTime: identity.authTime }
        : {}),
      ...(identity.stepUp ? { stepUp: true } : {}),
    },
    now,
  );
  return {
    token,
    cookie: `${ADMIN_COOKIE}=${token}`,
    csrf: claims.csrf,
    session: {
      sub: await memberIdFor(env, signedIn.accountId),
      name: signedIn.name,
      email: signedIn.email || identity.email || "",
      csrf: claims.csrf,
      groups: identity.groups,
      exp: claims.exp,
      authAt: claims.authAt,
      ...(claims.stepUpAt !== undefined ? { stepUpAt: claims.stepUpAt } : {}),
    },
  };
}

/**
 * The DB-less variant: a break-glass cookie (an account-less realm, one hour). The identity must
 * hold the platform-admin group, as the break-glass flow requires.
 */
export async function consoleTestBreakGlass(
  env: Env,
  identity: SessionIdentity,
  now: number,
): Promise<ConsoleTestSession> {
  const { token, session } = await issueBreakGlassSession(env, identity, now);
  return {
    token,
    cookie: `${ADMIN_COOKIE}=${token}`,
    csrf: session.csrf,
    session: {
      sub: session.sub,
      name: session.name,
      email: session.email,
      csrf: session.csrf,
      groups: session.groups,
      exp: session.exp,
      authAt: session.authAt ?? now,
      ...(session.stepUpAt !== undefined ? { stepUpAt: session.stepUpAt } : {}),
    },
  };
}

/**
 * The audit actor a console session signed in as `idpSub` carries: the member id of the account
 * its console link belongs to. A v1 cookie's actor was the IdP subject itself.
 */
export async function consoleActor(
  env: Env,
  db: Db,
  idpSub: string,
): Promise<string> {
  ensureConsoleIdp(env);
  const rp = adminOidcConfig(env)!;
  const link = await db.first<{ account_id: string }>(
    "SELECT account_id FROM account_links WHERE issuer_key = ? AND tenant_scope = '' AND subject = ?",
    portalIdentityIssuerKey(rp.issuer),
    idpSub,
  );
  if (!link) throw new Error(`consoleActor: ${idpSub} never signed in`);
  return memberIdFor(env, link.account_id);
}
