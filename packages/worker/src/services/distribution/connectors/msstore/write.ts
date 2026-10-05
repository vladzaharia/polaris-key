/**
 * THE MICROSOFT STORE WRITE CLIENT (A-18f; notes/S-15 §4.2, §6.2). The only path by which the
 * Worker changes anything at Microsoft. P5-04's `client.ts` stays GET-only for the poller; this
 * client is a separate class with its own gate, so the poller cannot write by accident.
 *
 *   - **Gate first.** Every request, reads included, is checked by the Microsoft Store rule table
 *     (`core/storefront/rules/microsoftStore.ts`) BEFORE either token thunk runs: a refused
 *     request throws `MsStoreWriteDenied`, mints no token and sends nothing.
 *   - **Two APIs, two tokens, fixed hosts.** The path picks the API: `/v1.0/my/…` goes to
 *     `https://manage.devcenter.microsoft.com` with the classic token (Entra v1,
 *     `resource=https://manage.devcenter.microsoft.com`); `/submission/v1/product/…` goes to
 *     `https://api.store.microsoft.com` with the MSI/EXE token (Entra v2.0,
 *     `scope=https://api.store.microsoft.com/.default`) and `X-Seller-Account-Id`. A path the gate
 *     admits has only plain segments, and the final URL's origin and path are re-checked.
 *   - **What is sent is what the gate checked.** The rule's `send` decides: a JSON body; the
 *     checked object as query parameters (the rollout percentage); or nothing (commit, submit).
 *   - **Budget.** A 429 (or a 503 with `Retry-After`) is retried after `Retry-After` (capped) at
 *     most `maxRetries` times, then reported to `onRateStop` (the budget meter's `retry-after`
 *     stop, `core/storefront/budget.ts`) and thrown as `StoreVendorError(429)`. Otherwise the
 *     client self-throttles: at least `minIntervalMs` between two sends (S-15 §4.2: the classic
 *     API documents no limit).
 *   - **No redirects, bounded bodies, no body in an error.** `redirect: "manual"` and any 3xx is a
 *     failure; bodies are read through `readCappedText`; a failure is a `StoreVendorError` with
 *     the HTTP status and Microsoft's error code when it sent an enum-like one, never its message.
 *   - **SAS uploads** (`uploadToSas`): listing images only (decision 2), PUT to the Azure Blob SAS
 *     URL Microsoft returned (`fileUploadUrl`, `listings/assets/create`), on
 *     `*.blob.core.windows.net` only, with no Authorization header. The URL carries a signature,
 *     so it is never logged, stored or echoed in an error.
 */

import type { FetchImpl } from "../../../../core/outletTokens.js";
import { isRedirect, readCappedText } from "../../../../core/readCapped.js";
import type { GateContext } from "../../../../core/storefront/gate.js";
import { StoreVendorError } from "../../../../core/storefront/errors.js";
import type { StoreResource } from "../../../../core/storefront/audit.js";
import {
  MICROSOFT_STORE_COMPILED_GATE,
  msStoreApiOf,
  type MsStoreRule,
} from "../../../../core/storefront/rules/microsoftStore.js";
import { STORE_API_ORIGIN } from "./client.js";

export const CLASSIC_API_ORIGIN = STORE_API_ORIGIN;
export const MSI_API_ORIGIN = "https://api.store.microsoft.com";

/** The most of one response body read. */
export const MAX_WRITE_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The most of one SAS upload (a ZIP of listing images, or one image). */
export const MAX_SAS_BYTES = 64 * 1024 * 1024;
const MAX_BACKOFF_MS = 30_000;

/** A GET query value: tokens and comma lists only (`languages=en-us,de-de`, `top=100`). */
const QUERY_VALUE = /^[A-Za-z0-9,_.-]{1,200}$/;
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
/** An error code Microsoft sends (`InvalidParameterValue`, `ResourceNotFound`). */
const VENDOR_CODE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const SELLER = /^[A-Za-z0-9-]{1,64}$/;

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface MsStoreWriteOptions {
  /** The classic API token, minted lazily (once per client). `null` = unusable credential. */
  classicToken: () => Promise<string | null>;
  /** The MSI/EXE API token, minted lazily (once per client). */
  msiToken: () => Promise<string | null>;
  /** The seller id for `X-Seller-Account-Id` (MSI/EXE only); from the credential's metadata. */
  sellerId: string | null;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds now (for the self-throttle). */
  clock?: () => number;
  maxRetries?: number;
  /** The least time between two sends (default 250 ms). */
  minIntervalMs?: number;
  /** Microsoft asked the Worker to wait (`Retry-After`, seconds), after the retries ran out. */
  onRateStop?: (seconds: number | undefined) => Promise<void>;
}

