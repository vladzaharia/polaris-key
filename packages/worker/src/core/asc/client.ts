/**
 * The App Store Connect API client (P5-02; notes/E1 §A1). Every later ASC call goes through
 * this (P5-08's asset-pack housekeeping included). A-17a moved it into Core (`core/asc/`) beside
 * the write gate, the operation ledger and the budget meter, so Distribution's connector and the
 * platform's provisioning share one client.
 *
 *   - **The write gate (A-17a, generalised by A-18a).** Every request is admitted by
 *     `checkAscRequest` (`core/storefront/rules/appStore.ts`, on the store-agnostic engine) BEFORE the token thunk runs: a write outside the deny-by-default allow
 *     table, a read of user records, or a typed-confirmation operation sent without the handler's
 *     assertion throws `AscWriteDenied`, so no token is minted and nothing is sent. The gate is
 *     the only barrier between the Worker's Admin team key and Apple's user, certificate and
 *     delete operations (S-14 §12 decision 1).
 *
 *   - **Fixed host.** Requests go to `https://api.appstoreconnect.apple.com/v1/…` (or `/v2/…`,
 *     where Apple serves IAPs and availability) and nowhere else. A path is built from validated segments (`ascPath`), never from a string a webhook,
 *     a manifest or an operator supplied whole, and a JSON:API `links.next` is followed only when
 *     it names that same origin and a `/v1/` or `/v2/` path. That is the SSRF control: a forged payload or
 *     a hostile `next` link cannot make the Worker send the bearer token anywhere.
 *   - **Token.** `Authorization: Bearer <ascToken>` from P5-01 (`core/outletTokens.ts`), passed
 *     in as a thunk so the client never sees the credential, only the ≤ 20-minute JWT.
 *   - **Budget.** Every response carries `X-Rate-Limit: user-hour-lim:3500;user-hour-rem:500;`
 *     (Apple's example; "actual limits can vary") — per key, rolling hour. The client parses it
 *     into `lastRate` so the poller can slow down as the remainder drops.
 *   - **429.** `RATE_LIMIT_EXCEEDED`: retried after `Retry-After` (capped), else an exponential
 *     backoff with jitter, at most `maxRetries` times; then `AscError(429)`.
 *   - **No redirects, bounded bodies.** `redirect: "manual"`, and any 3xx (or opaque redirect)
 *     is a failure (`AscError` with that status), so the bearer token never reaches a `Location`.
 *     A body is read through `readCappedText` (at most `MAX_RESPONSE_BYTES`); an oversized or
 *     non-object body is `AscError(502)`, the same "unreadable answer" as malformed JSON.
 *   - **Errors carry a status line only** (`AscError.message`), never a response body: the
 *     message may end up in `outlet_credentials.last_error` and on the console page. Apple's
 *     `errors[0].code` token is kept apart (`AscError.code`) for the A-17 ledger.
 *
 * `fetchImpl` and `sleep` are injectable; the tests drive the client against a fake ASC server.
 */

import { isRedirect, readCappedText } from "../readCapped.js";
import { StoreVendorError } from "../storefront/errors.js";
import {
  AscWriteDenied,
  checkAscRequest,
  type AscGateContext,
} from "../storefront/rules/appStore.js";

export {
  AscWriteDenied,
  type AscGateContext,
} from "../storefront/rules/appStore.js";

/** A fetch with the platform `fetch` shape, injectable for tests. */
export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export const ASC_ORIGIN = "https://api.appstoreconnect.apple.com";

/** One JSON:API resource object. */
export interface AscResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    | {
        /** Present only when the relationship was named in `include`. */
        data?: AscIdentifier | AscIdentifier[] | null;
        links?: Record<string, string>;
      }
    | undefined
  >;
}

export interface AscIdentifier {
  type: string;
  id: string;
}

/** One JSON:API document. */
export interface AscDocument {
  data: AscResource | AscResource[] | null;
  included?: AscResource[];
  links?: { self?: string; next?: string };
}

export interface AscRate {
  limit: number;
  remaining: number;
}

/**
 * A failed ASC call. The message is a status line this module composed. `code` is Apple's first
 * `errors[].code` when the error body carried one (an enum-like token such as
 * `ENTITY_ERROR.ATTRIBUTE.INVALID`, A-17h), never the body's free text (`title`, `detail`).
 */
export class AscError extends StoreVendorError {
  constructor(
    status: number,
    readonly method: string,
    readonly path: string,
    code: string | null = null,
  ) {
    super(status, code, `App Store Connect ${method} ${path}: HTTP ${status}`);
    this.name = "AscError";
  }
}

