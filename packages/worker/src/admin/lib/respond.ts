/**
 * Response + request helpers shared by every admin handler. The admin surface is always
 * `no-store`; errors are a flat `{ error, message?, ...extra }` JSON shape.
 */

import { ErrorCode } from "../../http.js";

/** JSON response with the admin defaults (no-store, charset). */
export function adminJson(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(extra ?? {}) },
  });
}

/** A flat error JSON response. */
export function err(status: number, code: string, message?: string, extra?: Record<string, unknown>): Response {
  return adminJson({ error: code, ...(message ? { message } : {}), ...(extra ?? {}) }, status);
}

export function unauthorized(): Response {
  return err(401, ErrorCode.Unauthorized);
}

export function forbidden(message?: string): Response {
  return err(403, ErrorCode.Forbidden, message);
}

export function notFound(): Response {
  return err(404, ErrorCode.NotFound);
}

/** True for any state-changing method (everything but GET/HEAD). */
export function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/** Parse a JSON request body into an object, tolerating malformed/empty bodies. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
