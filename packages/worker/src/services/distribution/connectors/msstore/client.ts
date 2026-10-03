/**
 * The Microsoft Store submission API client (P5-04; S-07 row 18 and Microsoft's "Get app data",
 * "Manage app submissions", "Get package flights for an app" and "Manage package flight
 * submissions" pages). READ ONLY: the one method this client can send is GET — there is no
 * other `method` to pass, and the connector never creates, updates, commits, deletes or changes
 * the rollout of a submission. Publishing is CI's (`msstore` / the GitHub Action).
 *
 *   GET /v1.0/my/applications/{applicationId}
 *   GET /v1.0/my/applications/{applicationId}/submissions/{submissionId}
 *   GET /v1.0/my/applications/{applicationId}/listflights?top=&skip=
 *   GET /v1.0/my/applications/{applicationId}/flights/{flightId}/submissions/{submissionId}
 *
 *   - **Fixed host and app.** Requests go only to `https://manage.devcenter.microsoft.com`, under
 *     the one Store ID the setup resolved (re-checked here). Every other segment is an id this
 *     module checked and percent-encoded; a `resourceLocation` or `@nextLink` from a response is
 *     never followed. That is the SSRF control: the bearer token cannot be sent anywhere else.
 *   - **409 is "not readable", not an error.** The API answers 409 for an app that uses mandatory
 *     app updates or Store-managed consumable add-ons (`MsStoreError.notReadable`).
 *   - **429.** Retried after `Retry-After` (capped), else an exponential backoff, at most
 *     `maxRetries` times; then `MsStoreError(429)`.
 *   - **No redirects, bounded bodies.** `redirect: "manual"`, and any 3xx is a failure; a body is
 *     read through `readCappedText` (at most `MAX_RESPONSE_BYTES`).
 *   - **Errors carry a status line only**, never a response body: the message may reach
 *     `outlet_credentials.last_error` and the connector page.
 */

import type { FetchImpl } from "../../../../core/outletTokens.js";
import { isRedirect, readCappedText } from "../../../../core/readCapped.js";
import { STORE_ID } from "./setup.js";

export type { FetchImpl };
/** Re-exported: the shared redirect test lives in `core/readCapped.ts`. */
export { isRedirect };

export const STORE_API_ORIGIN = "https://manage.devcenter.microsoft.com";
const PREFIX = "/v1.0/my/applications";

/** A submission id (digits today) and a flight id (a GUID): checked before they become paths. */
export const SUBMISSION_ID = /^[0-9]{1,30}$/;
export const FLIGHT_ID = /^[0-9A-Za-z-]{1,64}$/;

/** A failed Store API call. The message is a status line this module composed. */
export class MsStoreError extends Error {
  constructor(
    readonly status: number,
    readonly label: string,
  ) {
    super(`Microsoft Store GET ${label}: HTTP ${status}`);
    this.name = "MsStoreError";
  }

  /** The app uses a feature the submission API does not support (409). */
  get notReadable(): boolean {
    return this.status === 409;
  }
}

const MAX_BACKOFF_MS = 10_000;

/** The most of one response body read. A submission with many listings is tens of KiB; this only
 *  bounds what a misbehaving endpoint could make the isolate hold. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function backoffMillis(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0)
      return Math.min(secs * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface MsStoreClientOptions {
  /** The Store ID of the one app this client reads. */
  applicationId: string;
  /** The bearer token, minted lazily (once per client). `null` = unusable credential. */
  token: () => Promise<string | null>;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/** How many flights one `listflights` page asks for, and how many pages a tick reads at most. */
export const FLIGHT_PAGE = 100;
export const MAX_FLIGHT_PAGES = 5;

export class MsStoreClient {
  /** Requests sent (retries included). */
  calls = 0;
  private tokenValue: Promise<string | null> | null = null;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly prefix: string;

  constructor(private readonly opts: MsStoreClientOptions) {
    if (!STORE_ID.test(opts.applicationId))
      throw new Error("invalid Microsoft Store id");
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? realSleep;
    this.maxRetries = opts.maxRetries ?? 2;
    this.prefix = `${PREFIX}/${opts.applicationId}`;
  }

  /** The URL for `segments` below the app (none: the application itself). */
  url(segments: readonly string[], query?: Record<string, string>): URL {
    for (const s of segments)
      if (s === "" || s === "." || s === "..")
        throw new Error("invalid Microsoft Store path");
    const path = segments.map(encodeURIComponent).join("/");
    const url = new URL(
      path ? `${this.prefix}/${path}` : this.prefix,
      STORE_API_ORIGIN,
    );
    for (const [k, v] of Object.entries(query ?? {}))
      url.searchParams.set(k, v);
    return url;
  }

  /** One GET (with 429 retries): the parsed JSON object. `label` names the call in errors. */
  async get(
    segments: readonly string[],
    label: string,
    query?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = this.url(segments, query);
    if (
      url.origin !== STORE_API_ORIGIN ||
      (url.pathname !== this.prefix &&
        !url.pathname.startsWith(`${this.prefix}/`))
    )
      throw new Error("refusing a request outside the Microsoft Store app");
    this.tokenValue ??= this.opts.token();
    const token = await this.tokenValue;
    if (!token) throw new MsStoreError(401, label);
    const init: RequestInit = {
      method: "GET",
      // A redirect is a failure, never followed: the bearer token must not reach another URL.
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    };
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      const res = await this.fetchImpl(url.toString(), init);
      if (res.status === 429 && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.sleep(backoffMillis(res, attempt));
        continue;
      }
      if (!res.ok || isRedirect(res)) {
        await res.body?.cancel();
        throw new MsStoreError(res.status, label);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await readCappedText(
            res,
            MAX_RESPONSE_BYTES,
            () => new MsStoreError(502, label),
          ),
        );
      } catch {
        throw new MsStoreError(502, label);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new MsStoreError(502, label);
      return parsed as Record<string, unknown>;
    }
  }

  application(): Promise<Record<string, unknown>> {
    return this.get([], "application");
  }

  submission(submissionId: string): Promise<Record<string, unknown>> {
    return this.get(["submissions", checkId(submissionId)], "submission");
  }

  /** Every flight of the app: `listflights` paged by `top`/`skip` (never by `@nextLink`). */
  async flights(): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 0; page < MAX_FLIGHT_PAGES; page++) {
      let doc: Record<string, unknown>;
      try {
        doc = await this.get(["listflights"], "listflights", {
          top: String(FLIGHT_PAGE),
          skip: String(page * FLIGHT_PAGE),
        });
      } catch (e) {
        // "404: No package flights were found."
        if (e instanceof MsStoreError && e.status === 404) break;
        throw e;
      }
      const value = Array.isArray(doc.value) ? doc.value : [];
      out.push(...value);
      const total =
        typeof doc.totalCount === "number" ? doc.totalCount : out.length;
      if (value.length < FLIGHT_PAGE || out.length >= total) break;
    }
    return out;
  }

  flightSubmission(
    flightId: string,
    submissionId: string,
  ): Promise<Record<string, unknown>> {
    if (!FLIGHT_ID.test(flightId)) throw new Error("invalid flight id");
    return this.get(
      ["flights", flightId, "submissions", checkId(submissionId)],
      "flight submission",
    );
  }
}

function checkId(id: string): string {
  if (!SUBMISSION_ID.test(id)) throw new Error("invalid submission id");
  return id;
}