/** Apple's error codes are dotted upper-case tokens; anything else is dropped. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,40}(\.[A-Z0-9_]{1,40}){0,6}$/;

/** The most of an error body read, to find its `errors[0].code`. */
const MAX_ERROR_BYTES = 64 * 1024;

/** `errors[0].code` of an error response, or null. Never throws; the body is never kept. */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const text = await readCappedText(res, MAX_ERROR_BYTES, () => new Error());
    const parsed = JSON.parse(text) as { errors?: { code?: unknown }[] };
    const code = Array.isArray(parsed.errors) ? parsed.errors[0]?.code : null;
    return typeof code === "string" && ERROR_CODE.test(code) ? code : null;
  } catch {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
}

/**
 * The most of one response body read. Apple caps a collection page at `limit=200` resources and
 * each `include`d relationship at 50, and the poller asks for far less (`asc/poll.ts`: ten
 * versions, a handful of builds); a full 200-resource page with its `included` set is still well
 * under 1 MiB. 8 MiB leaves room for Apple's largest documented pages while bounding what a
 * misbehaving endpoint could make the isolate buffer.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** A path segment: a resource type (`appStoreVersions`) or an id (UUID, digits). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** `/v1/<seg>/<seg>…`, refusing any segment that is not a plain type or id. */
export function ascPath(...segments: string[]): string {
  return ascPathV("v1", ...segments);
}

/** `/<version>/<seg>…`: Apple serves a few resources only under `/v2/` (IAPs, availability). */
export function ascPathV(version: "v1" | "v2", ...segments: string[]): string {
  for (const s of segments) {
    if (!SEGMENT.test(s)) throw new Error("invalid App Store Connect path");
  }
  return `/${version}/${segments.join("/")}`;
}

/** An API path the client sends to: `/v1/…` or `/v2/…`. */
const isApiPath = (p: string): boolean => /^\/v[12]\//.test(p);

/** Parse `X-Rate-Limit: user-hour-lim:3500;user-hour-rem:500;`. */
export function parseRateLimit(header: string | null): AscRate | null {
  if (!header) return null;
  const lim = /user-hour-lim:(\d+)/.exec(header)?.[1];
  const rem = /user-hour-rem:(\d+)/.exec(header)?.[1];
  if (lim === undefined || rem === undefined) return null;
  const limit = Number(lim);
  const remaining = Number(rem);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0)
    return null;
  return { limit, remaining };
}

/** The longest a single 429 retry waits. A cron tick or a webhook has a wall clock. */
const MAX_BACKOFF_MS = 10_000;

/** How long to wait before retrying a 429: `Retry-After` seconds (capped), else 1 s, 2 s, … */
export function backoffMillis(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0)
      return Math.min(secs * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS) + jitter();
}

const jitter = (): number => Math.floor(Math.random() * 250);

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface AscClientOptions {
  /** The bearer token, minted lazily (once per client). `null` = unusable credential. */
  token: () => Promise<string | null>;
  /** Late-bound to the global `fetch` by default, so a test that swaps it is honoured. */
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  /** 429 retries per request. */
  maxRetries?: number;
}

export class AscClient {
  /** Requests sent (retries included). */
  calls = 0;
  /** The last `X-Rate-Limit` the server sent. */
  lastRate: AscRate | null = null;
  private tokenValue: Promise<string | null> | null = null;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly opts: AscClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? realSleep;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  private async bearer(method: string, path: string): Promise<string> {
    this.tokenValue ??= this.opts.token();
    const token = await this.tokenValue;
    // 401 is what Apple would answer without one; the caller's branch is the same.
    if (!token) throw new AscError(401, method, path);
    return token;
  }

