/**
 * The focused flows' return URL (PORTAL.md §3.3, PX-10): `?return=` is followed only when it
 * matches a browser origin or an app scheme the product declares (`GET /api/products/<p>`
 * `returnTo`); anything else, including a malformed or oversized value, is dropped and the flow
 * ends on the product page. Pure, so it is tested on its own.
 *
 * The Activate deep link (PORTAL.md §4.18, PX-17) adds one same-origin target, the login card
 * (`cardReturn`), and neither kind ever carries a license key (`carriesKey`): a return URL is
 * navigated to, so a key in it would reach a server and its logs (THREAT-MODEL.md, "Key-bearing
 * deep links").
 */

export interface ReturnTargets {
  /** Exact origins (`https://app.example`, `http://127.0.0.1:8080`). */
  origins: readonly string[];
  /** App schemes without the colon (`tidewater`). */
  schemes: readonly string[];
}

/** Longest return URL considered; app links and web URLs fit well inside it. */
export const MAX_RETURN_LENGTH = 2048;

/** Schemes that run or embed content in the page: never a return target, declared or not. */
const NEVER = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
  "blob",
  "about",
  "filesystem",
]);

function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** A license key (`pkey_<slug>_<22 base64url>`, PORTAL.md §4.17) anywhere in `value`. */
const KEY_ANYWHERE = /pkey_[a-z0-9-]+_[A-Za-z0-9_-]{22}/;
/** Percent-decoding rounds tried (`%255F` is `_` encoded twice) before a value is refused. */
const DECODE_ROUNDS = 4;

/**
 * Whether `value` holds a license key, as written or percent-decoded (`pkey%5Fslug%5F…`), again
 * for a value encoded more than once. A malformed encoding, or one still changing after a few
 * rounds, counts as holding one: a value that cannot be read is never carried into a URL either.
 */
export function carriesKey(value: string): boolean {
  let current = value;
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    if (KEY_ANYWHERE.test(current)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (decoded === current) return false;
    current = decoded;
  }
  return true;
}

/** The return URL to follow, normalised, or `null` when it isn't one the product declares. */
export function allowedReturn(
  raw: string | null | undefined,
  targets: ReturnTargets | null | undefined,
): string | null {
  if (!raw || !targets) return null;
  const value = raw.trim();
  if (!value || value.length > MAX_RETURN_LENGTH) return null;
  // Control characters and whitespace inside a URL are how parsers get fooled.
  if (/[\u0000- \u007f-\u009f]/.test(value)) return null;
  if (carriesKey(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (NEVER.has(scheme)) return null;
  if (scheme === "https" || scheme === "http") {
    const allowed = targets.origins
      .map(originOf)
      .filter((o): o is string => o !== null);
    return allowed.includes(url.origin) ? url.href : null;
  }
  const schemes = targets.schemes.map((s) => s.toLowerCase());
  return schemes.includes(scheme) ? url.href : null;
}

/**
 * The same-origin pages an Activate link may return to: only the login card, `/signin`. The card's
 * "You don't have <Product> yet" state links to `/activate?product=<slug>&return=/signin?request=rq_…`
 * and, after the add, the person goes back to the card, whose license chooser now lists the new
 * license (plans/I-04.md, "Owner decision (2026-10-05): licence choice at sign-in"). Nothing else
 * on this origin is a return target: a crafted link must not send someone who has just added a
 * key to a download, a sign-out or any other page by itself.
 */
const CARD_PATHS: ReadonlySet<string> = new Set(["/signin"]);

/**
 * The login card to go back to after an add, as a same-origin path and query (`/signin?request=…`),
 * or `null`. Accepts a path (`/signin?…`) or an absolute URL on `origin`; refuses another origin,
 * a protocol-relative or backslashed path, credentials, control characters, an oversized value,
 * any page but the card, and a value that carries a license key.
 */
export function cardReturn(
  raw: string | null | undefined,
  origin: string,
): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.length > MAX_RETURN_LENGTH) return null;
  if (/[\u0000- \u007f-\u009f\\]/.test(value)) return null;
  if (value.startsWith("//") || carriesKey(value)) return null;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  if (!CARD_PATHS.has(url.pathname.replace(/\/+$/, ""))) return null;
  return `${url.pathname}${url.search}`;
}
