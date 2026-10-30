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
 * Slice 2b adds the strong-method rule (ST-28 §2.5) and the computed root rule (§2.4):
 *
 *   - SM-1: the console needs a STRONG method. A link is strong when `strong_at` is set; an email
 *     code, and any method added in the portal, never is (SM-4). `consoleSubject` reads only a
 *     strong link through an issuer that still qualifies (SM-2), at every check.
 *   - SM-3(b)/(c): a sign-in through the console IdP marks its link strong when the link was
 *     created by that sign-in, or when the ID token asserted the platform-admin group (today's
 *     operators get in at once). A sign-in that is neither, on a link that is not strong, is
 *     refused ("method") BEFORE anything is written.
 *   - The root rule is computed from the link on every check (`rootRuleHolds`): strong, the group
 *     in `groups_json`, `asserted_at` under 8 h old. `asserted_at` moves only with the groups.
 *   - The audit actor is the member id (`mbr_…`, core/console/memberId.ts), never the account id;
 *     `consoleActorAliases` maps it to and from the IdP `sub` so old audit rows still read.
 *
 * SM-3(a)/(d) (a passkey added or a method confirmed after a console step-up), break-glass and
 * bindings come with the passkey button, ST-31 and the next slice.
 */

import { ADMIN_SESSION_TTL_SECONDS } from "../../core/console/session.js";
import type { ResolvedConsoleSubject } from "../../core/console/session.js";
import { erasureVerdict } from "../../core/accounts/erasureFence.js";
import { portalAudit } from "../../core/accounts/portalAudit.js";
import { operatorIssuerAllowed } from "../../core/rbac/operatorIssuer.js";
import { memberIdFor, isMemberId } from "../../core/console/memberId.js";
import { holdsRoot, rootRuleHolds } from "../../core/rbac/principal.js";
import { consoleOrigin } from "../../core/hosts.js";
import { portalOriginOf } from "../../core/licensing/manageUrl.js";
import {
  artefactRef,
  consumeArtefact,
  putArtefact,
} from "../../core/singleUse.js";
import { hashKey } from "../../platform/crypto.js";
import { randomToken } from "../../platform/random.js";
import type { Db } from "../../db/types.js";
import { normalizeEmail } from "../../platform/email.js";
import type { Env } from "../../platform/env.js";
import { parseJsonStringList } from "../../platform/json.js";
import { adminOidcConfig } from "../../platform/platformOidc.js";
import { accountsUsingEmail } from "./accounts/platformMigration.js";
import {
  findLink,
  getAccountRow,
  insertLink,
  markLinkStrong,
  rekeyLegacyAccountLinks,
  resolveAccount,
  type AccountRow,
} from "./accounts/repo.js";
import { signIn, type SignInResult } from "./accounts/signIn.js";
import {
  openAccountSessionRow,
  revokeAllAccountSessions,
  sessionIdHash,
} from "./portal/accountSessions.js";
import { CONSOLE_IDP_CONNECTION } from "../../core/rbac/operatorConnections.js";
import { portalIdentityIssuerKey, recordLinkGroups } from "./portal/repo.js";
import { providerVouchesForEmail } from "./providers/vouch.js";
import { handleAccountPasskeys, passkeyAddable } from "./passkeys/routes.js";
import {
  PASSKEY_CEREMONY_TTL_SECONDS,
  assertionUserHandle,
  parseAuthenticationResponse,
  passkeyRelyingParty,
  signInOptions,
  verifyAssertion,
  type RelyingParty,
} from "./passkeys/webauthn.js";
import {
  findPasskey,
  parseDetails,
  parseTransports,
  recordPasskeyUse,
} from "./passkeys/repo.js";
import { PASSKEY_ISSUER } from "./accounts/repo.js";

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
  | "join"
  /** The sign-in method is not strong (SM-1): an email code or a method nobody marked. */
  | "method";

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

  // SM-1, before anything is written: a known link that is not strong signs in only when this very
  // sign-in marks it (SM-3(c): the ID token asserted the platform-admin group). Otherwise the
  // method cannot open the console, and `signIn` would only touch it.
  const known = await findLink(db, {
    issuerKey,
    tenantScope: "",
    subject: identity.sub,
  });
  if (known && !known.strong_at && !opts.operator)
    return { status: "refused", reason: "method" };

  let linkCreated = false;
  let result: SignInResult = await signIn(db, verified, now, { env });
  if (result.status === "join_offer") {
    if (!opts.operator || !verified.email) {
      return { status: "refused", reason: "join" };
    }
    const using = await accountsUsingEmail(db, verified.email);
    const target = using.length === 1 ? using[0]! : null;
    if (!target || target !== result.existingAccountId)
      return { status: "refused", reason: "join" };
    // A disabled (or deleted) account is never joined: refuse before anything is written.
    const targetRow = await getAccountRow(db, target);
    if (!targetRow || targetRow.status !== "active")
      return { status: "refused", reason: "account" };
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
    linkCreated = joined;
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

  linkCreated = linkCreated || result.created;
  // SM-3(b): a link this sign-in created through the console IdP. SM-3(c): the ID token asserted
  // the platform-admin group. Either marks it BEFORE the strong check, so today's operators (whose
  // links predate `strong_at`) get in at once; nothing else marks it.
  const strong = Boolean(known?.strong_at) || opts.operator || linkCreated;
  if (!strong) return { status: "refused", reason: "method" };
  // Groups, the (empty) claims and the asserting connection in one statement: the console IdP has
  // no claim map, so no claim outlives the sign-in that dropped it (ST-32.3).
  await recordLinkGroups(
    db,
    result.linkId,
    identity.groups,
    now,
    CONSOLE_IDP_CONNECTION,
  );
  if (
    !known?.strong_at &&
    !(await markLinkStrong(db, result.account.id, result.linkId, now))
  )
    return { status: "refused", reason: "method" };
  // The member id is derived, never trusted from here: it only indexes the audit alias lookup.
  await db.run(
    "UPDATE account_links SET member_id = ? WHERE id = ?",
    await memberIdFor(env, result.account.id),
    result.linkId,
  );
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
  return subjectForAccount(env, db, cookie.aid, now);
}

