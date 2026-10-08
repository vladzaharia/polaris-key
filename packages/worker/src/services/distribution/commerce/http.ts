/**
 * The commerce bridge's outbound HTTP (P6-01): one JSON GET/POST helper for the App Store
 * Server API, Google's JWKS and the Steam Web API, with the store clients' hygiene (P5-04):
 * `redirect: "manual"` (a 3xx is a failure, so a bearer token or an API key in the query never
 * reaches a `Location`), a capped body read, and errors that carry a status line only — never a
 * response body, never the URL (a Steam key rides in the query string).
 *
 * The global `fetch` is late-bound, so a test that swaps it is honoured.
 */

import { isRedirect, readCappedText } from "../../../core/readCapped.js";

/** The most of one store response read. Store answers here are single small objects. */
export const MAX_STORE_RESPONSE_BYTES = 256 * 1024;

/** A store call that failed in a way a retry may fix: network, 5xx, 429, redirect, unreadable. */
export class StoreUnavailable extends Error {
  constructor(
    readonly label: string,
    readonly status: number,
  ) {
    super(`${label}: HTTP ${status}`);
    this.name = "StoreUnavailable";
  }
}

export interface StoreResponse {
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * Send one request and parse a JSON object body. 2xx and the 4xx statuses the caller lists in
 * `answerable` come back as a `StoreResponse` (the caller decides what a 404 means); anything
 * else throws `StoreUnavailable`.
 */
export async function storeJson(
  url: string,
  init: RequestInit,
  label: string,
  answerable: readonly number[] = [],
): Promise<StoreResponse> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "manual" });
  } catch {
    throw new StoreUnavailable(label, 0);
  }
  const ok = res.status >= 200 && res.status < 300;
  if (isRedirect(res) || (!ok && !answerable.includes(res.status))) {
    await res.body?.cancel().catch(() => undefined);
    throw new StoreUnavailable(label, res.status);
  }
  let body: Record<string, unknown> | null = null;
  try {
    const text = await readCappedText(
      res,
      MAX_STORE_RESPONSE_BYTES,
      () => new StoreUnavailable(label, 502),
    );
    if (text.trim() !== "") {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed as Record<string, unknown>;
      else if (ok) throw new Error("not an object");
    }
  } catch {
    if (ok) throw new StoreUnavailable(label, 502);
  }
  return { status: res.status, body };
}
