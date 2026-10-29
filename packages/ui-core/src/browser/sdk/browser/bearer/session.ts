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
//   commerce*         GET /<p>/commerce/binding, POST …/claim
//
// What is persisted is client-core's `Store` contract (`./store.ts`): the token, the random device
// id, and a `CacheRecordV3` of SIGNED ARTIFACTS ONLY, re-verified against the pinned keys on every
// load — so editing IndexedDB by hand can delete an activation but never invent one.
//
// A browser has no hardware fingerprint (`devices.fingerprint` is a web N/A): `fingerprint`
// answers null by default and the register request then carries no body, as Godot's web export
// sends. The seam exists for the transcript replayer, which records a host that has one.
//
// The device label (WIRE-CONTRACT-V4 §12.7.1, PX-W13) follows the same rule: a browser has no
// platform device name, so none is sent unless the host names one (`deviceName`, or a per-call
// name on `beginSignIn`). It goes on registration, activation and sign-in (never enroll or the
// token rotation), through client-core's `normalizeDeviceLabel`, as Node sends it.

import {
  CACHE_VERSION,
  REFRESH_MARGIN_SECONDS,
  channelForVersion,
  compareKidBytes,
  effectiveNow,
  jwsHeaderKid,
  loadPinRevocations,
  mergeTrust,
  normalizeDeviceLabel,
  buildDeviceKeysRequest,
  trustSignerOrder,
  usablePins,
  verifyConfigDoc,
  verifyLicenseDoc,
  verifyTrustManifest,
  type BlockedState,
  type CacheRecordV3,
  type DeviceKeyPort,
  type RedirectPending,
  type Store,
  type TrustManifestResult,
} from "@polaris-key/client-core";
import { reloadBundle, type CachedBundle } from "../offline.js";
import type { ExchangeDiscovery } from "../discovery.js";
import type { BrowserStore, TokenProvenance } from "./store.js";
import type {
  ExchangeContext,
  ExchangeOptions,
  ExchangeOutcome,
} from "./exchange.js";
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
import { DEVICE_POLL_DENIED } from "@polaris-key/protocol/identity";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import {
  STRICTEST_BLOCK_REASON,
  isBlockReason,
  type AllowedRange,
  type BlockReason,
  type LicenseDoc,
} from "@polaris-key/protocol/license";
import {
  Arch,
  ERROR_CODE_VALUES,
  Platform,
  SdkId,
} from "../../constants.generated.js";
import { SDK_VERSION } from "../../version.js";
import { BeforeSignOutHooks } from "../../core/account.js";
import {
  classifyActivation,
  bodyCode,
  networkOutcome,
  readKeyEntries,
  type ActivationOutcome,
} from "../../core/activation.js";
import {
  PolarisError,
  type AttachResult,
  type PolarisErrorCode,
} from "../../core/types.js";
import type { BridgeState } from "../../desktop/bridge.js";
import type { ServiceSlug } from "../../core/services.js";
import type { TrustSet } from "../offline.js";
import {
  buildUpdateEvent,
  type UpdateEventEntry,
  type UpdateEventInput,
} from "../../core/updateEvents.js";
import {
  ErrorCode,
  Feature,
  type UpdateEvent,
} from "../../constants.generated.js";
import { UnsupportedError } from "../../core/caps.js";
import {
  choiceRefusal,
  type ChoiceCompleteOptions,
  isChoiceCount,
  isLicenseChoiceView,
  isReplaceView,
  type ChoiceCancelResult,
  type ChoiceCompleteResult,
  type ChoiceEndpointName,
  type ChoiceEndpoints,
  type ChoiceViewResult,
  type LicenseChoice,
  type LicenseChoiceView,
  type ReplaceView,
} from "../../core/choice.js";
import type {
  DeviceCodeSignInOptions,
  RedirectEndpoints,
  RedirectSignInOptions,
  SignInOutcome,
} from "../../core/signIn.js";

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
  /** React only: set when the pass was skipped because the sync is backing off (SP-R02) after a
   *  5xx, a 429 or a network failure; epoch seconds of the next allowed attempt. Nothing was
   *  requested, and the adapter keeps projecting the cached documents. */
  deferredUntil?: number;
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
  /** The label the sign-in page shows (§12.7.1): the Worker's echo, else (an older Worker) the
   *  label sent; null when there is none. */
  deviceName: string | null;
}

export type SignInPoll =
  | { status: "pending" }
  | { status: "slow-down"; interval: number }
  /** Signed in: the token is stored and the post-acquisition sync has run. `identity` is the
   *  signed-in identity the server named, when it did (§3.12). */
  | { status: "ready"; identity?: { name?: string; email?: string } }
  | { status: "expired" }
  /** `code` is `sign-in-denied` when the Worker answered `error` + `access_denied` (a person
   *  refused), and `sign-in-failed` for a bare `error` (it failed after approval). */
  | {
      status: "error";
      message: string;
      code?: "sign-in-denied" | "sign-in-failed";
    };

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

/** `GET /<p>/commerce/binding`. Hand `bindingId` to the store before buying. */
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
export type { UpdateEventEntry, UpdateEventInput };

/** At most this many update events go in one report; the rest wait (§3.13). */
export const MAX_REPORT_UPDATES = 16;
/** At most this many unsent update events are kept in the page. */
export const MAX_JOURNAL = 64;
/** A cached mint is reused until this many seconds before its `expiresAt` (as Node). */
export const MINT_REUSE_MARGIN_SECONDS = 30;
/** The router's recipe-id alphabet. */
export const MINT_ID = /^[a-z0-9-]+$/;
/** RFC 8628 §3.5: an interval-less `slow_down` adds this to the current interval. */
export const SLOW_DOWN_STEP_SECONDS = 5;
/** Every request's deadline, as Node's `DEFAULT_REQUEST_TIMEOUT_MS`. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** How long `flushUpdateEvents()` waits before it lets a page go on without having sent its
 *  journal: a page about to reload must not sit behind a hung connection for the full 15 s. */
export const FLUSH_WAIT_SECONDS = 3;
/** Sync backoff (SP-R02): the first retry waits about this long after a 5xx, a 429 or a
 *  network failure, doubling per consecutive failure... */
export const SYNC_BACKOFF_BASE_SECONDS = 30;
/** ...up to this ceiling, which also caps a server's `Retry-After`. */
export const SYNC_BACKOFF_MAX_SECONDS = 3600;

/** The `Retry-After` header in seconds (delta-seconds or an HTTP date), or undefined. */
export function parseRetryAfter(
  value: string | null,
  nowSeconds: number,
): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil(at / 1000 - nowSeconds));
}

