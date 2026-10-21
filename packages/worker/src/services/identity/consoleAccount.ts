/**
 * The console's door into accounts (ST-30 slice 2a; ST-28 plan §2.2, §2.6).
 *
 * `consoleSignIn` is I-05 `signIn` for the console's own IdP: the operator lands on one Polaris Key
 * account (the same one the portal uses, keyed by the same issuer key) and the sign-in opens an
 * `account_sessions` row that the console cookie (v2) names. `consoleSubject` is the read the
 * console runs for that cookie, at most every 30 s: it answers who the cookie is TODAY, or `null`.
 * It is the one place that decides the console subject, and `operatorIssuerAllowed` is the one
 * place that decides which issuer may sign operators in.
 *
 * What "live" means: the row exists, is not revoked, has not expired and belongs to the account
 * the cookie names; the account is active, is the account itself (a merge or a deletion removed
 * the row the cookie names) and is not on the erasure ledger; and the account still holds a link
 * through an issuer that `operatorIssuerAllowed` admits. The groups come from that link, which the
 * console sign-in rewrote when it last ran, so a session never outlives its 8 h row on stale groups.
 *
 * Not here: bindings (ST-31), `asserted_at`/`strong_at` (ST-28 §2.4-§2.5), break-glass, passkeys.
 */

import { ADMIN_SESSION_TTL_SECONDS } from "../../core/console/session.js";
import type { ResolvedConsoleSubject } from "../../core/console/session.js";
import { erasureVerdict } from "../../core/accounts/erasureFence.js";
import { portalAudit } from "../../core/accounts/portalAudit.js";
import { operatorIssuerAllowed } from "../../core/rbac/operatorIssuer.js";
import type { Db } from "../../db/types.js";
import { normalizeEmail } from "../../platform/email.js";
import type { Env } from "../../platform/env.js";
import { parseJsonStringList } from "../../platform/json.js";
import { adminOidcConfig } from "../../platform/platformOidc.js";
import { accountsUsingEmail } from "./accounts/platformMigration.js";
import {
  insertLink,
  rekeyLegacyAccountLinks,
  resolveAccount,
  type AccountRow,
} from "./accounts/repo.js";
import { signIn, type SignInResult } from "./accounts/signIn.js";
import {
  openAccountSessionRow,
  sessionIdHash,
} from "./portal/accountSessions.js";
import {
  portalIdentityIssuerKey,
  recordLinkGroups,
  rekeyLegacyPortalIdentities,
} from "./portal/repo.js";
import { providerVouchesForEmail } from "./providers/vouch.js";

/** What the console IdP verified at the callback. */
export interface ConsoleIdentity {
  sub: string;
  email?: string | null;
  /** The `email_verified` claim was `true`. */
  emailVerified?: boolean;
  displayName?: string | null;
  groups: readonly string[];
}

export type ConsoleSignInResult =
  | {
      status: "ok";
      accountId: string;
      sid: string;
      name: string;
      email: string;
      /** The account was created by this sign-in. */
      created: boolean;
    }
  | { status: "refused"; reason: ConsoleRefusal };

export type ConsoleRefusal =
  /** The issuer is not one that may sign operators in. */
  | "issuer"
  /** The account is disabled, erased or being erased, or the identity is unusable. */
  | "account"
  /** An account already uses the address and this identity may not join it. */
  | "join";

/**
 * Sign an operator in through `console-idp`. The caller has already decided the identity may open
 * the console (the principal has a grant); this lands it on its account and opens the session row.
 *
 * `operator` is whether the ID token asserted the platform-admin group. It is the one condition
 * under which an identity may JOIN an account that already uses its verified address (ST-28 SM-3
 * (b)): the console IdP is deploy-time and the address is verified at both ends, so an operator who
 * first met Polaris Locker with an email code is not locked out of the console by it. Anyone else
 * whose address another account uses is refused, and nothing is written.
 */
