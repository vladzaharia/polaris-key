/**
 * The live credential check's answer (UX-69, SETUP.md D42 and W20), shared by every store.
 *
 * A connect form sends the UNSAVED value once to its check route
 * (`POST …/platform/store-connections/<store>/check`, `POST …/distribution/storefronts/<id>/
 * ci-secrets/<name>/check`). The Worker runs ONE minimal, read-only call at the store with it —
 * never a write, never a user, key or certificate endpoint — and answers what it found, in words:
 *
 *   - `valid`       the store accepted it and it can do what Polaris Key needs;
 *   - `warning`     the store accepted it, but something will bite later (it cannot see an app a
 *                   product is assigned, it belongs to another team than the one connected now,
 *                   it expires within days);
 *   - `invalid`     the store refused it, or it lacks a permission, or it has expired: the
 *                   `reason` says which and `detail` names the fix;
 *   - `unavailable` the store could not answer (rate limit, outage): nothing is known about the
 *                   key, so it is not saved;
 *   - `unchecked`   this kind of value cannot be checked from the Worker (the Steam builder
 *                   login needs SteamCMD and Steam Guard); the first use checks it.
 *
 * Nothing in a result comes from the value except its display metadata (key id, issuer id,
 * client email, the account's own name as the store reports it). Store error BODIES are never
 * copied: a status, an enum-like error token at most, mapped to sentences composed here.
 */

import type { Env } from "../../../core/platform.js";
import { rateLimitOk, type RateLimit } from "../../../core/rateLimit.js";

export type CheckVerdict =
  | "valid"
  | "warning"
  | "invalid"
  | "unavailable"
  | "unchecked";

export type CheckReason =
  /** Accepted, and able to do what Polaris Key needs. */
  | "ok"
  /** Not the right shape (caught before any call). */
  | "format"
  /** The store does not accept it: wrong, mistyped, revoked or deleted. */
  | "rejected"
  /** It has expired (or, as a warning, expires soon). */
  | "expired"
  | "expiring"
  /** Accepted, but missing a role, scope or permission Polaris Key needs. */
  | "permission"
  /** Accepted, but it belongs to another team or account, or cannot see an assigned app. */
  | "wrong-account"
  /** The thing it should reach (a tenant, a game, a fork) does not exist. */
  | "not-found"
  /** The store asked us to slow down. */
  | "rate-limited"
  /** The store failed or could not be reached. */
  | "store-down"
  /** This value cannot be checked from the Worker. */
  | "not-checkable";

export interface CheckFact {
  label: string;
  value: string;
}

export interface CredentialCheck {
  verdict: CheckVerdict;
  reason: CheckReason;
  /** One line: what was found ("Team 69a6de7f · 3 apps") or what is wrong. */
  title: string;
  /** The fix, or what the warning means, in a sentence or two; null when nothing to add. */
  detail: string | null;
  /** What the store reported: the account, the app count, the scopes, the expiry. */
  facts: CheckFact[];
  /** The form field a `format` or field-specific failure belongs to (`value.p8`, …). */
  field?: string;
  /** The store's HTTP status when it refused or failed (never its body). */
  status?: number;
}

export function checked(
  verdict: CheckVerdict,
  reason: CheckReason,
  title: string,
  detail: string | null,
  facts: CheckFact[] = [],
  extra: { field?: string; status?: number } = {},
): CredentialCheck {
  return {
    verdict,
    reason,
    title,
    detail,
    facts,
    ...(extra.field !== undefined ? { field: extra.field } : {}),
    ...(extra.status !== undefined ? { status: extra.status } : {}),
  };
}

/** A format failure, before any store call: the validator's own message, on its field. */
export function formatFailure(field: string, message: string): CredentialCheck {
  return checked(
    "invalid",
    "format",
    "This is not a complete key",
    message.charAt(0).toUpperCase() + message.slice(1) + ".",
    [],
    { field },
  );
}

/** The store could not answer: a rate limit (429), a failure (5xx, a redirect, a broken body)
 *  or no connection (status 0). Nothing is known about the value. */
export function storeUnavailable(
  store: string,
  status: number,
): CredentialCheck {
  if (status === 429)
    return checked(
      "unavailable",
      "rate-limited",
      `${store} asked Polaris Key to slow down`,
      "Nothing is known about the key yet. Check again in a minute.",
      [],
      { status },
    );
  return checked(
    "unavailable",
    "store-down",
    `${store} could not be reached`,
    `Nothing is known about the key yet. ${store} answered ${status === 0 ? "nothing" : `HTTP ${status}`}; check again in a few minutes.`,
    [],
    { status },
  );
}

/**
 * The warning for assigned apps the value cannot see: a key from another team or account, or one
 * whose access is limited to some apps. Products assigned those apps would stop working on it.
 */
export function hiddenAssignedApps(
  hidden: readonly string[],
  facts: CheckFact[],
  what: string,
): CredentialCheck {
  const list = hidden.slice(0, 5).join(", ") + (hidden.length > 5 ? ", …" : "");
  return checked(
    "warning",
    "wrong-account",
    hidden.length === 1
      ? `This ${what} cannot see an app a product is assigned: ${list}`
      : `This ${what} cannot see ${hidden.length} apps products are assigned: ${list}`,
    `It may belong to another team or account, or its access is limited to some apps. Saving it would leave ${hidden.length === 1 ? "that product" : "those products"} without a working key.`,
    facts,
  );
}

/** "1 app", "3 apps", "200+ apps". */
export function appCount(n: number, more = false): string {
  return `${n}${more ? "+" : ""} app${n === 1 && !more ? "" : "s"}`;
}

// ── rate limit ───────────────────────────────────────────────────────────────────────────────

/**
 * Checks per operator: 20 in 10 minutes, across every store and CI secret. A pasted key is
 * checked once (and again on an explicit "Check again"), so this only bites a loop. Counted
 * after the format check and before any store call, so a mistyped field costs nothing; the
 * bucket fails CLOSED (`core/rateLimit.ts`): every check spends the store's quota with a value
 * the Worker has never seen, so a limiter outage refuses rather than lets a loop through.
 */
export const CREDENTIAL_CHECK_LIMIT = { limit: 20, windowSec: 600 } as const;

export function credentialCheckRateLimit(actorSub: string): RateLimit {
  return { bucket: "credentialCheck", id: actorSub, ...CREDENTIAL_CHECK_LIMIT };
}

/** True when `actorSub` may run one more check now (and counts it). The `_admin` limiter: the
 *  same sharded object family as the console's own budget. */
export function credentialCheckAllowed(
  env: Env,
  actorSub: string,
  now: number,
): Promise<boolean> {
  return rateLimitOk(env, "_admin", credentialCheckRateLimit(actorSub), now);
}