/**
 * Seconds to wait after the `failures`-th consecutive retryable failure: exponential from
 * `SYNC_BACKOFF_BASE_SECONDS`, capped at `SYNC_BACKOFF_MAX_SECONDS`, with "equal jitter" (half
 * fixed, half random) so a fleet of pages that failed together does not retry together. A
 * server's `Retry-After` wins when it sent one (still capped).
 */
export function syncBackoffSeconds(
  failures: number,
  retryAfter: number | undefined,
  random: () => number = Math.random,
): number {
  if (retryAfter !== undefined)
    return Math.min(SYNC_BACKOFF_MAX_SECONDS, Math.max(0, retryAfter));
  const exp = Math.min(
    SYNC_BACKOFF_MAX_SECONDS,
    SYNC_BACKOFF_BASE_SECONDS * 2 ** Math.max(0, failures - 1),
  );
  return Math.ceil(exp / 2 + random() * (exp / 2));
}

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
  /** The identity endpoints discovery named (`identity.endpoints`): `subject`, `signout`,
   *  `attach`, `accountPortal`. A call whose endpoint is absent answers unavailable and builds no
   *  URL; the default answers none. */
  identityEndpoints?: () => IdentityAccountEndpoints | null;
  /** The redirect endpoints and issuer discovery named (`identity.endpoints.authorize`, `token`,
   *  `identity.issuer`). A redirect sign-in with none is `sign-in-unavailable`; the default
   *  answers none. */
  redirectEndpoints?: () => RedirectEndpoints | null;
  /** The `choice*` endpoints discovery named (`identity.endpoints`). A choice call whose endpoint
   *  is absent answers the typed unavailable and dials nothing; the default answers none. */
  choiceEndpoints?: () => ChoiceEndpoints | null;
  /** The platform sign-in discovery named (`identity.exchange`, `nonce`, `token`). An exchange
   *  with none answers `unavailable` and dials nothing; the default answers none. */
  exchangeEndpoints?: () => ExchangeDiscovery | null;
  /** Conformance replay only: the exact `state` and verifier of a recorded conversation. */
  redirectEntropy?: () => { state?: string; codeVerifier?: string };
  /** A hashed hardware fingerprint. A browser has none; the default answers null. */
  fingerprint?: () => HardwareFingerprint | null;
  /** This device's label (§12.7.1). A browser has no platform name: when omitted, or `""`, none
   *  is sent. */
  deviceName?: string;
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
  /** Jitter source for the sync backoff (tests). Defaults to `Math.random`. */
  random?: () => number;
  /** A fresh update-event id (tests). Defaults to 16 random bytes in hex, then the event. */
  eventId?: (event: UpdateEvent) => string;
}

/** The four account endpoints of the identity fragment (WIRE-CONTRACT-V4 §12.6). */
export interface IdentityAccountEndpoints {
  subject?: string;
  signout?: string;
  attach?: string;
  accountPortal?: string;
}

/** Why an account call could not run: the endpoint is not in discovery. */
export class AccountUnavailableError extends Error {
  constructor(readonly endpoint: string) {
    super(`the product's discovery names no identity ${endpoint} endpoint`);
    this.name = "AccountUnavailableError";
  }
}