  /**
   * Send one request (with 429 retries). Answers the parsed JSON, or `null` for 204/empty.
   * `gate` carries what the handler asserts (a typed confirmation, a first-time set) to the
   * write gate; it is never sent.
   */
  async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: {
      query?: Record<string, string>;
      body?: unknown;
      gate?: AscGateContext;
    } = {},
  ): Promise<AscDocument | null> {
    if (!isApiPath(path)) throw new Error("invalid App Store Connect path");
    const url = new URL(path, ASC_ORIGIN);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      url.searchParams.set(k, v);
    return this.send(method, url, opts.body, opts.gate);
  }

  private async send(
    method: string,
    url: URL,
    body: unknown,
    gate?: AscGateContext,
  ): Promise<AscDocument | null> {
    // Defence in depth: whatever built the URL, it must still be the one host.
    if (url.origin !== ASC_ORIGIN || !isApiPath(url.pathname))
      throw new Error("refusing a request outside App Store Connect");
    // Serialise once, and gate what will actually be sent: the gate checks the parsed form of the
    // exact string the request carries, so a `toJSON` or a getter cannot send something other
    // than what was checked. A body that does not serialise to JSON is refused outright.
    const serialised = body === undefined ? undefined : JSON.stringify(body);
    if (body !== undefined && typeof serialised !== "string")
      throw new AscWriteDenied(method, url.pathname, "invalid_body");
    const sent: unknown =
      serialised === undefined ? undefined : JSON.parse(serialised);
    // The write gate, BEFORE the token: a refused request mints nothing and sends nothing.
    checkAscRequest(method, url.pathname, sent, gate);
    const token = await this.bearer(method, url.pathname);
    const init: RequestInit = {
      method,
      // A redirect is a failure, never followed: the bearer token must not reach another URL.
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(serialised !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(serialised !== undefined ? { body: serialised } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      const res = await this.fetchImpl(url.toString(), init);
      const rate = parseRateLimit(res.headers.get("X-Rate-Limit"));
      if (rate) this.lastRate = rate;
      if (res.status === 429 && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.sleep(backoffMillis(res, attempt));
        continue;
      }
      if (isRedirect(res)) {
        await res.body?.cancel().catch(() => undefined);
        throw new AscError(res.status, method, url.pathname);
      }
      if (!res.ok)
        throw new AscError(
          res.status,
          method,
          url.pathname,
          await errorCode(res),
        );
      const unreadable = () => new AscError(502, method, url.pathname);
      if (res.status === 204) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      let parsed: unknown;
      try {
        const text = await readCappedText(res, MAX_RESPONSE_BYTES, unreadable);
        if (text.trim() === "") return null;
        parsed = JSON.parse(text);
      } catch {
        // Oversized, a broken stream or malformed JSON: one "unreadable answer".
        throw unreadable();
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw unreadable();
      return parsed as AscDocument;
    }
  }

  get(
    path: string,
    query?: Record<string, string>,
  ): Promise<AscDocument | null> {
    return this.request("GET", path, query ? { query } : {});
  }

  /** `get`, answering `null` for a 404 (an object deleted since the webhook named it). */
  async getOrNull(
    path: string,
    query?: Record<string, string>,
  ): Promise<AscDocument | null> {
    try {
      return await this.get(path, query);
    } catch (e) {
      if (e instanceof AscError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Every page of a collection, following `links.next` (JSON:API cursor paging) for at most
   * `maxPages` pages. `included` resources are merged across pages.
   */
  async getAll(
    path: string,
    query: Record<string, string>,
    maxPages = 3,
  ): Promise<{ data: AscResource[]; included: AscResource[] }> {
    const data: AscResource[] = [];
    const included: AscResource[] = [];
    let doc = await this.get(path, query);
    for (let page = 1; doc; page++) {
      if (Array.isArray(doc.data)) data.push(...doc.data);
      if (Array.isArray(doc.included)) included.push(...doc.included);
      const next = doc.links?.next;
      if (!next || page >= maxPages) break;
      let url: URL;
      try {
        url = new URL(next);
      } catch {
        break;
      }
      // Only ever the same host and API: a hostile `next` is dropped, not followed.
      if (url.origin !== ASC_ORIGIN || !isApiPath(url.pathname)) break;
      doc = await this.send("GET", url, undefined);
    }
    return { data, included };
  }

  patch(
    path: string,
    body: unknown,
    gate?: AscGateContext,
  ): Promise<AscDocument | null> {
    return this.request("PATCH", path, { body, ...(gate ? { gate } : {}) });
  }

  post(
    path: string,
    body: unknown,
    gate?: AscGateContext,
  ): Promise<AscDocument | null> {
    return this.request("POST", path, { body, ...(gate ? { gate } : {}) });
  }
}

// ── JSON:API helpers ─────────────────────────────────────────────────────────────────────────

/** The single resource of a document, or null. */
export function single(doc: AscDocument | null): AscResource | null {
  const d = doc?.data;
  return d && !Array.isArray(d) && typeof d.id === "string" ? d : null;
}

/** The id a to-one relationship names, or null. */
export function relId(
  r: AscResource | null | undefined,
  name: string,
): string | null {
  const d = r?.relationships?.[name]?.data;
  return d && !Array.isArray(d) && typeof d.id === "string" ? d.id : null;
}

/** An `included` resource by type and id. */
export function findIncluded(
  included: readonly AscResource[] | undefined,
  type: string,
  id: string | null,
): AscResource | null {
  if (!id) return null;
  return included?.find((r) => r.type === type && r.id === id) ?? null;
}

/** A string attribute, or null. */
export function attr(
  r: AscResource | null | undefined,
  name: string,
): string | null {
  const v = r?.attributes?.[name];
  return typeof v === "string" ? v : null;
}

/** A number attribute, or null. */
export function numAttr(
  r: AscResource | null | undefined,
  name: string,
): number | null {
  const v = r?.attributes?.[name];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
