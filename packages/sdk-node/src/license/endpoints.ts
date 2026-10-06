// The License service's HTTP surface — `POST /<p>/license/{activate,enroll,token,deauthorize}`
// and `GET /<p>/license/document` (§R1, wire contract v3 §5).
//
// Pure transport: it builds the request, maps the status taxonomy, and hands back raw bytes.
// Verification, caching and the gate live elsewhere on purpose — an HTTP layer that verified
// would be an HTTP layer that could be talked into not verifying.
//
// Every call carries the seven `X-PKey-*` metadata headers and a deadline, both from
// `CoreContext.headers()` / `.deadline()`, so a new endpoint cannot ship without them (R4-08).

import type { HardwareFingerprint } from "@polaris-key/protocol/core";
import { readManageUrl } from "@polaris-key/client-core";
import type { CoreContext, DocumentResult } from "../core/context.js";

/**
 * The typed outcome of `license.activate`, `license.enroll` and `license.token` (SDK parity pass
 * §3.1). Every refusal carries the server's own `code`; the mapping goes by that code, never by
 * the HTTP status alone, so a 403 that is not a device limit is never reported as one. An
 * unknown 4xx is `refused` with the server's code, which makes a future refusal code (I-09's
 * `license_owned`, `key_entry_limit`) a pure addition: it arrives as `refused{code}` today.
 *
 * The kinds are spelled in the transcript vocabulary (`conformance/transcripts`, kebab-case);
 * §3.1's camelCase names map one to one (`deviceLimit` ↔ `device-limit`).
 */
export type ActivationResult =
  | { kind: "ok"; token: string; schemaVersion: number }
  /** Every seat is taken. `manageUrl` (PX-W8) is the customer-portal link that frees one,
   *  present while the product's portal is on; add the app's return with `withManageReturn`
   *  and, on an `/activate` link, the key with `withManageKey`. Never an auth failure. */
  | {
      kind: "device-limit";
      code: string;
      limit?: number;
      deviceCount?: number;
      manageUrl?: string;
    }
  /** 401: the key or token is missing, invalid or revoked. */
  | { kind: "unauthorized"; code: string }
  /** The tier requires a fingerprint this host could not produce. */
  | { kind: "fingerprint-required"; code: string }
  /** The product does not offer keyless enrollment. */
  | { kind: "enroll-disabled"; code: string }
  /** Hardware drifted past the tier's tolerance; the binding was retired. Retrying
   *  activation re-binds the new hardware and consumes a seat. */
  | {
      kind: "hardware-mismatch";
      code: string;
      drift?: number;
      changed?: string[];
    }
  /** This machine's free licence now belongs to an identity: sign in to use it. */
  | { kind: "enroll-claimed"; code: string }
  /** An operator disabled the licence. */
  | { kind: "license-disabled"; code: string }
  /** The licence has expired. */
  | { kind: "license-expired"; code: string }
  /** The product's device-trust policy wants an attested device (Node cannot attest). */
  | { kind: "attestation-required"; code: string }
  /** Too many attempts; `retryAfterSeconds` from the `Retry-After` header when present. */
  | { kind: "rate-limited"; code: string; retryAfterSeconds?: number }
  /** Any other 4xx: the server's code, the status and its message. */
  | { kind: "refused"; code: string; status: number; message: string }
  /** No answer (`network`) or a 5xx (`server`). */
  | {
      kind: "error";
      code: "network" | "server";
      status?: number;
      message: string;
    };

/** The refusal kinds a registry code names directly (§3.1). */
const KIND_BY_CODE: Record<
  string,
  | "device-limit"
  | "fingerprint-required"
  | "enroll-disabled"
  | "hardware-mismatch"
  | "enroll-claimed"
  | "license-disabled"
  | "license-expired"
  | "attestation-required"
  | "rate-limited"
  | "unauthorized"
> = {
  device_limit: "device-limit",
  fingerprint_required: "fingerprint-required",
  enroll_disabled: "enroll-disabled",
  hardware_mismatch: "hardware-mismatch",
  enroll_claimed: "enroll-claimed",
  license_disabled: "license-disabled",
  license_expired: "license-expired",
  attestation_required: "attestation-required",
  rate_limited: "rate-limited",
  unauthorized: "unauthorized",
};