/**
 * Who an account is in the console right now, or `null`: the part of `consoleSubject` after the
 * session-row check, shared so a session and a token (ST-34.3) cannot disagree. It never writes.
 * Callers hold no session row for the account, so nothing here may echo `accountId`.
 */
export async function subjectForAccount(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
): Promise<ResolvedConsoleSubject | null> {
  if ((await erasureVerdict(env, now, accountId)) !== "clear") return null;
  const account = await resolveAccount(db, accountId, now);
  // A merge moved the account: the id named is no longer this account.
  if (!account || account.id !== accountId || account.status !== "active")
    return null;

  // SM-5: an account is a console member while it holds ANY strong method: a strong link through
  // the console IdP, or a strong passkey enrolled under the console's RP id. Each is read fresh
  // here on every check, so removing the last strong method ends entry within the 30 s window.
  const idp = await consoleIdpLink(env, db, account.id);
  const passkey = idp ? null : await strongConsolePasskey(env, db, account.id);
  if (!idp && !passkey) return null;
  // The root rule comes from the console-IdP link ALONE (SM-5): a passkey never carries groups,
  // so a passkey-only member is root-less and is a member only through stored bindings.
  const stored = idp ? parseJsonStringList(idp.groups_json) : [];
  const root = idp
    ? rootRuleHolds(
        env,
        {
          strongAt: idp.strong_at,
          assertedAt: idp.asserted_at,
          groups: stored,
        },
        now,
        ADMIN_SESSION_TTL_SECONDS,
      )
    : false;
  const memberId = await memberIdFor(env, account.id);
  return {
    sub: memberId,
    idpSub: idp?.subject ?? "",
    name:
      account.display_name ??
      idp?.display_name ??
      account.primary_email ??
      idp?.subject ??
      memberId,
    email: account.primary_email ?? idp?.email ?? "",
    // Groups are offered only while the IdP's assertion is fresh: a stale one grants nothing.
    groups: root ? stored : [],
    root,
  };
}

interface ConsoleIdpLink {
  subject: string;
  display_name: string | null;
  email: string | null;
  groups_json: string | null;
  strong_at: number | null;
  asserted_at: number | null;
}

/**
 * The account's strong link through the console IdP, the one the operator signed in through last
 * (`touchLink` moves `last_used_at`), or `null`: no console IdP, one that may not sign operators in
 * (SM-2), or no strong link (an email code only, a removed method).
 */
async function consoleIdpLink(
  env: Env,
  db: Db,
  accountId: string,
): Promise<ConsoleIdpLink | null> {
  const rp = adminOidcConfig(env);
  if (!rp || !operatorIssuerAllowed(env, rp.issuer)) return null;
  return db.first<ConsoleIdpLink>(
    `SELECT subject, display_name, email, groups_json, strong_at, asserted_at FROM account_links
      WHERE account_id = ? AND issuer_key = ? AND tenant_scope = '' AND strong_at IS NOT NULL
      ORDER BY last_used_at DESC, id LIMIT 1`,
    accountId,
    portalIdentityIssuerKey(rp.issuer),
  );
}

