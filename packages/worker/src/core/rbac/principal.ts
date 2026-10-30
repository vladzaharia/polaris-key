/**
 * Who is asking: the principal behind a console session (ST-28 plan §2.2, §2.4).
 *
 * ST-29 knows one source of grants, the **root rule**: a subject whose identity-provider groups
 * contain `PLATFORM_ADMIN_GROUP` holds Superadmin (`source: "root"`). It is computed from the
 * verified session on every request, never stored, and cannot be removed, so today's operators
 * need no setup and nothing changes for them.
 *
 * ST-30 moves the subject onto accounts (the `consoleSubject` hook; `rootRuleHolds` is the
 * `strong_at` + `asserted_at` freshness rule a v2 session's `root` comes from), ST-31 adds stored bindings and ST-32 the SSO rules; each adds grants here. The
 * signature already takes the database so those packages change the body, not the callers.
 *
 * ST-31.2: a subject that carries an `accountId` (a v2 session only) also holds the stored
 * bindings of that account (`console_role_bindings`, `source` grant / invite / creator), read from
 * the database on every request and appended after the root grant, so a deleted binding stops
 * granting on the next request. The two sources are summed; neither can remove the other. A v1
 * cookie and a `pkeya_` token carry no account id and stay root-only. Email rows (unclaimed
 * invites) never grant: only a row naming the account does.
 *
 * ST-32.3: the same account also holds the grants of the `console.access` rules that match its
 * strong operator-connection links (`source: "rule"`, `ruleGrants.ts`), computed on every request.
 */

import type { Db } from "../../db/types.js";
import type { Grant, Principal } from "./can.js";
import type { Env } from "../../platform/env.js";
import { listAccountGrants } from "./bindings.js";
import { assertionFresh, ruleGrantsFor } from "./ruleGrants.js";

/** The verified identity a principal is resolved for (the console session's `sub` and groups). */
export interface ConsoleSubject {
  sub: string;
  groups: readonly string[];
  /**
   * The computed root rule (ST-30 slice 2b, `rootRuleHolds`), when the caller read it from an
   * account's link. Authoritative when present: a v2 session always sets it, so stale or
   * non-strong groups never root anyone. Absent for groups the IdP asserted in THIS request (the
   * sign-in gate) and for a v1 cookie, which carries its own 8 h bound.
   */
  root?: boolean;
  /**
   * The signed-in account (`AdminSession.aid`, v2 only). Selects the stored bindings. Never
   * logged, never put in a response body (`accountIdBoundary.test.ts`). Absent for a v1 cookie,
   * a `pkeya_` token and the sign-in gate, which resolve the root rule alone. (An admin-scope
   * `pkeyp_` token does carry it, ST-34.3: it acts as its holder.)
   */
  accountId?: string;
}

/** The deploy-time root of console authority (AT-2, S-13 §8.2). */
export interface RootEnv {
  PLATFORM_ADMIN_GROUP?: string;
}

/** The root grant: Superadmin at platform scope. */
export const ROOT_GRANT: Grant = {
  role: "superadmin",
  scope: "platform",
  areas: null,
  source: "root",
};

/** True when the subject's groups carry the platform-admin group. An unset group roots no one. */
export function holdsRoot(env: RootEnv, groups: readonly string[]): boolean {
  const group = env.PLATFORM_ADMIN_GROUP;
  return !!group && groups.includes(group);
}

/** What the root rule reads off a console-IdP link (`account_links`). */
export interface RootLink {
  /** `strong_at`: when the method became eligible for the console (SM-3), or null. */
  strongAt: number | null;
  /** `asserted_at`: when the IdP last asserted `groups` (written only with them), or null. */
  assertedAt: number | null;
  groups: readonly string[];
}

/**
 * The root rule (ST-28 plan §2.4), computed and never stored: the link is strong, its groups
 * carry `PLATFORM_ADMIN_GROUP`, and the IdP asserted them no more than `maxAgeSeconds` ago
 * (`ADMIN_SESSION_TTL_SECONDS`, 8 h). `asserted_at`, not `last_used_at`: a path that signed in
 * without rewriting the groups cannot keep a stale group alive. Any missing value denies, and so
 * does an `asserted_at` from the future. The caller has already checked that the link is through
 * the console IdP, a console-IdP link with `tenant_scope = ''`.
 */
export function rootRuleHolds(
  env: RootEnv,
  link: RootLink,
  now: number,
  maxAgeSeconds: number,
): boolean {
  if (link.strongAt === null || link.assertedAt === null) return false;
  if (!Number.isFinite(link.assertedAt) || !Number.isFinite(link.strongAt))
    return false;
  if (!assertionFresh(link.assertedAt, now, maxAgeSeconds)) return false;
  return holdsRoot(env, link.groups);
}

function grantKey(g: Grant): string {
  return `${g.role}|${g.scope}|${g.areas === null ? "*" : g.areas.join(",")}|${g.source}`;
}

/**
 * The principal for a verified subject. A subject with no grant is still returned (with an empty
 * `grants`), so callers can tell "signed in but not a member" from "not signed in"; `can()`
 * denies it everything, `console` included.
 */
export async function resolvePrincipal(
  env: RootEnv & Partial<Env>,
  db: Db | null,
  subject: ConsoleSubject,
  now: number,
): Promise<Principal> {
  const grants: Grant[] = [];
  const root =
    subject.root !== undefined ? subject.root : holdsRoot(env, subject.groups);
  if (root) grants.push(ROOT_GRANT);
  if (db && subject.accountId) {
    const seen = new Set(grants.map(grantKey));
    for (const g of await listAccountGrants(db, subject.accountId)) {
      const key = grantKey(g);
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push(g);
    }
    // ST-32.3: SSO rules (`console.access`), evaluated now from the account's links. They add
    // `product_admin` and `console_access` grants only; the root rule and the stored bindings
    // above are unchanged and neither can remove the other.
    for (const g of await ruleGrantsFor(
      env as Env,
      db,
      subject.accountId,
      now,
    )) {
      const key = grantKey(g);
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push(g);
    }
  }
  return { memberId: subject.sub, grants };
}