interface RefusalBody {
  error?: string | { code?: string; message?: string; [k: string]: unknown };
  message?: string;
  limit?: number;
  deviceCount?: number;
  drift?: number;
  changed?: string[];
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Map a non-200 answer to its typed refusal, by the body's code (§3.1). Both body shapes are
 * read: the flat `{"error":"code",…}` and the nested `{"error":{"code":…}}`. Two legacy rules
 * keep pre-v3 servers readable without guessing from the status: a body with no code but a
 * numeric `limit` is the v2 device-limit body, one with `drift`/`changed` the v2
 * hardware-mismatch body, and a 401 with no code is `unauthorized`.
 */
export function activationRefusal(
  status: number,
  body: RefusalBody,
  retryAfter: string | null = null,
): Exclude<ActivationResult, { kind: "ok" }> {
  const nested = typeof body.error === "object" ? body.error : undefined;
  const code =
    typeof body.error === "string" ? body.error : (nested?.code ?? undefined);
  const message =
    (typeof nested?.message === "string" ? nested.message : undefined) ??
    (typeof body.message === "string" ? body.message : "");
  if (status >= 500) return { kind: "error", code: "server", status, message };
  const kind =
    code !== undefined
      ? KIND_BY_CODE[code]
      : num(body.limit) !== undefined
        ? "device-limit"
        : num(body.drift) !== undefined || Array.isArray(body.changed)
          ? "hardware-mismatch"
          : status === 401
            ? "unauthorized"
            : undefined;
  const wire =
    code ??
    (kind === "device-limit"
      ? "device_limit"
      : kind === "hardware-mismatch"
        ? "hardware_mismatch"
        : undefined);
  switch (kind) {
    case "device-limit": {
      const limit = num(body.limit) ?? num(nested?.limit);
      const deviceCount = num(body.deviceCount) ?? num(nested?.deviceCount);
      const manageUrl = readManageUrl(body);
      return {
        kind,
        code: wire!,
        ...(limit !== undefined ? { limit } : {}),
        ...(deviceCount !== undefined ? { deviceCount } : {}),
        ...(manageUrl !== undefined ? { manageUrl } : {}),
      };
    }
    case "hardware-mismatch": {
      const drift = num(body.drift) ?? num(nested?.drift);
      const changed = Array.isArray(body.changed)
        ? body.changed
        : Array.isArray(nested?.changed)
          ? (nested.changed as string[])
          : undefined;
      return {
        kind,
        code: wire!,
        ...(drift !== undefined ? { drift } : {}),
        ...(changed !== undefined ? { changed } : {}),
      };
    }
    case "rate-limited": {
      const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
      return {
        kind,
        code: wire!,
        ...(Number.isFinite(seconds) && seconds >= 0
          ? { retryAfterSeconds: Math.ceil(seconds) }
          : {}),
      };
    }
    case "unauthorized":
      return { kind, code: code ?? "unauthorized" };
    case undefined:
      return {
        kind: "refused",
        code: code ?? fallbackCode(status),
        status,
        message,
      };
    default:
      return { kind, code: wire! };
  }
}

/** The registry code a codeless 4xx is reported under. */
function fallbackCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 413:
      return "body_too_large";
    case 429:
      return "rate_limited";
    default:
      return "http-error";
  }
}

/**
 * The three mint/rotate endpoints share a response ladder, so they share a reader. Codes are
 * read from BOTH the v3 nested body (`{"error":{"code":…}}`) and the flat shape, because a
 * 403 that says "device limit" and a 403 that says "fingerprint required" are different
 * outcomes for the caller and guessing between them would be worse than either.
 */
