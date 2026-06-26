// Activation + lifecycle HTTP calls (key -> token, token re-acquire, deauthorize, report).

import { arch, platform } from "node:os";
import {
  HEADER_ARCH,
  HEADER_DEVICE,
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
} from "@polaris-key/protocol";
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
}

async function activationLike(
  url: string,
  headers: Record<string, string>,
  f: typeof fetch,
): Promise<ActivationResult> {
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers });
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (res.status === 200) {
    const b = (await res.json()) as { token: string; schemaVersion: number };
    return { kind: "ok", token: b.token, schemaVersion: b.schemaVersion };
  }
  if (res.status === 403) {
    const b = (await res.json().catch(() => ({}))) as {
      limit?: number;
      deviceCount?: number;
    };
    return {
      kind: "device-limit",
      limit: b.limit,
      deviceCount: b.deviceCount,
    };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  return { kind: "error", message: await res.text().catch(() => "") };
}

export async function activateWithKey(
  opts: Base & { key: string },
): Promise<ActivationResult> {
  return activationLike(
    `${opts.baseUrl}/${opts.product}/activate`,
    {
      authorization: `Bearer ${opts.key}`,
      [HEADER_DEVICE]: opts.deviceId,
      ...metadataHeaders(),
    },
    opts.fetchImpl ?? fetch,
  );
}

export async function listDevices(opts: {
  baseUrl: string;
  product: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<AccountDevice[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}/${opts.product}/devices`, {
    headers: { authorization: `Bearer ${opts.token}` },
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
}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `${opts.baseUrl}/${opts.product}/devices/${encodeURIComponent(opts.deviceId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${opts.token}` },
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
  );
}

export async function deauthorize(opts: {
  baseUrl: string;
  product: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  try {
    await f(`${opts.baseUrl}/${opts.product}/deauthorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}` },
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
    });
    return res.ok;
  } catch {
    return false;
  }
}