/** The console's RP id from configuration alone (no request): the host of `CONSOLE_ORIGIN`. */
function configuredConsoleRpId(env: Env): string | null {
  const origin = consoleOrigin(env, "");
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * SM-5: a strong passkey of the account enrolled under the console's RP id. The link must be
 * strong (SM-1) AND twinned with a passkey row of the same account whose `rp_id` is the console's:
 * a passkey marked strong, then re-enrolled elsewhere or whose row is gone, admits nobody. The
 * link is deleted when the holder removes the passkey, so the next check (at most 30 s) refuses.
 */
async function strongConsolePasskey(
  env: Env,
  db: Db,
  accountId: string,
): Promise<{ linkId: string } | null> {
  const rpId = configuredConsoleRpId(env);
  if (!rpId) return null;
  const row = await db.first<{ id: string }>(
    `SELECT l.id FROM account_links l
       JOIN account_passkeys p ON p.credential_id = l.subject AND p.account_id = l.account_id
      WHERE l.account_id = ? AND l.issuer_key = ? AND l.tenant_scope = '' AND l.kind = 'passkey'
        AND l.strong_at IS NOT NULL AND p.rp_id = ?
      ORDER BY l.last_used_at DESC, l.id LIMIT 1`,
    accountId,
    PASSKEY_ISSUER,
    rpId,
  );
  return row ? { linkId: row.id } : null;
}

/**
 * The address the console IdP vouches for at THIS sign-in, normalised, or `null`: the ID token
 * carried an `email` and `email_verified: true` and the provider is one that may vouch. An invite
 * converts only against this (ST-31.8): a claimed or stale address never does. The address must
 * be plain ASCII before it is lower-cased, as I-30 requires of platform connections: a lookalike
 * such as the Kelvin sign would otherwise fold onto another person's invite.
 */
export function consoleAssertedEmail(
  identity: Pick<ConsoleIdentity, "email" | "emailVerified">,
): string | null {
  const raw = identity.email?.trim() ?? "";
  if (!/^[\x21-\x7e]+$/.test(raw)) return null;
  const asserted = normalizeEmail(raw);
  return providerVouchesForEmail(
    {
      kind: "oidc",
      email: asserted,
      emailVerified: identity.emailVerified === true,
    },
    null,
  )
    ? asserted
    : null;
}

/**
 * The account behind a console IdP subject, or `null` when this IdP never signed that subject in.
 * The sign-in gate asks it BEFORE anything is written (is this a known member?). The account id
 * is for the caller's own reads; it never goes into a response.
 */
export async function consoleLinkedAccount(
  env: Env,
  db: Db,
  sub: string,
): Promise<string | null> {
  const rp = adminOidcConfig(env);
  if (!rp || !sub) return null;
  const row = await db.first<{ account_id: string }>(
    `SELECT account_id FROM account_links
      WHERE issuer_key = ? AND tenant_scope = '' AND subject = ? LIMIT 1`,
    portalIdentityIssuerKey(rp.issuer),
    sub,
  );
  return row?.account_id ?? null;
}

/**
 * The account a member id (`mbr_…`) names, or `null`. One indexed read of the console links'
 * `member_id` column, then the id is recomputed from the account: a stale or planted column value
 * never names a person it does not. Invite conversion resolves an inviter with it (ST-31.8).
 */
export async function consoleAccountForMember(
  env: Env,
  db: Db,
  memberId: string,
): Promise<string | null> {
  if (!isMemberId(memberId)) return null;
  const row = await db.first<{ account_id: string }>(
    "SELECT account_id FROM account_links WHERE member_id = ? LIMIT 1",
    memberId,
  );
  if (!row) return null;
  return (await memberIdFor(env, row.account_id)) === memberId
    ? row.account_id
    : null;
}

/** The account's primary email, normalised, only while it is VERIFIED; else `null`. */
export async function consoleVerifiedPrimaryEmail(
  db: Db,
  accountId: string,
): Promise<string | null> {
  const row = await db.first<{ primary_email: string | null }>(
    `SELECT primary_email FROM accounts
      WHERE id = ? AND primary_email IS NOT NULL AND primary_email_verified_at IS NOT NULL
        AND status = 'active'`,
    accountId,
  );
  return row?.primary_email ? normalizeEmail(row.primary_email) : null;
}

/**
 * `subjectForAccount` for a credential with no session row (a personal token, ST-34.3). Never
 * cache it longer than `LIVE_CHECK_SECONDS`.
 */
export const consoleTokenSubject = subjectForAccount;

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
 * End every live session row of the account now (ST-34.12, "Sign out everywhere"). The rows are
 * shared with the portal, so this ends both. The console's 30 s session cache elsewhere ends
 * within its window, and the caller writes the operator's revocation mark for the cookie itself.
 * Answers how many rows ended.
 */
export async function endConsoleSessionsForAccount(
  db: Db,
  accountId: string,
  now: number,
): Promise<number> {
  return revokeAllAccountSessions(db, accountId, now);
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
  now: number,
): Promise<boolean> {
  const rp = adminOidcConfig(env);
  if (
    !env.PLATFORM_ADMIN_GROUP ||
    !rp ||
    !operatorIssuerAllowed(env, rp.issuer)
  )
    return false;
  const row = await db.first<{
    groups_json: string | null;
    strong_at: number | null;
    asserted_at: number | null;
  }>(
    `SELECT groups_json, strong_at, asserted_at FROM account_links
      WHERE account_id = ? AND issuer_key = ? AND tenant_scope = '' AND strong_at IS NOT NULL
      ORDER BY last_used_at DESC LIMIT 1`,
    accountId,
    portalIdentityIssuerKey(rp.issuer),
  );
  if (!row) return false;
  return rootRuleHolds(
    env,
    {
      strongAt: row.strong_at,
      assertedAt: row.asserted_at,
      groups: parseJsonStringList(row.groups_json),
    },
    now,
    ADMIN_SESSION_TTL_SECONDS,
  );
}

/**
 * Every audit `actor_sub` that names the same person as `actor` (ST-30 slice 2b): the member id
 * (`mbr_…`) and the IdP subject(s) of the console links of the account behind it, so a filter on
 * either finds both the new rows (member id) and the old ones (IdP sub). The answer always holds
 * `actor` itself; an actor that matches no console link maps to itself alone. Read-only, bounded
 * to the console IdP's links.
 */
export async function consoleActorAliases(
  env: Env,
  db: Db,
  actor: string,
): Promise<string[]> {
  const out = new Set<string>([actor]);
  const rp = adminOidcConfig(env);
  if (!rp) return [...out];
  const issuerKey = portalIdentityIssuerKey(rp.issuer);
  const subjectsOf = async (accountId: string): Promise<string[]> =>
    (
      await db.all<{ subject: string }>(
        `SELECT subject FROM account_links
          WHERE account_id = ? AND issuer_key = ? AND tenant_scope = '' LIMIT 20`,
        accountId,
        issuerKey,
      )
    ).map((r) => r.subject);
  let accountId: string | null = null;
  if (isMemberId(actor)) {
    // One indexed read (idx_account_links_member), then the id is recomputed from the account: a
    // stale or planted column value (a merge moves links) never maps a person it does not name.
    const row = await db.first<{ account_id: string }>(
      "SELECT account_id FROM account_links WHERE member_id = ? LIMIT 1",
      actor,
    );
    if (row && (await memberIdFor(env, row.account_id)) === actor)
      accountId = row.account_id;
  } else {
    const row = await db.first<{ account_id: string }>(
      `SELECT account_id FROM account_links
        WHERE issuer_key = ? AND tenant_scope = '' AND subject = ? LIMIT 1`,
      issuerKey,
      actor,
    );
    accountId = row?.account_id ?? null;
  }
  if (!accountId) return [...out];
  out.add(await memberIdFor(env, accountId));
  for (const sub of await subjectsOf(accountId)) out.add(sub);
  return [...out];
}

/**
 * The IdP subject(s) of the console links of an account (ST-34.13). A break-glass session has no
 * account: its `sub` is the IdP subject, so a sign-out mark for the member must also be written
 * under each of these. Read-only, bounded.
 */
export async function consoleIdpSubjectsForAccount(
  env: Env,
  db: Db,
  accountId: string,
): Promise<string[]> {
  const rp = adminOidcConfig(env);
  if (!rp) return [];
  return (
    await db.all<{ subject: string }>(
      `SELECT subject FROM account_links
        WHERE account_id = ? AND issuer_key = ? AND tenant_scope = '' LIMIT 20`,
      accountId,
      portalIdentityIssuerKey(rp.issuer),
    )
  ).map((r) => r.subject);
}

/** A console member as the Members page shows them (ST-31.4). Never carries the account id. */
export interface ConsoleDirectoryEntry {
  memberId: string;
  name: string;
  email: string;
  /** Epoch seconds of the latest `admin.signin` under any of the person's aliases, or `null`. */
  lastSignInAt: number | null;
  /** The account is not active (disabled). Shown so a roster row explains a member who cannot sign in. */
  disabled: boolean;
}

/** Bound parameters per statement stay under D1's limit of 100. */
const IN_CHUNK = 80;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * The directory of the accounts the CALLER names: member id, display name, address and last
 * console sign-in. It answers only for the ids it is given (the Members handler passes the
 * accounts that hold a binding or the root rule), so nothing is learned about any other account.
 * The last sign-in is the newest `admin.signin` row under the person's member id or any IdP
 * subject of their console links (the `consoleActorAliases` set), through the
 * `(action, actor_sub, at)` index. An account on the erasure ledger is skipped. Read-only; an unknown id is simply absent from the map.
 */
export async function consoleDirectory(
  env: Env,
  db: Db,
  accountIds: readonly string[],
  now: number,
): Promise<Map<string, ConsoleDirectoryEntry>> {
  return (await consoleDirectoryRead(env, db, accountIds, now)).entries;
}

/** A person as the product-scope roster and `/access/admins` name them: no last sign-in. */
export type ConsoleDirectoryPerson = Omit<
  ConsoleDirectoryEntry,
  "lastSignInAt"
>;

/**
 * The directory read behind {@link consoleDirectory}. `lastSignIn: false` skips the audit queries
 * and leaves `lastSignInAt` `null` (the entry is typed without it by {@link consoleDirectoryPeople}).
 * `incomplete` is true when the erasure ledger could not be read for at least one account (R2
 * failure or no bucket): that account is left out, and the caller says the answer is incomplete.
 */
export async function consoleDirectoryRead(
  env: Env,
  db: Db,
  accountIds: readonly string[],
  now: number,
  opts: { lastSignIn?: boolean } = {},
): Promise<{
  entries: Map<string, ConsoleDirectoryEntry>;
  incomplete: boolean;
}> {
  const out = new Map<string, ConsoleDirectoryEntry>();
  let incomplete = false;
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return { entries: out, incomplete };
  const rp = adminOidcConfig(env);
  const issuerKey = rp ? portalIdentityIssuerKey(rp.issuer) : null;
  const aliasOf = new Map<string, string>(); // alias -> accountId
  const base = new Map<
    string,
    { memberId: string; name: string; email: string; disabled: boolean }
  >();
  for (const part of chunks(ids, IN_CHUNK)) {
    const marks = part.map(() => "?").join(", ");
    const accounts = await db.all<{
      id: string;
      display_name: string | null;
      primary_email: string | null;
      status: string;
    }>(
      `SELECT id, display_name, primary_email, status FROM accounts WHERE id IN (${marks})`,
      ...part,
    );
    const links = issuerKey
      ? await db.all<{
          account_id: string;
          subject: string;
          display_name: string | null;
          email: string | null;
        }>(
          `SELECT account_id, subject, display_name, email FROM account_links
            WHERE issuer_key = ? AND tenant_scope = '' AND account_id IN (${marks})
            ORDER BY last_used_at DESC, id`,
          issuerKey,
          ...part,
        )
      : [];
    for (const a of accounts) {
      // An account on the erasure ledger is gone, whatever a restored D1 row says.
      const verdict = await erasureVerdict(env, now, a.id);
      if (verdict === "unavailable") incomplete = true;
      if (verdict !== "clear") continue;
      const mine = links.filter((l) => l.account_id === a.id);
      const memberId = await memberIdFor(env, a.id);
      aliasOf.set(memberId, a.id);
      for (const l of mine.slice(0, 20)) aliasOf.set(l.subject, a.id);
      const first = mine[0];
      base.set(a.id, {
        memberId,
        name:
          a.display_name ??
          first?.display_name ??
          a.primary_email ??
          first?.subject ??
          "",
        email: a.primary_email ?? first?.email ?? "",
        disabled: a.status !== "active",
      });
    }
  }
  const last = new Map<string, number>();
  for (const part of opts.lastSignIn === false
    ? []
    : chunks([...aliasOf.keys()], IN_CHUNK)) {
    const marks = part.map(() => "?").join(", ");
    const rows = await db.all<{ actor_sub: string; at: number }>(
      `SELECT actor_sub, MAX(at) AS at FROM platform_audit
        WHERE action = 'admin.signin' AND actor_sub IN (${marks})
        GROUP BY actor_sub`,
      ...part,
    );
    for (const r of rows) {
      const id = aliasOf.get(r.actor_sub);
      if (id && r.at > (last.get(id) ?? 0)) last.set(id, r.at);
    }
  }
  for (const [id, b] of base)
    out.set(id, { ...b, lastSignInAt: last.get(id) ?? null });
  return { entries: out, incomplete };
}

/** {@link consoleDirectoryRead} without the last-sign-in queries, for the routes that never show it. */
export async function consoleDirectoryPeople(
  env: Env,
  db: Db,
  accountIds: readonly string[],
  now: number,
): Promise<{
  people: Map<string, ConsoleDirectoryPerson>;
  incomplete: boolean;
}> {
  const r = await consoleDirectoryRead(env, db, accountIds, now, {
    lastSignIn: false,
  });
  const people = new Map<string, ConsoleDirectoryPerson>();
  for (const [id, { lastSignInAt: _omit, ...p }] of r.entries)
    people.set(id, p);
  return { people, incomplete: r.incomplete };
}

/**
 * The accounts that hold Superadmin through the root rule right now (ST-31.4): a strong console
 * link whose groups carry `PLATFORM_ADMIN_GROUP`, asserted within `ADMIN_SESSION_TTL_SECONDS`
 * (the same constant and the same `rootRuleHolds` the principal uses), on an active account.
 * Account ids are for the caller's own joins; they never go into a response.
 */
export async function consoleRootHolders(
  env: Env,
  db: Db,
  now: number,
): Promise<string[]> {
  const rp = adminOidcConfig(env);
  if (
    !rp ||
    !env.PLATFORM_ADMIN_GROUP ||
    !operatorIssuerAllowed(env, rp.issuer)
  )
    return [];
  // Like `consoleSubject`, only the account's most recently used strong link speaks for it, so a
  // stale link that still carries the group never lists someone the principal would not treat as
  // a Superadmin.
  const rows = await db.all<{
    account_id: string;
    groups_json: string | null;
    strong_at: number | null;
    asserted_at: number | null;
  }>(
    `SELECT l.account_id, l.groups_json, l.strong_at, l.asserted_at
       FROM account_links l JOIN accounts a ON a.id = l.account_id
      WHERE l.issuer_key = ? AND l.tenant_scope = '' AND l.strong_at IS NOT NULL
        AND a.status = 'active'
      ORDER BY l.last_used_at DESC, l.id
      LIMIT 2000`,
    portalIdentityIssuerKey(rp.issuer),
  );
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.account_id)) continue;
    seen.add(r.account_id);
    if (
      !rootRuleHolds(
        env,
        {
          strongAt: r.strong_at,
          assertedAt: r.asserted_at,
          groups: parseJsonStringList(r.groups_json),
        },
        now,
        ADMIN_SESSION_TTL_SECONDS,
      )
    )
      continue;
    // The erasure ledger outranks D1 (a restore can bring an erased account back); cached 30 s.
    if ((await erasureVerdict(env, now, r.account_id)) !== "erased")
      out.add(r.account_id);
  }
  return [...out];
}

