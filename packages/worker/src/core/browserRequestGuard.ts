/**
 * The checks every cookie-carrying browser JSON endpoint of the sign-in flows shares
 * Imports only the shared capped body reader.
 */
import { BodyTooLargeError, readBodyText } from "./cappedBody.js";

/** The most bytes a sign-in JSON body may carry. */
export const BROWSER_JSON_MAX_BYTES = 64 * 1024;

/**
 * Whether a state-changing request comes from this origin's own pages. Fetch Metadata decides
 * when the browser sends it: only `same-origin` passes. Without it, an absent `Origin` (a
 * non-browser client) or this origin passes; `"null"` and every other origin do not.
 */
export function isSameOriginRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

/** Whether the body, if there is one, is declared JSON. A cross-site form or `text/plain`
 *  POST cannot set `application/json` without a CORS preflight, which this origin never grants. */
export function hasJsonContentType(req: Request): boolean {
  const type = (req.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/** A UTF-8 body read under `maxBytes` (counted while reading), or `null` when it is larger.
 *  The shared streamed reader (`core/cappedBody.ts`) does the counting. */
export async function readTextCapped(
  req: Request,
  maxBytes: number,
): Promise<string | null> {
  try {
    return await readBodyText(req, maxBytes);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return null;
    throw e;
  }
}

/**
 * The request body as a JSON object (`{}` when empty), or `null` when the request is not
 * same-origin, carries a non-JSON content type, is over `maxBytes`, or is not an object.
 */
export async function readGuardedJsonObject(
  req: Request,
  maxBytes: number = BROWSER_JSON_MAX_BYTES,
): Promise<Record<string, unknown> | null> {
  if (!isSameOriginRequest(req)) return null;
  let raw: string | null;
  try {
    raw = await readTextCapped(req, maxBytes);
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (!raw.trim()) return {};
  if (!hasJsonContentType(req)) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
