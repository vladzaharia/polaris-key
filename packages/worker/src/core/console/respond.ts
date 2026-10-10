/**
 * Response + request helpers shared by every admin handler. The admin surface is always
 * `no-store`; errors are a flat `{ error, message?, ...extra }` JSON shape.
 */

import { ErrorCode } from "../errors.js";
import type { WriteRefusal } from "../settings/write.js";
import { appSecurityHeaders } from "../securityHeaders.js";
import { BodyTooLargeError, readBodyText } from "../cappedBody.js";

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

/**
 * A `writeSetting()` refusal (ST-04) as the console's error: its status, its reason, the key and
 * any details (`currentVersion`, `bound`, `level`). `fields` names the request field(s) when the
 * route's body spells the setting differently from its registry key.
 */
export function settingRefused(
  refusal: WriteRefusal,
  fields?: readonly string[],
): Response {
  return err(refusal.status, ErrorCode.BadRequest, refusal.message, {
    reason: refusal.reason,
    ...(refusal.key ? { key: refusal.key } : {}),
    ...(fields ? { fields } : {}),
    ...(refusal.details ?? {}),
  });
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
  let raw: string;
  try {
    raw = await readBodyText(req, MAX_ADMIN_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError)
      throw new AdminBodyError(413, "body_too_large", "request body too large");
    throw e;
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
