/**
 * Who is asking: the principal behind a console session (ST-28 plan §2.2, §2.4).
 *
 * ST-29 knows one source of grants, the **root rule**: a subject whose identity-provider groups
 * contain `PLATFORM_ADMIN_GROUP` holds Superadmin (`source: "root"`). It is computed from the
 * verified session on every request, never stored, and cannot be removed, so today's operators
 * need no setup and nothing changes for them.
 *
 * ST-30 moves the subject onto accounts (the `consoleSubject` hook, `asserted_at` freshness),
 * ST-31 adds stored bindings and ST-32 the SSO rules; each adds grants here. The
 * signature already takes the database so those packages change the body, not the callers.
 */

import type { Db } from "../../db/types.js";
import type { Grant, Principal } from "./can.js";

/** The verified identity a principal is resolved for (the console session's `sub` and groups). */
export interface ConsoleSubject {
  sub: string;
  groups: readonly string[];
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
  if (holdsRoot(env, subject.groups)) grants.push(ROOT_GRANT);
  return { memberId: subject.sub, grants };
}
