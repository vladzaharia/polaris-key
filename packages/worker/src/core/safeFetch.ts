/// <reference types="@cloudflare/workers-types" />

/**
 * The guarded outbound fetcher (HA-01; S-20 §6.3 step 1, THREAT-MODEL "The outbound fetcher").
 *
 * Every fetch the Worker makes of a URL that someone other than Polaris Key wrote — a manifest's
 * asset URL, a console operator's "pull from", the portal media proxy's listing art — goes through
 * `safeFetch`. It does not decide WHO may name a URL (its callers do: manifest authors and product
 * operators, never end users); it bounds what any such URL can make the Worker do.
 *
 * ── THE GUARD (`guardUrl`, checked on the first URL and again on every redirect hop) ────────
 *
 *   https only · no userinfo · port 443 · no IP literal · no single-label host · not `plrs.im`
 *   or any `*.plrs.im` · not `.local`, `.internal`, `.localhost` or `.home.arpa` · ≤ 2048 chars
 *
 * Why `plrs.im` is denied: the Worker runs without `global_fetch_strictly_public`, so a fetch to
 * one of our own custom domains is routed to "origin" and either 522s or bypasses the front
 * door's own checks. Why there is no private-range check: the Worker resolves nothing itself, and
 * Cloudflare's edge neither dials an IP literal from a Worker nor routes a subrequest to RFC 1918
 * or loopback space. The names above are the ones that only ever resolve privately.
 *
 * The case table in `test/safeFetch.test.ts` is the S-20 reference puller's `--self-test` table
 * (`docs/research/2026-09-29-godot-omniplatform/prototype/hosted-assets/pull.mjs`), case for case:
 * the test reads the prototype's table and fails if the two drift.
 *
 * ── THE FETCH ───────────────────────────────────────────────────────────────────────────────
 *
 *   - `redirect: "manual"`; at most `SAFE_FETCH_MAX_REDIRECTS` hops, each re-guarded before it
 *     is dialled. An `Authorization` header goes to the FIRST hop only, never to a `Location`.
 *   - One timeout (`SAFE_FETCH_TIMEOUT_MS` unless the caller sets a shorter one) covering every
 *     hop, the headers and the body.
 *   - A byte cap: a declared `Content-Length` over it is refused before the body is read, and the
 *     body the caller receives is counted and errors the moment it passes the cap, whatever the
 *     header said.
 *   - `If-None-Match` when the caller has a validator from the last pull: a `304` is "no work".
 *
 * Refusals are stable reason strings (stored in `hosted_assets.error`): `guard:<reason>`,
 * `status:<n>`, `too-large`, `timeout`, `network`.
 */

/** Redirect hops followed, each re-guarded. */
export const SAFE_FETCH_MAX_REDIRECTS = 3;
/** The budget for the whole fetch: every hop, the headers and the body. */
export const SAFE_FETCH_TIMEOUT_MS = 30_000;
/** The longest URL dialled. */
export const SAFE_FETCH_MAX_URL = 2048;

/** Our own zone and the names that only resolve privately. */
const DENY_SUFFIXES = [
  ".plrs.im",
  ".local",
  ".internal",
  ".localhost",
  ".home.arpa",
];
const DENY_EXACT: ReadonlySet<string> = new Set(["plrs.im", "localhost"]);

export type GuardReason =
  | "unparseable"
  | "scheme"
  | "credentials"
  | "port"
  | "ip-literal"
  | "single-label"
  | "denied-host"
  | "too-long"
  /** The caller's own host predicate refused it (the portal media proxy's GitHub-only rule). */
  | "not-allowed"
  /** More than `SAFE_FETCH_MAX_REDIRECTS` hops, or a redirect without a usable `Location`. */
  | "redirects";

export type SafeFetchReason =
  | `guard:${GuardReason}`
  | `status:${number}`
  | "too-large"
  | "timeout"
  | "network";

/**
 * The S-20 §6.3 guard: `null` when `raw` may be dialled, else why not. The order of the checks is
 * the reference puller's, so both answer the same reason for the same URL.
 */
export function guardUrl(raw: string): GuardReason | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "unparseable";
  }
  if (u.protocol !== "https:") return "scheme";
  if (u.username || u.password) return "credentials";
  if (u.port && u.port !== "443") return "port";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  // The URL parser has already normalised every IPv4 spelling (hex, octal, short forms) to a
  // dotted quad, and an IPv6 literal keeps its brackets.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("["))
    return "ip-literal";
  if (!host.includes(".")) return "single-label";
  if (DENY_EXACT.has(host) || DENY_SUFFIXES.some((s) => host.endsWith(s)))
    return "denied-host";
  if (raw.length > SAFE_FETCH_MAX_URL) return "too-long";
  return null;
}

