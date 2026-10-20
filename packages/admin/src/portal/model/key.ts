/**
 * Polaris Key license keys (PORTAL.md §4.17): `pkey_<product-slug>_<22 characters of
 * base64url>`, case-sensitive, never grouped or re-cased.
 */

import type { LicenseKeyCheck as KeyCheck } from "@polaris-key/manifest";
import { t } from "../../lib/copy.js";

export {
  LICENSE_KEY_PATTERN as KEY_PATTERN,
  checkLicenseKey as checkKey,
  licenseKeyParts as keyParts,
  licenseKeySlug as slugOf,
  maskLicenseKey as maskKey,
  normaliseLicenseKey as normaliseKey,
  type LicenseKeyCheck as KeyCheck,
  type LicenseKeyIncompleteReason as IncompleteReason,
} from "@polaris-key/manifest";

/**
 * The name a product is shown by (EXPERIENCE.md §0.6 P2: the presentation name, never the
 * slug). The real name wins whenever the portal has one (the account's licenses, a preview);
 * before any request, the slug is presented as words (`lumen-raw` → "Lumen Raw").
 */
export function productLabel(slug: string, known?: string | null): string {
  if (known && known.trim()) return known;
  const words = slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(" ") : slug;
}

const CUT_SHORT_NO_SLUG =
  "This key is cut short. It starts with pkey_, the product, then 22 characters. Copy the whole key again.";

/** The inline message for a key that can't be sent yet (§4.19). */
export function keyProblem(check: KeyCheck): string | null {
  if (check.kind === "notKey")
    return (
      `That isn't a Polaris Locker license key. Ours start with pkey_.` +
      (check.steam
        ? " This one looks like a Steam key: activate it in Steam."
        : "")
    );
  if (check.kind === "partial") return CUT_SHORT_NO_SLUG;
  if (check.kind === "incomplete") {
    if (check.reason === "space")
      return "This key has a space or line break in it. Copy the whole key again in one piece.";
    if (!check.slug)
      return check.reason === "short"
        ? CUT_SHORT_NO_SLUG
        : "This key doesn't look right. After pkey_ comes the product in lowercase, then _ and 22 characters. Copy the whole key again.";
    if (check.reason === "short")
      return `This key is cut short. After ${check.slug}_ come 22 characters, and this has ${check.length}. Copy the whole key again.`;
    if (check.reason === "long")
      return `This key is too long. After ${check.slug}_ come 22 characters, and this has ${check.length}. Copy only the key.`;
    return `This key doesn't look right. After ${check.slug}_ come exactly 22 letters, digits, - or _. Copy the whole key again.`;
  }
  return null;
}

// ── Verdicts ───────────────────────────────────────────────────────────────────────────────
//
// Everything the portal can say about a key, in one shape, shown inline under the field
// (PORTAL.md §4.19, EXPERIENCE.md §0.6 P1 step 4), never as a toast. A `danger` verdict blocks
// sending the same key again; a `warning` (the entries notice, Q-5) never blocks.

export type KeyVerdictCode =
  | "format"
  | "unknown"
  | "license_owned"
  | "email_mismatch"
  | "portal_off"
  | "rate_limited"
  | "failed"
  | "entries";

export interface KeyVerdict {
  code: KeyVerdictCode;
  tone: "danger" | "warning";
  message: string;
  /**
   * `license_owned` only: where the person signs in to the account that holds the license
   * (I-09's `signInUrl`). Absent until the Worker sends one; the verdict then offers only
   * **Use a different key**.
   */
  signInUrl?: string;
}

/** A key's entries (I-09 `keyEntries`): how many it has used of the product's limit. */
export interface KeyEntries {
  used: number;
  limit: number;
}

/**
 * The fields I-09 adds to the key preview and the claim refusal. Read defensively so this
 * module works against today's Worker (which sends `entries: null` and no `signInUrl`).
 */
export interface KeyVerdictExtras {
  entries?: unknown;
  keyEntries?: unknown;
  signInUrl?: unknown;
}

/** The entries a preview reports, or `null` when the product doesn't count them. */
export function readEntries(extras: KeyVerdictExtras): KeyEntries | null {
  const raw = extras.keyEntries ?? extras.entries;
  if (!raw || typeof raw !== "object") return null;
  const { used, limit } = raw as { used?: unknown; limit?: unknown };
  if (
    typeof used !== "number" ||
    typeof limit !== "number" ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    limit <= 0
  )
    return null;
  return { used, limit };
}

