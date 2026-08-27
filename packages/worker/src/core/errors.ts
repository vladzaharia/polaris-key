/**
 * The error taxonomy and the JSON response helpers every surface answers with (design spec
 * §5.1: "error taxonomy" is a core capability).
 *
 * Extracted verbatim from `src/http.ts`, which keeps the REQUEST-side helpers (`bearer`,
 * `isSafeAssetPath`, `isSameOriginNavigation`). The split is the one the layout draws: a
 * service may import `core/`, so the codes and the response shapes have to live here for
 * `services/<slug>/` to be able to answer at all, while request parsing is not a core concern.
 */

/// <reference types="@cloudflare/workers-types" />

/** Stable error codes returned to clients (mirrors the SDK error taxonomy). */
export const ErrorCode = {
  Unauthorized: "unauthorized",
  NotEntitled: "not_entitled",
  DeviceLimit: "device_limit",
  BadRequest: "bad_request",
  NotFound: "not_found",
  ManagedByAdmin: "managed_by_admin",
  Forbidden: "forbidden",
  HardwareMismatch: "hardware_mismatch",
  FingerprintRequired: "fingerprint_required",
  EnrollDisabled: "enroll_disabled",
  /** This machine's auto-issued license exists but now belongs to an identity (R3-05). */
  EnrollClaimed: "enroll_claimed",
} as const;

export function json(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

export function errorResponse(
  status: number,
  code: string,
  message?: string,
  extra?: Record<string, unknown>,
): Response {
  return json(
    { error: code, ...(message ? { message } : {}), ...(extra ?? {}) },
    { status },
  );
}

export function notFound(): Response {
  return errorResponse(404, ErrorCode.NotFound);
}

export function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}
