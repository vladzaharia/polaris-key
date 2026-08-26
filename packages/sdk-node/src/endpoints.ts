// Activation + lifecycle HTTP calls (key -> token, token re-acquire, deauthorize, report).

import { arch, platform } from "node:os";
import {
  HEADER_ARCH,
  HEADER_DEVICE,
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  type HardwareFingerprint,
} from "@plrs/protocol";
import { SDK_NAME, SDK_VERSION } from "./version.js";

function metadataHeaders(): Record<string, string> {
  return {
    [HEADER_PLATFORM]: platform(),
    [HEADER_ARCH]: arch(),
    [HEADER_SDK_NAME]: SDK_NAME,
    [HEADER_SDK_VERSION]: SDK_VERSION,
  };
}

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

export interface AccountDevice {
  id: string;
  licenseId?: string;
  label?: string | null;
  status: string;
  current: boolean;
  firstSeen?: number;
  lastSeen?: number;
  platform?: string | null;
  arch?: string | null;
  appVersion?: string | null;
  sdkName?: string | null;
  sdkVersion?: string | null;
}

interface Base {
  baseUrl: string;
  product: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
  /** Deadline for the request. Node's `fetch` has NO default timeout, so without one a
   *  slowloris on any endpoint stalls the caller indefinitely (R4-08). */
  signal?: AbortSignal;
}

async function activationLike(
  url: string,
  headers: Record<string, string>,
  f: typeof fetch,
  fingerprint?: HardwareFingerprint | null,
  signal?: AbortSignal,
): Promise<ActivationResult> {
  let res: Response;
  try {
    // The body is omitted entirely when there is no fingerprint, so this call stays
    // byte-identical to the pre-fingerprint contract against an older Worker.
    const init: RequestInit = fingerprint
      ? {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ fingerprint }),
          signal,
        }
      : { method: "POST", headers, signal };
    res = await f(url, init);
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
    };
    return { kind: "hardware-mismatch", drift: b.drift, changed: b.changed };
  }
  if (res.status === 403) {
    const b = (await res.json().catch(() => ({}))) as {
      error?: string;
      limit?: number;
      deviceCount?: number;
    };
    if (b.error === "fingerprint_required")
      return { kind: "fingerprint-required" };
    return {
      kind: "device-limit",
      limit: b.limit,
      deviceCount: b.deviceCount,
    };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 404) return { kind: "enroll-disabled" };
  return { kind: "error", message: await res.text().catch(() => "") };
}

/**
 * `POST /<product>/enroll` — obtain a license with no key and no sign-in.
 *
 * Returns the same `ActivationResult` shape `activateWithKey` does, so callers need no new
 * branching. A product that hasn't opted in answers 404, surfaced as `enroll-disabled`.
 */
export async function enroll(
  opts: Base & { fingerprint?: HardwareFingerprint | null },
): Promise<ActivationResult> {
  return activationLike(
    `${opts.baseUrl}/${opts.product}/enroll`,
    { [HEADER_DEVICE]: opts.deviceId, ...metadataHeaders() },
    opts.fetchImpl ?? fetch,
    opts.fingerprint,
    opts.signal,
  );
}

export async function activateWithKey(
  opts: Base & { key: string; fingerprint?: HardwareFingerprint | null },
): Promise<ActivationResult> {
  return activationLike(
    `${opts.baseUrl}/${opts.product}/activate`,
    {
      authorization: `Bearer ${opts.key}`,
      [HEADER_DEVICE]: opts.deviceId,
      ...metadataHeaders(),
    },
    opts.fetchImpl ?? fetch,
    opts.fingerprint,
    opts.signal,
  );
}

export async function listDevices(opts: {
  baseUrl: string;
  product: string;
  token: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<AccountDevice[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}/${opts.product}/devices`, {
    headers: { authorization: `Bearer ${opts.token}` },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`device list failed: ${res.status}`);
  const body = (await res.json()) as { devices?: AccountDevice[] };
  return Array.isArray(body.devices) ? body.devices : [];
}

export async function renameDevice(opts: {
  baseUrl: string;
  product: string;
  token: string;
  deviceId: string;
  label: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `${opts.baseUrl}/${opts.product}/devices/${encodeURIComponent(opts.deviceId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: opts.label }),
      signal: opts.signal,
    },
  );
  if (!res.ok) throw new Error(`device rename failed: ${res.status}`);
}

export async function deauthorizeDevice(opts: {
  baseUrl: string;
  product: string;
  token: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `${opts.baseUrl}/${opts.product}/devices/${encodeURIComponent(opts.deviceId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${opts.token}` },
      signal: opts.signal,
    },
  );
  if (!res.ok) throw new Error(`device deauthorize failed: ${res.status}`);
}

export async function reacquireToken(
  opts: Base & { token: string },
): Promise<ActivationResult> {
  return activationLike(
    `${opts.baseUrl}/${opts.product}/token`,
    {
      authorization: `Bearer ${opts.token}`,
      [HEADER_DEVICE]: opts.deviceId,
      ...metadataHeaders(),
    },
    opts.fetchImpl ?? fetch,
    null,
    opts.signal,
  );
}

export async function deauthorize(opts: {
  baseUrl: string;
  product: string;
  token: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  try {
    await f(`${opts.baseUrl}/${opts.product}/deauthorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}` },
      signal: opts.signal,
    });
  } catch {
    // best-effort; the local wipe is what matters
  }
}

export async function reportSnapshot(opts: {
  baseUrl: string;
  product: string;
  token: string;
  snapshot: unknown;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<boolean> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${opts.baseUrl}/${opts.product}/config/report`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
        ...metadataHeaders(),
      },
      body: JSON.stringify(opts.snapshot),
      signal: opts.signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}
