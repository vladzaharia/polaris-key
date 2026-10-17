// `usePolarisFetch()`'s engine — the React half of `client.backend` (WIRE-CONTRACT-V4 §14.5,
// framework drop-ins §6). The adapter supplies the licence and device headers
// (`adapter.backendHeaders()`, which refreshes a document near its expiry first); this module
// holds what the page decides: which origins may receive them, the one retry on `license_stale` /
// `license_invalid`, and the typed `not_entitled` / `sign_in_required` errors.
//
// The page's own origin is allowed by default when it is HTTPS (or loopback); `backend.origins`
// adds exact origins. A redirect is refused unless the caller asks to follow one: the browser
// hides an opaque redirect's target, so a licence cannot be checked against it.

import { clientBackendAction } from "@polaris-key/client-core/backend";
import { HEADER_DEVICE, HEADER_LICENSE } from "@polaris-key/protocol/core";
import { ErrorCode } from "../constants.generated.js";
import { copyMessage } from "./copy.js";
import { PolarisError, type PolarisAdapter } from "./types.js";

/** `backend.origins`: where the licence may go besides the page's own origin. */
export interface BackendOptions {
  origins?: readonly string[];
}

/** The two headers `adapter.backendHeaders()` returns. `X-PKey-License` is absent without a
 *  held licence document. */
export type BackendHeaders = Record<string, string>;

export type PolarisFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** One exact origin, or a thrown `invalid-options`. */
export function normalizeBackendOrigin(origin: string): string {
  const bad = (): PolarisError =>
    new PolarisError(
      ErrorCode.invalidOptions,
      `backend.origins: ${JSON.stringify(origin)} is not an exact origin (https://host[:port]; http only on loopback).`,
    );
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw bad();
  }
  const plain =
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!plain || !secure || origin.includes("*")) throw bad();
  return url.origin;
}

/** The page's own origin when it may receive the licence: HTTPS or loopback HTTP. */
function pageOrigin(): string | null {
  const loc = (globalThis as { location?: Location }).location;
  if (!loc || typeof loc.origin !== "string") return null;
  try {
    return normalizeBackendOrigin(loc.origin);
  } catch {
    return null;
  }
}

/** The origin a request's URL names, resolved against the page; null when it has none. */
function originOf(url: string): string | null {
  try {
    const loc = (globalThis as { location?: Location }).location;
    return new URL(url, loc?.href).origin;
  } catch {
    return null;
  }
}

async function problemCode(res: Response): Promise<string | null> {
  if (res.status !== 401 && res.status !== 403) return null;
  try {
    const body: unknown = await res.clone().json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/**
 * A `fetch` that sends the licence to an allowed origin: `X-PKey-License` and `X-PKey-Device`
 * attached, the developer's own headers (an `Authorization` included) untouched. Refuses any
 * other origin with `backend-origin-not-allowed` before sending. On `license_stale` or
 * `license_invalid` it force-syncs and retries once; if the sync fails it hands back the
 * backend's answer. `not_entitled` and `sign_in_required` throw a `PolarisError` carrying the
 * response status and the copy, and are never retried.
 */
export function createPolarisFetch(
  adapter: Pick<PolarisAdapter, "backendHeaders">,
  options: BackendOptions = {},
  transport: () => typeof fetch = () => globalThis.fetch.bind(globalThis),
): PolarisFetch {
  const configured = (options.origins ?? []).map(normalizeBackendOrigin);
  return async (input, init) => {
    // A relative URL is the page's own.
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(
            String(input),
            (globalThis as { location?: Location }).location?.href,
          ).href
        : input;
    const request = new Request(target, init);
    const allowed = new Set(configured);
    const own = pageOrigin();
    if (own) allowed.add(own);
    const origin = originOf(request.url);
    if (origin === null || !allowed.has(origin))
      throw new PolarisError(
        ErrorCode.backendOriginNotAllowed,
        copyMessage(ErrorCode.backendOriginNotAllowed, {
          detail: origin ?? request.url,
        }),
      );
    let retried = false;
    let force = false;
    for (;;) {
      const headers = new Headers(request.headers);
      const own = await adapter.backendHeaders({ force });
      headers.delete(HEADER_LICENSE);
      for (const [name, value] of Object.entries(own)) headers.set(name, value);
      headers.set(HEADER_DEVICE, own[HEADER_DEVICE] ?? "");
      const send: RequestInit = {
        method: request.method,
        headers,
        redirect: init?.redirect ?? "error",
        signal: request.signal,
        credentials: request.credentials,
        cache: request.cache,
        ...(request.body !== null
          ? { body: request.clone().body, duplex: "half" }
          : {}),
      } as RequestInit;
      const res = await transport()(request.url, send);
      const code = await problemCode(res);
      const action = clientBackendAction({
        document: null,
        now: 0,
        response: { status: res.status, code },
        retried,
      });
      if (action === "refresh-and-retry") {
        retried = true;
        force = true;
        try {
          await adapter.backendHeaders({ force: true });
        } catch {
          // The sync failed (offline, or a 401 from the Worker): the backend's answer stands.
          return res;
        }
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      if (
        res.status === 403 &&
        (code === ErrorCode.notEntitled || code === ErrorCode.signInRequired)
      )
        throw new PolarisError(code, copyMessage(code), undefined, undefined, {
          status: res.status,
        });
      return res;
    }
  };
}
