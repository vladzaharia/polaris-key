/**
 * Required secrets and origins fail closed instead of degrading silently.
 *
 * `configProblems` returns the NAMES (never values) of what is missing or weak. `index.ts` refuses
 * every request on a deployed environment (prod, staging, dev) while the list is non-empty; the
 * deploy workflow runs the same name check before anything ships (`scripts/check-config.mjs`).
 * Unit-test and unset environments are exempt: `hashKey`'s unpeppered fallback is reachable there
 * only.
 */
import type { Env } from "../platform/env.js";

/** Minimum length of an HMAC / pepper secret (32 random bytes encode to 43+ characters). */
export const MIN_SECRET_LENGTH = 32;

const DEPLOYED = new Set(["prod", "staging", "dev"]);

/** Secrets that must be present on a deployed environment, and be at least `MIN_SECRET_LENGTH`. */
export const REQUIRED_STRONG_SECRETS = [
  "KEY_HASH_PEPPER",
  "ADMIN_SESSION_SECRET",
  "PORTAL_SESSION_SECRET",
] as const;

/** Secrets that are optional, but must be strong when set. */
export const OPTIONAL_STRONG_SECRETS = [
  "DOWNLOAD_TICKET_KEY",
  "DOWNLOAD_TICKET_KEY_PREVIOUS",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_SECRET_PREVIOUS",
] as const;

/** Origin vars that, when set, must be an absolute `https://host` URL (a bare hostname parses to
 *  nothing, which turns the host split off). */
export const ORIGIN_VARS = ["BLOB_ORIGIN", "PKG_ORIGIN", "IMG_ORIGIN"] as const;

/** Is `value` an absolute https URL with a host? */
export function isHttpsOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
}

export function isDeployedEnvironment(env: Env): boolean {
  return DEPLOYED.has((env.PKEY_ENVIRONMENT ?? "").trim().toLowerCase());
}

/** Names of the config that is missing or weak. Empty off a deployed environment. */
export function configProblems(env: Env): string[] {
  if (!isDeployedEnvironment(env)) return [];
  const out: string[] = [];
  const get = (n: string) => {
    const v = (env as Record<string, unknown>)[n];
    return typeof v === "string" ? v : "";
  };
  for (const n of REQUIRED_STRONG_SECRETS)
    if (get(n).length < MIN_SECRET_LENGTH) out.push(n);
  for (const n of OPTIONAL_STRONG_SECRETS) {
    const v = get(n);
    if (v !== "" && v.length < MIN_SECRET_LENGTH) out.push(n);
  }
  for (const n of ORIGIN_VARS) {
    const v = get(n);
    if (v.trim() !== "" && !isHttpsOrigin(v.trim())) out.push(n);
  }
  return out;
}
