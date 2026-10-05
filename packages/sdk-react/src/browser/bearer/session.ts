// Bearer mode's engine (SDK-PARITY-PASS §3.17): the device-token client a browser page runs when
// it cannot use the Worker's first-party cookie session — a page on its own origin, a Tauri
// webview, a TV or kiosk browser. Every route it calls is CORS-covered for the product's
// `web.origins` (`build/web-cors.md`); none sets or reads a cookie.
//
// It is `@polaris-key/node`'s Core loop, ported route for route and rule for rule, because the
// HTTP transcripts (`conformance/transcripts/`) hold both to the same conversation:
//
//   register()        POST /<p>/devices/register — the keyless mint, never with a bearer
//   activate(key)     POST /<p>/license/activate — the key as the bearer; §3.1's typed outcome
//   enroll()          POST /<p>/license/enroll
//   sync()            trust manifest → license + config documents in parallel (ETag/304, the
//                     half-life re-ask, the ONE re-acquire per pass) → one cache write →
//                     best-effort report
//   deactivate()      POST /<p>/license/deauthorize, best-effort; then the local wipe
//   devices.*         GET /<p>/devices, PATCH/DELETE /<p>/devices/:id, POST /<p>/devices/report
//   mint(recipe)      GET /<p>/config/mint/<recipe>/token, memory-cached per device token
//   signIn*           POST /<p>/identity/auth/device/{start,poll} (RFC 8628)
//   commerce*         GET /<p>/distribution/commerce/binding, POST …/claim
//
// What is persisted is client-core's `Store` contract (`./store.ts`): the token, the random device
// id, and a `CacheRecordV3` of SIGNED ARTIFACTS ONLY, re-verified against the pinned keys on every
// load — so editing IndexedDB by hand can delete an activation but never invent one.
//
// A browser has no hardware fingerprint (`devices.fingerprint` is a web N/A): `fingerprint`
// answers null by default and the register request then carries no body, as Godot's web export
// sends. The seam exists for the transcript replayer, which records a host that has one.

import {
  CACHE_VERSION,
  REFRESH_MARGIN_SECONDS,
  channelForVersion,
  effectiveNow,
  mergeTrust,
  verifyConfigDoc,
  verifyLicenseDoc,
  verifyTrustManifest,
  type BlockedState,
  type CacheRecordV3,
  type Store,
} from "@polaris-key/client-core";
import type { PackInstallReport } from "@polaris-key/client-core/packs";
import {
  HEADER_ARCH,
  HEADER_CHANNEL,
  HEADER_DEVICE,
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_VERSION,
  type HardwareFingerprint,
  type JSONValue,
} from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type {
  AllowedRange,
  BlockReason,
  LicenseDoc,
} from "@polaris-key/protocol/license";
import {
  ERROR_CODE_VALUES,
  Platform,
  SdkId,
} from "../../constants.generated.js";
import { SDK_VERSION } from "../../version.js";
import {
  classifyActivation,
  networkOutcome,
  type ActivationOutcome,
} from "../../core/activation.js";
import { PolarisError, type PolarisErrorCode } from "../../core/types.js";
import type { BridgeState } from "../../desktop/bridge.js";
import type { ServiceSlug } from "../../core/services.js";
import type { TrustSet } from "../offline.js";

/** How the current token was obtained, which picks the §5 re-acquire route (as Node). */
export type TokenSource =
  | "activate"
  | "enroll"
  | "register"
  | "signin"
  | "reacquire";

export type DocOutcome =
  | { kind: "applied" }
  | { kind: "unchanged" }
  | { kind: "unauthorized" }
  | { kind: "blocked"; blocked: BlockedState }
  | { kind: "device-cap"; limit?: number; deviceCount?: number }
  | { kind: "skipped" }
  | { kind: "error" };

/** `@polaris-key/node`'s `SyncResult`, field for field. */
export interface SyncResult {
  applied: boolean;
  unauthorized?: boolean;
  blocked?: boolean;
  deviceCap?: boolean;
  documents: { license?: DocOutcome; config?: DocOutcome };
}

export type RegisterResult =
  | { kind: "ok"; token: string; deviceId: string }
  | { kind: "registration-closed" }
  | { kind: "rate-limited" }
  | { kind: "not-configured" }
  | { kind: "error"; message: string };

/** One device as `GET /<p>/devices` reports it. */
export interface AccountDevice {
  id: string;
  licenseId?: string;
  label?: string | null;
  status: string;
  current: boolean;
  firstSeen?: number;
  lastSeen?: number;
  platform?: string | null;
  arch?: string | null;
  appVersion?: string | null;
  sdkName?: string | null;
  sdkVersion?: string | null;
}

/** What `beginSignIn` returns. `deviceCode` is the poll credential: never shown. */
export interface SignInPrompt {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
  /** `beginSignIn`'s clock plus `expiresIn`, epoch seconds. */
  expiresAt: number;
}

export type SignInPoll =
  | { status: "pending" }
  | { status: "slow-down"; interval: number }
  /** Signed in: the token is stored and the post-acquisition sync has run. `identity` is the
   *  signed-in identity the server named, when it did (§3.12). */
  | { status: "ready"; identity?: { name?: string; email?: string } }
  | { status: "expired" }
  | { status: "error"; message: string };

export type SignInResult = Exclude<
  SignInPoll,
  { status: "pending" } | { status: "slow-down" }
>;

/** A minted third-party token. Memory only; never persisted. */
export interface MintedToken {
  token: string;
  expiresAt: number;
}

