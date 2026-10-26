/**
 * The error taxonomy and the JSON response helpers every surface answers with (design spec
 * §5.1: "error taxonomy" is a core capability).
 *
 * Extracted verbatim from `src/platform/http.ts`, which keeps the REQUEST-side helpers (`bearer`,
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
  /** CC-03.2: `PUT /<p>/devices/keys` refused: a bad key, a failed or stale proof, or an `agreeKey`
   *  another device holds. One code for all three. */
  DeviceKeysInvalid: "device_keys_invalid",
  /** CC-06.1: a Cloud Connect route was called by a device that has registered no keys (409). */
  DeviceKeysRequired: "device_keys_required",
  /** CC-06.1: the person has more devices than a roster holds (409). */
  RingTooLarge: "ring_too_large",
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
  /** `GET /<p>/config/document` on a product that runs License, for a device whose licence is
   *  disabled, expired or gone (R1): answered `401`, so the document's secrets stop with the
   *  licence and a client re-acquires once and lands on `revoked`, as it does for the licence
   *  document. One code for all three, because the device's remedy is the same. */
  LicenseUnusable: "license_unusable",
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
  /** B-100: a browser followed an app's sign-in link for a product that does not exist. Human-
   *  facing only (the 404 card); JSON callers keep `not_found`. */
  UnknownApp: "unknown_app",
  /** PX-W9 (WIRE-CONTRACT-V4 §12.2): a licence in no account has used every key entry on an
   *  Identity product while `identity.keyEntryRefusals` is on. The flat 403 carries `keyEntries`
   *  and, while the portal is on, `manageUrl`. Never sent to an enrolled device. */
  KeyEntryLimit: "key_entry_limit",
  /** I-09 (WIRE-CONTRACT-V4 §12.2 step 3, §12.3): the licence is in an account. Key entry on a
   *  device not enrolled on it answers the flat 403 with `signInUrl` (Identity on, refusals on);
   *  attach answers it nested, with no link, when another account holds the licence. */
  LicenseOwned: "license_owned",
  /** I-09 (§12.3): attach of a licence whose buyer email the signed-in account has not verified,
   *  on a product without `identity.keyEntry.claimByKey`. */
  LicenseEmailBound: "license_email_bound",
  /** I-09 (§12.3): the request needs an account signed in on the device. */
  AccountRequired: "account_required",
  /** U-05 (§13.4, §13.6, §13.9): the pull cursor is older than the tombstone horizon (410). */
  CursorExpired: "cursor_expired",
  /** U-05 (§13.3): the `clientId` belongs to another device (409). */
  ClientMismatch: "client_mismatch",
  /** U-05 (§13.3): a per-mutation result, the value fails validation. */
  ValueInvalid: "value_invalid",
  /** U-05 (§13.3, §13.7): a per-mutation result, the operation does not fit the merge policy. */
  OpInvalidForPolicy: "op_invalid_for_policy",
  /** U-05 (§13.1, §13.3): a per-mutation result, not a synced setting or the wrong scope. */
  SettingNotSynced: "setting_not_synced",
  /** U-05 (§13.1, §13.3): a per-mutation result (403 for files), over quota. */
  QuotaExceeded: "quota_exceeded",
  /** U-05 (§13.9): `cloudSync.writesPaused` is on (503, `Retry-After`). */
  WritesPaused: "writes_paused",
  /** I-08 (§12.4, §12.5): the OAuth-shaped passthrough's codes. The grant's own refusals are the
   *  flat RFC 6749 §5.2 bodies; `RedirectUriMismatch` is a card page and never travels. */
  InvalidRequest: "invalid_request",
  InvalidClient: "invalid_client",
  InvalidGrant: "invalid_grant",
  UnsupportedGrantType: "unsupported_grant_type",
  InvalidScope: "invalid_scope",
  RedirectUriMismatch: "redirect_uri_mismatch",
  /** I-08: a licence choice is owed and was not made (Continue, `token`). */
  LicenseChoiceRequired: "license_choice_required",
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