export async function consoleSignIn(
  env: Env,
  db: Db,
  identity: ConsoleIdentity,
  opts: { operator: boolean; req?: Request },
  now: number,
): Promise<ConsoleSignInResult> {
  const rp = adminOidcConfig(env);
  if (!rp || !operatorIssuerAllowed(env, rp.issuer))
    return { status: "refused", reason: "issuer" };
  const issuerKey = portalIdentityIssuerKey(rp.issuer);
  // A pre-I-01 row keyed by the literal `oidc` is this IdP's subject: re-key before the lookup, or
  // the operator would get a second account (as the portal callback does).
  await rekeyLegacyPortalIdentities(db, issuerKey);
  await rekeyLegacyAccountLinks(db, issuerKey);

  const asserted = identity.email?.trim()
    ? normalizeEmail(identity.email)
    : null;
  const vouched = providerVouchesForEmail(
    {
      kind: "oidc",
      email: asserted,
      emailVerified: identity.emailVerified === true,
    },
    null,
  );
  const verified = {
    issuerKey,
    subject: identity.sub,
    kind: "oidc",
    email: vouched ? asserted : null,
    emailVerified: vouched,
    displayName: identity.displayName ?? null,
  };

  let result: SignInResult = await signIn(db, verified, now, { env });
  if (result.status === "join_offer") {
    if (!opts.operator || !verified.email) {
      return { status: "refused", reason: "join" };
    }
    const using = await accountsUsingEmail(db, verified.email);
    const target = using.length === 1 ? using[0]! : null;
    if (!target || target !== result.existingAccountId)
      return { status: "refused", reason: "join" };
    const joined = await insertLink(
      db,
      target,
      {
        issuerKey,
        tenantScope: "",
        subject: identity.sub,
        kind: "oidc",
        email: verified.email,
        emailVerified: true,
        displayName: verified.displayName,
        amr: null,
      },
      now,
    );
    if (joined)
      await portalAudit(db, {
        accountId: target,
        action: "account.link",
        targetKind: "link",
        summary: "Console sign-in joined this account",
        now,
      });
    result = await signIn(db, verified, now, { env });
  }
  if (result.status !== "signed_in")
    return {
      status: "refused",
      reason: result.status === "refused" ? "account" : "join",
    };

  await recordLinkGroups(db, result.linkId, identity.groups);
  const { sid } = await openAccountSessionRow(
    env,
    db,
    {
      accountId: result.account.id,
      ...(opts.req ? { req: opts.req } : {}),
      amr: ["oidc"],
      ttlSeconds: ADMIN_SESSION_TTL_SECONDS,
    },
    now,
  );
  return {
    status: "ok",
    accountId: result.account.id,
    sid,
    name: displayNameOf(result.account, identity),
    email: result.account.primary_email ?? asserted ?? "",
    created: result.created,
  };
}

function displayNameOf(account: AccountRow, identity: ConsoleIdentity): string {
  return (
    account.display_name ??
    identity.displayName ??
    account.primary_email ??
    identity.email ??
    identity.sub
  );
}

/**
 * Who a console cookie (`aid`, `sid`) is today, or `null` when it no longer holds. Read at most
 * every 30 s per session by the console (`console/consoleSession.ts`); it never writes.
 */
export async function consoleSubject(
  env: Env,
  db: Db,
  cookie: { aid: string; sid: string },
  now: number,
): Promise<ResolvedConsoleSubject | null> {
  const row = await db.first<{
    account_id: string;
    revoked_at: number | null;
    expires_at: number;
  }>(
    "SELECT account_id, revoked_at, expires_at FROM account_sessions WHERE id_hash = ?",
    await sessionIdHash(env, cookie.sid),
  );
  if (
    !row ||
    row.revoked_at !== null ||
    row.expires_at <= now ||
    row.account_id !== cookie.aid
  )
    return null;
  if ((await erasureVerdict(env, now, cookie.aid)) !== "clear") return null;
  const account = await resolveAccount(db, cookie.aid, now);
  // A merge moved the account: the cookie names a row that is no longer this account.
  if (!account || account.id !== cookie.aid || account.status !== "active")
    return null;

  const rp = adminOidcConfig(env);
  if (!rp || !operatorIssuerAllowed(env, rp.issuer)) return null;
  const issuerKey = portalIdentityIssuerKey(rp.issuer);
  // The link the operator signed in through last (`touchLink` moves `last_used_at`).
  const link = await db.first<{
    subject: string;
    display_name: string | null;
    email: string | null;
    groups_json: string | null;
  }>(
    `SELECT subject, display_name, email, groups_json FROM account_links
      WHERE account_id = ? AND issuer_key = ? AND tenant_scope = ''
      ORDER BY last_used_at DESC, id LIMIT 1`,
    account.id,
    issuerKey,
  );
  if (!link) return null;
  return {
    sub: link.subject,
    name:
      account.display_name ??
      link.display_name ??
      account.primary_email ??
      link.subject,
    email: account.primary_email ?? link.email ?? "",
    groups: parseJsonStringList(link.groups_json),
  };
}

/** End one console session now (sign out). The 30 s cache elsewhere is dropped by the caller. */
export async function endConsoleSession(
  env: Env,
  db: Db,
  sid: string,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE account_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
    now,
    await sessionIdHash(env, sid),
  );
}

/**
 * Whether the account could open the console: it holds a link through an issuer that may sign
 * operators in, whose last-asserted groups carry `PLATFORM_ADMIN_GROUP`. Only the portal's
 * "Open console" link asks (a pointer, never an authorisation: the console decides on arrival).
 */
export async function accountMayOpenConsole(
  env: Env,
  db: Db,
  accountId: string,
): Promise<boolean> {
  const group = env.PLATFORM_ADMIN_GROUP;
  const rp = adminOidcConfig(env);
  if (!group || !rp || !operatorIssuerAllowed(env, rp.issuer)) return false;
  const row = await db.first<{ groups_json: string | null }>(
    `SELECT groups_json FROM account_links
      WHERE account_id = ? AND issuer_key = ? AND tenant_scope = ''
      ORDER BY last_used_at DESC LIMIT 1`,
    accountId,
    portalIdentityIssuerKey(rp.issuer),
  );
  return parseJsonStringList(row?.groups_json ?? null).includes(group);
}