/** One store product the licence's commerce binding sells. */
export interface CommerceProduct {
  store: string;
  productId: string;
  flag: string;
  deliverable: string;
}

/** `GET /<p>/distribution/commerce/binding`. Hand `bindingId` to the store before buying. */
export interface CommerceBinding {
  bindingId: string;
  products: CommerceProduct[];
}

/** SDK-PARITY-PASS §3.9's `ClaimResult`. On `ok`, sync to receive the flag. */
export type ClaimResult =
  | {
      kind: "ok";
      store: string;
      productId: string;
      flag: string;
      deliverable: string;
      state: string;
      granted: boolean;
      changed: boolean;
    }
  | { kind: "notOwned"; code: string; reason: string; status: number }
  | { kind: "attestationRequired"; code: string; status: number }
  | { kind: "refused"; code: string; reason?: string; status: number };

/** The store payloads a claim forwards (P6-01). */
export type ClaimPayload =
  | { signedTransaction: string }
  | { productId: string; purchaseToken: string }
  | { ticket: string; dlcAppId: string | number };

/** A P6-03 update-health event, the Worker's `UpdateEventEntry` (`core/updateHealth.ts`). */
export interface UpdateEventEntry {
  eventId: string;
  event:
    | "update_offered"
    | "update_downloaded"
    | "update_applied"
    | "update_confirmed"
    | "update_reverted"
    | "pack_failed"
    | "boot_rolled_back";
  deliverable: string;
  release: string;
  fromRelease?: string;
  outlet: string;
  channel: string;
  packSetId?: string;
  at: number;
  code?: string;
}

/** At most this many update events go in one report; the rest wait (§3.13). */
export const MAX_REPORT_UPDATES = 16;
/** A cached mint is reused until this many seconds before its `expiresAt` (as Node). */
export const MINT_REUSE_MARGIN_SECONDS = 30;
/** The router's recipe-id alphabet. */
export const MINT_ID = /^[a-z0-9-]+$/;
/** RFC 8628 §3.5: an interval-less `slow_down` adds this to the current interval. */
export const SLOW_DOWN_STEP_SECONDS = 5;

export interface BearerSessionOptions {
  baseUrl: string;
  product: string;
  /** The host app's version (`X-PKey-Version`). */
  version: string;
  /** Release channel; derived from `version` when omitted (as every SDK). */
  channel?: string;
  fetchImpl: typeof fetch;
  /** Epoch seconds. */
  now: () => number;
  /** The pinned product keys. Required: a bearer page verifies every document in-page. */
  pinned: TrustSet;
  store: Store;
  /** Whether the product runs a service (discovery, or the host's expectation). */
  enabled: (slug: ServiceSlug) => boolean;
  /** A hashed hardware fingerprint. A browser has none; the default answers null. */
  fingerprint?: () => HardwareFingerprint | null;
  /** The software facts a report carries (`./facts.ts`). */
  facts?: () => Record<string, JSONValue>;
  /** The `caps` list every report carries (P1b-10). */
  caps?: () => string[];
  /** The active pack set, for the report's `content`. */
  packSetId?: () => Promise<string | null>;
  /** Recent pack installs (P4-17). */
  packInstalls?: () => PackInstallReport[];
  /** The outlet a report names. */
  outlet?: () => Record<string, JSONValue> | null;
  /** The gate status a report names. */
  gate?: () => string | null;
}

type DocumentResult =
  | { kind: "ok"; jws: string; etag: string | null }
  | { kind: "not-modified" }
  | { kind: "unauthorized" }
  | { kind: "device-cap"; limit?: number; deviceCount?: number }
  | { kind: "blocked"; reason: BlockReason; allowedRange?: AllowedRange }
  | { kind: "error"; status: number; message: string };

interface Held<T> {
  jws: string;
  doc: T;
}

const isString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isSeconds = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

export class BearerSession {
  private deviceIdValue = "";
  private token: string | null = null;
  private tokenSource: TokenSource | null = null;
  private record: CacheRecordV3 | null = null;
  private license: Held<LicenseDoc> | null = null;
  private config: Held<ConfigDoc> | null = null;
  private discovered: TrustSet = {};
  private manifestIssuedAt: number | undefined;
  private floor = 0;
  private lastVerifiedAt: number | null = null;
  /** The §5 single re-acquire's per-pass budget. */
  private reacquireInFlight: Promise<boolean> | null = null;
  private reacquireAttempted = false;
  private readonly mints = new Map<
    string,
    { deviceToken: string; value: MintedToken }
  >();
  private readonly journal: UpdateEventEntry[] = [];
  private loaded: Promise<void> | null = null;
  readonly channel: string;

  constructor(private readonly opts: BearerSessionOptions) {
    this.channel = opts.channel ?? channelForVersion(opts.version);
  }

  // ── State ────────────────────────────────────────────────────────────────────────────────

