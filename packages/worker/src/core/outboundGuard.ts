/// <reference types="@cloudflare/workers-types" />

/**
 * The shared outbound-URL guard for fetches whose URL a repo or operator wrote and
 * whose request carries a secret (the custom-OIDC token POST) or decides trust (the JWKS fetch).
 *
 *   https only (http only to the exact dev loopback names) · no userinfo · no private, loopback,
 *   link-local or metadata host (the manifest package's `isSafeIssuerUrl`, applied to every hop)
 *   · redirects followed by hand, at most `OUTBOUND_MAX_REDIRECTS`, each hop re-checked, and a
 *   request body (a posted secret) never re-sent to a hop on another origin · one timeout over
 *   the whole fetch · a byte cap on the body.
 */
import { isSafeIssuerUrl } from "@polaris-key/manifest";
import { isRedirect, readCappedText } from "./readCapped.js";

export const OUTBOUND_MAX_REDIRECTS = 3;
export const OUTBOUND_TIMEOUT_MS = 10_000;
export const OUTBOUND_MAX_BYTES = 256 * 1024;

export class OutboundRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRefusedError";
  }
}

/** A host with every trailing dot removed; `null` when it has an empty label (`a..b`, `.a`). */
export function normalizeHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || host.split(".").some((l) => l === "")) return null;
  return host;
}

/** Why `raw` may not be dialled, or `null`. */
export function outboundUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "unparseable";
  }
  if (u.username || u.password) return "credentials";
  if (normalizeHost(u.hostname) === null) return "bad host";
  // `isSafeIssuerUrl` takes an origin-shaped value: it also refuses a query and fragment,
  // which an endpoint legitimately may carry, so check the origin and the scheme here.
  if (!isSafeIssuerUrl(u.origin)) return "not permitted";
  return null;
}

export interface OutboundOptions {
  init?: RequestInit;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Dial `url` under the guard; returns the final status and the capped body text. */
export async function outboundFetch(
  url: string,
  opts: OutboundOptions = {},
): Promise<{ status: number; body: string; url: string }> {
  const fetchImpl = opts.fetchImpl ?? ((i, n) => fetch(i, n));
  const signal = AbortSignal.timeout(opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS);
  const maxBytes = opts.maxBytes ?? OUTBOUND_MAX_BYTES;
  let current = url;
  let init: RequestInit = opts.init ?? {};
  for (let hop = 0; ; hop++) {
    const problem = outboundUrlProblem(current);
    if (problem) throw new OutboundRefusedError(`refused URL: ${problem}`);
    const res = await fetchImpl(current, {
      ...init,
      redirect: "manual",
      signal,
    });
    if (!isRedirect(res)) {
      const body = await readCappedText(
        res,
        maxBytes,
        (d) => new OutboundRefusedError(`response too large (${d})`),
      );
      return { status: res.status, body, url: current };
    }
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get("location");
    if (!location || hop >= OUTBOUND_MAX_REDIRECTS) {
      throw new OutboundRefusedError("too many redirects");
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new OutboundRefusedError("bad redirect");
    }
    // A posted secret, or a header that carries one, never follows a redirect off its origin:
    // the hop becomes a bare GET.
    if (next.origin !== new URL(current).origin) {
      init = { method: "GET" };
    } else if (res.status === 303) {
      init = { ...init, method: "GET", body: undefined };
    }
    current = next.toString();
  }
}
