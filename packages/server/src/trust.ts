// A backend's trust set for one product (WIRE-CONTRACT-V4 §14.4): the pins from its
// configuration plus the keys of the last trust manifest it verified. The manifest verifies
// against the pins only (§1), a failed fetch keeps the last verified set, and the pins always
// verify, so an outage of Polaris Key never refuses a document a pinned key signed.
//
// There are no timers: the 900 s refresh is checked when a request arrives, so the core runs on
// Workers, which allow none at module scope. An unknown `kid` fetches at most once every 60 s,
// so junk headers cannot be amplified into requests to Polaris Key.

import type { TrustSet } from "@polaris-key/jws";
import {
  jwsHeaderKid,
  mergeTrust,
  trustSignerOrder,
  usablePins,
  verifyTrustManifest,
} from "@polaris-key/client-core/trust";
import {
  BACKEND_TRUST_REFRESH_SECONDS,
  HEADER_SDK_NAME,
} from "@polaris-key/protocol/core";

/** An unknown `kid` fetches at most once in this many seconds (§14.4). */
export const UNKNOWN_KID_FETCH_SECONDS = 60;
/** The trust fetch's `X-PKey-SDK` (§14.4, §8): a server sighting on the Integration page. */
export const SERVER_SDK_ID = "node-server";
const FETCH_TIMEOUT_MS = 5000;
/** The largest trust manifest read, in bytes. A signed document is capped at 64 KiB before
 *  encoding (§3), so 128 KiB of compact JWS is generous; a larger body is dropped unread. */
export const MAX_MANIFEST_BYTES = 131072;

/** The body of `res` as text, or null when it is longer than `limit` bytes. */
async function readBounded(
  res: Response,
  limit: number,
): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) {
    const text = await res.text();
    return utf8Length(text) > limit ? null : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

export interface ProductTrustOptions {
  product: string;
  /** The Polaris Key origin, without a trailing slash. */
  baseUrl: string;
  pinned: TrustSet;
  /** False: run on the pins alone (an air-gapped server). */
  refresh: boolean;
  fetch: typeof fetch;
  /** Epoch seconds. */
  now: () => number;
  /** Keep a background refresh alive after the response (Workers' `ctx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Called whenever the effective set changes. */
  onChange: () => void;
  debug?: (line: string) => void;
}

export class ProductTrust {
  readonly product: string;
  private readonly o: ProductTrustOptions;
  private discovered: TrustSet = {};
  private tombstones = new Set<string>();
  private lastIssuedAt: number | undefined;
  private lastAttemptAt: number | null = null;
  private inflight: Promise<void> | null = null;
  private effective: TrustSet;

  constructor(options: ProductTrustOptions) {
    this.o = options;
    this.product = options.product;
    this.effective = this.compute();
    if (options.refresh) this.start();
  }

  /** The keys that verify a document for this product: pins win over the manifest's keys. */
  get set(): TrustSet {
    return this.effective;
  }

  has(kid: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.effective, kid);
  }

  /** The 900 s refresh, started in the background when due. Never awaited by a request. */
  refreshIfDue(): void {
    if (!this.o.refresh || this.inflight) return;
    const at = this.lastAttemptAt;
    if (at !== null && this.o.now() - at < BACKEND_TRUST_REFRESH_SECONDS)
      return;
    this.start();
  }

  /**
   * An unknown `kid`: wait for a fetch already running, or start one when the last attempt is at
   * least 60 s old. Resolves once the set is as fresh as that allows; never rejects.
   */
  async refreshForUnknownKid(): Promise<void> {
    if (!this.o.refresh) return;
    if (this.inflight) return this.inflight;
    const at = this.lastAttemptAt;
    if (at !== null && this.o.now() - at < UNKNOWN_KID_FETCH_SECONDS) return;
    return this.start();
  }

  private start(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastAttemptAt = this.o.now();
    const run = this.fetchAndInstall()
      .catch(() => {
        // A failed fetch keeps the last verified set (§14.4).
        this.o.debug?.(`trust: fetch failed for ${this.product}`);
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = run;
    this.o.waitUntil?.(run);
    return run;
  }

  private compute(): TrustSet {
    return mergeTrust(
      usablePins(this.o.pinned, this.tombstones),
      this.discovered,
    );
  }

  private async fetchManifest(signer: string | null): Promise<string | null> {
    const path =
      signer === null
        ? ".well-known/polaris-trust.jws"
        : `.well-known/polaris-trust.jws?signer=${encodeURIComponent(signer)}`;
    const res = await this.o.fetch(
      `${this.o.baseUrl}/${encodeURIComponent(this.product)}/${path}`,
      {
        headers: {
          accept: "application/jose",
          [HEADER_SDK_NAME]: SERVER_SDK_ID,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "error",
      },
    );
    return res.ok ? readBounded(res, MAX_MANIFEST_BYTES) : null;
  }

  private async fetchAndInstall(): Promise<void> {
    const first = await this.fetchManifest(null);
    if (first === null) return;
    const verify = (jws: string) =>
      verifyTrustManifest(jws, {
        pinned: this.o.pinned,
        tombstones: [...this.tombstones],
        expectedAud: this.product,
        now: this.o.now(),
        lastTrustIssuedAt: this.lastIssuedAt,
      });
    let result = await verify(first);
    if (!result.doc) {
      // §2.3: the default manifest's signer is not a usable pin: ask for the manifest each
      // pin signed.
      const usable = usablePins(this.o.pinned, this.tombstones);
      for (const signer of trustSignerOrder(usable, jwsHeaderKid(first))) {
        const retry = await this.fetchManifest(signer);
        if (retry === null) continue;
        const r = await verify(retry);
        if (r.doc) {
          result = r;
          break;
        }
      }
    }
    if (!result.doc) return;
    const before = JSON.stringify([Object.entries(this.effective).sort()]);
    this.discovered = result.discovered;
    this.lastIssuedAt = result.doc.issuedAt;
    for (const kid of result.revokedPins) this.tombstones.add(kid);
    this.effective = this.compute();
    if (JSON.stringify([Object.entries(this.effective).sort()]) !== before)
      this.o.onChange();
  }
}