async function activationLike(
  ctx: CoreContext,
  path: string,
  headers: Record<string, string>,
  fingerprint?: HardwareFingerprint | null,
  /** PX-W13 §8 Q2: the device label, on activation only (never enroll or token rotation). */
  deviceName?: string | null,
): Promise<ActivationResult> {
  // OUTSIDE the try, deliberately. `fetcher()` throws only in local-only mode, and that is a
  // configuration error — the host asked a transportless client to dial — not a transport
  // outcome. Swallowing it into `{kind:"error"}` would make it indistinguishable from a dropped
  // connection, so the caller could never branch on the one thing it can actually fix.
  const f = ctx.fetcher();
  let res: Response;
  try {
    // The body is omitted entirely when there is neither a fingerprint nor a label, so a host
    // that opted out sends a byte-identical request to one that has nothing to report.
    const body = {
      ...(fingerprint ? { fingerprint } : {}),
      ...(deviceName ? { deviceName } : {}),
    };
    const init: RequestInit =
      Object.keys(body).length > 0
        ? {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: ctx.deadline(),
          }
        : { method: "POST", headers, signal: ctx.deadline() };
    res = await f(ctx.url(path), init);
  } catch (e) {
    return { kind: "error", code: "network", message: (e as Error).message };
  }
  if (res.status === 200) {
    const b = (await res.json()) as { token: string; schemaVersion: number };
    return { kind: "ok", token: b.token, schemaVersion: b.schemaVersion };
  }
  const text = await res.text().catch(() => "");
  let body: RefusalBody = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      body = parsed as RefusalBody;
  } catch {
    // A non-JSON body names no code; the status's registry code stands in for it.
  }
  const refusal = activationRefusal(
    res.status,
    body,
    res.headers.get("retry-after"),
  );
  // A 5xx keeps the raw body as its message (it names no code a caller could branch on).
  if (refusal.kind === "error" && !refusal.message)
    return { ...refusal, message: text };
  return refusal;
}

/** `POST /<p>/license/enroll` — obtain a licence with no key and no sign-in.
 *  Returns the same shape `activateWithKey` does, so callers need no new branching; a product
 *  that has not opted in answers 404, surfaced as `enroll-disabled`. */
export function enroll(
  ctx: CoreContext,
  fingerprint?: HardwareFingerprint | null,
): Promise<ActivationResult> {
  return activationLike(ctx, "license/enroll", ctx.headers(), fingerprint);
}

/** `POST /<p>/license/activate` — exchange a licence key for a per-device `pkeyt_` token. */
export function activateWithKey(
  ctx: CoreContext,
  key: string,
  fingerprint?: HardwareFingerprint | null,
): Promise<ActivationResult> {
  return activationLike(
    ctx,
    "license/activate",
    ctx.headers({ authorization: `Bearer ${key}` }),
    fingerprint,
    // PX-W13 §8 Q2: seeds the device's label in the customer's and the console's device lists.
    ctx.deviceLabel(),
  );
}

/** `POST /<p>/license/token` — rotate the current device token. The §5 single re-acquire. */
export function reacquireToken(
  ctx: CoreContext,
  token: string,
): Promise<ActivationResult> {
  return activationLike(
    ctx,
    "license/token",
    ctx.headers({ authorization: `Bearer ${token}` }),
    null,
  );
}

/** `POST /<p>/license/deauthorize` — release this device's seat. Best-effort: the LOCAL wipe
 *  is what the caller actually depends on, and a device that deactivates on a plane must not
 *  be left holding credentials because the server was unreachable. */
export async function deauthorize(
  ctx: CoreContext,
  token: string,
): Promise<void> {
  try {
    const f = ctx.fetcher();
    await f(ctx.url("license/deauthorize"), {
      method: "POST",
      headers: ctx.headers({ authorization: `Bearer ${token}` }),
      signal: ctx.deadline(),
    });
  } catch {
    // best-effort; the local wipe is what matters
  }
}

/** `GET /<p>/license/document` — the signed grant document, with ETag/304 (§5). The build gate
 *  lives on THIS route (D-20), so this is the only document fetch that can answer `blocked`. */
export function fetchLicenseDocument(
  ctx: CoreContext,
  token: string,
  etag?: string,
): Promise<DocumentResult> {
  return ctx.getDocument("license/document", token, etag);
}
