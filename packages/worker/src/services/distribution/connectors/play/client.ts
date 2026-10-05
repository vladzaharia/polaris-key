/**
 * The Google Play API clients (P5-03; notes/E2 §A1, S-07 row 17). Every later Play call goes
 * through `GoogleApiClient` — P6-01's purchase verification and acknowledgement included.
 *
 *   - **Fixed hosts.** Requests go to exactly two origins: the Android Publisher API
 *     (`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/…`,
 *     scope `androidpublisher`) and the Play Developer Reporting API
 *     (`https://playdeveloperreporting.googleapis.com/v1beta1/apps/{packageName}/…`, scope
 *     `playdeveloperreporting`). A path is built from validated segments, never from a string a
 *     manifest, an operator or a response supplied whole; the package name is re-checked against
 *     the Android rule and every other segment is percent-encoded. That is the SSRF control: the
 *     bearer token cannot be sent anywhere else.
 *   - **Token.** `Authorization: Bearer <access token>` from P5-01's `googleAccessToken`
 *     (`core/outletTokens.ts`), passed in as a thunk so the client never sees the service-account
 *     key, only the access token — and only for the one scope this client was built for.
 *   - **429.** Google's quota is 3,000 queries a minute per bucket (notes/E2 §A1 "Quotas"); the
 *     poller is far below it, but a 429 is retried after `Retry-After` (capped), else an
 *     exponential backoff with jitter, at most `maxRetries` times; then `PlayError(429)`.
 *   - **No redirects, bounded bodies.** `redirect: "manual"`, and any 3xx (or opaque redirect)
 *     is a failure (`PlayError` with that status), so the bearer token never reaches a
 *     `Location`. A body is read through `readCappedText` (at most `MAX_RESPONSE_BYTES`); an
 *     oversized body is `PlayError(502)`, the same "unreadable answer" as malformed JSON.
 *   - **Errors carry a status line only** (`PlayError.message`), never a response body: the
 *     message may end up in `outlet_credentials.last_error` and on the connector page.
 *
 * `fetchImpl` and `sleep` are injectable; the tests drive the clients against a fake Google.
 *
 * **The write gate (A-18e).** A client built with `gated: true` (every Android Publisher client
 * the edits workflow uses: P5-03's poll and controls, A-16's lister, the storefront adapter) asks
 * the Play gate (`core/storefront/rules/googlePlay.ts`) about EVERY request before its token thunk
 * runs: a refused request throws `PlayWriteDenied` with no token minted and nothing sent. The one
 * request a gated client sends without the gate is `discardEdit`, `edits.delete` of a throwaway
 * edit (P5-03's discipline: never leave an edit open). It is a `DELETE`, which no gate rule may
 * allow (owner rule: never delete), so it is a fixed method that can address nothing but
 * `edits/<editId>`; it discards an uncommitted draft and removes nothing published. P6-01's
 * purchase client (`commerce/play.ts`) is not gated: it reads purchases and acknowledges them,
 * outside the storefront surface (the gate's `commerceRuntime` deny group).
 */

import type { FetchImpl } from "../../../../core/outletTokens.js";
import { isRedirect, readCappedText } from "../../../../core/readCapped.js";
import { StoreVendorError } from "../../../../core/storefront/errors.js";
import type { GateContext } from "../../../../core/storefront/gate.js";
import {
  checkPlayRequest,
  PLAY_EDIT_SCOPE,
  type PlayGateRequest,
} from "../../../../core/storefront/rules/googlePlay.js";

export type { FetchImpl };

export const ANDROID_PUBLISHER_ORIGIN =
  "https://androidpublisher.googleapis.com";
export const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";
export const PLAY_REPORTING_ORIGIN =
  "https://playdeveloperreporting.googleapis.com";
export const PLAY_REPORTING_SCOPE =
  "https://www.googleapis.com/auth/playdeveloperreporting";

