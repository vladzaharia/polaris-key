/**
 * The licence-key format (`pkey_<product-slug>_<22 characters of base64url>`), checked as a
 * person types it. One definition for the customer portal, the console's `KeyField` and any
 * other surface that reads a key; the Worker mints it (`mintLicenseKey`), this only reads it.
 * Display only: the wire never carries these results, and no sentence lives here (each surface
 * words its own refusal).
 */

/** The prefix every licence key starts with. */
export const LICENSE_KEY_PREFIX = "pkey_";
/** The characters of base64url after the product slug. */
export const LICENSE_KEY_SECRET_LENGTH = 22;
/** The exact minted format: prefix, lowercase product slug, `_`, 22 characters of base64url. */
export const LICENSE_KEY_PATTERN = /^pkey_([a-z0-9-]+)_([A-Za-z0-9_-]{22})$/;

const STEAM_SHAPE = /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i;

/** The masked display: the prefix, the slug, an ellipsis and the last 4 (`pkey_tidewater_…KQ2w`). */
export function maskLicenseKey(slug: string, last4?: string | null): string {
  return `${LICENSE_KEY_PREFIX}${slug}_…${last4 ?? ""}`;
}

/** The only normalisation: trim leading and trailing whitespace, newlines included. */
export function normaliseLicenseKey(raw: string): string {
  return raw.replace(/^\s+|\s+$/g, "");
}

/** Why a key with the right prefix can't be sent yet. */
export type LicenseKeyIncompleteReason =
  /** The secret is shorter than 22 (or the slug's separator hasn't arrived). */
  | "short"
  /** Longer than 22 characters of the secret alphabet. */
  | "long"
  /** A space or line break inside the key (a key wrapped across lines in an email). */
  | "space"
  /** A character outside A–Z a–z 0–9 - _, or a slug that isn't lowercase. */
  | "chars";

export type LicenseKeyCheck =
  | { kind: "empty" }
  /** Still typing the prefix ("pke"). */
  | { kind: "partial" }
  | { kind: "valid"; slug: string; secret: string }
  | { kind: "notKey"; steam: boolean }
  /** The right prefix, the wrong length or a character outside A–Z a–z 0–9 - _. */
  | {
      kind: "incomplete";
      slug: string | null;
      length: number;
      short: boolean;
      reason: LicenseKeyIncompleteReason;
    };

/** Classify what a person has typed or pasted. */
export function checkLicenseKey(raw: string): LicenseKeyCheck {
  const key = normaliseLicenseKey(raw);
  if (!key) return { kind: "empty" };
  if (!key.startsWith(LICENSE_KEY_PREFIX)) {
    if (LICENSE_KEY_PREFIX.startsWith(key)) return { kind: "partial" };
    return { kind: "notKey", steam: STEAM_SHAPE.test(key) };
  }
  const m = LICENSE_KEY_PATTERN.exec(key);
  if (m) return { kind: "valid", slug: m[1]!, secret: m[2]! };
  const parts = /^pkey_([a-z0-9-]+)_(.*)$/s.exec(key);
  if (!parts) {
    // "pkey_tidewater": the product so far, no separator yet. Anything else (an upper-case
    // slug, a stray character) is a key that doesn't look right, not one that's cut short.
    const cut = /^pkey_[a-z0-9-]*$/.test(key);
    return {
      kind: "incomplete",
      slug: null,
      length: 0,
      short: cut,
      reason: cut ? "short" : /\s/.test(key) ? "space" : "chars",
    };
  }
  const secret = parts[2]!;
  const alphabet = /^[A-Za-z0-9_-]*$/.test(secret);
  const reason: LicenseKeyIncompleteReason = /\s/.test(secret)
    ? "space"
    : !alphabet
      ? "chars"
      : secret.length < LICENSE_KEY_SECRET_LENGTH
        ? "short"
        : "long";
  return {
    kind: "incomplete",
    slug: parts[1]!,
    length: secret.length,
    short: reason === "short",
    reason,
  };
}

/** The slug a key names, as soon as its prefix is complete (before any request). */
export function licenseKeySlug(raw: string): string | null {
  const m = /^pkey_([a-z0-9-]+)_/.exec(normaliseLicenseKey(raw));
  return m ? m[1]! : null;
}

/** The key split for colouring: `pkey_` · slug · `_` · secret (or the raw text). */
export function licenseKeyParts(
  raw: string,
): { prefix: string; slug: string; sep: string; rest: string } | null {
  const m = /^(pkey_)([a-z0-9-]*)(_?)(.*)$/s.exec(raw);
  if (!m) return null;
  return { prefix: m[1]!, slug: m[2]!, sep: m[3]!, rest: m[4]! };
}