type DocumentResult =
  | { kind: "ok"; jws: string; etag: string | null }
  | { kind: "not-modified" }
  | { kind: "unauthorized" }
  | {
      kind: "device-cap";
      limit?: number;
      deviceCount?: number;
      retryAfter?: number;
    }
  | { kind: "blocked"; reason: BlockReason; allowedRange?: AllowedRange }
  | { kind: "error"; status: number; message: string; retryAfter?: number };

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
  /** Persisted beside the token: only "signin" is a signed-in account (rung 1). */
  private provenanceValue: TokenProvenance | null = null;
  private record: CacheRecordV3 | null = null;
  private license: Held<LicenseDoc> | null = null;
  private config: Held<ConfigDoc> | null = null;
  private discovered: TrustSet = {};
  private manifestIssuedAt: number | undefined;
  /** The tombstoned pins and their evidence (WIRE-CONTRACT-V4 §1, §4.1). */
  private tombstones: string[] = [];
  private evidence: Record<string, string> = {};
  /** The cached bundle, when it re-verified on the reload profile (§7). */
  private bundle: CachedBundle | null = null;
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
  /** The signed-in account's pairwise subject, as last answered (this page only). */
  private subjectValue: string | null = null;
  private readonly beforeSignOut = new BeforeSignOutHooks();
  /** Consecutive sync passes that hit a 5xx, a 429 or a network failure (SP-R02). */
  private syncFailures = 0;
  /** Epoch seconds before which `sync()` does not touch the network. */
  private syncNotBefore = 0;
  /** Consecutive passes the server answered 401 to (a revoked or unknown token). */
  private unauthorizedPasses = 0;
  /** The current pass's retryable failure, if any: the largest `Retry-After` seen. */
  private passFailure: { retryAfter?: number } | null = null;
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
  get provenance(): TokenProvenance | null {
    return this.token === null ? null : this.provenanceValue;
  }

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

  /** The held licence document's compact JWS and times, for `client.backend` (SP-58). */
  backendLicense(): {
    jws: string;
    issuedAt: number;
    expiresAt: number;
  } | null {
    const l = this.license;
    return l
      ? { jws: l.jws, issuedAt: l.doc.issuedAt, expiresAt: l.doc.expiresAt }
      : null;
  }

  /** The time every gate comparison runs at: `max(systemClock, floor)`. */
  effectiveTime(): number {
    return this.now();
  }

  /** The gate inputs, shaped as the desktop bridge's `BridgeState` (Node's `getSyncState`). */
  syncState(): BridgeState {
    return {
      activation: this.token
        ? "token"
        : this.bundle?.activates && this.license
          ? "bundle"
          : null,
      doc: this.license?.doc ?? null,
      lastSyncUnauthorized: this.record?.lastSyncUnauthorized === true,
      // Unsigned, and kept in storage a page script can write: a reason outside the block
      // vocabulary is not a hint this session wrote, and is dropped rather than handed to a gate
      // that returns the reason AS the status (`isBlockReason`).
      blocked: isBlockReason(this.record?.blocked?.reason)
        ? this.record.blocked
        : null,
      lastVerifiedAt: this.lastVerifiedAt,
      highWaterMark: this.floor,
      config: this.config?.doc.config ?? {},
    };
  }

  /** The effective trust set: manifest keys first, the USABLE pins spread last (terminal). */
  private get trust(): TrustSet {
    return mergeTrust(
      usablePins(this.opts.pinned, this.tombstones),
      this.discovered,
    );
  }

  /** The effective trust set, for documents verified outside the session (Connect's roster and
   *  certificate). */
  effectiveTrust(): TrustSet {
    return this.trust;
  }

  /** Record a verified manifest's new tombstones, with the manifest as their evidence. */
  private noteRevocations(jws: string, revokedPins: readonly string[]): void {
    if (revokedPins.length === 0) return;
    for (const kid of revokedPins) this.evidence[kid] = jws;
    this.tombstones = [...new Set([...this.tombstones, ...revokedPins])].sort(
      compareKidBytes,
    );
  }

  private installManifest(jws: string, m: TrustManifestResult): void {
    if (!m.doc) return;
    this.noteRevocations(jws, m.revokedPins);
    this.discovered = m.discovered;
    this.manifestIssuedAt = m.doc.issuedAt;
    this.raiseFloor(m.doc.issuedAt);
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
    this.provenanceValue =
      this.token === null
        ? null
        : ((await this.store()
            .provenance?.get()
            .catch(() => null)) ?? null);
    this.discovered = {};
    this.manifestIssuedAt = undefined;
    this.license = null;
    this.config = null;
    this.bundle = null;
    this.floor = 0;
    this.lastVerifiedAt = null;
    const rec = await s.readCache();
    // §4.1: a record of another version is discarded, never migrated.
    if (!rec || rec.v !== CACHE_VERSION) {
      this.record = null;
      return;
    }
    this.record = { ...rec };
    // §4.1: the pin evidence first; the manifest, the documents and the bundle verify against
    // the usable pins. Evidence that no longer verifies is dropped on the next write.
    const evidence = await loadPinRevocations(rec.pinRevocations, {
      pinned: this.opts.pinned,
      expectedAud: this.opts.product,
    });
    this.tombstones = evidence.tombstones;
    this.evidence = evidence.kept;
    if (rec.trustJws) {
      const m = await verifyTrustManifest(rec.trustJws, {
        pinned: this.opts.pinned,
        tombstones: this.tombstones,
        expectedAud: this.opts.product,
        now: this.opts.now(),
        checkFreshness: false,
      });
      if (m.doc) this.installManifest(rec.trustJws, m);
      else delete this.record.trustJws;
    }
    this.keepEvidence();
    const reload = {
      trust: this.trust,
      expectedAud: this.opts.product,
      deviceId: this.deviceIdValue,
      now: this.opts.now(),
      // Reload: no floor (explicit); the floors are derived from what verifies here.
      lastAcceptedIssuedAt: null,
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
    this.bundle = await reloadBundle(this.record, {
      pinned: this.opts.pinned,
      tombstones: this.tombstones,
      product: this.opts.product,
      deviceId: this.deviceIdValue,
      now: this.opts.now(),
      license: this.license?.jws,
    });
  }

  /** The in-memory `pinRevocations` slice follows the evidence that re-verified. */
  private keepEvidence(): void {
    if (!this.record) return;
    const next: CacheRecordV3 = { ...this.record };
    delete next.pinRevocations;
    if (Object.keys(this.evidence).length > 0)
      next.pinRevocations = { ...this.evidence };
    this.record = next;
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
      [HEADER_ARCH]: Arch.wasm32,
      [HEADER_SDK_NAME]: SdkId.react,
      [HEADER_SDK_VERSION]: SDK_VERSION,
      ...extra,
    };
  }

  private url(path: string): string {
    return `${this.opts.baseUrl}/${this.opts.product}/${path}`;
  }

  private send(path: string, init: RequestInit): Promise<Response> {
    return this.sendTo(this.url(path), init);
  }

  /** `fetch` with no ambient credential and the request deadline, to an absolute URL. */
  private async sendTo(url: string, init: RequestInit): Promise<Response> {
    // Bearer mode never sends an ambient credential: no cookie, ever. Every request carries a
    // deadline (Node's 15 s), so a hung connection fails like a dropped one instead of
    // stalling the sync forever. Like `AbortSignal.timeout`, it also covers reading the body.
    const deadline = new AbortController();
    setTimeout(() => {
      deadline.abort(
        typeof DOMException === "function"
          ? new DOMException("The request timed out.", "TimeoutError")
          : new Error("The request timed out."),
      );
    }, REQUEST_TIMEOUT_MS);
    return this.opts.fetchImpl(url, {
      credentials: "omit",
      signal: deadline.signal,
      ...init,
    });
  }

  private store(): Partial<BrowserStore> {
    return this.opts.store as Partial<BrowserStore>;
  }

  private async setToken(
    token: string,
    source: TokenSource,
    keepProvenance = false,
  ): Promise<void> {
    const keep = keepProvenance || source === "reacquire";
    // A rotation keeps what the token already was; every other source says what it is now.
    const next: TokenProvenance | null =
      source === "signin"
        ? "signin"
        : source === "register"
          ? "register"
          : keep
            ? this.provenanceValue
            : "key";
    if (!keep) this.provenanceValue = null;
    // A token just arrived from the server, so it is reachable: drop any sync backoff.
    this.syncFailures = 0;
    this.syncNotBefore = 0;
    this.unauthorizedPasses = 0;
    this.token = token;
    this.tokenSource = source;
    try {
      // Cleared first and written last: a crash between leaves "not signed in", never a stale yes.
      if (!keep) await this.store().provenance?.set(null);
      await this.opts.store.setToken(token);
      if (!keep) await this.store().provenance?.set(next);
      this.provenanceValue = next;
    } catch (e) {
      throw new PolarisError(
        "store-failed",
        `The device token could not be saved: ${(e as Error).message}`,
      );
    }
  }

  // ── Registration and activation ──────────────────────────────────────────────────────────

  /** The label to send (§12.7.1): `override`, else the `deviceName` option; no platform default. */
  deviceLabel(override?: string): string | null {
    return normalizeDeviceLabel(override ?? this.opts.deviceName ?? null);
  }

  /** The fingerprint and label body, or none when it would hold neither (as Node omits it). */
  private static deviceBody(
    fingerprint: HardwareFingerprint | null,
    deviceName: string | null,
  ): string | null {
    if (!fingerprint && !deviceName) return null;
    return JSON.stringify({
      ...(fingerprint ? { fingerprint } : {}),
      ...(deviceName ? { deviceName } : {}),
    });
  }

  /** `POST /<p>/devices/register` without storing the token (the re-register path stores it). */
  private async requestRegistration(): Promise<RegisterResult> {
    const body = BearerSession.deviceBody(
      this.opts.fingerprint?.() ?? null,
      this.deviceLabel(),
    );
    let res: Response;
    try {
      res = await this.send(
        "devices/register",
        body
          ? {
              method: "POST",
              headers: this.headers({ "content-type": "application/json" }),
              body,
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
    withLabel = false,
  ): Promise<ActivationOutcome & { token?: string }> {
    // The rotate (`license/token`) carries no fingerprint, and only activation carries the
    // label (PX-W13 §8 Q2), as in Node.
    const request = BearerSession.deviceBody(
      withFingerprint ? (this.opts.fingerprint?.() ?? null) : null,
      withLabel ? this.deviceLabel() : null,
    );
    let res: Response;
    try {
      res = await this.send(
        path,
        request
          ? {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: request,
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
      const keyEntries = readKeyEntries(body);
      return {
        kind: "ok",
        code: "ok",
        status: 200,
        token,
        ...(keyEntries ? { keyEntries } : {}),
      };
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
      true,
      true,
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
    await this.wipeLocal();
  }

  /** Forget the token, the grants and the subject. Makes no request. */
  private async wipeLocal(): Promise<void> {
    this.subjectValue = null;
    this.token = null;
    this.tokenSource = null;
    this.provenanceValue = null;
    this.mints.clear();
    await this.opts.store.clearToken().catch(() => undefined);
    const carried: Partial<CacheRecordV3> = {};
    if (this.record?.feeds) carried.feeds = this.record.feeds;
    if (this.record?.releaseRecords)
      carried.releaseRecords = this.record.releaseRecords;
    // A pinned key's revocation is security state, not a grant (§4.1): it stays.
    if (Object.keys(this.evidence).length > 0)
      carried.pinRevocations = { ...this.evidence };
    this.bundle = null;
    this.license = null;
    this.config = null;
    this.discovered = {};
    this.manifestIssuedAt = undefined;
    this.floor = 0;
    this.lastVerifiedAt = null;
    this.record = { v: CACHE_VERSION, ...carried };
    await this.opts.store.writeCache(this.record).catch(() => undefined);
  }

  // ── The account (WIRE-CONTRACT-V4 §12.3, §12.6) ────────────────────────────────────────────

  /** The held account subject, from the last `subject()`, `attach()` or sign-in; null for a
   *  device with no account. */
  get account(): string | null {
    return this.subjectValue;
  }

  /** Whether discovery names the account endpoints (`identity.account: true`'s fragment). */
  accountPortal(): string | null {
    const url = this.opts.identityEndpoints?.()?.accountPortal;
    return isString(url) ? url : null;
  }

  private accountEndpoint(name: "subject" | "signout" | "attach"): string {
    const url = this.opts.identityEndpoints?.()?.[name];
    if (!isString(url)) throw new AccountUnavailableError(name);
    return url;
  }

  /** The endpoint's path under this product, for `send`. A URL on another origin or product is
   *  refused rather than followed: the bearer goes only to the Worker that issued it. */
  private accountPath(url: string): string {
    const prefix = `${this.opts.baseUrl}/${this.opts.product}/`;
    if (!url.startsWith(prefix))
      throw new PolarisError(
        "bad_response",
        "an identity endpoint points outside this product.",
      );
    return url.slice(prefix.length);
  }

  /** Run `fn` with the device bearer; the token is the caller's, never logged. */
  private async withBearer(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    await this.init();
    const token = this.requireToken();
    try {
      return await this.send(path, {
        ...init,
        headers: this.headers({
          authorization: `Bearer ${token}`,
          ...init.headers,
        }),
      });
    } catch (e) {
      throw new PolarisError("network-error", (e as Error).message);
    }
  }

  /** Register a function `signOut()` awaits before it signs out. Returns the remover. */
  onBeforeSignOut(hook: () => Promise<void> | void): () => void {
    return this.beforeSignOut.add(hook);
  }

  /** `GET identity/subject`: the account this device's licence is in, or null. */
  async subject(): Promise<string | null> {
    const res = await this.withBearer(
      this.accountPath(this.accountEndpoint("subject")),
      { method: "GET" },
    );
    if (res.status !== 200) throw await refusal(res, `http_${res.status}`);
    const b = (await res.json().catch(() => ({}))) as { subject?: unknown };
    this.subjectValue = isString(b.subject) ? b.subject : null;
    return this.subjectValue;
  }

  /**
   * Sign out of the account: the pre-sign-out hooks, then `POST identity/signout`. On
   * `released: true` the server freed this device, so the token, the grants and the subject go;
   * on `released: false` the device keeps its token (it is still activated by key) and only the
   * subject is forgotten.
   */
  async signOut(): Promise<{ released: boolean }> {
    const path = this.accountPath(this.accountEndpoint("signout"));
    await this.beforeSignOut.run();
    const res = await this.withBearer(path, { method: "POST" });
    if (res.status !== 200) throw await refusal(res, `http_${res.status}`);
    const b = (await res.json().catch(() => ({}))) as { released?: unknown };
    if (typeof b.released !== "boolean")
      throw new PolarisError(
        "bad_response",
        "sign-out answered without `released`.",
      );
    if (b.released) await this.wipeLocal();
    else {
      this.subjectValue = null;
      // The device keeps its token but is no longer the person's sign-in.
      this.provenanceValue = "key";
      try {
        await this.store().provenance?.set("key");
      } catch {
        // The in-memory value holds for this page; a stale "signin" is the store's to fail closed.
      }
    }
    return { released: b.released };
  }

  /**
   * `POST identity/attach`. `confirm: false` previews the device's licence; `confirm: true`
   * puts it in the signed-in account, rotates and stores the token (the caller syncs, as after `activate`). A refusal is a
   * typed result that keeps every piece of state.
   */
  async attach(confirm: boolean): Promise<AttachResult> {
    const path = this.accountPath(this.accountEndpoint("attach"));
    const res = await this.withBearer(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status !== 200)
      return {
        kind: "refused",
        code: bodyCode(body) ?? `http_${res.status}`,
        status: res.status,
      };
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.status === "confirm") {
      const l = (b.license ?? {}) as Record<string, unknown>;
      return {
        kind: "confirm",
        license: {
          id: isString(l.id) ? l.id : "",
          tierId: isString(l.tierId) ? l.tierId : null,
          name: isString(l.name) ? l.name : null,
        },
      };
    }
    if (!isString(b.token))
      throw new PolarisError(
        "bad_response",
        "attach answered without a token.",
      );
    // Attaching never upgrades what the token was: a sign-out may have downgraded it.
    await this.setToken(b.token, "activate", true);
    this.subjectValue = isString(b.subject) ? b.subject : null;
    return {
      kind: "ok",
      subject: this.subjectValue,
      attached: b.attached === "claimed" ? "claimed" : null,
    };
  }

  // ── The licence choice (identity.choice, WIRE-CONTRACT-V4 §12.5.1) ─────────────────────────

  /** Whether discovery names all four `choice*` endpoints (a session may run `licenseChoice:
   *  "app"` only then). */
  get choiceAvailable(): boolean {
    const e = this.opts.choiceEndpoints?.();
    return (
      !!e &&
      isString(e.choiceLicenses) &&
      isString(e.choiceDevices) &&
      isString(e.choiceComplete) &&
      isString(e.choiceCancel)
    );
  }

  /** POST a JSON body to the named choice endpoint, no device bearer except for `keep` (the grant is the
   *  credential). A 5xx or a network failure throws; any other answer is returned. */
  private async choicePost(
    name: ChoiceEndpointName,
    body: Record<string, unknown>,
    bearer: string | null = null,
  ): Promise<{ res: Response; json: unknown }> {
    await this.init();
    if (!this.opts.enabled("identity"))
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.identityChoice,
          reason: "product",
          detail: "the product does not run the identity service",
        },
        ErrorCode.serviceUnavailable,
      );
    const url = this.opts.choiceEndpoints?.()?.[name];
    if (!isString(url))
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.identityChoice,
          reason: "product",
          detail: `this product's discovery names no identity ${name} endpoint`,
        },
        ErrorCode.serviceUnavailable,
      );
    let res: Response;
    try {
      res = await this.opts.fetchImpl(url, {
        method: "POST",
        credentials: "omit",
        headers: this.headers({
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        }),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new PolarisError(ErrorCode.networkError, (e as Error).message);
    }
    const json: unknown = await res
      .text()
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => null);
    if (res.status >= 500)
      throw new PolarisError(
        ErrorCode.serverError,
        `${name} failed with status ${res.status}.`,
        bodyCode(json) ?? undefined,
        undefined,
        { status: res.status },
      );
    return { res, json };
  }

  private refused(res: Response, json: unknown) {
    return choiceRefusal(
      res.status,
      bodyCode(json) ?? `http_${res.status}`,
      json,
      parseRetryAfter(res.headers.get("retry-after"), this.now()),
    );
  }

  private async choiceRead<V>(
    name: ChoiceEndpointName,
    body: Record<string, unknown>,
    valid: (v: unknown) => v is V,
  ): Promise<ChoiceViewResult<V>> {
    const { res, json } = await this.choicePost(name, body);
    if (res.status !== 200) return this.refused(res, json);
    if (!valid(json))
      throw new PolarisError(
        ErrorCode.badResponse,
        `${name} answered without a readable view.`,
        undefined,
        undefined,
        { status: 200 },
      );
    return { kind: "ok", view: json };
  }

  /** The licences the account can run this device on. */
  choiceLicenses(grant: string): Promise<ChoiceViewResult<LicenseChoiceView>> {
    return this.choiceRead("choiceLicenses", { grant }, isLicenseChoiceView);
  }

  /** The devices seated on a full licence, for Replace. */
  choiceDevices(
    grant: string,
    licenseId: string,
  ): Promise<ChoiceViewResult<ReplaceView>> {
    return this.choiceRead(
      "choiceDevices",
      { grant, licenseId },
      isReplaceView,
    );
  }

  /** Finish with the person's choice. Only `ok` stores the token (and syncs); a refusal keeps
   *  every piece of state, and one the person can fix (`device_limit`,
   *  `license_choice_required`) leaves the grant open. */
  async choiceComplete(
    grant: string,
    choice?: LicenseChoice,
    opts: ChoiceCompleteOptions = {},
  ): Promise<ChoiceCompleteResult> {
    // `keep` is proven by the device's own token; every other choice rides on the grant alone.
    const { res, json } = await this.choicePost(
      "choiceComplete",
      {
        grant,
        ...(choice ? { choice } : {}),
        ...(opts.consent
          ? { consent: { claims: [...opts.consent.claims] } }
          : {}),
      },
      choice?.kind === "keep" ? this.token : null,
    );
    if (res.status !== 200) return this.refused(res, json);
    const answer = (await import("./redirect.js")).parseTokenAnswer(200, json);
    if (answer.kind !== "token")
      throw new PolarisError(
        ErrorCode.badResponse,
        "choice complete answered without a complete sign-in.",
        undefined,
        undefined,
        { status: 200 },
      );
    const keyEntries =
      typeof json === "object" &&
      json !== null &&
      isChoiceCount((json as Record<string, unknown>).keyEntries)
        ? ((json as Record<string, unknown>).keyEntries as {
            used: number;
            limit: number;
          })
        : undefined;
    await this.setToken(answer.accessToken, "signin");
    await this.syncAfterSignIn();
    this.subjectValue = answer.subject;
    return {
      kind: "ok",
      licenseId:
        answer.license && typeof answer.license.id === "string"
          ? answer.license.id
          : null,
      subject: answer.subject,
      scope: answer.scope,
      ...(keyEntries ? { keyEntries } : {}),
      ...(choice?.kind === "keep" ? { attachable: true as const } : {}),
    };
  }

  /** Give the grant up (`204`). Nothing is stored. */
  async choiceCancel(grant: string): Promise<ChoiceCancelResult> {
    const { res, json } = await this.choicePost("choiceCancel", { grant });
    if (res.status === 204 || res.status === 200) return { kind: "ok" };
    return this.refused(res, json);
  }

  // ── The platform sign-in (identity.exchange, WIRE-CONTRACT-V5 §12.11.2-.3) ─────────────────

  /**
   * Sign in with a platform identity: a fresh nonce, the provider's token for it, the token
   * exchange with the `exchange` proof. A token is stored like any sign-in; every other answer
   * comes back as an outcome (`exchange.ts`). The nonce is spent by the attempt.
   */
  async exchange(
    port: DeviceKeyPort,
    opts: ExchangeOptions,
  ): Promise<ExchangeOutcome> {
    await this.init();
    // Lazy: the exchange is the ladder's rung, not the first paint's.
    const { runExchange } = await import("./exchange.js");
    return runExchange(
      {
        ...this.wire(),
        identityEnabled: this.opts.enabled("identity"),
        accept: async (token, subject) => {
          if (opts.mayStore && !(await opts.mayStore()))
            throw Object.assign(new Error("the sign-in was abandoned."), {
              name: "ExchangeAborted",
            });
          await this.setToken(token, "signin");
          this.subjectValue = subject;
          // The session is stored: a sync failure is reported beside the sign-in, not instead.
          try {
            await this.syncAfterSignIn();
          } catch (e) {
            return e instanceof PolarisError
              ? e
              : new PolarisError(ErrorCode.networkError, (e as Error).message);
          }
          return null;
        },
      },
      port,
      opts,
    );
  }

  // ── The link offer (identity.link, WIRE-CONTRACT-V5 §12.11.4) ──────────────────────────────

  /** What the exchange and the link calls (`link.ts`) share: the device, the product's endpoints and the
   *  transport (no ambient credential, the request deadline). */
  wire(): Omit<ExchangeContext, "identityEnabled" | "accept"> {
    return {
      product: this.opts.product,
      deviceId: this.deviceIdValue,
      endpoints: this.opts.exchangeEndpoints?.() ?? null,
      baseUrl: this.opts.baseUrl,
      headers: (extra) => this.headers(extra),
      send: (url, init) => this.sendTo(url, init),
      now: () => this.now(),
    };
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
        const retryAfter = parseRetryAfter(
          res.headers.get("retry-after"),
          this.opts.now(),
        );
        return {
          kind: "device-cap",
          limit: b.limit,
          deviceCount: b.deviceCount,
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        };
      }
      case 403: {
        const b = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; reason?: unknown };
          reason?: unknown;
          allowedRange?: AllowedRange;
        };
        // The reason is lifted from attacker-shaped JSON and ends up, unsigned, as the gate's
        // status: a body claiming `{"error":{"reason":"ok"}}` must not turn a 403 into a licensed
        // client. Anything outside the block vocabulary falls back exactly as a body that says
        // nothing at all does.
        const claimed = isBlockReason(b.error?.reason)
          ? b.error?.reason
          : isBlockReason(b.reason)
            ? b.reason
            : undefined;
        const reason: BlockReason =
          claimed ??
          (b.error?.code === "channel_not_allowed"
            ? "channel-not-entitled"
            : STRICTEST_BLOCK_REASON);
        return { kind: "blocked", reason, allowedRange: b.allowedRange };
      }
      case 200:
        return {
          kind: "ok",
          jws: await res.text(),
          etag: res.headers.get("etag"),
        };
      default: {
        const retryAfter = parseRetryAfter(
          res.headers.get("retry-after"),
          this.opts.now(),
        );
        return {
          kind: "error",
          status: res.status,
          message: await res.text().catch(() => ""),
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        };
      }
    }
  }

  /** Note a retryable failure (5xx, 429, network) for this pass's backoff decision. */
  private noteRetryable(retryAfter: number | undefined): void {
    const prev = this.passFailure?.retryAfter;
    const worst =
      retryAfter === undefined
        ? prev
        : prev === undefined
          ? retryAfter
          : Math.max(prev, retryAfter);
    this.passFailure = worst === undefined ? {} : { retryAfter: worst };
  }

  /**
   * Fetch, verify and install the trust manifest. Null when nothing acceptable arrived. When the
   * default manifest's signer is not a usable pin, retry with `?signer=<kid>` for each usable pin
   * (ascending kid bytes, at most `MAX_TRUST_SIGNER_ATTEMPTS`) and keep the first accepted
   * (WIRE-CONTRACT-V4 §2.3).
   */
  private async refreshTrust(): Promise<string | null> {
    return this.trustLocked(() => this.refreshTrustNow());
  }

  /** One manifest change at a time: a refresh and a peer's manifest do not interleave. */
  private trustLock: Promise<unknown> = Promise.resolve();
  private trustLocked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.trustLock.then(fn, fn);
    this.trustLock = run.catch(() => undefined);
    return run;
  }

  /**
   * A trust manifest a connected peer pushed (Connect, WIRE-CONTRACT-V5 §15.5): verified against
   * the usable pins under the rules the Worker's own manifest meets (signed by a usable pin, bound
   * to this product, fresh, newer than the one held: anti-rollback) and installed under the trust
   * lock, then persisted in the same slice a sync writes. Refused with the reason otherwise.
   */
  acceptPeerTrust(
    jws: string,
  ): Promise<{ applied: true } | { applied: false; reason: string }> {
    return this.trustLocked(async () => {
      await this.init();
      const m = await verifyTrustManifest(jws, {
        pinned: this.opts.pinned,
        tombstones: this.tombstones,
        expectedAud: this.opts.product,
        now: this.now(),
      });
      if (!m.doc) return { applied: false as const, reason: "invalid" };
      if (
        this.manifestIssuedAt !== undefined &&
        m.doc.issuedAt <= this.manifestIssuedAt
      )
        return { applied: false as const, reason: "not_newer" };
      this.installManifest(jws, m);
      await this.writeRecord({
        trustJws: jws,
        ...(Object.keys(this.evidence).length > 0
          ? { pinRevocations: { ...this.evidence } }
          : {}),
      });
      return { applied: true as const };
    });
  }

  private async refreshTrustNow(): Promise<string | null> {
    const fetchManifest = async (signer: string | null) => {
      const res = await this.send(
        signer === null
          ? ".well-known/polaris-trust.jws"
          : `.well-known/polaris-trust.jws?signer=${encodeURIComponent(signer)}`,
        { headers: { accept: "application/jose" } },
      );
      return res.ok ? res.text() : null;
    };
    const verify = (jws: string) =>
      verifyTrustManifest(jws, {
        pinned: this.opts.pinned,
        tombstones: this.tombstones,
        expectedAud: this.opts.product,
        // The effective clock (never behind a held floor), as every network path.
        now: this.now(),
        lastTrustIssuedAt: this.manifestIssuedAt,
      });
    const first = await fetchManifest(null);
    if (first === null) return null;
    let jws = first;
    let m = await verify(first);
    if (!m.doc) {
      const usable = usablePins(this.opts.pinned, this.tombstones);
      for (const signer of trustSignerOrder(usable, jwsHeaderKid(first))) {
        const retry = await fetchManifest(signer);
        if (retry === null) continue;
        const r = await verify(retry);
        if (r.doc) {
          jws = retry;
          m = r;
          break;
        }
      }
    }
    if (!m.doc) return null;
    this.installManifest(jws, m);
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
        this.noteRetryable(res.retryAfter);
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
          now: this.now(),
        };
        if (slice === "license") {
          const doc = await verifyLicenseDoc(res.jws, {
            ...opts,
            lastAcceptedIssuedAt: this.license?.doc.issuedAt ?? null,
          });
          if (!doc) return { kind: "error" };
          this.license = { jws: res.jws, doc };
          this.raiseFloor(doc.issuedAt);
        } else {
          const doc = await verifyConfigDoc(res.jws, {
            ...opts,
            lastAcceptedIssuedAt: this.config?.doc.issuedAt ?? null,
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
        if (res.status === 0 || res.status >= 500)
          this.noteRetryable(res.retryAfter);
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
    // Backing off (SP-R02): no request until the next allowed time; the cached documents stay
    // projected. A forced pass (an explicit user refresh) goes through.
    if (opts.force !== true && this.opts.now() < this.syncNotBefore)
      return {
        applied: false,
        documents: {},
        deferredUntil: this.syncNotBefore,
      };
    this.passFailure = null;
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
    // One backoff decision per pass: any retryable failure backs off further; a pass with none
    // that reached the server resets the counter.
    const failure = this.passFailure as { retryAfter?: number } | null;
    this.passFailure = null;
    if (failure) {
      this.syncFailures += 1;
      this.syncNotBefore =
        this.opts.now() +
        syncBackoffSeconds(
          this.syncFailures,
          failure.retryAfter,
          this.opts.random,
        );
    } else if (unauthorized && !healthy) {
      // A revoked token answers 401 every time. Revocation is reversible, so polling goes on,
      // but at a growing distance rather than on every automatic pass (the same curve as a 5xx).
      this.unauthorizedPasses += 1;
      this.syncFailures = 0;
      this.syncNotBefore =
        this.opts.now() +
        syncBackoffSeconds(
          this.unauthorizedPasses,
          undefined,
          this.opts.random,
        );
    } else if (healthy || blocked) {
      this.syncFailures = 0;
      this.unauthorizedPasses = 0;
      this.syncNotBefore = 0;
    }
    const patch: Partial<CacheRecordV3> = {};
    if (trustJws) {
      patch.trustJws = trustJws;
      // §4.1: a manifest that tombstoned a pin is its evidence, in the same write.
      if (Object.keys(this.evidence).length > 0)
        patch.pinRevocations = { ...this.evidence };
    }
    // A hard 401 deletes the slice it answered for, and a 403 build block deletes the
    // licence document, in the SAME write that sets the hint (hints are display-only: clearing
    // one must not hand back a usable cached document). The token and the floor stay.
    const revoked: Array<"license" | "config"> = [];
    if (license.kind === "unauthorized" || blocked) revoked.push("license");
    if (config.kind === "unauthorized") revoked.push("config");
    for (const slice of revoked) {
      this[slice] = null;
      const { [slice]: _doc, ...docs } = this.record?.docs ?? {};
      const { [slice]: _etag, ...etags } = this.record?.etags ?? {};
      patch.docs = docs;
      patch.etags = etags;
      this.record = { v: CACHE_VERSION, ...this.record, docs, etags };
    }
    if (unauthorized) patch.lastSyncUnauthorized = true;
    else if (healthy) patch.lastSyncUnauthorized = false;
    if (blocked?.kind === "blocked") patch.blocked = blocked.blocked;
    else if (healthy) patch.blocked = undefined;
    // An online document supersedes an imported bundle (§7).
    if (applied && this.record?.bundle) {
      patch.bundle = undefined;
      this.bundle = null;
    }
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

  // ── Cloud Sync key ring and device keys (sync.keyring, U-38.2) ──────────────────────────────

  /**
   * One authenticated request under `/<p>/` for the key ring engine and the Cloud Sync host
   * (`keepalive` lets the last flush of a closing page finish): the device bearer and the
   * seven `X-PKey-*` headers, no cookie. The caller reads the status; nothing here logs a body.
   */
  async ringRequest(
    path: string,
    init: { method: string; body?: string; keepalive?: boolean },
  ): Promise<Response> {
    await this.init();
    return this.send(path, {
      method: init.method,
      ...(init.keepalive ? { keepalive: true } : {}),
      headers: this.headers({
        authorization: `Bearer ${this.requireToken()}`,
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      }),
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  }

  /**
   * `PUT /<p>/devices/keys` (CC-03.2) with the port's public keys and a `keys` proof, as Node's
   * `devices.registerKeys`. Resending is safe. A memory-only port is refused unless
   * `allowEphemeral`; the private halves never leave the port.
   */
  async registerKeys(
    port: DeviceKeyPort,
    opts: { allowEphemeral?: boolean } = {},
  ): Promise<{ keySeq: number }> {
    await this.init();
    const token = this.requireToken();
    const { body } = await buildDeviceKeysRequest(port, {
      product: this.opts.product,
      deviceId: this.deviceIdValue,
      ...(opts.allowEphemeral ? { allowEphemeral: true } : {}),
    });
    const res = await this.send("devices/keys", {
      method: "PUT",
      headers: this.headers({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await refusal(res, "device_keys_failed");
    const out = (await res.json().catch(() => null)) as {
      keySeq?: unknown;
    } | null;
    if (
      typeof out?.keySeq !== "number" ||
      !Number.isSafeInteger(out.keySeq) ||
      out.keySeq < 1
    )
      throw new PolarisError(
        ErrorCode.badResponse,
        "devices/keys answered without a keySeq.",
      );
    return { keySeq: out.keySeq };
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

  /**
   * Journal a P6-03 update-health event for the next report (§3.13), with Node's defaults and
   * validation (`core/updateEvents.ts`): the outlet is the report's outlet id, the channel this
   * session's, the time now. Returns the entry, or null when a value was malformed (the event
   * is not recorded). The in-page journal keeps at most `MAX_JOURNAL` unsent events, dropping
   * the oldest, so a page that never reports cannot grow it without bound.
   */
  recordUpdateEvent(
    event: UpdateEvent,
    input: UpdateEventInput,
  ): UpdateEventEntry | null {
    let outlet: string | null = null;
    try {
      const o = this.opts.outlet?.();
      outlet = o && typeof o.id === "string" ? o.id : null;
    } catch {
      outlet = null;
    }
    const entry = buildUpdateEvent(event, input, {
      outlet,
      channel: this.channel,
      now: this.opts.now(),
      eventId: this.opts.eventId?.(event) ?? `${randomId()}-${event}`,
    });
    if (!entry) return null;
    this.journal.push(entry);
    if (this.journal.length > MAX_JOURNAL)
      this.journal.splice(0, this.journal.length - MAX_JOURNAL);
    return entry;
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
      const carried = new Set(
        (Array.isArray(body.updates)
          ? (body.updates as unknown as UpdateEventEntry[])
          : []
        ).map((u) => u.eventId),
      );
      const res = await this.send("devices/report", {
        method: "POST",
        headers: this.headers({
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify(body),
      });
      // By id, not by position: another report in flight (a flush that stopped waiting) may
      // have taken some of these out already, and an event recorded since must stay.
      if (res.ok && carried.size > 0)
        for (let i = this.journal.length - 1; i >= 0; i -= 1)
          if (carried.has(this.journal[i]!.eventId)) this.journal.splice(i, 1);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Send the journal now, for a page about to lose it: an install's reload, a rollback's
   * restart, a confirmation no later sync follows. It reports until nothing is waiting or a
   * report fails (each carries at most `MAX_REPORT_UPDATES`, oldest first), best effort, and
   * stops waiting after `FLUSH_WAIT_SECONDS`: the report in flight keeps its own 15 s deadline
   * and, if it lands, its events leave the journal. Does nothing when no event is waiting.
   * Never throws.
   */
  async flushUpdateEvents(): Promise<void> {
    if (this.journal.length === 0) return;
    const patience = new AbortController();
    const drain = async (): Promise<void> => {
      let more = true;
      while (more) more = (await this.report()) && this.journal.length > 0;
    };
    try {
      await Promise.race([
        drain().catch(() => undefined),
        sleepFor(FLUSH_WAIT_SECONDS, patience.signal).catch(() => undefined),
      ]);
    } finally {
      patience.abort();
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

  /** The post-acquisition sync. A product that serves neither the licence nor the config
   *  document has nothing to fetch, verify or report, so a sign-in alone leaves it at rest. */
  private async syncAfterSignIn(): Promise<void> {
    if (this.opts.enabled("license") || this.opts.enabled("config"))
      await this.sync();
  }

  /** `service-unavailable`: the product does not run Identity (the typed N/A Node gives). */
  private identityOff(feature: string): UnsupportedError {
    return new UnsupportedError(
      {
        supported: false,
        feature,
        reason: "product",
        detail: "the product does not run the identity service",
      },
      ErrorCode.serviceUnavailable,
    );
  }

  /** Begin a device-code sign-in. No bearer: a sign-in asks for the IDENTITY's credential. */
  async beginSignIn(
    opts: Partial<Omit<DeviceCodeSignInOptions, "channel">> = {},
  ): Promise<SignInPrompt> {
    await this.init();
    if (!this.opts.enabled("identity"))
      throw this.identityOff(Feature.identityDevicecode);
    const body: Record<string, string> = { deviceId: this.deviceIdValue };
    const label = this.deviceLabel(opts.deviceName);
    if (label) body.deviceName = label;
    if (opts.loginHint !== undefined) body.loginHint = opts.loginHint;
    if (opts.nameHint !== undefined) body.nameHint = opts.nameHint;
    if (opts.purpose !== undefined) body.purpose = opts.purpose;
    if (opts.scope !== undefined)
      body.scope =
        typeof opts.scope === "string" ? opts.scope : opts.scope.join(" ");
    if (opts.licenseChoice !== undefined)
      body.licenseChoice = opts.licenseChoice;
    const res = await this.postJson("identity/auth/device/start", body);
    // A 404 means the Worker serves no sign-in for this product (Identity off before discovery
    // said so): the typed N/A, as in Node.
    if (res.status === 404) throw this.identityOff(Feature.identityDevicecode);
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
      // The echo is what the page shows; an older Worker sends none, so show what was sent.
      deviceName:
        "deviceName" in b
          ? isString(b.deviceName)
            ? b.deviceName
            : null
          : label,
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
      reason?: unknown;
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
      case "error":
        return b.reason === DEVICE_POLL_DENIED
          ? {
              status: "error",
              message: "device sign-in was refused.",
              code: ErrorCode.signInDenied,
            }
          : {
              status: "error",
              message: "device sign-in failed.",
              code: ErrorCode.signInFailed,
            };
      case "ready": {
        if (!isString(b.token))
          return { status: "error", message: "ready without a token." };
        await this.setToken(b.token, "signin");
        await this.syncAfterSignIn();
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

  // ── Redirect sign-in (identity.redirect.web, WIRE-CONTRACT-V4 §12.4, §12.5) ──────────────

  /**
   * Build the authorize request for a navigation. Refuses before any request when the product
   * does not run Identity (`service-unavailable`) or its discovery serves no `authorize`, `token`
   * or `issuer` (`sign-in-unavailable`). The caller keeps the returned pending request (in
   * `sessionStorage`, across the navigation) for `redeemRedirect`.
   */
  async startRedirect(
    opts: Omit<RedirectSignInOptions, "channel">,
  ): Promise<RedirectPending> {
    if (!this.opts.enabled("identity"))
      throw this.identityOff(Feature.identityRedirectWeb);
    const found = this.opts.redirectEndpoints?.() ?? null;
    if (!found)
      throw new PolarisError(
        ErrorCode.signInUnavailable,
        "this product's discovery serves no redirect sign-in.",
      );
    const entropy = this.opts.redirectEntropy?.() ?? {};
    return await (
      await import("./redirect.js")
    ).beginRedirect({
      endpoints: found,
      clientId: this.opts.product,
      options: opts,
      entropy,
    });
  }

  /**
   * Redeem the callback a redirect brought back. Checks `state` and `iss` first (a mismatch is
   * `sign-in-failed`, nothing sent), then POSTs the form body to the token endpoint.
   * `error=access_denied` is `cancelled`; any other callback error is `sign-in-failed`; the
   * Worker's refusal is thrown under its own code (`invalid_grant`, `rate_limited` with
   * `retryAfterSeconds`, …) and changes nothing. Only `signedIn` stores a token (and syncs).
   */
  async redeemRedirect(
    pending: RedirectPending,
    callbackUrl: string,
    deviceName?: string | null,
  ): Promise<SignInOutcome> {
    await this.init();
    const answer = await (
      await import("./redirect.js")
    ).redeemCallback({
      pending,
      callbackUrl,
      deviceName,
      fetchImpl: this.opts.fetchImpl,
      headers: (extra) => this.headers(extra),
      now: this.now(),
      held: { token: this.token, baseUrl: this.opts.baseUrl },
    });
    if (answer.kind !== "token") return answer;
    await this.setToken(answer.accessToken, "signin");
    await this.syncAfterSignIn();
    this.subjectValue = answer.subject;
    const licenseId =
      answer.license && typeof answer.license.id === "string"
        ? answer.license.id
        : null;
    return {
      kind: "signedIn",
      subject: answer.subject,
      scope: answer.scope,
      activation: { licenseId },
    };
  }

  // ── Commerce (P6-01) ─────────────────────────────────────────────────────────────────────

  /** `GET /<p>/commerce/binding`. */
  async commerceBinding(): Promise<CommerceBinding> {
    await this.init();
    const res = await this.send("commerce/binding", {
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

  /** `POST /<p>/commerce/claim`. On `ok`, sync to receive the flag. */
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
    const res = await this.send("commerce/claim", {
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