/**
 * The most of one response body read. The edits API answers single small resources (an edit, a
 * track list, a listing) and the Reporting API's `:query` pages are bounded by `pageSize`
 * (`play/vitals.ts`); none is more than tens of KiB in practice. 4 MiB — the Microsoft Store
 * client's cap — only bounds what a misbehaving endpoint could make the isolate buffer.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** An Android package name: it becomes a URL segment, so it is checked here as well. */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * A failed Google call. The message is a status line this module composed. A `StoreVendorError`
 * (A-18e) so the store ledger records it as the store's own answer (`vendor_status`; a 5xx or a
 * network failure after a send is `ambiguous`), with no error token: the body is never read.
 */
export class PlayError extends StoreVendorError {
  constructor(
    status: number,
    readonly method: string,
    readonly label: string,
  ) {
    super(status, null, `Google Play ${method} ${label}: HTTP ${status}`);
    this.name = "PlayError";
  }
}

/** The longest a single 429 retry waits. A cron tick or a console action has a wall clock. */
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

export interface GoogleApiClientOptions {
  /** `ANDROID_PUBLISHER_ORIGIN` or `PLAY_REPORTING_ORIGIN`; nothing else is accepted. */
  origin: typeof ANDROID_PUBLISHER_ORIGIN | typeof PLAY_REPORTING_ORIGIN;
  packageName: string;
  /** The bearer token, minted lazily (once per client). `null` = unusable credential. */
  token: () => Promise<string | null>;
  /** Late-bound to the global `fetch` by default, so a test that swaps it is honoured. */
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  /** 429 retries per request. */
  maxRetries?: number;
  /**
   * Consult the Play write gate before every request (Android Publisher origin only). Every
   * client of the edits workflow is gated; only P6-01's purchase client is not.
   */
  gated?: boolean;
  /** Called once per request actually sent (retries included): the budget meter's spend. */
  onSend?: () => Promise<void>;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Google custom methods a caller may append to its last segment. */
export type GoogleCustomMethod =
  | "commit"
  | "validate"
  | "query"
  | "acknowledge";

/**
 * One authenticated client for one Google API and one app. `request` takes the path BELOW the
 * app (`edits`, `edits/<id>/tracks`, `crashRateMetricSet` + the `query` custom method) as segments; the app prefix is
 * fixed by the constructor.
 */
export class GoogleApiClient {
  /** Requests sent (retries included). */
  calls = 0;
  private tokenValue: Promise<string | null> | null = null;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly prefix: string;

  constructor(private readonly opts: GoogleApiClientOptions) {
    if (
      opts.origin !== ANDROID_PUBLISHER_ORIGIN &&
      opts.origin !== PLAY_REPORTING_ORIGIN
    )
      throw new Error("refusing a Google API origin outside Play");
    if (!PACKAGE_NAME.test(opts.packageName) || opts.packageName.length > 255)
      throw new Error("invalid Android package name");
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? realSleep;
    this.maxRetries = opts.maxRetries ?? 2;
    if (opts.gated && opts.origin !== ANDROID_PUBLISHER_ORIGIN)
      throw new Error("only the Android Publisher client is gated");
    this.prefix =
      opts.origin === ANDROID_PUBLISHER_ORIGIN
        ? `/androidpublisher/v3/applications/${opts.packageName}`
        : `/v1beta1/apps/${opts.packageName}`;
  }

  /** Whether this client consults the Play write gate. */
  get gated(): boolean {
    return this.opts.gated === true;
  }

  /**
   * The gate's view of a request: the unencoded path (`/androidpublisher/v3/applications/<pkg>/…`)
   * and, for a write, its query and body. Throws `PlayWriteDenied` before any token or byte.
   */
  private gate(
    method: Method,
    segments: readonly string[],
    custom: GoogleCustomMethod | undefined,
    req: PlayGateRequest,
    ctx: GateContext | undefined,
  ): void {
    if (!this.opts.gated) return;
    const path = `${this.prefix}/${segments.join("/")}${custom ? `:${custom}` : ""}`;
    checkPlayRequest(
      method,
      path,
      method === "GET" ? undefined : req,
      ctx ?? {},
    );
  }

