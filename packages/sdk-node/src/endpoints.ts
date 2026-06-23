// Enrollment + lifecycle HTTP calls (key -> token, token re-acquire, deauthorize, report).

import { HEADER_DEVICE } from "@polaris-key/protocol";

export type EnrollResult =
  | { kind: "ok"; token: string; schemaVersion: number }
  | { kind: "machine-limit"; limit?: number; machineCount?: number }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

interface Base {
  baseUrl: string;
  product: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
}

async function enrollLike(url: string, headers: Record<string, string>, f: typeof fetch): Promise<EnrollResult> {
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
    const b = (await res.json().catch(() => ({}))) as { limit?: number; machineCount?: number };
    return { kind: "machine-limit", limit: b.limit, machineCount: b.machineCount };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  return { kind: "error", message: await res.text().catch(() => "") };
}

export async function enrollWithKey(opts: Base & { key: string }): Promise<EnrollResult> {
  return enrollLike(
    `${opts.baseUrl}/${opts.product}/enroll`,
    { authorization: `Bearer ${opts.key}`, [HEADER_DEVICE]: opts.deviceId },
    opts.fetchImpl ?? fetch,
  );
}

export async function reacquireToken(opts: Base): Promise<EnrollResult> {
  return enrollLike(
    `${opts.baseUrl}/${opts.product}/token`,
    { [HEADER_DEVICE]: opts.deviceId },
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
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(opts.snapshot),
    });
    return res.ok;
  } catch {
    return false;
  }
}
