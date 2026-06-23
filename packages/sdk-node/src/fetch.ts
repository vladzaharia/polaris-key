// GET /<product>/config with the documented status taxonomy. Verification + anti-replay
// happen in the client (verify.ts); this is purely the HTTP layer.

import {
  HEADER_CHANNEL,
  HEADER_DEVICE,
  HEADER_VERSION,
  type AllowedRange,
  type BlockReason,
} from "@polaris-key/protocol";

export type FetchResult =
  | { kind: "ok"; jws: string; etag: string | null }
  | { kind: "not-modified" }
  | { kind: "unauthorized" }
  | { kind: "device-cap"; limit?: number; machineCount?: number }
  | { kind: "blocked"; reason: BlockReason; allowedRange?: AllowedRange }
  | { kind: "error"; status: number; message: string };

export interface FetchOptions {
  baseUrl: string;
  product: string;
  token: string;
  deviceId: string;
  version: string;
  channel: string;
  etag?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function fetchManagedConfig(opts: FetchOptions): Promise<FetchResult> {
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    [HEADER_DEVICE]: opts.deviceId,
    [HEADER_VERSION]: opts.version,
    [HEADER_CHANNEL]: opts.channel,
  };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  const url = `${opts.baseUrl}/${opts.product}/config`;

  let res: Response;
  try {
    res = await f(url, { headers, signal: opts.signal });
  } catch (e) {
    return { kind: "error", status: 0, message: (e as Error).message };
  }

  switch (res.status) {
    case 304:
      return { kind: "not-modified" };
    case 401:
      return { kind: "unauthorized" };
    case 429: {
      const body = (await res.json().catch(() => ({}))) as { limit?: number; machineCount?: number };
      return { kind: "device-cap", limit: body.limit, machineCount: body.machineCount };
    }
    case 403: {
      const body = (await res.json().catch(() => ({}))) as {
        reason?: BlockReason;
        allowedRange?: AllowedRange;
      };
      return { kind: "blocked", reason: body.reason ?? "version-too-old", allowedRange: body.allowedRange };
    }
    case 200: {
      const jws = await res.text();
      return { kind: "ok", jws, etag: res.headers.get("etag") };
    }
    default:
      return { kind: "error", status: res.status, message: await res.text().catch(() => "") };
  }
}