  /**
   * The URL for `segments` below the app. Every segment is percent-encoded (a track id may hold a
   * space or `:`); a Google custom method (`:commit`, `:query`) is appended only when asked for,
   * so no segment a caller passes can turn into one.
   */
  url(
    segments: readonly string[],
    query?: Record<string, string>,
    custom?: GoogleCustomMethod,
    upload = false,
  ): URL {
    if (segments.length === 0) throw new Error("invalid Google Play path");
    const path = segments.map(encodeSegment).join("/");
    const url = new URL(
      `${upload ? "/upload" : ""}${this.prefix}/${path}${custom ? `:${custom}` : ""}`,
      this.opts.origin,
    );
    for (const [k, v] of Object.entries(query ?? {}))
      url.searchParams.set(k, v);
    return url;
  }

  private async bearer(method: string, label: string): Promise<string> {
    this.tokenValue ??= this.opts.token();
    const token = await this.tokenValue;
    // 401 is what Google would answer without one; the caller's branch is the same.
    if (!token) throw new PlayError(401, method, label);
    return token;
  }

  /** Send one request (with 429 retries). Answers the parsed JSON object, or `null` for an empty
   *  body. `label` names the call in errors (`edits.tracks.list`), never the URL. */
  async request(
    method: Method,
    segments: readonly string[],
    label: string,
    opts: {
      query?: Record<string, string>;
      body?: unknown;
      custom?: GoogleCustomMethod;
      /** What the handler asserts to the gate (a gated client only; never sent). */
      gate?: GateContext;
    } = {},
  ): Promise<Record<string, unknown> | null> {
    // The gate first: a refusal mints no token and sends nothing.
    this.gate(
      method,
      segments,
      opts.custom,
      {
        ...(opts.query && Object.keys(opts.query).length
          ? { query: opts.query }
          : {}),
        ...(opts.body !== undefined ? { json: opts.body } : {}),
      },
      opts.gate,
    );
    return this.send(method, segments, label, opts);
  }

  /**
   * `request` by FULL path (`/androidpublisher/v3/…`, unencoded, a custom method on its last
   * segment), for callers that hold a template-shaped path. The gate sees the path as given, before
   * anything else; only then must it lie below this client's app.
   */
  async requestPath(
    method: Method,
    path: string,
    label: string,
    opts: {
      query?: Record<string, string>;
      body?: unknown;
      gate?: GateContext;
    } = {},
  ): Promise<Record<string, unknown> | null> {
    if (this.opts.gated)
      checkPlayRequest(
        method,
        path,
        method === "GET"
          ? undefined
          : {
              ...(opts.query && Object.keys(opts.query).length
                ? { query: opts.query }
                : {}),
              ...(opts.body !== undefined ? { json: opts.body } : {}),
            },
        opts.gate ?? {},
      );
    if (!path.startsWith(`${this.prefix}/`))
      throw new Error("refusing a request outside Google Play");
    const segments = path.slice(this.prefix.length + 1).split("/");
    const last = segments[segments.length - 1]!;
    const colon = last.lastIndexOf(":");
    // Only a known custom method is one (a track id may hold a colon: `wear:beta`).
    const suffix = colon > 0 ? last.slice(colon + 1) : "";
    const custom = (
      ["commit", "validate", "query", "acknowledge"] as const
    ).find((c) => c === suffix);
    if (custom) segments[segments.length - 1] = last.slice(0, colon);
    return this.send(method, segments, label, {
      ...opts,
      ...(custom ? { custom } : {}),
    });
  }

