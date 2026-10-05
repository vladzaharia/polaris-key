/**
 * Polaris Key license keys (PORTAL.md §4.17): `pkey_<product-slug>_<22 characters of
 * base64url>`, case-sensitive, never grouped or re-cased.
 */

/**
 * The masked display: the prefix, the slug, an ellipsis and the last 4 (`pkey_tidewater_…KQ2w`).
 * Without the last 4 (today's Worker keeps none, G7) it ends at the ellipsis.
 */
export function maskKey(slug: string, last4?: string | null): string {
  return `pkey_${slug}_…${last4 ?? ""}`;
}

/** The exact minted format (`mintLicenseKey`): the portal checks the full length. */
export const KEY_PATTERN = /^pkey_([a-z0-9-]+)_([A-Za-z0-9_-]{22})$/;
const PREFIX = "pkey_";
const SECRET_LENGTH = 22;
const STEAM_SHAPE = /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i;

/** The only normalisation (§4.17): trim leading and trailing whitespace, newlines included. */
export function normaliseKey(raw: string): string {
  return raw.replace(/^\s+|\s+$/g, "");
}

export type KeyCheck =
  | { kind: "empty" }
  /** Still typing the prefix ("pke"). */
  | { kind: "partial" }
  | { kind: "valid"; slug: string; secret: string }
  | { kind: "notKey"; steam: boolean }
  /** The right prefix, the wrong length or a character outside A–Z a–z 0–9 - _. */
  | { kind: "incomplete"; slug: string | null; length: number; short: boolean };

export function checkKey(raw: string): KeyCheck {
  const key = normaliseKey(raw);
  if (!key) return { kind: "empty" };
  if (!key.startsWith(PREFIX)) {
    if (PREFIX.startsWith(key)) return { kind: "partial" };
    return { kind: "notKey", steam: STEAM_SHAPE.test(key) };
  }
  const m = KEY_PATTERN.exec(key);
  if (m) return { kind: "valid", slug: m[1]!, secret: m[2]! };
  const parts = /^pkey_([a-z0-9-]+)_(.*)$/s.exec(key);
  if (!parts) return { kind: "incomplete", slug: null, length: 0, short: true };
  const secret = parts[2]!;
  return {
    kind: "incomplete",
    slug: parts[1]!,
    length: secret.length,
    short: secret.length < SECRET_LENGTH && /^[A-Za-z0-9_-]*$/.test(secret),
  };
}

/** The slug a key names, as soon as its prefix is complete (before any request). */
export function slugOf(raw: string): string | null {
  const m = /^pkey_([a-z0-9-]+)_/.exec(normaliseKey(raw));
  return m ? m[1]! : null;
}

/** The key split for colouring: `pkey_` · slug · `_` · secret (or the raw text). */
export function keyParts(
  raw: string,
): { prefix: string; slug: string; sep: string; rest: string } | null {
  const m = /^(pkey_)([a-z0-9-]*)(_?)(.*)$/s.exec(raw);
  if (!m) return null;
  return { prefix: m[1]!, slug: m[2]!, sep: m[3]!, rest: m[4]! };
}

/** The inline message for a key that can't be sent yet (§4.19). */
export function keyProblem(check: KeyCheck): string | null {
  if (check.kind === "notKey")
    return (
      "That isn't a Polaris Key license key. Ours start with pkey_." +
      (check.steam
        ? " This one looks like a Steam key: activate it in Steam."
        : "")
    );
  if (check.kind === "incomplete") {
    if (!check.slug)
      return "This key is cut short. It starts with pkey_, the product, then 22 characters. Copy the whole key again.";
    if (check.short)
      return `This key is cut short. After ${check.slug}_ come 22 characters, and this has ${check.length}. Copy the whole key again.`;
    return `This key doesn't look right. After ${check.slug}_ come exactly 22 letters, digits, - or _. Copy the whole key again.`;
  }
  return null;
}
