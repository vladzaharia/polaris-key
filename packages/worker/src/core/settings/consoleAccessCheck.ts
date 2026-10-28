/**
 * The write-time checks of `console.access` that need the database (ST-28 plan §2.4, ST-32.2).
 *
 * The document's shape is `parseAccessRules` (`core/rbac/claimMatcher.ts`). What it cannot know
 * lives here: every rule's connection must be an operator connection (SM-2), and a `domain`
 * matcher needs a domain that is DNS-verified AND enforced on that connection. `write.ts` runs
 * this for every write of the key, so no caller can skip it. Evaluation re-checks both at every
 * request (ST-32.3), so a connection that stops qualifying later grants nothing.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { parseAccessRules } from "../rbac/claimMatcher.js";
import {
  enforcedDomainsOf,
  isOperatorConnection,
} from "../rbac/operatorConnections.js";

/** The key this module guards. */
export const CONSOLE_ACCESS_KEY = "console.access";

/**
 * Why `value` may not be stored as the rule document, or `null` when it may. Every rule is
 * checked, in order; the first refusal names the rule's position, never a person or a secret.
 */
export async function accessRulesRefusal(
  env: Env,
  db: Db,
  value: unknown,
): Promise<{ reason: string; message: string } | null> {
  const parsed = parseAccessRules(value);
  if (!parsed.ok) return { reason: "invalid_rules", message: parsed.reason };
  const operator = new Map<string, boolean>();
  const domains = new Map<string, ReadonlySet<string>>();
  for (const [i, rule] of parsed.doc.rules.entries()) {
    const id = rule.when.connection;
    if (!operator.has(id))
      operator.set(id, await isOperatorConnection(env, db, id));
    if (!operator.get(id))
      return {
        reason: "not_operator_connection",
        message: `rules[${i}] names a connection that is not an operator connection`,
      };
    if ("domain" in rule.when) {
      if (!domains.has(id))
        domains.set(id, await enforcedDomainsOf(env, db, id));
      if (!domains.get(id)!.has(rule.when.domain))
        return {
          reason: "domain_not_enforced",
          message: `rules[${i}] needs a verified, enforced domain on its connection`,
        };
    }
  }
  return null;
}
