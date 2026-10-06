// Typed activation results (SDK-PARITY-PASS §3.1): one table every SDK maps an activation or
// enrolment answer through, so a refusal keeps the SERVER's code instead of collapsing into
// "device limit" or a raw body string.
//
// The rules the table encodes:
//
//   * every kind carries `code`;
//   * mapping goes by the body's `error` code, never by status alone;
//   * an unknown 403 is NEVER `deviceLimit`: it is `refused` with the server's code, which is
//     what makes a later server addition (I-09's `license_owned`, `key_entry_limit`) a pure
//     addition here.
//
// React surfaces a refusal as a `PolarisError("sign-in-failed", …)` whose `wireCode` is the
// server's code and whose `activation` is the kind below, so a component branches on
// `err.activation.kind` and reads its copy by `err.wireCode` (`./copy.ts`).

import { readManageUrl } from "@polaris-key/client-core";

/** The §3.1 kinds. `ok` never appears on an error. */
export type ActivationKind =
  | "ok"
  | "deviceLimit"
  | "fingerprintRequired"
  | "hardwareMismatch"
  | "enrollClaimed"
  | "licenseDisabled"
  | "licenseExpired"
  | "attestationRequired"
  | "rateLimited"
  | "unauthorized"
  | "enrollDisabled"
  | "refused"
  | "error";

/** One classified activation answer. */
export interface ActivationOutcome {
  kind: ActivationKind;
  /** The registry code: the body's own for a refusal, `network`/`server` for transport. */
  code: string;
  /** The HTTP status, when there was one. */
  status?: number;
  /** `deviceLimit`: the licence's seat count, when the server said. */
  limit?: number;
  /** `deviceLimit`: how many devices hold a seat now, when the server said. */
  deviceCount?: number;
  /** `deviceLimit` (PX-W8): the customer-portal link that frees a seat, validated
   *  (`readManageUrl`), present while the product's portal is on. Never an auth failure. */
  manageUrl?: string;
  /** `rateLimited`: the server's `Retry-After`, in seconds, when it sent one. */
  retryAfterSeconds?: number;
  /** The server's own human message, when it sent one (never shown verbatim by the kits). */
  message?: string;
}

/** The registry code each named kind maps from (`conformance/parity/errors.json`). */
const KIND_BY_CODE: Readonly<Record<string, ActivationKind>> = {
  device_limit: "deviceLimit",
  fingerprint_required: "fingerprintRequired",
  hardware_mismatch: "hardwareMismatch",
  enroll_claimed: "enrollClaimed",
  license_disabled: "licenseDisabled",
  license_expired: "licenseExpired",
  attestation_required: "attestationRequired",
  rate_limited: "rateLimited",
  unauthorized: "unauthorized",
  enroll_disabled: "enrollDisabled",
};

/** The body shapes the Worker answers with: v3 nested (`{error:{code,…}}`) and v2 flat. */
interface RefusalBody {
  error?:
    | string
    | {
        code?: unknown;
        message?: unknown;
        limit?: unknown;
        deviceCount?: unknown;
      };
  message?: unknown;
  limit?: unknown;
  deviceCount?: unknown;
}

const asInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
const asText = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** The code a refusal body names, flat or nested, or null. */
export function bodyCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const e = (body as RefusalBody).error;
  if (typeof e === "string") return e === "" ? null : e;
  if (typeof e === "object" && e !== null) return asText(e.code) ?? null;
  return null;
}

/** Parse `Retry-After` (delta-seconds only; an HTTP date is ignored). */
export function retryAfterSeconds(
  header: string | null | undefined,
): number | undefined {
  if (!header) return undefined;
  const n = Number(header.trim());
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Classify one activation-like answer (`license/activate`, `license/enroll`, the cookie
 * session's `session/license`). `body` is the parsed JSON body, or null when there was none.
 */
export function classifyActivation(
  status: number,
  body: unknown,
  retryAfter?: string | null,
): ActivationOutcome {
  if (status >= 200 && status < 300) return { kind: "ok", code: "ok", status };
  const code = bodyCode(body);
  const b = (
    typeof body === "object" && body !== null ? body : {}
  ) as RefusalBody;
  const nested =
    typeof b.error === "object" && b.error !== null ? b.error : undefined;
  const message = asText(nested?.message) ?? asText(b.message);
  const base = { status, ...(message ? { message } : {}) };
  if (status >= 500) return { kind: "error", code: code ?? "server", ...base };
  // By code first: a registry code decides, whatever the status.
  const named = code ? KIND_BY_CODE[code] : undefined;
  if (named === "deviceLimit") {
    const limit = asInt(b.limit) ?? asInt(nested?.limit);
    const deviceCount = asInt(b.deviceCount) ?? asInt(nested?.deviceCount);
    const manageUrl = readManageUrl(body);
    return {
      kind: "deviceLimit",
      code: code!,
      ...base,
      ...(limit !== undefined ? { limit } : {}),
      ...(deviceCount !== undefined ? { deviceCount } : {}),
      ...(manageUrl !== undefined ? { manageUrl } : {}),
    };
  }
  if (named === "rateLimited" || (status === 429 && !code)) {
    const seconds = retryAfterSeconds(retryAfter);
    return {
      kind: "rateLimited",
      code: code ?? "rate_limited",
      ...base,
      ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}),
    };
  }
  if (named) return { kind: named, code: code!, ...base };
  // No registry code we name. Status alone decides only where it is unambiguous: a bare 401 is
  // `unauthorized`, a bare 409 is the hardware drift answer, a bare 404 is enrolment closed.
  if (!code) {
    if (status === 401)
      return { kind: "unauthorized", code: "unauthorized", ...base };
    if (status === 409)
      return { kind: "hardwareMismatch", code: "hardware_mismatch", ...base };
    if (status === 404)
      return { kind: "enrollDisabled", code: "enroll_disabled", ...base };
  }
  // Anything else — an unknown 403 above all — is `refused` with the server's code.
  return { kind: "refused", code: code ?? "http-error", ...base };
}

/** A transport failure (no answer at all). */
export function networkOutcome(message?: string): ActivationOutcome {
  return { kind: "error", code: "network", ...(message ? { message } : {}) };
}