/** `Retry-After` in seconds, or undefined. */
export function retryAfterSeconds(res: Response): number | undefined {
  const v = res.headers.get("Retry-After");
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Microsoft's error code from a failure body, when it is an enum-like token. */
function vendorCode(text: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const candidates = [
    d.code,
    Array.isArray(d.errors)
      ? (d.errors[0] as Record<string, unknown> | undefined)?.code
      : undefined,
    (d.error as Record<string, unknown> | undefined)?.code,
  ];
  for (const c of candidates)
    if (typeof c === "string" && VENDOR_CODE.test(c)) return c;
  return null;
}

export class MsStoreWriteClient {
  /** Requests sent (retries included). */
  calls = 0;
  private classicTokenValue: Promise<string | null> | null = null;
  private msiTokenValue: Promise<string | null> | null = null;
  private lastSend = -Infinity;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;

  constructor(private readonly opts: MsStoreWriteOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? realSleep;
    this.clock = opts.clock ?? (() => Date.now());
    this.maxRetries = opts.maxRetries ?? 2;
    this.minIntervalMs = opts.minIntervalMs ?? 250;
  }

  /**
   * One gated request. `body` is what the gate checks: the JSON body, the query of a
   * `send: "query"` rule, or nothing (a bodiless write is checked as `{}`). `query` is for reads
   * only. Answers the parsed JSON object, or null for an empty answer.
   */
  async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    ctx: GateContext = {},
    query?: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown> | null> {
    const gate = MICROSOFT_STORE_COMPILED_GATE;
    const checked = method === "GET" ? body : (body ?? {});
    // THE GATE, before any token: throws MsStoreWriteDenied.
    const rule = gate.check(method, path, checked, ctx);
    if (method !== "GET" && query)
      throw new Error("a Microsoft Store write takes no extra query");
    const api = msStoreApiOf(path);
    if (!api) throw new Error("unreachable: the gate admitted an unknown path");
    const origin = api === "classic" ? CLASSIC_API_ORIGIN : MSI_API_ORIGIN;
    const url = new URL(path, origin);
    if (url.origin !== origin || url.pathname !== path)
      throw new Error("refusing a request outside the Microsoft Store APIs");
    for (const [k, v] of Object.entries(query ?? {})) {
      if (!QUERY_KEY.test(k) || !QUERY_VALUE.test(v))
        throw new Error("invalid Microsoft Store query");
      url.searchParams.set(k, v);
    }
    const send = rule?.send ?? "none";
    const init = await this.init(method, api, send, rule, checked, url);
    return this.send(method, rule?.path ?? path, url, init);
  }

  private async init(
    method: string,
    api: "classic" | "msi",
    send: MsStoreRule["send"],
    rule: MsStoreRule | null,
    checked: unknown,
    url: URL,
  ): Promise<RequestInit> {
    let token: string | null;
    const headers: Record<string, string> = { accept: "application/json" };
    if (api === "classic") {
      this.classicTokenValue ??= this.opts.classicToken();
      token = await this.classicTokenValue;
    } else {
      if (!this.opts.sellerId || !SELLER.test(this.opts.sellerId))
        throw new StoreVendorError(
          401,
          "seller_id_missing",
          "Microsoft Store: no seller id",
        );
      this.msiTokenValue ??= this.opts.msiToken();
      token = await this.msiTokenValue;
      headers["x-seller-account-id"] = this.opts.sellerId;
    }
    if (!token)
      throw new StoreVendorError(
        401,
        null,
        `Microsoft Store ${method}: no token`,
      );
    headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method, redirect: "manual", headers };
    if (rule && send === "json") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(checked);
    } else if (rule && send === "query") {
      for (const [k, v] of Object.entries(checked as Record<string, unknown>))
        url.searchParams.set(k, String(v));
    }
    return init;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastSend + this.minIntervalMs - this.clock();
    if (wait > 0) await this.sleep(wait);
    this.lastSend = this.clock();
  }

  private async send(
    method: string,
    label: string,
    url: URL,
    init: RequestInit,
  ): Promise<Record<string, unknown> | null> {
    const what = `Microsoft Store ${method} ${label}`;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      this.calls++;
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), init);
      } catch {
        throw new StoreVendorError(0, null, `${what}: network failure`);
      }
      const retryAfter = retryAfterSeconds(res);
      if (
        res.status === 429 ||
        (res.status === 503 && retryAfter !== undefined)
      ) {
        await res.body?.cancel();
        if (attempt < this.maxRetries) {
          await this.sleep(
            Math.min((retryAfter ?? 2 ** attempt) * 1000, MAX_BACKOFF_MS),
          );
          continue;
        }
        await this.opts.onRateStop?.(retryAfter);
        throw new StoreVendorError(
          429,
          "rate_limited",
          `${what}: HTTP ${res.status}`,
        );
      }
      if (isRedirect(res)) {
        await res.body?.cancel();
        throw new StoreVendorError(
          res.status,
          null,
          `${what}: redirect refused`,
        );
      }
      let text: string;
      try {
        text = await readCappedText(
          res,
          MAX_WRITE_RESPONSE_BYTES,
          () => new StoreVendorError(502, null, `${what}: answer too large`),
        );
      } catch (e) {
        if (e instanceof StoreVendorError) throw e;
        throw new StoreVendorError(0, null, `${what}: read failed`);
      }
      if (!res.ok)
        throw new StoreVendorError(
          res.status,
          vendorCode(text),
          `${what}: HTTP ${res.status}`,
        );
      if (text.trim() === "") return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new StoreVendorError(502, null, `${what}: answer is not JSON`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new StoreVendorError(
          502,
          null,
          `${what}: answer is not an object`,
        );
      const doc = parsed as Record<string, unknown>;
      // The MSI/EXE API answers 200 with `isSuccess: false` for a refused change.
      if (doc.isSuccess === false)
        throw new StoreVendorError(
          422,
          vendorCode(text),
          `${what}: not successful`,
        );
      return doc;
    }
  }

  /**
   * PUT bytes to an Azure Blob SAS URL Microsoft returned (listing images only). Not a Store API
   * call and not gated by the rule table: the host is fixed to `*.blob.core.windows.net`, no
   * bearer token is sent, and the URL (it carries a signature) is never put in an error.
   */
  async uploadToSas(
    sasUrl: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    if (!isSasUrl(sasUrl))
      throw new Error("refusing an upload outside Azure Blob storage");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SAS_BYTES)
      throw new Error("SAS upload size out of range");
    if (!/^[a-z]+\/[a-z0-9.+-]{1,64}$/.test(contentType))
      throw new Error("invalid SAS upload content type");
    await this.throttle();
    this.calls++;
    let res: Response;
    try {
      res = await this.fetchImpl(sasUrl, {
        method: "PUT",
        redirect: "manual",
        headers: { "x-ms-blob-type": "BlockBlob", "content-type": contentType },
        body: bytes,
      });
    } catch {
      throw new StoreVendorError(
        0,
        null,
        "Microsoft Store SAS upload: network failure",
      );
    }
    await res.body?.cancel();
    if (!res.ok || isRedirect(res))
      throw new StoreVendorError(
        res.status,
        null,
        `Microsoft Store SAS upload: HTTP ${res.status}`,
      );
  }
}