  /**
   * `edits.delete` of a throwaway edit, outside the gate (see the file comment): a fixed method
   * and a fixed path shape, best effort. Nothing published is removed; an edit already gone
   * (invalidated, expired, committed) is not an error.
   */
  async discardEdit(editId: string): Promise<void> {
    try {
      await this.send("DELETE", ["edits", checkEdit(editId)], "edits.delete");
    } catch (e) {
      if (!(e instanceof PlayError)) throw e;
    }
  }

  /**
   * Upload one listing image's bytes (`edits.images.upload`, simple media upload). The gate sees
   * the descriptor (type and size, from the blob store's record) before the token or a byte.
   */
  async upload(
    segments: readonly string[],
    label: string,
    opts: {
      query?: Record<string, string>;
      contentType: string;
      bytes: Uint8Array;
      gate?: GateContext;
    },
  ): Promise<Record<string, unknown> | null> {
    const query = { ...(opts.query ?? {}), uploadType: "media" };
    this.gate(
      "POST",
      segments,
      undefined,
      {
        query,
        upload: { contentType: opts.contentType, size: opts.bytes.byteLength },
      },
      opts.gate,
    );
    return this.send("POST", segments, label, {
      query,
      raw: { contentType: opts.contentType, bytes: opts.bytes },
      upload: true,
    });
  }

  /** Send one request (with 429 retries), after the gate. */
  private async send(
    method: Method,
    segments: readonly string[],
    label: string,
    opts: {
      query?: Record<string, string>;
      body?: unknown;
      custom?: GoogleCustomMethod;
      raw?: { contentType: string; bytes: Uint8Array };
      upload?: boolean;
    } = {},
  ): Promise<Record<string, unknown> | null> {
    const url = this.url(segments, opts.query, opts.custom, opts.upload);
    // Defence in depth: whatever built the URL, it must still be this API and this app.
    if (
      url.origin !== this.opts.origin ||
      !url.pathname.startsWith(`${opts.upload ? "/upload" : ""}${this.prefix}/`)
    )
      throw new Error("refusing a request outside Google Play");
    const token = await this.bearer(method, label);
    const contentType = opts.raw
      ? opts.raw.contentType
      : opts.body !== undefined
        ? "application/json"
        : null;
    const init: RequestInit = {
      method,
      // A redirect is a failure, never followed: the bearer token must not reach another URL.
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(contentType ? { "content-type": contentType } : {}),
      },
      ...(opts.raw
        ? { body: opts.raw.bytes }
        : opts.body !== undefined
          ? { body: JSON.stringify(opts.body) }
          : {}),
    };
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      await this.opts.onSend?.().catch(() => undefined);
      const res = await this.fetchImpl(url.toString(), init);
      if (res.status === 429 && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.sleep(backoffMillis(res, attempt));
        continue;
      }
      if (!res.ok || isRedirect(res)) {
        await res.body?.cancel().catch(() => undefined);
        throw new PlayError(res.status, method, label);
      }
      let parsed: unknown;
      try {
        const text = await readCappedText(
          res,
          MAX_RESPONSE_BYTES,
          () => new PlayError(502, method, label),
        );
        if (text.trim() === "") return null;
        parsed = JSON.parse(text);
      } catch {
        // Oversized, a broken stream or malformed JSON: one "unreadable answer".
        throw new PlayError(502, method, label);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new PlayError(502, method, label);
      return parsed as Record<string, unknown>;
    }
  }
}

function encodeSegment(s: string): string {
  if (s === "" || s === "." || s === "..")
    throw new Error("invalid Google Play path");
  return encodeURIComponent(s);
}

// ── The Android Publisher edits API ──────────────────────────────────────────────────────────

/** An edit id as Google issues them (digits today); anything else is refused before it becomes a
 *  path segment. */
const EDIT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `changesInReviewBehavior` on every commit: refuse, never cancel a review in flight. */
export const CHANGES_IN_REVIEW_BEHAVIOR = "ERROR_IF_IN_REVIEW";