// ── SM-3(a) and (d): the console's own sign-in methods (ST-30c.3) ─────────────────────────────

/**
 * The console's relying-party id for this request: the host of `CONSOLE_ORIGIN` (LEAD decision on
 * plans/F-33b-ST-30c-slices.md §7), or `null` when the request did not arrive on a console origin.
 * A passkey is `consoleEligible` only when its stored `rp_id` equals it.
 */
export function consoleRpId(env: Env, req: Request): string | null {
  return passkeyRelyingParty(env, req)?.id ?? null;
}

/** One sign-in method as the console's "Sign-in methods" list shows it. */
export interface ConsoleMethod {
  /** The method's link id (`account_links.id`): the path segment of "Use for the console". */
  id: string;
  kind: string;
  /** What its holder named it, or the address / name the provider asserted; null when none. */
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  /** `strong_at` is set: this method opens the console (SM-1). */
  strong: boolean;
  /** A passkey enrolled under the console's RP id: "Use for the console" may mark it. */
  consoleEligible: boolean;
  /** A passkey's authenticator model (AAGUID) as I-16 stored it; null for other kinds. */
  aaguid: string | null;
  /** The browser a passkey was added from, as I-16 stored it; null for other kinds. */
  addedFrom: string | null;
}

/** Whether a passkey can be added now (I-16's own test), and the reason when not. */
export async function consolePasskeyAddable(
  db: Db,
  accountId: string,
): Promise<{ canAdd: boolean; reason: "email_unverified" | "limit" | null }> {
  return passkeyAddable(db, accountId);
}

