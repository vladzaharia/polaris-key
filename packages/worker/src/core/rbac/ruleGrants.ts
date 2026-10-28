/**
 * Per-request evaluation of the `console.access` rules (ST-28 plan §2.4, built by ST-32.3).
 *
 * `resolvePrincipal` calls {@link ruleGrantsFor} for a signed-in account; the Members preview calls
 * {@link ruleMatchesFor} with a candidate document. Both end in `evaluate` (`claimMatcher.ts`),
 * so what a preview shows is what a sign-in grants.
 *
 * The input is the account's strong OIDC links through operator connections, read from the
 * database on every call (nothing is stored on the principal):
 *   - the connection must still be an operator connection (`isOperatorConnection`, SM-2), and for
 *     `console-idp` its issuer must still be allowed;
 *   - the link is the `account_links` row of that connection's issuer (`tenant_scope = ''`,
 *     `kind = 'oidc'`) with `strong_at` set;
 *   - `asserted_at` is no older than 8 h and not from the future, the same freshness as the root
 *     rule. A link without it contributes nothing;
 *   - `email` is passed only when the IdP marked the address verified. An address confirmed by an
 *     email code is a different link (`kind = 'email'`) and is never read here.
 * The rule document comes from the `console.access` setting, whose 30-second per-isolate cache
 * bounds how long a deleted rule keeps granting. Everything fails closed: an unreadable setting,
 * a malformed document or a malformed link row yields no grant.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { adminOidcConfig } from "../../platform/platformOidc.js";
import {
  isJsonObject,
  parseJsonOr,
  parseJsonStringList,
} from "../../platform/json.js";
import { ADMIN_SESSION_TTL_SECONDS } from "../console/session.js";
import { resolveConnection } from "../oidc/connections.js";
import { platformSetting } from "../settings/platformRead.js";
import type { Grant } from "./can.js";
import {
  evaluate,
  parseAccessRules,
  type AccessRule,
  type DomainFacts,
  type LinkFacts,
  type RuleMatch,
} from "./claimMatcher.js";
import {
  CONSOLE_IDP_CONNECTION,
  enforcedDomainsOf,
  isOperatorConnection,
} from "./operatorConnections.js";
import { operatorIssuerAllowed } from "./operatorIssuer.js";

/** How far ahead of the Worker's clock an `asserted_at` may be before it counts as not fresh. */
export const ASSERTED_SKEW_SECONDS = 60;

/** True when the IdP asserted the link's claims no more than `maxAgeSeconds` ago. Missing denies. */
export function assertionFresh(
  assertedAt: number | null,
  now: number,
  maxAgeSeconds: number,
): boolean {
  if (assertedAt === null || !Number.isFinite(assertedAt)) return false;
  const age = now - assertedAt;
  return age >= -ASSERTED_SKEW_SECONDS && age <= maxAgeSeconds;
}

const trimSlash = (issuer: string): string => issuer.replace(/\/$/, "");

/** The issuer a rule's connection signs in through, or null when it no longer qualifies. */
async function operatorIssuerOf(
  env: Env,
  db: Db,
  connection: string,
): Promise<string | null> {
  if (!(await isOperatorConnection(env, db, connection))) return null;
  if (connection === CONSOLE_IDP_CONNECTION) {
    const issuer = adminOidcConfig(env)?.issuer;
    return issuer && operatorIssuerAllowed(env, issuer)
      ? trimSlash(issuer)
      : null;
  }
  const c = await resolveConnection(db, connection);
  return c ? trimSlash(c.issuer) : null;
}

interface LinkRow {
  groups_json: string | null;
  claims_json: string | null;
  email: string | null;
  email_verified: number;
  strong_at: number | null;
  asserted_at: number | null;
}

/** The facts every rule is evaluated against, for the connections the rules name. */
export async function linkFactsFor(
  env: Env,
  db: Db,
  accountId: string,
  connections: readonly string[],
  now: number,
): Promise<{ links: LinkFacts[]; domainFacts: DomainFacts }> {
  const links: LinkFacts[] = [];
  const domains = new Map<string, ReadonlySet<string>>();
  for (const connection of new Set(connections)) {
    const issuer = await operatorIssuerOf(env, db, connection);
    if (issuer === null) continue;
    const rows = await db.all<LinkRow>(
      `SELECT groups_json, claims_json, email, email_verified, strong_at, asserted_at
         FROM account_links
        WHERE account_id = ? AND issuer_key = ? AND tenant_scope = '' AND kind = 'oidc'
          AND strong_at IS NOT NULL
        ORDER BY last_used_at DESC LIMIT 5`,
      accountId,
      issuer,
    );
    for (const r of rows) {
      if (!assertionFresh(r.asserted_at, now, ADMIN_SESSION_TTL_SECONDS))
        continue;
      const claims = parseJsonOr<unknown>(r.claims_json, {});
      links.push({
        connection,
        groups: parseJsonStringList(r.groups_json),
        claims: isJsonObject(claims) ? claims : {},
        email: r.email_verified === 1 && r.email ? r.email : null,
      });
    }
    domains.set(connection, await enforcedDomainsOf(env, db, connection));
  }
  return { links, domainFacts: domains };
}

/**
 * Every rule of `rules` that holds for this account, as `evaluate` answers it. The one call both
 * the preview (a candidate document) and sign-in (the stored one) make.
 */
export async function ruleMatchesFor(
  env: Env,
  db: Db,
  accountId: string,
  rules: readonly AccessRule[],
  now: number,
): Promise<RuleMatch[]> {
  if (rules.length === 0) return [];
  const { links, domainFacts } = await linkFactsFor(
    env,
    db,
    accountId,
    rules.map((r) => r.when.connection),
    now,
  );
  if (links.length === 0) return [];
  return evaluate(links, rules, domainFacts);
}

/** The stored rules, through the settings cache. Unreadable or malformed: no rules. */
async function storedRules(env: Env, db: Db): Promise<AccessRule[]> {
  try {
    const value = await platformSetting(env, db, "console.access");
    const parsed = parseAccessRules(value);
    return parsed.ok ? parsed.doc.rules : [];
  } catch {
    return [];
  }
}

/** The `source: "rule"` grants of one account, at `now`. */
export async function ruleGrantsFor(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
): Promise<Grant[]> {
  const rules = await storedRules(env, db);
  if (rules.length === 0) return [];
  try {
    return (await ruleMatchesFor(env, db, accountId, rules, now)).map(
      (m) => m.grant,
    );
  } catch {
    return [];
  }
}