/** `signInUrl`, only when it is an http(s) URL (it is navigated to as-is). */
export function readSignInUrl(extras: KeyVerdictExtras): string | undefined {
  const raw = extras.signInUrl;
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:"
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** The format verdict for a key that can't be sent yet, or `null`. */
export function formatVerdict(check: KeyCheck): KeyVerdict | null {
  const message = keyProblem(check);
  return message ? { code: "format", tone: "danger", message } : null;
}

const UNKNOWN_KEY =
  "We couldn't find that key. Capital letters matter, and l, 1, O and 0 are easy to mix up, so paste the key instead of typing it.";

function ownedVerdict(name: string, extras: KeyVerdictExtras): KeyVerdict {
  const signInUrl = readSignInUrl(extras);
  return {
    code: "license_owned",
    tone: "danger",
    message: t("core.codes.license_owned.message", { product: name }),
    ...(signInUrl ? { signInUrl } : {}),
  };
}

/** A preview refusal (anything but `addable` / `already_yours`) in the person's words. */
export function previewVerdict(
  p: {
    verdict: string;
    product: { name: string; developerName: string | null } | null;
    maskedEmail?: string;
  } & KeyVerdictExtras,
  name: string,
): KeyVerdict {
  const shown = p.product?.name ?? name;
  switch (p.verdict) {
    case "license_owned":
      return ownedVerdict(shown, p);
    case "email_mismatch":
      return {
        code: "email_mismatch",
        tone: "danger",
        message: `${shown} was bought with ${p.maskedEmail ?? "another email"}. It joins only the account with that email verified.`,
      };
    case "portal_off":
      return {
        code: "portal_off",
        tone: "danger",
        message: `${p.product?.developerName ?? shown} manages this license elsewhere.`,
      };
    default:
      return { code: "unknown", tone: "danger", message: UNKNOWN_KEY };
  }
}

/** A claim refusal, from its status and error code, in the person's words. */
export function claimVerdict(
  err: { status: number; code?: string } & KeyVerdictExtras,
  name: string,
): KeyVerdict | null {
  if (err.code === "license_owned") return ownedVerdict(name, err);
  if (err.code === "email_mismatch")
    return {
      code: "email_mismatch",
      tone: "danger",
      message: `${name} joins only the account with the license's email verified.`,
    };
  if (err.status === 401)
    return { code: "unknown", tone: "danger", message: UNKNOWN_KEY };
  if (err.status === 404)
    return {
      code: "portal_off",
      tone: "danger",
      message: `${name} manages this license elsewhere.`,
    };
  if (err.status === 422)
    return {
      code: "format",
      tone: "danger",
      message: `That isn't a Polaris Locker license key. Ours start with pkey_.`,
    };
  if (err.status === 429)
    return {
      code: "rate_limited",
      tone: "danger",
      message: "Too many tries. Wait a minute, then try again.",
    };
  return null;
}

/** SIGN-IN.md §5.2 `signin.key.noEntries` (the kit key, which names the product): the one wording
 *  of "this key has no entries left" where the product is known. The core copy of
 *  `key_entry_limit` (`conformance/parity/copy.en.json`, PX-W9) is the same sentence without the
 *  product, for SDKs that cannot name it. */
export function noEntriesCopy(name: string): string {
  return t("signin.key.noEntries", { product: name });
}

/**
 * The entries notice (PORTAL.md §4.19, decided Q-5): a `warning` once the key has used all its
 * entries. Adding stays enabled; adding is the way past the limit.
 */
export function entriesVerdict(
  entries: KeyEntries | null,
  name: string,
): KeyVerdict | null {
  if (!entries || entries.used < entries.limit) return null;
  return { code: "entries", tone: "warning", message: noEntriesCopy(name) };
}

/**
 * Whether sending the same key again would get the same answer: refusals block Continue until
 * the key changes; a failure to reach the Worker, a rate limit and the entries notice don't.
 */
export function blocksResend(verdict: KeyVerdict | null): boolean {
  if (!verdict || verdict.tone !== "danger") return false;
  return verdict.code !== "failed" && verdict.code !== "rate_limited";
}
