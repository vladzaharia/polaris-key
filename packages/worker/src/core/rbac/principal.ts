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
 */

import type { Db } from "../../db/types.js";
import type { Grant, Principal } from "./can.js";

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

/** How far ahead of the Worker's clock an `asserted_at` may be before it counts as not fresh. */
const ASSERTED_SKEW_SECONDS = 60;

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
  const age = now - link.assertedAt;
  if (age < -ASSERTED_SKEW_SECONDS || age > maxAgeSeconds) return false;
  return holdsRoot(env, link.groups);
}

/**
 * The principal for a verified subject. A subject with no grant is still returned (with an empty
 * `grants`), so callers can tell "signed in but not a member" from "not signed in"; `can()`
 * denies it everything, `console` included.
 */
export async function resolvePrincipal(
  env: RootEnv,
  db: Db | null,
  subject: ConsoleSubject,
  now: number,
): Promise<Principal> {
  void db;
  void now;
  const grants: Grant[] = [];
  const root =
    subject.root !== undefined ? subject.root : holdsRoot(env, subject.groups);
  if (root) grants.push(ROOT_GRANT);
  return { memberId: subject.sub, grants };
}