/** The account's own sign-in methods. Never another account's; never a secret. */
export async function listConsoleMethods(
  db: Db,
  accountId: string,
  rpId: string,
): Promise<ConsoleMethod[]> {
  const rows = await db.all<{
    id: string;
    kind: string;
    email: string | null;
    display_name: string | null;
    created_at: number;
    last_used_at: number | null;
    strong_at: number | null;
    pk_name: string | null;
    pk_rp_id: string | null;
    pk_last_used_at: number | null;
    pk_details: string | null;
  }>(
    `SELECT l.id, l.kind, l.email, l.display_name, l.created_at, l.last_used_at, l.strong_at,
            p.name AS pk_name, p.rp_id AS pk_rp_id, p.last_used_at AS pk_last_used_at,
            p.details_json AS pk_details
       FROM account_links l
       LEFT JOIN account_passkeys p
         ON l.kind = 'passkey' AND l.issuer_key = ? AND p.credential_id = l.subject
        AND p.account_id = l.account_id
      WHERE l.account_id = ?
      ORDER BY l.created_at, l.id`,
    PASSKEY_ISSUER,
    accountId,
  );
  return rows.map((r) => {
    const details = r.kind === "passkey" ? parseDetails(r.pk_details) : null;
    return {
      id: r.id,
      kind: r.kind,
      name:
        r.kind === "passkey"
          ? r.pk_name && r.pk_name !== ""
            ? r.pk_name
            : null
          : (r.email ?? r.display_name ?? null),
      createdAt: r.created_at,
      lastUsedAt: r.kind === "passkey" ? r.pk_last_used_at : r.last_used_at,
      strong: r.strong_at !== null,
      consoleEligible:
        r.kind === "passkey" && r.pk_rp_id === rpId && r.strong_at === null,
      aaguid: typeof details?.aaguid === "string" ? details.aaguid : null,
      addedFrom:
        typeof details?.addedFrom === "string" ? details.addedFrom : null,
    };
  });
}

