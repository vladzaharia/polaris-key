/**
 * Response + request helpers shared by every admin handler. The admin surface is always
 * `no-store`; errors are a flat `{ error, message?, ...extra }` JSON shape.
 */

import { ErrorCode } from "../../core/errors.js";
import { appSecurityHeaders } from "../../securityHeaders.js";

/** JSON response with the admin defaults (no-store, charset). */
export function adminJson(
  body: unknown,
  status = 200,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: appSecurityHeaders(
      new Headers({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...(extra ?? {}),
      }),
    ),
  });
}

/** A flat error JSON response. */
export function err(
  status: number,
  code: string,
  message?: string,
  extra?: Record<string, unknown>,
): Response {
  return adminJson(
    {
      error: { code, ...(message ? { message } : {}), ...(extra ?? {}) },
      code,
      ...(message ? { message } : {}),
      ...(extra ?? {}),
    },
    status,
  );
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

export class AdminBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

/** Parse a JSON request body into an object. Empty bodies remain `{}`; malformed or
 *  oversized bodies are request errors, not silent empty objects. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const len = req.headers.get("content-length");
  if (len && Number(len) > MAX_ADMIN_BODY_BYTES) {
    throw new AdminBodyError(413, "body_too_large", "request body too large");
  }
  const raw = await req.text();
  if (raw.length > MAX_ADMIN_BODY_BYTES) {
    throw new AdminBodyError(413, "body_too_large", "request body too large");
  }
  if (raw.trim().length === 0) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw) as unknown;
  } catch {
    throw new AdminBodyError(
      400,
      "invalid_json",
      "request body is not valid JSON",
    );
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new AdminBodyError(
      400,
      "invalid_json",
      "request body must be a JSON object",
    );
  }
  return v as Record<string, unknown>;
}
