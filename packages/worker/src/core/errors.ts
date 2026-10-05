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
  /** This machine's auto-issued license exists but an operator disabled it. Distinct from
   *  `enroll_claimed` because the guidance differs: signing in will not reach it, and
   *  re-enrolling around the disable would bypass a deliberate refusal. */
  LicenseDisabled: "license_disabled",
  /** A written value no signed document could carry (plans/P3-01.md §2.2): a lone surrogate,
   *  U+0000 in a member name, canonically equivalent sibling names, a number out of range or
   *  more than 32 levels. Answered `422` with `fields` by the console's write paths. */
  ValueNotRepresentable: "value_not_representable",
  /** A stored value the signer guards refuse: the route answers `500` rather than signing a
   *  document no wire-v4 verifier would accept (plans/P3-01.md §2.2). */
  DocumentNotRepresentable: "document_not_representable",
  /** PX-W17: a person tried to sign in through a product whose Identity service is off. Human-
   *  facing only (the `303` to the card's `?error=` and the portal passthrough context's `403`);
   *  device and JSON routes keep answering `not_found` (plans/PX-W17.md §2). */
  IdentityDisabled: "identity_disabled",
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

/**
 * The wire-v3 NESTED error body — `{"error":{"code":…}, …extra}` (WIRE-CONTRACT-V3 §5, R4).
 *
 * Distinct from `errorResponse` above, which still emits the flat v2 shape
 * (`{"error":"not_found"}`) that the routes not yet moved onto the registry answer with. The
 * two co-exist deliberately: a handler that MOVED without changing its body keeps the flat
 * shape so its behaviour is byte-identical after the move, while the surfaces v3 introduces —
 * the two signed documents, and the registry's own not-found — speak the nested shape from
 * their first request. Mixing them inside one handler is the thing to avoid; carrying both
 * across a migration is the point.
 *
 * `extra` rides at the TOP level, not inside `error`, because that is where the contract puts
 * `allowedRange` on the 403 build block.
 */
export function wireError(
  status: number,
  code: string,
  extra?: Record<string, unknown>,
): Response {
  return json({ error: { code }, ...(extra ?? {}) }, { status });
}

export function notFound(): Response {
  return errorResponse(404, ErrorCode.NotFound);
}

export function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}
