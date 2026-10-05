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
import type { CoreContext, DocumentResult } from "../core/context.js";

export type ActivationResult =
  | { kind: "ok"; token: string; schemaVersion: number }
  | { kind: "device-limit"; limit?: number; deviceCount?: number }
  | { kind: "unauthorized" }
  /** The tier requires a fingerprint this host could not produce. */
  | { kind: "fingerprint-required" }
  /** The product does not offer keyless enrollment. */
  | { kind: "enroll-disabled" }
  /** Hardware drifted past the tier's tolerance; the binding was retired. Retrying
   *  activation re-binds the new hardware and consumes a seat. */
  | { kind: "hardware-mismatch"; drift?: number; changed?: string[] }
  | { kind: "error"; message: string };

/**
 * The three mint/rotate endpoints share a response ladder, so they share a reader. Codes are
 * read from BOTH the v3 nested body (`{"error":{"code":…}}`) and the flat v2 shape, because a
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
    return { kind: "error", message: (e as Error).message };
  }
  if (res.status === 200) {
    const b = (await res.json()) as { token: string; schemaVersion: number };
    return { kind: "ok", token: b.token, schemaVersion: b.schemaVersion };
  }
  if (res.status === 409) {
    const b = (await res.json().catch(() => ({}))) as {
      drift?: number;
      changed?: string[];
      error?: { drift?: number; changed?: string[] };
    };
    return {
      kind: "hardware-mismatch",
      drift: b.drift ?? b.error?.drift,
      changed: b.changed ?? b.error?.changed,
    };
  }
  if (res.status === 403) {
    const b = (await res.json().catch(() => ({}))) as {
      error?: string | { code?: string; limit?: number; deviceCount?: number };
      limit?: number;
      deviceCount?: number;
    };
    const code =
      typeof b.error === "string" ? b.error : (b.error?.code ?? undefined);
    if (code === "fingerprint_required")
      return { kind: "fingerprint-required" };
    const nested = typeof b.error === "object" ? b.error : undefined;
    return {
      kind: "device-limit",
      limit: b.limit ?? nested?.limit,
      deviceCount: b.deviceCount ?? nested?.deviceCount,
    };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 404) return { kind: "enroll-disabled" };
  return { kind: "error", message: await res.text().catch(() => "") };
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
