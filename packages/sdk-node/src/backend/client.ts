// `client.backend` — the client half of a product backend (WIRE-CONTRACT-V4 §14, framework
// drop-ins §6). It sends the app's signed licence document to the app's own backend:
//
//   X-PKey-License   the compact licence JWS, when one is held
//   X-PKey-Device    this device's id
//
// Never the device token, never the config document. `fetch()` refuses any origin outside
// `backend.origins` (exact, HTTPS except loopback) with `backend-origin-not-allowed`, and a
// redirect to one too: a custom header would otherwise ride the redirect. `headers()` is raw: the
// caller decides where it goes. The refresh-and-retry rule is client-core's `clientBackendAction`
// (the reference `backend-matrix.json`'s `client` section pins): refresh a document within
// REFRESH_MARGIN_SECONDS of expiry before sending, force-sync and retry once on `license_stale` or
// `license_invalid`, never retry `not_entitled` or `sign_in_required` (they throw, typed).
// Concurrent callers share one sync. The developer's own `Authorization` passes through.

import { clientBackendAction } from "@polaris-key/client-core/backend";
import { PolarisError } from "@polaris-key/client-core";
import { HEADER_DEVICE, HEADER_LICENSE } from "@polaris-key/protocol/core";
import { ErrorCode } from "../constants.generated.js";
import { copy } from "../core/copy.js";
import type { SyncResult } from "../core/sync.js";

/** `backend.origins` and the transport. */
export interface BackendClientOptions {
  /** The origins `fetch()` may send the licence to: exact (`https://api.example.com`), HTTPS only
   *  except loopback. A path, query, userinfo or wildcard is refused (`invalid-options`). */
  origins?: readonly string[];
}

/** What the backend client reads off its client. */
export interface BackendDeps {
  /** The held licence document's compact JWS and times, or null. */
  held(): { jws: string; issuedAt: number; expiresAt: number } | null;
  deviceId(): string;
  /** The effective time (the clock floor applied), epoch seconds. */
  now(): number;
  sync(opts: { force: boolean }): Promise<SyncResult>;
  /** The bare transport (no Polaris redirect policy: this one follows its own). */
  fetcher(): typeof fetch;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** One exact origin, or a thrown `invalid-options`. */
export function normalizeBackendOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw invalid(origin);
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
  if (!plain || !secure || origin.includes("*")) throw invalid(origin);
  return url.origin;
}

const invalid = (origin: string): PolarisError =>
  new PolarisError(
    ErrorCode.invalidOptions,
    `backend.origins: ${JSON.stringify(origin)} is not an exact origin (https://host[:port]; http only on loopback).`,
  );

const FORBIDDEN = (url: string): PolarisError =>
  new PolarisError(
    ErrorCode.backendOriginNotAllowed,
    copy.message(ErrorCode.backendOriginNotAllowed, new URL(url).origin),
  );

export class BackendClient {
  private readonly allowed: ReadonlySet<string>;
  private inflight: { force: boolean; promise: Promise<boolean> } | null = null;

  constructor(
    private readonly deps: BackendDeps,
    options: BackendClientOptions = {},
  ) {
    this.allowed = new Set((options.origins ?? []).map(normalizeBackendOrigin));
  }

  /** The configured origins, normalised. */
  get origins(): string[] {
    return [...this.allowed];
  }

  /**
   * The two headers, raw. A document within the refresh margin of its expiry is synced first.
   * Without a licence only `X-PKey-Device` is returned.
   */
  async headers(): Promise<Record<string, string>> {
    await this.freshen();
    return this.build();
  }

  /**
   * `fetch()` to an allowed origin with the headers attached, the freshness pre-sync and one
   * retry on `license_stale` / `license_invalid`. Throws `backend-origin-not-allowed` (before
   * anything is sent), and `not_entitled` / `sign_in_required` as a `PolarisError` with the
   * response status. Any other answer, a failed retry's included, is returned as it came.
   */
  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const base = new Request(input, init);
    this.assertAllowed(base.url);
    let retried = false;
    for (;;) {
      await this.freshen();
      const res = await this.roundTrip(base);
      const code = await problemCode(res);
      const held = this.deps.held();
      const action = clientBackendAction({
        document: held
          ? { issuedAt: held.issuedAt, expiresAt: held.expiresAt }
          : null,
        now: this.deps.now(),
        response: { status: res.status, code },
        retried,
      });
      if (action === "refresh-and-retry") {
        retried = true;
        // A failed sync (offline, a 401 from the Worker) hands back the backend's answer.
        if (!(await this.shared(true))) return res;
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      if (
        res.status === 403 &&
        (code === ErrorCode.notEntitled || code === ErrorCode.signInRequired)
      )
        throw new PolarisError(code, copy.message(code), {
          status: res.status,
        });
      return res;
    }
  }

  private build(): Record<string, string> {
    const held = this.deps.held();
    return {
      ...(held ? { [HEADER_LICENSE]: held.jws } : {}),
      [HEADER_DEVICE]: this.deps.deviceId(),
    };
  }

  private async freshen(): Promise<void> {
    const held = this.deps.held();
    const action = clientBackendAction({
      document: held
        ? { issuedAt: held.issuedAt, expiresAt: held.expiresAt }
        : null,
      now: this.deps.now(),
      response: null,
    });
    if (action === "refresh-then-send") await this.shared(false);
  }

  /** One sync for every concurrent caller; a forced caller joins only a forced one. True when
   *  the licence document is now current (applied or unchanged). */
  private shared(force: boolean): Promise<boolean> {
    const live = this.inflight;
    if (live && (live.force || !force)) return live.promise;
    const promise = this.deps
      .sync({ force })
      .then(
        (r) =>
          r.documents.license?.kind === "applied" ||
          r.documents.license?.kind === "unchanged",
        () => false,
      )
      .finally(() => {
        if (this.inflight?.promise === promise) this.inflight = null;
      });
    this.inflight = { force, promise };
    return promise;
  }

  private assertAllowed(url: string): void {
    if (!this.allowed.has(new URL(url).origin)) throw FORBIDDEN(url);
  }

  /** One request, following redirects by hand so each hop is checked against the origins. */
  private async roundTrip(base: Request): Promise<Response> {
    const fetchImpl = this.deps.fetcher();
    let url = base.url;
    let method = base.method;
    let withBody = base.body !== null;
    for (let hop = 0; ; hop++) {
      this.assertAllowed(url);
      const headers = new Headers(base.headers);
      for (const [k, v] of Object.entries(this.build())) headers.set(k, v);
      const init: RequestInit & { duplex?: "half" } = {
        method,
        headers,
        redirect: "manual",
        signal: base.signal,
      };
      if (withBody) {
        init.body = base.clone().body;
        init.duplex = "half";
      }
      const res = await fetchImpl(url, init);
      const location = res.headers.get("location");
      if (
        !REDIRECTS.has(res.status) ||
        location === null ||
        hop >= MAX_REDIRECTS
      )
        return res;
      url = new URL(location, url).href;
      // 303 becomes a GET; 301 and 302 turn a POST into one; 307 and 308 replay as they were.
      const toGet =
        res.status === 303
          ? method !== "HEAD"
          : (res.status === 301 || res.status === 302) && method === "POST";
      if (toGet) {
        method = "GET";
        withBody = false;
      }
    }
  }
}

/** The problem body's `code` on a 401 or 403, else null. The response stays readable. */
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
