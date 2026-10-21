/**
 * Which identity provider may sign operators in (ST-28 plan §2.5 SM-2; built by ST-30).
 *
 * The console's own IdP (`console-idp`, the issuer of `adminOidcConfig`) always qualifies: it is a
 * deploy-time secret, as S-13 §8.2 requires of "the admin IdP". Any other issuer qualifies only when
 * its host is on `OIDC_ISSUER_ALLOWLIST`, and this check FAILS CLOSED: with the list unset or empty
 * no other issuer qualifies, in every environment. That is deliberately not
 * `issuerHostAllowed` (identity/productOidc/config.ts), which is fail-open outside prod because it
 * guards where the platform sends a customer client's secret, not who may become an operator.
 *
 * Pure: reads the environment and compares strings, so Core and the console can both ask.
 */

import { adminOidcConfig } from "../../platform/platformOidc.js";
import { secret, type Env } from "../../platform/env.js";

const trimSlash = (issuer: string): string => issuer.replace(/\/$/, "");

/** True when `issuer` is the console's own IdP (trailing slash ignored, exact otherwise). */
export function isConsoleIdpIssuer(env: Env, issuer: string): boolean {
  const own = adminOidcConfig(env)?.issuer;
  return !!own && trimSlash(own) === trimSlash(issuer);
}

/** True when `issuer` may sign an operator in: `console-idp`, or a listed host (never by default). */
export function operatorIssuerAllowed(env: Env, issuer: string): boolean {
  if (!issuer) return false;
  if (isConsoleIdpIssuer(env, issuer)) return true;
  const hosts = (secret(env, "OIDC_ISSUER_ALLOWLIST") ?? "")
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length === 0) return false;
  try {
    const url = new URL(issuer);
    // https only: the allowlist names a host, and an operator IdP over plain http is no IdP.
    return url.protocol === "https:" && hosts.includes(url.host.toLowerCase());
  } catch {
    return false;
  }
}
