/**
 * Response + request helpers shared by every admin handler. The admin surface is always
 * `no-store`; errors are a flat `{ error, message?, ...extra }` JSON shape.
 */

import { ErrorCode } from "../errors.js";
import type { WriteRefusal } from "../settings/write.js";
import { appSecurityHeaders } from "../securityHeaders.js";

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
  // ST-29: an area refusal is the dispatcher's 403 (`forbidden`, reason `no_access`, its scope and
  // area), so the console renders one denial whichever layer caught it.
  const code =
    refusal.status === 403 ? ErrorCode.Forbidden : ErrorCode.BadRequest;
  return err(refusal.status, code, refusal.message, {
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

export { AdminBodyError, readBody } from "../http/body.js";