  get deviceId(): string {
    return this.deviceIdValue;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  /** How the current token was obtained in this page; null after a reload. */
  get source(): TokenSource | null {
    return this.tokenSource;
  }

  /** The verified documents, for the report and the adapter. */
  get documents(): { license: LicenseDoc | null; config: ConfigDoc | null } {
    return {
      license: this.license?.doc ?? null,
      config: this.config?.doc ?? null,
    };
  }

  /** The gate inputs, shaped as the desktop bridge's `BridgeState` (Node's `getSyncState`). */
  syncState(): BridgeState {
    const bundle = this.record?.importedBundle;
    return {
      activation: this.token
        ? "token"
        : bundle && this.license
          ? "bundle"
          : null,
      doc: this.license?.doc ?? null,
      lastSyncUnauthorized: this.record?.lastSyncUnauthorized === true,
      blocked: this.record?.blocked ?? null,
      lastVerifiedAt: this.lastVerifiedAt,
      highWaterMark: this.floor,
      config: this.config?.doc.config ?? {},
    };
  }

  /** The effective trust set: manifest keys first, pins spread last (terminal). */
  private get trust(): TrustSet {
    return mergeTrust(this.opts.pinned, this.discovered);
  }

  private raiseFloor(issuedAt: number): void {
    if (issuedAt > this.floor) this.floor = issuedAt;
  }

  private now(): number {
    return effectiveNow(this.opts.now(), this.floor);
  }

  /** Load the device id, the token and the cache, re-verifying every artifact. Idempotent. */
  init(): Promise<void> {
    if (!this.loaded) this.loaded = this.load();
    return this.loaded;
  }

  /** Re-read the store (another tab wrote it, or a bundle was imported). */
  reload(): Promise<void> {
    this.loaded = this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    const s = this.opts.store;
    this.deviceIdValue = await s.getDeviceId();
    this.token = await s.getToken();
    this.tokenSource = null;
    this.discovered = {};
    this.manifestIssuedAt = undefined;
    this.license = null;
    this.config = null;
    this.floor = 0;
    this.lastVerifiedAt = null;
    const rec = await s.readCache();
    // §4.1: a record of another version is discarded, never migrated.
    if (!rec || rec.v !== CACHE_VERSION) {
      this.record = null;
      return;
    }
    this.record = { ...rec };
    if (rec.trustJws) {
      const m = await verifyTrustManifest(rec.trustJws, {
        pinned: this.opts.pinned,
        expectedAud: this.opts.product,
        now: this.opts.now(),
        checkFreshness: false,
      });
      if (m.doc) {
        this.discovered = m.discovered;
        this.manifestIssuedAt = m.doc.issuedAt;
        this.raiseFloor(m.doc.issuedAt);
      } else delete this.record.trustJws;
    }
    const reload = {
      trust: this.trust,
      expectedAud: this.opts.product,
      deviceId: this.deviceIdValue,
      now: this.opts.now(),
      checkFreshness: false as const,
    };
    let newest = 0;
    if (rec.docs?.license) {
      const doc = await verifyLicenseDoc(rec.docs.license, reload);
      if (doc) {
        this.license = { jws: rec.docs.license, doc };
        this.raiseFloor(doc.issuedAt);
        newest = Math.max(newest, doc.issuedAt);
      } else this.dropSlice("license");
    }
    if (rec.docs?.config) {
      const doc = await verifyConfigDoc(rec.docs.config, reload);
      if (doc) {
        this.config = { jws: rec.docs.config, doc };
        this.raiseFloor(doc.issuedAt);
        newest = Math.max(newest, doc.issuedAt);
      } else this.dropSlice("config");
    }
    this.lastVerifiedAt = newest > 0 ? newest * 1000 : null;
  }

  private dropSlice(slice: "license" | "config"): void {
    if (!this.record) return;
    const docs = { ...this.record.docs };
    const etags = { ...this.record.etags };
    delete docs[slice];
    delete etags[slice];
    this.record = { ...this.record, docs, etags };
  }

  private async writeRecord(patch: Partial<CacheRecordV3>): Promise<void> {
    this.record = { v: CACHE_VERSION, ...this.record, ...patch };
    await this.opts.store.writeCache(this.record);
  }

  // ── Transport ────────────────────────────────────────────────────────────────────────────

  /** The seven `X-PKey-*` headers. A browser is platform `web`, arch `wasm32` (§5.2). */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      [HEADER_DEVICE]: this.deviceIdValue,
      [HEADER_VERSION]: this.opts.version,
      [HEADER_CHANNEL]: this.channel,
      [HEADER_PLATFORM]: Platform.web,
      [HEADER_ARCH]: "wasm32",
      [HEADER_SDK_NAME]: SdkId.react,
      [HEADER_SDK_VERSION]: SDK_VERSION,
      ...extra,
    };
  }

  private url(path: string): string {
    return `${this.opts.baseUrl}/${this.opts.product}/${path}`;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    // Bearer mode never sends an ambient credential: no cookie, ever.
    return this.opts.fetchImpl(this.url(path), {
      credentials: "omit",
      ...init,
    });
  }

  private async setToken(token: string, source: TokenSource): Promise<void> {
    this.token = token;
    this.tokenSource = source;
    try {
      await this.opts.store.setToken(token);
    } catch (e) {
      throw new PolarisError(
        "store-failed",
        `The device token could not be saved: ${(e as Error).message}`,
      );
    }
  }

  // ── Registration and activation ──────────────────────────────────────────────────────────

  /** `POST /<p>/devices/register` without storing the token (the re-register path stores it). */
  private async requestRegistration(): Promise<RegisterResult> {
    const fingerprint = this.opts.fingerprint?.() ?? null;
    let res: Response;
    try {
      res = await this.send(
        "devices/register",
        fingerprint
          ? {
              method: "POST",
              headers: this.headers({ "content-type": "application/json" }),
              body: JSON.stringify({ fingerprint }),
            }
          : { method: "POST", headers: this.headers() },
      );
    } catch (e) {
      return { kind: "error", message: (e as Error).message };
    }
    if (res.status === 200) {
      const b = (await res.json().catch(() => ({}))) as {
        token?: unknown;
        deviceId?: unknown;
      };
      if (!isString(b.token))
        return { kind: "error", message: "register answered no token" };
      return {
        kind: "ok",
        token: b.token,
        deviceId: isString(b.deviceId) ? b.deviceId : this.deviceIdValue,
      };
    }
    if (res.status === 403) return { kind: "registration-closed" };
    if (res.status === 429) return { kind: "rate-limited" };
    if (res.status === 404) return { kind: "not-configured" };
    return { kind: "error", message: await res.text().catch(() => "") };
  }

  /** The keyless mint (§6, the `open` registration policy). Does not sync. */
  async register(): Promise<RegisterResult> {
    await this.init();
    const r = await this.requestRegistration();
    if (r.kind === "ok") await this.setToken(r.token, "register");
    return r;
  }

  private async activationLike(
    path: string,
    headers: Record<string, string>,
    withFingerprint = true,
  ): Promise<ActivationOutcome & { token?: string }> {
    // The rotate (`license/token`) carries no fingerprint, as in Node.
    const fingerprint = withFingerprint
      ? (this.opts.fingerprint?.() ?? null)
      : null;
    let res: Response;
    try {
      res = await this.send(
        path,
        fingerprint
          ? {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ fingerprint }),
            }
          : { method: "POST", headers },
      );
    } catch (e) {
      return networkOutcome((e as Error).message);
    }
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 200) {
      const token = (body as { token?: unknown } | null)?.token;
      if (!isString(token))
        return { kind: "error", code: "invalid-response", status: 200 };
      return { kind: "ok", code: "ok", status: 200, token };
    }
    return classifyActivation(res.status, body, res.headers.get("retry-after"));
  }

  /** `POST /<p>/license/activate` with the key as the bearer. On `ok` the token is stored; the
   *  caller syncs. */
  async activate(key: string): Promise<ActivationOutcome> {
    await this.init();
    const r = await this.activationLike(
      "license/activate",
      this.headers({ authorization: `Bearer ${key}` }),
    );
    if (r.kind === "ok" && r.token) await this.setToken(r.token, "activate");
    const { token: _t, ...outcome } = r;
    void _t;
    return outcome;
  }

  /** `POST /<p>/license/enroll` — a free licence with no key, when the product offers one. */
  async enroll(): Promise<ActivationOutcome> {
    await this.init();
    const r = await this.activationLike("license/enroll", this.headers());
    if (r.kind === "ok" && r.token) await this.setToken(r.token, "enroll");
    const { token: _t, ...outcome } = r;
    void _t;
    return outcome;
  }

  /** Release this device's seat (best-effort) and wipe the token and every grant. The update
   *  slices (`feeds`, `releaseRecords`) stay: they are each channel's `seq` floor. */
  async deactivate(): Promise<void> {
    await this.init();
    const token = this.token;
    if (token) {
      try {
        await this.send("license/deauthorize", {
          method: "POST",
          headers: this.headers({ authorization: `Bearer ${token}` }),
        });
      } catch {
        // best-effort: the local wipe is what matters
      }
    }
    this.token = null;
    this.tokenSource = null;
    this.mints.clear();
    await this.opts.store.clearToken().catch(() => undefined);
    const carried: Partial<CacheRecordV3> = {};
    if (this.record?.feeds) carried.feeds = this.record.feeds;
    if (this.record?.releaseRecords)
      carried.releaseRecords = this.record.releaseRecords;
    this.license = null;
    this.config = null;
    this.discovered = {};
    this.manifestIssuedAt = undefined;
    this.floor = 0;
    this.lastVerifiedAt = null;
    this.record = { v: CACHE_VERSION, ...carried };
    await this.opts.store.writeCache(this.record).catch(() => undefined);
  }

  // ── The §5 single re-acquire ─────────────────────────────────────────────────────────────

  /** Rotate the token by the route its source implies (as Node's `chooseReacquireRoute`). */
  private async reacquireNow(current: string): Promise<boolean> {
    const viaRegister =
      !this.opts.enabled("license") || this.tokenSource === "register";
    if (viaRegister) {
      const r = await this.requestRegistration();
      if (r.kind !== "ok") return false;
      await this.setToken(r.token, "register");
      return true;
    }
    const r = await this.activationLike(
      "license/token",
      this.headers({ authorization: `Bearer ${current}` }),
      false,
    );
    if (r.kind !== "ok" || !r.token) return false;
    await this.setToken(r.token, "reacquire");
    return true;
  }

  private reacquireOnce(): Promise<boolean> {
    if (this.reacquireInFlight) return this.reacquireInFlight;
    if (this.reacquireAttempted || !this.token) return Promise.resolve(false);
    this.reacquireAttempted = true;
    this.reacquireInFlight = this.reacquireNow(this.token).catch(() => false);
    return this.reacquireInFlight;
  }

  // ── Sync ─────────────────────────────────────────────────────────────────────────────────

  private async getDocument(
    path: string,
    token: string,
    etag?: string,
  ): Promise<DocumentResult> {
    const headers = this.headers({ authorization: `Bearer ${token}` });
    if (etag) headers["if-none-match"] = etag;
    let res: Response;
    try {
      res = await this.send(path, { headers });
    } catch (e) {
      return { kind: "error", status: 0, message: (e as Error).message };
    }
    switch (res.status) {
      case 304:
        return { kind: "not-modified" };
      case 401:
        return { kind: "unauthorized" };
      case 429: {
        const b = (await res.json().catch(() => ({}))) as {
          limit?: number;
          deviceCount?: number;
        };
        return {
          kind: "device-cap",
          limit: b.limit,
          deviceCount: b.deviceCount,
        };
      }
      case 403: {
        const b = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; reason?: BlockReason };
          reason?: BlockReason;
          allowedRange?: AllowedRange;
        };
        const reason =
          b.error?.reason ??
          b.reason ??
          (b.error?.code === "channel_not_allowed"
            ? "channel-not-entitled"
            : "version-too-old");
        return { kind: "blocked", reason, allowedRange: b.allowedRange };
      }
      case 200:
        return {
          kind: "ok",
          jws: await res.text(),
          etag: res.headers.get("etag"),
        };
      default:
        return {
          kind: "error",
          status: res.status,
          message: await res.text().catch(() => ""),
        };
    }
  }

  /** Fetch, verify and install the trust manifest. Null when nothing acceptable arrived. */
  private async refreshTrust(): Promise<string | null> {
    const res = await this.send(".well-known/polaris-trust.jws", {
      headers: { accept: "application/jose" },
    });
    if (!res.ok) return null;
    const jws = await res.text();
    const m = await verifyTrustManifest(jws, {
      pinned: this.opts.pinned,
      expectedAud: this.opts.product,
      now: this.opts.now(),
      lastTrustIssuedAt: this.manifestIssuedAt,
    });
    if (!m.doc) return null;
    this.discovered = m.discovered;
    this.manifestIssuedAt = m.doc.issuedAt;
    this.raiseFloor(m.doc.issuedAt);
    return jws;
  }

  private async syncDocument(
    slice: "license" | "config",
    force: boolean,
    allowReacquire = true,
  ): Promise<DocOutcome> {
    const token = this.token;
    if (!token) return { kind: "skipped" };
    const path = slice === "license" ? "license/document" : "config/document";
    const res = await this.getDocument(
      path,
      token,
      force ? undefined : this.record?.etags?.[slice],
    );
    switch (res.kind) {
      case "not-modified": {
        // §5: past the half-life, re-ask unconditionally so the server re-signs the window.
        const expiresAt =
          slice === "license"
            ? this.license?.doc.expiresAt
            : this.config?.doc.expiresAt;
        if (
          !force &&
          expiresAt !== undefined &&
          this.now() > expiresAt - REFRESH_MARGIN_SECONDS
        )
          return this.syncDocument(slice, true, allowReacquire);
        this.lastVerifiedAt = this.opts.now() * 1000;
        return { kind: "unchanged" };
      }
      case "unauthorized":
        if (allowReacquire && (await this.reacquireOnce()))
          return this.syncDocument(slice, force, false);
        return { kind: "unauthorized" };
      case "device-cap":
        return {
          kind: "device-cap",
          limit: res.limit,
          deviceCount: res.deviceCount,
        };
      case "blocked":
        return {
          kind: "blocked",
          blocked: {
            reason: res.reason,
            ...(res.allowedRange ? { allowedRange: res.allowedRange } : {}),
          },
        };
      case "ok": {
        const opts = {
          trust: this.trust,
          expectedAud: this.opts.product,
          deviceId: this.deviceIdValue,
          now: this.opts.now(),
        };
        if (slice === "license") {
          const doc = await verifyLicenseDoc(res.jws, {
            ...opts,
            lastAcceptedIssuedAt: this.license?.doc.issuedAt,
          });
          if (!doc) return { kind: "error" };
          this.license = { jws: res.jws, doc };
          this.raiseFloor(doc.issuedAt);
        } else {
          const doc = await verifyConfigDoc(res.jws, {
            ...opts,
            lastAcceptedIssuedAt: this.config?.doc.issuedAt,
          });
          if (!doc) return { kind: "error" };
          this.config = { jws: res.jws, doc };
          this.raiseFloor(doc.issuedAt);
        }
        this.record = {
          v: CACHE_VERSION,
          ...this.record,
          docs: { ...this.record?.docs, [slice]: res.jws },
          etags: { ...this.record?.etags, [slice]: res.etag ?? undefined },
        };
        this.lastVerifiedAt = this.opts.now() * 1000;
        return { kind: "applied" };
      }
      case "error":
        return { kind: "error" };
    }
  }

  /**
   * One sync pass, in Node's order: no token ⇒ nothing at all; trust; the enabled documents in
   * parallel; one cache write; then the report (skipped only on a hard 401 with nothing applied).
   */
  async sync(opts: { force?: boolean } = {}): Promise<SyncResult> {
    await this.init();
    if (!this.token) return { applied: false, documents: {} };
    this.reacquireInFlight = null;
    this.reacquireAttempted = false;
    const trustJws = await this.refreshTrust().catch(() => null);
    const wantLicense = this.opts.enabled("license");
    const wantConfig = this.opts.enabled("config");
    const force = opts.force === true;
    const [license, config] = await Promise.all([
      wantLicense
        ? this.syncDocument("license", force)
        : Promise.resolve<DocOutcome>({ kind: "skipped" }),
      wantConfig
        ? this.syncDocument("config", force)
        : Promise.resolve<DocOutcome>({ kind: "skipped" }),
    ]);
    const outcomes = [license, config];
    const unauthorized = outcomes.some((o) => o.kind === "unauthorized");
    const blocked = outcomes.find((o) => o.kind === "blocked");
    const cap = outcomes.find((o) => o.kind === "device-cap");
    const applied = outcomes.some((o) => o.kind === "applied");
    const healthy = outcomes.some(
      (o) => o.kind === "applied" || o.kind === "unchanged",
    );
    const patch: Partial<CacheRecordV3> = {};
    if (trustJws) patch.trustJws = trustJws;
    if (unauthorized) patch.lastSyncUnauthorized = true;
    else if (healthy) patch.lastSyncUnauthorized = false;
    if (blocked?.kind === "blocked") patch.blocked = blocked.blocked;
    else if (healthy) patch.blocked = undefined;
    // An online document supersedes an imported bundle (§7), as in Node.
    if (applied && this.record?.importedBundle)
      patch.importedBundle = undefined;
    if (Object.keys(patch).length > 0 || applied || healthy)
      await this.writeRecord(patch).catch(() => undefined);
    const result: SyncResult = {
      applied,
      documents: {
        ...(wantLicense ? { license } : {}),
        ...(wantConfig ? { config } : {}),
      },
    };
    if (unauthorized) result.unauthorized = true;
    if (blocked) result.blocked = true;
    if (cap) result.deviceCap = true;
    if (applied || !unauthorized) await this.report().catch(() => false);
    return result;
  }

  // ── Devices ──────────────────────────────────────────────────────────────────────────────

  private requireToken(): string {
    if (!this.token)
      throw new PolarisError(
        "no-token",
        "Activate, sign in or register before using this.",
      );
    return this.token;
  }

  /** `GET /<p>/devices`. */
  async listDevices(): Promise<AccountDevice[]> {
    await this.init();
    const res = await this.send("devices", {
      headers: this.headers({ authorization: `Bearer ${this.requireToken()}` }),
    });
    if (!res.ok) throw await refusal(res, "device_list_failed");
    const b = (await res.json().catch(() => ({}))) as { devices?: unknown };
    return Array.isArray(b.devices) ? (b.devices as AccountDevice[]) : [];
  }

  /** `PATCH /<p>/devices/:id`. */
  async renameDevice(id: string, label: string | null): Promise<void> {
    await this.init();
    const res = await this.send(`devices/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: this.headers({
        authorization: `Bearer ${this.requireToken()}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ label }),
    });
    if (!res.ok) throw await refusal(res, "device_rename_failed");
  }

  /** `DELETE /<p>/devices/:id`. */
  async deauthorizeDevice(id: string): Promise<void> {
    await this.init();
    const res = await this.send(`devices/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers({ authorization: `Bearer ${this.requireToken()}` }),
    });
    if (!res.ok) throw await refusal(res, "device_deauthorize_failed");
  }

  /** Queue a P6-03 update-health event for the next report (§3.13). */
  recordUpdateEvent(
    entry: Omit<UpdateEventEntry, "eventId" | "at"> & { at?: number },
  ): void {
    const eventId = randomId();
    this.journal.push({ ...entry, eventId, at: entry.at ?? this.opts.now() });
    // Bound the in-page journal: the oldest go first when a page never reports.
    if (this.journal.length > 64)
      this.journal.splice(0, this.journal.length - 64);
  }

  /** The events waiting for a report. */
  pendingUpdateEvents(): readonly UpdateEventEntry[] {
    return this.journal;
  }

  /** The report body: software facts plus re-verified documents, never anything from storage
   *  that did not just verify (R4-05). */
  async snapshot(): Promise<Record<string, JSONValue>> {
    const config: Record<string, JSONValue> = {};
    const entitlements: Record<string, JSONValue> = {};
    for (const [k, v] of Object.entries(this.config?.doc.config ?? {}))
      config[k] = v.value;
    for (const [k, v] of Object.entries(this.license?.doc.entitlements ?? {}))
      entitlements[k] = v.value;
    let facts: Record<string, JSONValue> = {};
    try {
      facts = this.opts.facts?.() ?? {};
    } catch {
      facts = {};
    }
    const caps = this.opts.caps?.();
    const packSetId = (await this.opts.packSetId?.().catch(() => null)) ?? null;
    const installs = this.opts.packInstalls?.() ?? [];
    const outlet = this.opts.outlet?.() ?? null;
    const gate = this.opts.gate?.() ?? null;
    const updates = this.journal.slice(0, MAX_REPORT_UPDATES);
    return {
      ...facts,
      config,
      entitlements,
      ...(caps ? { caps } : {}),
      ...(packSetId !== null ? { content: { packSetId } } : {}),
      ...(installs.length > 0
        ? { packInstalls: installs as unknown as JSONValue }
        : {}),
      ...(outlet ? { outlet } : {}),
      ...(gate ? { gate } : {}),
      ...(updates.length > 0
        ? { updates: updates as unknown as JSONValue }
        : {}),
    };
  }

  /** `POST /<p>/devices/report`, best-effort. Returns whether the server accepted it; the
   *  events it carried leave the journal only then. */
  async report(): Promise<boolean> {
    await this.init();
    const token = this.token;
    if (!token) return false;
    try {
      const body = await this.snapshot();
      const carried = Array.isArray(body.updates) ? body.updates.length : 0;
      const res = await this.send("devices/report", {
        method: "POST",
        headers: this.headers({
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify(body),
      });
      if (res.ok && carried > 0) this.journal.splice(0, carried);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Edge-mint ────────────────────────────────────────────────────────────────────────────

  /** `GET /<p>/config/mint/<recipe>/token`, reused from memory until 30 s before expiry while
   *  the same device token is held. Throws `PolarisError(<server code>)` on a refusal. */
  async mint(recipeId: string): Promise<MintedToken> {
    await this.init();
    if (!MINT_ID.test(recipeId))
      throw new PolarisError(
        "bad_request",
        `"${recipeId}" is not an edge-mint recipe id.`,
      );
    const current = this.token;
    const held = this.mints.get(recipeId);
    if (held) {
      if (
        current !== null &&
        held.deviceToken === current &&
        this.opts.now() < held.value.expiresAt - MINT_REUSE_MARGIN_SECONDS
      )
        return held.value;
      this.mints.delete(recipeId);
    }
    let presented = this.requireTokenAs("unauthorized");
    const get = (token: string) =>
      this.send(`config/mint/${recipeId}/token`, {
        headers: this.headers({ authorization: `Bearer ${token}` }),
      }).catch((e: unknown) => {
        throw new PolarisError("network-error", (e as Error).message);
      });
    let res = await get(presented);
    if (
      res.status === 401 &&
      (await this.reacquireNow(presented).catch(() => false))
    ) {
      presented = this.requireTokenAs("unauthorized");
      res = await get(presented);
    }
    if (res.status === 200) {
      const b = (await res.json().catch(() => ({}))) as {
        token?: unknown;
        expiresAt?: unknown;
      };
      if (typeof b.token !== "string" || typeof b.expiresAt !== "number")
        throw new PolarisError(
          "bad_response",
          "edge-mint answered without a token and expiry.",
        );
      const minted = { token: b.token, expiresAt: b.expiresAt };
      this.mints.set(recipeId, { deviceToken: presented, value: minted });
      return minted;
    }
    throw await refusal(res, `http_${res.status}`);
  }

  private requireTokenAs(code: "unauthorized" | "no-token"): string {
    if (!this.token)
      throw new PolarisError(
        code,
        "This needs a device token: activate, sign in or register first.",
      );
    return this.token;
  }

  // ── Device-code sign-in (RFC 8628) ───────────────────────────────────────────────────────

  private async postJson(path: string, body: unknown): Promise<Response> {
    try {
      return await this.send(path, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new PolarisError("network-error", (e as Error).message);
    }
  }

  /** Begin a device-code sign-in. No bearer: a sign-in asks for the IDENTITY's credential. */
  async beginSignIn(opts: { deviceName?: string } = {}): Promise<SignInPrompt> {
    await this.init();
    const body: Record<string, string> = { deviceId: this.deviceIdValue };
    const name = opts.deviceName?.trim();
    if (name) body.deviceName = name;
    const res = await this.postJson("identity/auth/device/start", body);
    if (res.status !== 200) throw await refusal(res, "sign-in-unavailable");
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      !isString(b.deviceCode) ||
      !isString(b.userCode) ||
      !isString(b.verificationUri) ||
      !isString(b.verificationUriComplete) ||
      !isSeconds(b.expiresIn) ||
      !isSeconds(b.interval)
    )
      throw new PolarisError(
        "bad_response",
        "device sign-in start answered without a complete prompt.",
      );
    const expiresIn = Math.ceil(b.expiresIn);
    return {
      deviceCode: b.deviceCode,
      userCode: b.userCode,
      verificationUri: b.verificationUri,
      verificationUriComplete: b.verificationUriComplete,
      expiresIn,
      interval: Math.ceil(b.interval),
      expiresAt: this.now() + expiresIn,
    };
  }

  /** Poll once. On `ready` the token is stored and a sync has run before this resolves. */
  async pollSignIn(
    prompt: SignInPrompt,
    current = prompt.interval,
  ): Promise<SignInPoll> {
    const res = await this.postJson("identity/auth/device/poll", {
      deviceCode: prompt.deviceCode,
      deviceId: this.deviceIdValue,
    });
    if (res.status >= 500)
      throw new PolarisError(
        "server-error",
        `device sign-in poll failed with status ${res.status}.`,
      );
    const b = (await res.json().catch(() => ({}))) as {
      status?: unknown;
      interval?: unknown;
      token?: unknown;
      identity?: unknown;
    };
    if (res.status === 429)
      return {
        status: "slow-down",
        interval: isSeconds(b.interval)
          ? Math.ceil(b.interval)
          : current + SLOW_DOWN_STEP_SECONDS,
      };
    if (res.status !== 200)
      return {
        status: "error",
        message: `device sign-in poll refused (status ${res.status}).`,
      };
    switch (b.status) {
      case "pending":
        return { status: "pending" };
      case "timeout":
        return { status: "expired" };
      case "ready": {
        if (!isString(b.token))
          return { status: "error", message: "ready without a token." };
        await this.setToken(b.token, "signin");
        await this.sync();
        const id = b.identity as
          | { name?: unknown; email?: unknown }
          | undefined;
        const identity =
          id && typeof id === "object"
            ? {
                ...(isString(id.name) ? { name: id.name } : {}),
                ...(isString(id.email) ? { email: id.email } : {}),
              }
            : undefined;
        return identity ? { status: "ready", identity } : { status: "ready" };
      }
      default:
        return { status: "error", message: "device sign-in failed." };
    }
  }

  /** Poll until the sign-in settles: at least `interval` between polls, longer after a
   *  `slow_down`, transient failures ridden out, `expired` once `expiresAt` passes. */
  async waitForSignIn(
    prompt: SignInPrompt,
    opts: {
      signal?: AbortSignal;
      sleep?: (seconds: number, signal?: AbortSignal) => Promise<void>;
    } = {},
  ): Promise<SignInResult> {
    const sleep = opts.sleep ?? sleepFor;
    let interval = prompt.interval;
    for (;;) {
      opts.signal?.throwIfAborted();
      if (this.now() >= prompt.expiresAt) return { status: "expired" };
      await sleep(
        Math.min(Math.max(interval, 1), Math.max(prompt.expiresIn, 1)),
        opts.signal,
      );
      if (this.now() >= prompt.expiresAt) return { status: "expired" };
      let poll: SignInPoll;
      try {
        poll = await this.pollSignIn(prompt, interval);
      } catch (e) {
        if (
          e instanceof PolarisError &&
          (e.code === "network-error" || e.code === "server-error")
        )
          continue;
        throw e;
      }
      if (poll.status === "pending") continue;
      if (poll.status === "slow-down") {
        interval = Math.max(interval, poll.interval);
        continue;
      }
      return poll;
    }
  }

  // ── Commerce (P6-01) ─────────────────────────────────────────────────────────────────────

  /** `GET /<p>/distribution/commerce/binding`. */
  async commerceBinding(): Promise<CommerceBinding> {
    await this.init();
    const res = await this.send("distribution/commerce/binding", {
      headers: this.headers({ authorization: `Bearer ${this.requireToken()}` }),
    });
    if (!res.ok) throw await refusal(res, `http_${res.status}`);
    const b = (await res.json().catch(() => ({}))) as {
      bindingId?: unknown;
      products?: unknown;
    };
    if (
      !isString(b.bindingId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        b.bindingId,
      )
    )
      throw new PolarisError(
        "invalid-response",
        "commerce/binding answered no binding UUID.",
      );
    const products: CommerceProduct[] = [];
    if (Array.isArray(b.products))
      for (const p of b.products as Record<string, unknown>[])
        if (p && isString(p.store) && isString(p.productId) && isString(p.flag))
          products.push({
            store: p.store,
            productId: p.productId,
            flag: p.flag,
            deliverable: isString(p.deliverable) ? p.deliverable : "app",
          });
    return { bindingId: b.bindingId.toLowerCase(), products };
  }

  /** `POST /<p>/distribution/commerce/claim`. On `ok`, sync to receive the flag. */
  async commerceClaim(
    store: "app-store" | "play" | "steam",
    payload: ClaimPayload,
  ): Promise<ClaimResult> {
    await this.init();
    const body: Record<string, string> = { store };
    const p = payload as Record<string, unknown>;
    if (store === "app-store" && isString(p.signedTransaction))
      body.signedTransaction = p.signedTransaction;
    else if (
      store === "play" &&
      isString(p.productId) &&
      isString(p.purchaseToken)
    ) {
      body.productId = p.productId;
      body.purchaseToken = p.purchaseToken;
    } else if (
      store === "steam" &&
      isString(p.ticket) &&
      (isString(p.dlcAppId) || typeof p.dlcAppId === "number")
    ) {
      body.ticket = p.ticket;
      body.dlcAppId = String(p.dlcAppId);
    } else
      throw new PolarisError(
        "invalid-options",
        `The ${store} claim payload is incomplete.`,
      );
    const res = await this.send("distribution/commerce/claim", {
      method: "POST",
      headers: this.headers({
        authorization: `Bearer ${this.requireToken()}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify(body),
    });
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && b.ok === true)
      return {
        kind: "ok",
        store: String(b.store ?? store),
        productId: String(b.productId ?? ""),
        flag: String(b.flag ?? ""),
        deliverable: String(b.deliverable ?? "app"),
        state: String(b.state ?? ""),
        granted: b.granted === true,
        changed: b.changed === true,
      };
    const err = b.error;
    const code =
      typeof err === "string"
        ? err
        : isString((err as { code?: unknown })?.code)
          ? String((err as { code: string }).code)
          : `http_${res.status}`;
    const reason = isString(b.reason)
      ? b.reason
      : isString((err as { reason?: unknown })?.reason)
        ? String((err as { reason: string }).reason)
        : undefined;
    if (code === "attestation_required")
      return { kind: "attestationRequired", code, status: res.status };
    if (reason === "not_owned")
      return { kind: "notOwned", code, reason, status: res.status };
    return {
      kind: "refused",
      code,
      ...(reason ? { reason } : {}),
      status: res.status,
    };
  }

  // ── Bearer-authenticated reads ───────────────────────────────────────────────────────────

  /** The bearer a gated read presents (entitled changelog, licensed downloads, gated packs). */
  get bearer(): string | null {
    return this.token;
  }
}

/** A refusal as a `PolarisError` carrying the server's code (flat or nested), else `fallback`. */
async function refusal(res: Response, fallback: string): Promise<PolarisError> {
  const b = (await res.json().catch(() => ({}))) as {
    error?: string | { code?: string; message?: string };
    message?: string;
  };
  const wire =
    typeof b.error === "string" ? b.error : (b.error?.code ?? fallback);
  const message =
    (typeof b.error === "object" ? b.error?.message : undefined) ??
    b.message ??
    `request failed with status ${res.status}`;
  // `code` stays inside the registry (PolarisErrorCode is closed); the server's own code, whatever
  // it is, is `wireCode`.
  const code = (ERROR_CODE_VALUES as readonly string[]).includes(wire)
    ? (wire as PolarisErrorCode)
    : "http-error";
  return new PolarisError(code, message, wire, undefined, {
    status: res.status,
  });
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sleepFor(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, seconds * 1000);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
