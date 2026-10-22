/**
 * The one HTTP transport and the one error class for both apps (the console at `/manage` and the
 * customer portal). It is the only module that calls `fetch` (`test/noDirectFetch.test.ts`) and
 * imports nothing outside `lib/` (`test/boundaries.test.ts`, rule 1).
 *
 * A refusal becomes an {@link HttpError}. Status 0 is a network failure in both apps (offline,
 * DNS, a dropped connection). Route-specific extras (`packageFeeds`, the portal's `next`,
 * `unknownCredential`) stay on `body` for app-side readers: this module knows only the fields the
 * Worker's refusals share.
 */

/** The refusal fields every route shares, read from the nested or the flat body shape. */
export interface Refusal {
  code?: string;
  message?: string;
  fields?: string[];
  errors?: string[];
  reason?: string;
  area?: string;
  retryAfter?: number;
  triesLeft?: number;
  stale?: string[];
}

export class HttpError extends Error {
  readonly code?: string;
  readonly fields?: string[];
  /** Stable coherence codes: inputs individually fine and jointly impossible. */
  readonly errors?: string[];
  /** A machine-readable case beside the registered `code` (`unknown_channel`, `too_large`, …). */
  readonly reason?: string;
  /** The area a `no_access` 403 names. */
  readonly area?: string;
  /** Seconds until a 429 clears, when the route says. */
  readonly retryAfter?: number;
  /** A wrong sign-in code's remaining tries. */
  readonly triesLeft?: number;
  /** `step_up_required` on a join: which proofs are older than 5 minutes. */
  readonly stale?: string[];
  /** The parsed refusal body as sent (`undefined` when it was not JSON): route extras live here. */
  readonly body: unknown;

  constructor(
    /** The HTTP status; 0 is a network failure. */
    readonly status: number,
    refusal: Refusal = {},
    body?: unknown,
  ) {
    super(refusal.message || (status === 0 ? "network" : `http ${status}`));
    this.name = "HttpError";
    this.code = refusal.code;
    this.fields = refusal.fields;
    this.errors = refusal.errors;
    this.reason = refusal.reason;
    this.area = refusal.area;
    this.retryAfter = refusal.retryAfter;
    this.triesLeft = refusal.triesLeft;
    this.stale = refusal.stale;
    this.body = body;
  }
}

const str = (x: unknown): string | undefined =>
  typeof x === "string" ? x : undefined;
const num = (x: unknown): number | undefined =>
  typeof x === "number" ? x : undefined;
const strings = (x: unknown): string[] | undefined =>
  Array.isArray(x)
    ? x.filter((v): v is string => typeof v === "string")
    : undefined;
const obj = (x: unknown): Record<string, unknown> | undefined =>
  typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;

/**
 * Read a refusal body. Two shapes exist: nested (`{error:{code,message,fields,errors,reason,area}}`)
 * and flat (`{error:"code", message, fields, …}`). The nested field wins, the top level fills in.
 */
export function parseRefusal(status: number, body: unknown): HttpError {
  const top = obj(body);
  if (!top) return new HttpError(status, {}, body);
  const nested = obj(top.error);
  const pick = <T>(read: (x: unknown) => T | undefined, key: string) =>
    (nested ? read(nested[key]) : undefined) ?? read(top[key]);
  return new HttpError(
    status,
    {
      code: nested
        ? (str(nested.code) ?? str(top.code))
        : (str(top.error) ?? str(top.code)),
      message: pick(str, "message"),
      fields: pick(strings, "fields"),
      errors: pick(strings, "errors"),
      reason: pick(str, "reason"),
      area: pick(str, "area"),
      retryAfter: pick(num, "retryAfter"),
      triesLeft: pick(num, "triesLeft"),
      stale: pick(strings, "stale"),
    },
    body,
  );
}

/** Per-call options every client understands. An app adds its own through the type parameter. */
export interface HttpOptions {
  /**
   * Send the CSRF header: `true` on a read that needs it (a personal-data download), `false` on a
   * write that must not carry it (`/logout`). Default: on every request that is not a GET.
   */
  csrf?: boolean;
  /** Return the `Response` whatever its status (an opaque redirect from `redirect: "manual"`). */
  raw?: boolean;
}

export interface HttpClientConfig<Extra extends object = object> {
  /** The CSRF header's name (`X-PKey-CSRF`, `X-PKey-Portal-CSRF`). */
  csrfHeader: string;
  /** The current token, read at each request. */
  csrf: () => string;
  /**
   * Runs on a 401. Return the response `retry()` produced to carry on, or nothing to let the 401
   * throw. `retry` sends the same request once more with this hook off, so it cannot loop.
   */
  onUnauthorized?: (
    res: Response,
    retry: () => Promise<Response>,
    opts: HttpOptions & Extra,
  ) => Promise<Response | void> | Response | void;
  /** Runs with the refusal, before it is thrown (the step-up redirect). */
  onRefusal?: (error: HttpError, opts: HttpOptions & Extra) => void;
}

export interface HttpClient<Extra extends object = object> {
  send(
    path: string,
    init?: RequestInit,
    opts?: HttpOptions & Extra,
  ): Promise<Response>;
  /** JSON in, JSON out; an empty body (204) is `undefined`. */
  call<T>(
    path: string,
    init?: RequestInit,
    opts?: HttpOptions & Extra,
  ): Promise<T>;
  /** A read whose body is a file (a CSV report), as text. */
  callText(
    path: string,
    init?: RequestInit,
    opts?: HttpOptions & Extra,
  ): Promise<string>;
}

export function createHttpClient<Extra extends object = object>(
  config: HttpClientConfig<Extra>,
): HttpClient<Extra> {
  async function attempt(
    path: string,
    init: RequestInit,
    opts: HttpOptions & Extra,
    mayRecover: boolean,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const mutating = init.method != null && init.method.toUpperCase() !== "GET";
    if (opts.csrf ?? mutating) headers.set(config.csrfHeader, config.csrf());
    // A JSON body unless the caller sent its own type (a raw file upload).
    if (mutating && init.body && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    let res: Response;
    try {
      res = await fetch(path, { ...init, headers, credentials: "same-origin" });
    } catch (e) {
      // A caller's abort is theirs to handle, not a network failure.
      if ((e as { name?: unknown } | null)?.name === "AbortError") throw e;
      throw new HttpError(0, { code: "network" });
    }
    if (opts.raw) return res;
    if (res.status === 401 && mayRecover && config.onUnauthorized) {
      const again = await config.onUnauthorized(
        res,
        () => attempt(path, init, opts, false),
        opts,
      );
      if (again) return again;
    }
    if (res.ok) return res;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    const error = parseRefusal(res.status, body);
    config.onRefusal?.(error, opts);
    throw error;
  }

  const send: HttpClient<Extra>["send"] = (
    path,
    init = {},
    opts = {} as never,
  ) => attempt(path, init, opts, true);

  return {
    send,
    async call<T>(
      path: string,
      init?: RequestInit,
      opts?: HttpOptions & Extra,
    ) {
      const text = await (await send(path, init, opts)).text();
      return (text ? JSON.parse(text) : undefined) as T;
    },
    async callText(path, init, opts) {
      return (await send(path, init, opts)).text();
    },
  };
}
