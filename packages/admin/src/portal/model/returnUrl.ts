/**
 * The focused flows' return URL (PORTAL.md §3.3, PX-10): `?return=` is followed only when it
 * matches a browser origin or an app scheme the product declares (`GET /api/products/<p>`
 * `returnTo`); anything else, including a malformed or oversized value, is dropped and the flow
 * ends on the product page. Pure, so it is tested on its own.
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
