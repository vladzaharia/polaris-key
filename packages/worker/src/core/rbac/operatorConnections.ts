/**
 * Which connections are operator connections (ST-28 plan §2.5 SM-2; ST-32.2).
 *
 * `console-idp` always qualifies: it is the console's own deploy-time IdP, and it has no
 * `identity_connections` row. Any other connection qualifies only when it is a platform-scope,
 * active connection whose audience covers operators and whose issuer passes
 * `operatorIssuerAllowed` (which fails closed). The write validator for `console.access` and, in
 * ST-32.3, per-request evaluation ask this one function, so a connection that stops qualifying is
 * refused at write and ignored at evaluation by the same rule.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import {
  audienceCovers,
  enforcedDomains,
  resolveConnection,
} from "../oidc/connections.js";
import { operatorIssuerAllowed } from "./operatorIssuer.js";

/** The id a rule names for the console's own IdP. */
export const CONSOLE_IDP_CONNECTION = "console-idp";

export async function isOperatorConnection(
  env: Env,
  db: Db,
  id: string,
): Promise<boolean> {
  if (id === CONSOLE_IDP_CONNECTION) return true;
  const c = await resolveConnection(db, id);
  return (
    c !== null &&
    c.scope === "platform" &&
    c.status === "active" &&
    audienceCovers(c.audience, "operators") &&
    operatorIssuerAllowed(env, c.issuer)
  );
}

/**
 * The domains a `domain` rule may name on `connection`: verified and enforced. Empty for
 * `console-idp` (no domain proof exists for it) and for a connection that does not qualify.
 */
export async function enforcedDomainsOf(
  env: Env,
  db: Db,
  connection: string,
): Promise<ReadonlySet<string>> {
  if (connection === CONSOLE_IDP_CONNECTION) return new Set();
  if (!(await isOperatorConnection(env, db, connection))) return new Set();
  return new Set(await enforcedDomains(db, connection));
}