/** An Azure Blob SAS URL: https, `*.blob.core.windows.net`, no credentials, port or fragment. */
export function isSasUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 4096) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    /^[a-z0-9-]{1,63}\.blob\.core\.windows\.net$/.test(u.hostname) &&
    u.username === "" &&
    u.password === "" &&
    u.port === "" &&
    u.hash === ""
  );
}

// ── Resources for the ledger and audit (`core/storefront/audit.ts`) ─────────────────────────

const pick = (
  o: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

/** The MSI/EXE envelope's `responseData`, or the document itself. */
export function msiData(
  doc: Record<string, unknown> | null,
): Record<string, unknown> {
  const d = doc?.responseData;
  return d && typeof d === "object" && !Array.isArray(d)
    ? (d as Record<string, unknown>)
    : (doc ?? {});
}

/** An application as a resource (`primaryName` is the typed-confirmation phrase). */
export function applicationResource(
  raw: Record<string, unknown>,
): StoreResource | null {
  if (typeof raw.id !== "string") return null;
  return {
    type: "applications",
    id: raw.id,
    attributes: pick(raw, [
      "primaryName",
      "packageIdentityName",
      "firstPublishedDate",
    ]),
  };
}

/**
 * A classic (or flight) submission as a resource. `fileUploadUrl` (a writable SAS URI) and
 * `statusDetails` (certification report URLs carry tokens) are DROPPED here, before anything can
 * reach the ledger or an audit row.
 */
export function submissionResource(
  raw: Record<string, unknown>,
  type: "submissions" | "flightSubmissions" = "submissions",
): StoreResource | null {
  if (typeof raw.id !== "string") return null;
  const pricing = raw.pricing as Record<string, unknown> | undefined;
  return {
    type,
    id: raw.id,
    attributes: {
      ...pick(raw, [
        "status",
        "friendlyName",
        "applicationCategory",
        "visibility",
        "targetPublishMode",
      ]),
      ...(typeof pricing?.priceId === "string"
        ? { priceId: pricing.priceId }
        : {}),
    },
  };
}

/** The certification reports' dates only: their `reportUrl`s carry tokens and are never kept. */
export function certificationReportDates(
  raw: Record<string, unknown>,
): string[] {
  const reports = (raw.statusDetails as Record<string, unknown> | undefined)
    ?.certificationReports;
  if (!Array.isArray(reports)) return [];
  return reports
    .map((r) => (r as Record<string, unknown>)?.date)
    .filter((d): d is string => typeof d === "string")
    .map((d) => d.slice(0, 40));
}