/**
 * SM-3(a): the passkey ceremony for a console session, delegated to I-16. `POST options` and
 * `POST` only (listing, renaming and removal stay in the Locker account). The caller's
 * `authenticatedAt` is the session's step-up and nothing else: a session with none is passed the
 * epoch, which I-16 refuses as stale (`step_up_required`). It is never `now`.
 *
 * A successful add marks the new passkey link strong in the same request and reports its id.
 */
export async function consolePasskeyCeremony(
  req: Request,
  env: Env,
  db: Db,
  caller: { accountId: string; sid: string; stepUpAt: number | undefined },
  rest: readonly ["options"] | readonly [],
  now: number,
): Promise<{ response: Response; strongLinkId: string | null }> {
  const response = await handleAccountPasskeys(
    req,
    env,
    db,
    {
      accountId: caller.accountId,
      authenticatedAt: caller.stepUpAt ?? 0,
      sessionIdHash: await sessionIdHash(env, caller.sid),
      // The console sends its own notice for a passkey that opens it (never two for one add).
      quietAdd: true,
    },
    [...rest],
    now,
  );
  if (rest.length !== 0 || response.status !== 201)
    return { response, strongLinkId: null };
  let linkId: string | null = null;
  try {
    const body = (await response.clone().json()) as {
      passkey?: { methodId?: unknown };
    };
    if (typeof body.passkey?.methodId === "string")
      linkId = body.passkey.methodId;
  } catch {
    // An unreadable body marks nothing.
  }
  if (!linkId) return { response, strongLinkId: null };
  // The link must be this caller's own; a miss reports nothing strong (the add itself stands).
  if (!(await markLinkStrong(db, caller.accountId, linkId, now)))
    return { response, strongLinkId: null };
  return { response, strongLinkId: linkId };
}

export type MarkStrongResult =
  | { status: "marked"; kind: string }
  | { status: "not_found" | "not_eligible" | "already_strong" };

/**
 * SM-3(d), "Use for the console": mark one of the caller's own passkeys strong. The caller has
 * passed the console step-up. A link of another account is `not_found` (never a hint that it
 * exists); anything that is not a passkey enrolled under the console's RP id is `not_eligible`.
 */
export async function markConsoleMethodStrong(
  db: Db,
  accountId: string,
  linkId: string,
  rpId: string,
  now: number,
): Promise<MarkStrongResult> {
  const mine = (await listConsoleMethods(db, accountId, rpId)).find(
    (m) => m.id === linkId,
  );
  if (!mine) return { status: "not_found" };
  if (mine.strong) return { status: "already_strong" };
  if (!mine.consoleEligible) return { status: "not_eligible" };
  const changed = await db.runChanges(
    `UPDATE account_links SET strong_at = ? WHERE id = ? AND account_id = ? AND strong_at IS NULL`,
    now,
    linkId,
    accountId,
  );
  return changed > 0
    ? { status: "marked", kind: mine.kind }
    : { status: "already_strong" };
}

