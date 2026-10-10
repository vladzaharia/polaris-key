/**
 * `identity.platformTerms` (I-33; plans/I-27.md §2.4, §3, Q2): Polaris Key's own terms and privacy
 * notice, `{version, termsUrl, privacyUrl}`, a platform setting that is UNSET by default.
 *
 * Unset, no step shows and no row is written: the mechanism is dormant until the owner publishes
 * reviewed terms (`docs/legal/README.md`: the drafts are not to be published). Set, every new
 * account accepts this version in FinishStep before it exists (`services/identity/card/gate.ts`),
 * recorded as a `_platform` row of `account_terms_acceptances` whose `url` is `termsUrl`. The
 * privacy notice is linked beside it on the same rule as a product's: it informs, it is not a
 * contract, so it gets no acceptance row.
 *
 * Storage is the registry's `scalar` kind with no row alias: a `platform_settings` row keyed by the
 * registry key, holding the JSON object. No console route writes it yet (ST-05 was dropped), so
 * publishing is an owner step: one `INSERT` into `platform_settings` (docs/RUNBOOK.md, "Publish
 * Polaris Key's terms"), and it waits for PX-21's FinishStep UI, I-30's `/callback` through the
 * gate and I-32b's retirement of the legacy product callback, the account-creating paths that
 * cannot show the step today.
 *
 * Read fresh (one primary-key read, no cache): the version a gate records is the version it
 * showed, so a gate opened just before a change keeps the version it opened with. A stored value
 * that is not exactly this shape reads as unset; an unreadable table throws, so an outage never
 * creates an account without the acceptance published terms require. Core-owned (the table is
 * Core's), product-less, no outbound call.
 */

import type { Db } from "../db/types.js";

/** The registry key, which is also the `platform_settings` row key (no `storedAs` alias). */
export const PLATFORM_TERMS_KEY = "identity.platformTerms";

/** The `product` column of a platform acceptance in `account_terms_acceptances`. */
export const PLATFORM_TERMS_PRODUCT = "_platform";

export interface PlatformTerms {
  /** The published version, e.g. `2026-10`. */
  version: string;
  /** The terms the person accepts (https). */
  termsUrl: string;
  /** The privacy notice linked beside them (https); informs, never accepted. */
  privacyUrl: string;
}

/** A terms version: what `identity.terms`'s version accepts too (a date or a short label). */
export const TERMS_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URL_MAX = 2048;

/** An https URL with a host and no credentials, at most 2048 characters, or `null`. */
export function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname) return null;
  if (url.username || url.password) return null;
  return raw;
}

/** The stored value as terms, or `null` when it is not exactly `{version, termsUrl, privacyUrl}`. */
export function parsePlatformTerms(value: unknown): PlatformTerms | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys !== "privacyUrl,termsUrl,version") return null;
  if (typeof v.version !== "string" || !TERMS_VERSION_RE.test(v.version))
    return null;
  const termsUrl = httpsUrl(v.termsUrl);
  const privacyUrl = httpsUrl(v.privacyUrl);
  if (!termsUrl || !privacyUrl) return null;
  return { version: v.version, termsUrl, privacyUrl };
}

/** Polaris Key's published terms, or `null` while `identity.platformTerms` is unset. */
export async function platformTerms(db: Db): Promise<PlatformTerms | null> {
  const row = await db.first<{ value_json: string }>(
    "SELECT value_json FROM platform_settings WHERE key = ?",
    PLATFORM_TERMS_KEY,
  );
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.value_json) as unknown;
  } catch {
    return null;
  }
  return parsePlatformTerms(value);
}