/**
 * The edits workflow (notes/E2 §A1): every read and every change is ONE edit, opened and closed
 * within one request or tick — `insertEdit` → reads/patch → `commitEdit` or `deleteEdit`. Never
 * hold an edit open between requests: one open edit per user, a new edit invalidates the last,
 * and a Console change or another commit invalidates them all.
 */
export class PlayPublisher {
  constructor(readonly api: GoogleApiClient) {
    // Every edits-workflow client is gated (A-18e): refuse to build one that is not.
    if (!api.gated) throw new Error("the Play edits client must be gated");
  }

  get calls(): number {
    return this.api.calls;
  }

  /** `edits.insert`: a new edit, a copy of the app's live state. Answers its id. */
  async insertEdit(): Promise<string> {
    const doc = await this.api.request("POST", ["edits"], "edits.insert", {
      body: {},
    });
    const id = doc?.id;
    if (typeof id !== "string" || !EDIT_ID.test(id))
      throw new PlayError(502, "POST", "edits.insert");
    return id;
  }

  /** `edits.tracks.list`: every track of the edit, raw. */
  async listTracks(editId: string): Promise<unknown> {
    return this.api.request(
      "GET",
      ["edits", checkEdit(editId), "tracks"],
      "edits.tracks.list",
    );
  }

  /** `edits.tracks.get`: one track of the edit, raw. */
  async getTrack(editId: string, track: string): Promise<unknown> {
    return this.api.request(
      "GET",
      ["edits", checkEdit(editId), "tracks", track],
      "edits.tracks.get",
    );
  }

  /**
   * `edits.tracks.patch`: replace one track's releases in the edit. `gate` is what the caller
   * asserts (P5-03's controls: `PLAY_ROLLOUT_CONTROL`; a completed production release otherwise
   * needs `typedConfirmation`).
   */
  async patchTrack(
    editId: string,
    track: string,
    body: { track: string; releases: unknown[] },
    gate: GateContext = {},
  ): Promise<unknown> {
    return this.api.request(
      "PATCH",
      ["edits", checkEdit(editId), "tracks", track],
      "edits.tracks.patch",
      { body, gate },
    );
  }

  /**
   * `edits.commit` with `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (and `changesNotSentForReview`
   * when staging only). `gate` says what the edit holds (`PLAY_EDIT_SCOPE`); without a plain scope
   * the gate requires `typedConfirmation`.
   */
  async commitEdit(
    editId: string,
    gate: GateContext = {},
    opts: { changesNotSentForReview?: boolean } = {},
  ): Promise<void> {
    await this.api.request(
      "POST",
      ["edits", checkEdit(editId)],
      "edits.commit",
      {
        query: {
          changesInReviewBehavior: CHANGES_IN_REVIEW_BEHAVIOR,
          ...(opts.changesNotSentForReview
            ? { changesNotSentForReview: "true" }
            : {}),
        },
        custom: "commit",
        gate,
      },
    );
  }

  /** `edits.validate`: Google's check of the edit, nothing changes. */
  async validateEdit(editId: string): Promise<void> {
    await this.api.request(
      "POST",
      ["edits", checkEdit(editId)],
      "edits.validate",
      { custom: "validate" },
    );
  }

  /** `edits.delete`, best effort and outside the gate (`GoogleApiClient.discardEdit`): an edit that
   *  is already gone (invalidated, expired, committed) is not an error — the point was only not to
   *  leave one open. */
  async deleteEdit(editId: string): Promise<void> {
    await this.api.discardEdit(editId);
  }
}

/** What P5-03's rollout controls assert to the gate (see `rules/googlePlay.ts`). */
export const PLAY_ROLLOUT_CONTROL: GateContext = {
  resourceState: PLAY_EDIT_SCOPE.rolloutControl,
};

function checkEdit(editId: string): string {
  if (!EDIT_ID.test(editId)) throw new Error("invalid Play edit id");
  return editId;
}