/** The error a capped body raises once it passes its cap. */
export class TooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`body exceeds ${maxBytes} bytes`);
    this.name = "TooLargeError";
  }
}

/**
 * `body`, counted: the returned stream errors with `TooLargeError` the moment more than
 * `maxBytes` have passed, and cancels the source.
 */
export function cappedStream(
  body: ReadableStream,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const r = await reader.read();
      if (r.done) {
        controller.close();
        return;
      }
      const v = r.value as unknown;
      const chunk =
        v instanceof Uint8Array
          ? v
          : ArrayBuffer.isView(v)
            ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
            : new Uint8Array(v as ArrayBuffer);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        controller.error(new TooLargeError(maxBytes));
        return;
      }
      controller.enqueue(chunk);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The reason a failed body read maps to: the cap, the timeout, or the network. */
export function bodyFailureReason(
  err: unknown,
): "too-large" | "timeout" | "network" {
  if (err instanceof TooLargeError) return "too-large";
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "network";
}

export type FetchImpl = (
  input: Request | string,
  init?: RequestInit,
) => Promise<Response>;

export interface SafeFetchOptions {
  /** The byte cap on the body (declared and streamed). */
  maxBytes: number;
  /** At most `SAFE_FETCH_TIMEOUT_MS`; a shorter budget is allowed, a longer one is clamped. */
  timeoutMs?: number;
  /** Request headers. `authorization` is sent to the first hop only. */
  headers?: Record<string, string>;
  /** The source's validator from the last pull, sent as `If-None-Match`. */
  etag?: string | null;
  /**
   * An extra host rule on top of the guard, applied to every hop (`guard:not-allowed`). It can
   * only narrow: a host the guard refuses stays refused.
   */
  allowHost?: (host: string) => boolean;
  /** A test seam; the global `fetch` otherwise. */
  fetchImpl?: FetchImpl;
}

export type SafeFetchResult =
  | {
      ok: true;
      status: 200;
      /** The body, capped at `maxBytes` (`TooLargeError` past it). The caller must consume or
       *  cancel it. */
      body: ReadableStream<Uint8Array>;
      /** The declared `Content-Length`, when the source sent a usable one. */
      length: number | null;
      /** The source's `ETag`, for the next pull's `If-None-Match`. */
      etag: string | null;
      /** The URL the bytes came from, after redirects. */
      url: string;
      /** The hosts of the redirect hops, in order. */
      hops: string[];
    }
  | {
      ok: true;
      status: 304;
      etag: string | null;
      url: string;
      hops: string[];
    }
  | { ok: false; reason: SafeFetchReason; hops: string[] };

function check(
  raw: string,
  allowHost: SafeFetchOptions["allowHost"],
): GuardReason | null {
  const why = guardUrl(raw);
  if (why) return why;
  if (allowHost && !allowHost(new URL(raw).hostname.toLowerCase()))
    return "not-allowed";
  return null;
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

/** Fetch `url` under the guard, the redirect rule, the timeout and the byte cap. */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const hops: string[] = [];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.min(
    opts.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS,
    SAFE_FETCH_TIMEOUT_MS,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const why = check(current, opts.allowHost);
      if (why) return { ok: false, reason: `guard:${why}`, hops };
      const headers = new Headers(opts.headers ?? {});
      if (hop > 0) headers.delete("authorization");
      if (opts.etag) headers.set("if-none-match", opts.etag);
      const res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers,
        signal,
      });
      if (isRedirectStatus(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location || hop >= SAFE_FETCH_MAX_REDIRECTS)
          return { ok: false, reason: "guard:redirects", hops };
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { ok: false, reason: "guard:redirects", hops };
        }
        hops.push(hostOf(next));
        current = next;
        continue;
      }
      const etag = res.headers.get("etag");
      if (res.status === 304) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: true, status: 304, etag, url: current, hops };
      }
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: `status:${res.status}`, hops };
      }
      const declared = Number(res.headers.get("content-length") ?? "");
      const length =
        res.headers.get("content-length") !== null &&
        Number.isSafeInteger(declared) &&
        declared >= 0
          ? declared
          : null;
      if (length !== null && length > opts.maxBytes) {
        await res.body.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large", hops };
      }
      return {
        ok: true,
        status: 200,
        body: cappedStream(res.body, opts.maxBytes),
        length,
        etag,
        url: current,
        hops,
      };
    }
  } catch (err) {
    const reason = bodyFailureReason(err);
    return {
      ok: false,
      reason: reason === "too-large" ? "network" : reason,
      hops,
    };
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}