// ── Passkey sign-in to the console (ST-30c.5) ─────────────────────────────────────────────────

/**
 * The console's ceremony record, in the single-use store under its own id namespace and its own
 * browser cookie (`__Host-pkey_console_passkey`): the portal's `passkey-signin:` record and cookie
 * can neither start nor finish a console sign-in, nor the reverse.
 */
interface ConsoleCeremony {
  v: 1;
  purpose: "console-signin";
  challenge: string;
  rpId: string;
  createdAt: number;
  /** The account of the session that asked for a step-up; absent for a plain sign-in. */
  stepUpFor?: string;
  returnTo?: string;
}

async function consoleCeremonyRef(env: Env, secret: string) {
  return artefactRef(
    "webauthn-challenge",
    await hashKey(`console-passkey-signin:${secret}`, env.KEY_HASH_PEPPER),
  );
}

/**
 * The relying party for a console ceremony: this request must have arrived on the console origin
 * itself (the related customer origin never mints one), and a response may name that origin alone.
 */
function consoleCeremonyRp(env: Env, req: Request): RelyingParty | null {
  // Without a configured console origin no passkey can admit (`subjectForAccount`), so refuse the
  // ceremony up front rather than verify, record a use and only then refuse.
  const configured = configuredConsoleRpId(env);
  const rp = passkeyRelyingParty(env, req);
  if (!configured || !rp || rp.id !== configured) return null;
  if (rp.origin !== portalOriginOf(env, req)) return null;
  return { ...rp, origins: [rp.origin] };
}

/**
 * Whether a console passkey ceremony can run for this request at all: the console origin is
 * configured and the request arrived on it (the same test `consolePasskeyOptions` applies). The
 * sign-in card shows its passkey button, and its script, only then.
 */
export function consolePasskeyAvailable(env: Env, req: Request): boolean {
  return consoleCeremonyRp(env, req) !== null;
}

/** Whether the account holds a console-eligible (strong, console-RP) passkey: step-up's offer. */
export async function accountHasConsolePasskey(
  env: Env,
  db: Db,
  accountId: string,
): Promise<boolean> {
  return (await strongConsolePasskey(env, db, accountId)) !== null;
}

/**
 * `POST /manage/login/passkey/options`: a challenge for THIS browser. `secret` goes into the
 * ceremony cookie and is never stored; the record is addressed by its hash. `stepUpFor` is the
 * `aid` of the caller's current session when it asked for a step-up (the caller has verified it).
 * `null` when the request did not arrive on the console origin.
 */
export async function consolePasskeyOptions(
  env: Env,
  req: Request,
  opts: { stepUpFor?: string; returnTo?: string },
  now: number,
): Promise<{
  options: Awaited<ReturnType<typeof signInOptions>>;
  secret: string;
  expiresIn: number;
} | null> {
  const rp = consoleCeremonyRp(env, req);
  if (!rp) return null;
  const options = await signInOptions(rp);
  const secret = randomToken(32);
  const ceremony: ConsoleCeremony = {
    v: 1,
    purpose: "console-signin",
    challenge: options.challenge,
    rpId: rp.id,
    createdAt: now,
    ...(opts.stepUpFor ? { stepUpFor: opts.stepUpFor } : {}),
    ...(opts.returnTo ? { returnTo: opts.returnTo } : {}),
  };
  await putArtefact(
    env,
    await consoleCeremonyRef(env, secret),
    JSON.stringify(ceremony),
    PASSKEY_CEREMONY_TTL_SECONDS,
  );
  return { options, secret, expiresIn: PASSKEY_CEREMONY_TTL_SECONDS };
}

export type ConsolePasskeyRefusal =
  /** No usable ceremony: absent, spent, expired, or for another RP. */
  | "expired"
  /** Anything that failed to prove a console-eligible passkey: one answer, whatever failed. */
  | "invalid"
  /** SM-1: nobody marked the passkey strong for entry. */
  | "method"
  /** The account is disabled, erased or being erased, or has no console entry. */
  | "account"
  /** A step-up must be answered by the account that asked for it (checklist 14). */
  | "step_up_account";

export type ConsolePasskeySignInResult =
  | {
      status: "ok";
      accountId: string;
      sid: string;
      /** The resolved subject (`subjectForAccount`): member id, name, email, groups, root. */
      subject: ResolvedConsoleSubject;
      /** The ceremony asked for a step-up and the same account answered it. */
      stepUp: boolean;
      /**
       * The account holds a console-IdP link that asserts the root group but is no longer fresh:
       * "Sign in with Pocket ID first" is the guidance when it holds no other grant.
       */
      rootStale: boolean;
      returnTo: string | null;
    }
  | { status: "refused"; reason: ConsolePasskeyRefusal };

/**
 * `POST /manage/login/passkey/verify`: finish a console passkey sign-in (SM-1, SM-5, I-16).
 *
 * `secret` is the ceremony cookie's value and `currentAid` the `aid` of the caller's live console
 * session (or `null`). The checks, in order, and every one before anything is written:
 *
 *   1. the ceremony of THIS browser is taken (single use: spent whatever happens next) and its RP
 *      id is the console's;
 *   2. the response parses, the credential exists, was enrolled under the console's RP id, the
 *      user handle is the one it was created under, and its link belongs to the same account;
 *   3. `verifyAssertion` (I-16, unchanged): challenge, exact console origin, RP id hash, user
 *      verification, signature, counter. A regressed counter is audited and refused;
 *   4. SM-1: the passkey's link has `strong_at`, else `method`;
 *   5. the account is active and the erasure verdict is clear;
 *   6. a step-up is answered by the account that asked: the ceremony's `stepUpFor` and
 *      `currentAid` both equal this account, else `step_up_account`.
 *
 * Only then does it write: the counter, the link's use, the member-id mark and an
 * `account_sessions` row (`amr: ["passkey"]`, the console TTL). The caller applies the console
 * gate (a grant; the root rule) and ends the row when it fails.
 */
export async function consolePasskeySignIn(
  env: Env,
  db: Db,
  req: Request,
  input: { secret: string; response: unknown; currentAid: string | null },
  now: number,
): Promise<ConsolePasskeySignInResult> {
  const rp = consoleCeremonyRp(env, req);
  if (!rp) return { status: "refused", reason: "expired" };
  // Taken BEFORE anything is checked: a challenge verifies at most once.
  const raw = await consumeArtefact(
    env,
    await consoleCeremonyRef(env, input.secret),
  );
  let ceremony: ConsoleCeremony | null = null;
  try {
    ceremony = raw ? (JSON.parse(raw) as ConsoleCeremony) : null;
  } catch {
    ceremony = null;
  }
  if (
    !ceremony ||
    ceremony.v !== 1 ||
    ceremony.purpose !== "console-signin" ||
    typeof ceremony.challenge !== "string" ||
    ceremony.challenge === "" ||
    ceremony.rpId !== rp.id
  )
    return { status: "refused", reason: "expired" };
  const refuseInvalid = (): ConsolePasskeySignInResult => ({
    status: "refused",
    reason: "invalid",
  });

  const response = parseAuthenticationResponse(input.response);
  if (!response) return refuseInvalid();
  const passkey = await findPasskey(db, response.id);
  if (!passkey || passkey.rp_id !== rp.id) return refuseInvalid();
  if (assertionUserHandle(response) !== passkey.user_handle)
    return refuseInvalid();
  const link = await findLink(db, {
    issuerKey: PASSKEY_ISSUER,
    tenantScope: "",
    subject: passkey.credential_id,
  });
  if (!link || link.account_id !== passkey.account_id) return refuseInvalid();

  const verdict = await verifyAssertion({
    response,
    challenge: ceremony.challenge,
    rp,
    passkey,
    transports: parseTransports(passkey.transports_json),
  });
  if (!verdict.ok) {
    if (verdict.reason === "counter")
      await portalAudit(db, {
        accountId: passkey.account_id,
        action: "account.passkey.counter_regressed",
        targetKind: "link",
        targetId: link.id,
        summary:
          "Refused a passkey sign-in: its signature counter went backwards",
        now,
      });
    return refuseInvalid();
  }

  const accountId = link.account_id;
  // SM-1, after the signature (only the key's holder learns the answer) and before any write.
  if (!link.strong_at) return { status: "refused", reason: "method" };
  const account = await getAccountRow(db, accountId);
  if (
    !account ||
    account.status !== "active" ||
    (await erasureVerdict(env, now, accountId)) !== "clear"
  )
    return { status: "refused", reason: "account" };
  // Checklist item 14: a step-up for account A can never mint a session for account B.
  const stepUp = ceremony.stepUpFor !== undefined;
  if (
    stepUp &&
    (ceremony.stepUpFor !== accountId || input.currentAid !== accountId)
  )
    return { status: "refused", reason: "step_up_account" };

  if (!(await recordPasskeyUse(db, passkey, verdict, now)))
    return refuseInvalid();
  const signed = await signIn(
    db,
    {
      issuerKey: PASSKEY_ISSUER,
      subject: passkey.credential_id,
      kind: "passkey",
      amr: ["passkey"],
    },
    now,
    { env, linkedOnly: true },
  );
  if (
    signed.status !== "signed_in" ||
    signed.account.id !== accountId ||
    signed.account.status !== "active"
  )
    return { status: "refused", reason: "account" };
  const subject = await subjectForAccount(env, db, accountId, now);
  if (!subject) return { status: "refused", reason: "account" };
  // The member id is derived, never trusted from here: it only indexes the audit alias lookup.
  await db.run(
    "UPDATE account_links SET member_id = ? WHERE id = ?",
    subject.sub,
    link.id,
  );
  const { sid } = await openAccountSessionRow(
    env,
    db,
    {
      accountId,
      req,
      amr: ["passkey"],
      ttlSeconds: ADMIN_SESSION_TTL_SECONDS,
    },
    now,
  );
  let rootStale = false;
  if (!subject.root) {
    const idp = await consoleIdpLink(env, db, accountId);
    rootStale =
      idp !== null && holdsRoot(env, parseJsonStringList(idp.groups_json));
  }
  return {
    status: "ok",
    accountId,
    sid,
    subject,
    stepUp,
    rootStale,
    returnTo: ceremony.returnTo ?? null,
  };
}
