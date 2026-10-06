// The browser adapter: a cookie-session `PolarisAdapter` that talks to the control plane's
// first-party identity routes over `fetch(..., { credentials: "include" })` (the bearer-only,
// CORS-covered reads use `credentials: "omit"`). There is NO token/keyring/loopback here — the
// browser is online-only and the session lives in a first-party HttpOnly cookie the Worker
// sets. OIDC sign-in is a full-page navigation (`window.location.assign`), so the page unloads
// and `signInWithOidc` never resolves by design.
//
// ── ROUTES (§R1) ────────────────────────────────────────────────────────────────────────────
//
// The browser session and the OIDC flow are the IDENTITY service, so they live under
// `/<product>/identity/…`. The response shapes are unchanged from the pre-suite surface; only
// the mount point moved.
//
// ── ACTIVATION (§5) ─────────────────────────────────────────────────────────────────────────
//
// The gate's `activation` input is `"token"` for an authenticated session: the session cookie
// IS the credential here, standing in for the per-device `pkeyt_` token a native client holds.
//
// It is `"bundle"` for a page that imported an offline activation bundle (§7, P1b-07) and holds
// no session: the bundle is verified in-page against the pinned keys (`trust`) for a RANDOM
// device id kept in IndexedDB, and its signed artifacts are re-verified from IndexedDB on every
// load (`./offline.ts`). A session supersedes a bundle, as a token does in every other SDK.
//
// ── WHAT A BROWSER CANNOT DO ────────────────────────────────────────────────────────────────
//
// Device telemetry (`report()`) needs a device bearer, which a cookie session does not hold, so
// it throws `report-unsupported` — the `devices.report` web N/A the parity registry allows.
//
// ── UPDATE DECISIONS (wire v4) ──────────────────────────────────────────────────────────────
//
// `decideUpdate()` fetches the signed channel feed and the pinned release record, verifies both
// in-page through `@polaris-key/client-core` and decides (`./update.ts`). The `feeds` and
// `releaseRecords` slices persist beside the bundle cache in IndexedDB, as signed JWSs only, and
// are re-verified on every decision, so each channel's `seq` floor survives a reload. Without
// IndexedDB they live for the page's lifetime.
//
// Mode-parity: the adapter reduces the authenticated session read to the SAME `client-core`
// `GateInput` the desktop bridge produces and runs the SAME `licenseState`, so a browser
// snapshot is shape-identical to a desktop one.

import type { ManagedEntry } from "@polaris-key/protocol/core";
import { DELEGATED_KID_PATTERN } from "@polaris-key/protocol/release";
import {
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_VERSION,
} from "@polaris-key/protocol/core";
import type {
  BlockReason,
  DocProfile,
  LicenseDoc,
} from "@polaris-key/protocol/license";
import {
  CACHE_VERSION,
  channelForVersion,
  compareSemver,
  detectOutlet,
  detectionStamp,
  effectiveNow,
  highWaterMark,
  isValidHostOutlet,
  reloadFeeds,
  resolveUpdateOutlet,
  type DetectedOutlet,
  type HostOutlet,
  type OutletStamp,
  type ResolvedOutlet,
  type UpdateCheckContent,
  type VerifiedRevocation,
} from "@polaris-key/client-core";
import type { CapabilityContext } from "@polaris-key/client-core";
import type {
  BinaryMethod,
  FeedDeltas,
  InstalledBuild,
  UpdateCheck,
} from "@polaris-key/protocol/update";
import type { ProductCatalog } from "@polaris-key/catalog";
import { SDK_VERSION } from "../version.js";
import { readOutletSignals, type WebOutletEnvironment } from "./outlet.js";
import {
  configSource,
  currentDeviceFromState,
  listUserConfig,
  projectState,
  readConfig,
  readEntitled,
  readEntitledChannels,
} from "../core/adapter.js";
import { ErrorCode, Feature, Platform, SdkId } from "../constants.generated.js";
import { createStore, type Store } from "../core/store.js";
import {
  PolarisError,
  UnsupportedError,
  capabilityContext,
  capsIn,
  initialState,
  refuse,
  requireSupported,
  supportsIn,
  type ConfigSource,
  type Support,
  type DeviceInfo,
  type JSONValue,
  type OidcSignInHandle,
  type PolarisAdapter,
  type PolarisDocs,
  type PolarisState,
  type UserConfigEntry,
  type VersionCheck,
  type ChangelogEntry,
  type DownloadUrlOptions,
  type ImportBundleResult,
  type UpdateDecideOptions,
} from "../core/index.js";
import {
  copyServices,
  defaultServices,
  noBusy,
  noErrors,
  withBusy,
  withError,
  type ServiceBusyMap,
  type ServiceErrorMap,
  type ServicesMap,
} from "../core/services.js";
import { discoverProduct, type DiscoveryDocument } from "./discovery.js";
import {
  BearerSession,
  type AccountDevice,
  type SignInResult,
} from "./bearer/session.js";
import {
  indexedDbStore,
  memoryStore,
  type BrowserStore,
} from "./bearer/store.js";
import { browserFacts } from "./bearer/facts.js";
import { bearerBootDriver } from "./boot.js";
import {
  fetchReleaseBuild,
  fetchVerifiedRecord,
  type FetchTarget,
  type PartStore,
  type ReleaseFetchOptions,
  type ReleaseFetchResult,
} from "./releaseFetch.js";
import {
  browserPlatform,
  fetchDownloadModel,
  pickPlatform,
  type DownloadModel,
  type ThisPlatform,
} from "./distribution.js";
import {
  bootDecisionOf,
  runBoot,
  type BootDriver,
  type BootResult,
  type BootRunOptions,
} from "../core/boot.js";
import {
  crashTagsFor,
  type CrashTags,
  type CrashTagsOptions,
} from "../core/crash.js";
import type { FeedKind, FeedUrl, FeedUrlOptions } from "../core/types.js";
import { classifyActivation } from "../core/activation.js";
import { activationError } from "../core/activationError.js";
import type { HardwareFingerprint } from "@polaris-key/protocol/core";
import type { StoreStatus } from "@polaris-key/client-core";
import type {
  BrowserAuthMode,
  CommerceBinding,
  CommerceClaimResult,
  CommercePayload,
  CommerceStore,
  DeviceSignIn,
  DeviceSignInResult,
  MintedToken,
} from "../core/types.js";
import {
  buildDownloadUrlFor,
  decideBrowserUpdate,
  type UpdateSlices,
} from "./update.js";
import { fetchCatalog } from "./catalog.js";
import {
  buildDownloadUrl,
  buildInstallUrl,
  fetchChangelog,
} from "./release.js";
import {
  ensureRecord,
  importOfflineBundle,
  indexedDbOfflineStore,
  loadOffline,
  type OfflineState,
  type OfflineStore,
  type TrustSet,
} from "./offline.js";

const DEFAULT_BASE = "https://key.plrs.im";

/** The stamp a web runtime synthesises (plans/P3-01.md §2.9): a web build is a `web` outlet. */
export const WEB_OUTLET_STAMP: OutletStamp = {
  outlet: "web",
  outletKind: "web",
};

/** What a browser page needs for wire v4 update decisions (`decideUpdate()`). */
export interface BrowserUpdateConfig {
  /** `kid` → raw 32-byte Ed25519 release key, base64url: the only keys a release record verifies
   *  against. Compiled into the app, never persisted or extended from the network. Empty ⇒
   *  `decideUpdate()` throws `not-configured`; a key that is also a trust pin ⇒ the adapter's
   *  construction throws `invalid-options`. */
  pinnedReleaseKeys: TrustSet;
  /** The host's outlet: a kind (`"web"`) or `{id, kind, subkind?}`. It wins over the stamp; a
   *  value outside the vocabularies throws `invalid-options` at construction. */
  outlet?: HostOutlet;
  /** The build stamp's outlet fields. Defaults to `WEB_OUTLET_STAMP`. */
  stamp?: OutletStamp | null;
  /** A detection result the host computed itself. When it is absent and `outlet` is too, the
   *  adapter detects in-page (`detect`). */
  detected?: DetectedOutlet | null;
  /** Detect the outlet in-page when neither `outlet` nor `detected` is given: the page's
   *  display mode (`readOutletSignals`) and the stamp, through client-core's `detectOutlet`,
   *  whose result goes to `resolveUpdateOutlet` as `detected`. Default true. */
  detect?: boolean;
  /** What the in-page reader looks at; the page's globals by default (tests pass a fake). */
  outletEnvironment?: WebOutletEnvironment;
  /** The installed build. `version` defaults to the adapter's `version`; a browser is
   *  `platform: "web"`, `arch: "wasm32"`, with no format, engine or build number. */
  installed?: Partial<InstalledBuild>;
  /** What this host can do. Default `["download"]`. */
  methods?: BinaryMethod[];
  /**
   * The page's pack facet (`createBrowserPacks`). When given, `decideUpdate()` runs the content
   * decision (plans/P4-13.md §2.5, §2.6) over its content stamp, running set and stored
   * revocations, and hands the revocations it verified back to it.
   */
  packs?: {
    contentInput(): Promise<UpdateCheckContent | null>;
    recordRevocations(r: {
      learned: { revocation: VerifiedRevocation; jws: string }[];
      relearnCleared: string[];
    }): Promise<void>;
    /** plans/P4-29.md §2.4 step 1: the decided feed's delta menu, for the next installs. */
    recordFeedDeltas?(deltas: FeedDeltas | null): void;
    /** plans/P4-29.md §2.4 step 1: called once at construction with a reader of the most
     *  recently committed feed's menu in the adapter's cache, so installs before any decision
     *  still offer it. */
    seedFeedDeltas?(load: () => Promise<FeedDeltas | null>): void;
  };
}

function rawKeyBytes(key: string): string | null {
  try {
    const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
    return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return null;
  }
}

/** True when a pinned release key is also a pinned product key (compared as raw bytes). */
function releaseKeysOverlap(release: TrustSet, product: TrustSet): boolean {
  const pins = new Set(
    Object.values(product)
      .map(rawKeyBytes)
      .filter((k): k is string => k !== null),
  );
  return Object.values(release).some((k) => {
    const raw = rawKeyBytes(k);
    return raw !== null && pins.has(raw);
  });
}

export interface BrowserAdapterOptions {
  /** The product slug — path-scopes every request (`/<product>/...`). */
  productSlug: string;
  /** The control-plane origin. Defaults to `https://key.plrs.im`. */
  baseUrl?: string;
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable navigation (tests). Defaults to `window.location.assign`. */
  navigate?: (url: string) => void;
  /** Override the clock (seconds) — for tests. */
  now?: () => number;
  /** Client-supplied local/user overrides for `default`-state config keys. Never override
   *  `enforced`/`hidden` keys (server wins). */
  localOverrides?: Record<string, JSONValue>;
  /** The host app's version, reported as `X-PKey-Version` so a browser device row carries
   *  the same app-version metadata a native one does. Also the basis of `updateAvailable`. */
  version?: string;
  /** What the host EXPECTS this product to run, used only while discovery has not answered
   *  (D-21). Defaults to license + config; never all-true. */
  expectServices?: ServicesMap;
  /** The pinned trust keys (kid → raw Ed25519 public key, base64url). An offline bundle
   *  verifies against these ONLY (§7.1), so without them `importBundle` throws
   *  `bundle-import-unsupported` and no stored bundle is ever loaded. */
  trust?: { pinnedKeys: TrustSet };
  /** Where the random device id and an imported bundle live. Defaults to IndexedDB; `null`
   *  (or a runtime without IndexedDB) makes bundle import unsupported. */
  offlineStore?: OfflineStore | null;
  /** Wire v4 update decisions (`decideUpdate()`). Absent ⇒ it throws `not-configured`. Needs
   *  `trust.pinnedKeys` too: a feed verifies against the pinned product keys. */
  update?: BrowserUpdateConfig;
  /**
   * How the page authenticates (SDK-PARITY-PASS §3.17, owner decision Q1):
   *
   *   "auto" (the default)  bearer when the page runs inside Tauri or on another origin than
   *                         `baseUrl` (an opaque `"null"` origin counts as another), cookie
   *                         when it is first-party.
   *   "cookie"              the Worker's first-party session cookie. Same origin only: those
   *                         routes never answer CORS. Signed-out pages sign in by redirect.
   *   "bearer"              a `pkeyt_` device token in IndexedDB over the CORS-covered routes
   *                         (the product lists the page under `web.origins`). Needs
   *                         `trust.pinnedKeys`: every document is verified in-page.
   *
   * An explicit "bearer" without `trust.pinnedKeys` throws `invalid-options` at construction.
   * "auto" resolving to bearer without them does not throw (that would crash a render): the
   * adapter makes no request and reports `invalid-options` as the identity error in its state.
   */
  auth?: "cookie" | "bearer" | "auto";
  /** Bearer mode's `core.store`. Defaults to IndexedDB (`indexedDbStore`), or to a page-lived
   *  memory store where IndexedDB does not exist, which `storeStatus()` reports as degraded. */
  store?: BrowserStore;
  /** Bearer mode: register this device keylessly at load when it holds no token and discovery
   *  says the product's registration policy is `open`. Default true. */
  autoRegister?: boolean;
  /** A hashed hardware fingerprint for bearer requests. A browser has none (the default);
   *  the seam exists for tests and for hosts (a kiosk shell) that do. */
  fingerprint?: () => HardwareFingerprint | null;
  /** The page's own origin, for `auth: "auto"`. Defaults to `window.location.origin`. */
  pageOrigin?: string;
  /** Start loading at construction (default true). The Provider passes false and calls
   *  `start()` from an effect, so a server render performs no network call (SP-R13). */
  autoStart?: boolean;
}

/** The JSON shape the Worker's authenticated session endpoint returns. Unchanged by §R1's
 *  route move — only the path did. The document is still the FUSED v2 artifact, which this
 *  adapter splits into the v3 license/config pair at its own edge. */
interface SessionResponse {
  /** Whether the session cookie is present + valid (drives `activation`). */
  authenticated: boolean;
  doc: FusedSessionDoc | null;
  /** A 403-equivalent block, surfaced inline rather than as an HTTP error. */
  blocked?: {
    reason: BlockReason;
    allowedRange?: { min?: string; max?: string };
  };
  /** A CSRF token to echo back on writes (sign-out). */
  csrfToken?: string;
}

/** The fused document the identity session still mints (license claims + config + entitlements
 *  in one artifact). Kept local rather than imported from `@polaris-key/protocol`'s legacy barrel:
 *  nothing new may depend on that module, and this is the last surface that speaks it. */
interface FusedSessionDoc {
  schemaVersion?: number;
  aud: string;
  iss: string;
  licenseId: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  graceUntil: number;
  profile?: DocProfile;
  payload: {
    config: Record<string, ManagedEntry>;
    secrets?: Record<string, ManagedEntry>;
    entitlements: Record<string, ManagedEntry>;
  };
}

/**
 * Split the fused session document into the v3 pair. Grants (`entitlements`) ride the license
 * document (D-20); settings ride the config document. The claims envelope is shared, so both
 * halves carry the same `issuedAt`/`expiresAt`/`graceUntil` and the gate sees exactly what it
 * saw before the split.
 */
export function splitSessionDoc(doc: FusedSessionDoc | null): PolarisDocs {
  if (!doc) return { license: null, config: {} };
  const license: LicenseDoc = {
    iss: doc.iss,
    aud: doc.aud,
    deviceId: doc.deviceId,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
    graceUntil: doc.graceUntil,
    licenseId: doc.licenseId,
    entitlements: doc.payload.entitlements ?? {},
    ...(doc.profile ? { profile: doc.profile } : {}),
  };
  return { license, config: doc.payload.config ?? {} };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export class BrowserAdapter implements PolarisAdapter {
  readonly mode = "browser" as const;
  private readonly base: string;
  private readonly product: string;
  private readonly fetchImpl: typeof fetch;
  private readonly navigate: (url: string) => void;
  private readonly clock: () => number;
  private readonly store: Store<PolarisState>;
  private readonly localOverrides: Record<string, JSONValue>;
  private readonly version?: string;
  private csrf: string | null = null;
  private hadSession = false;
  private capabilities: ServicesMap;
  /** `supports()`'s inputs: the generated table, runtime `web`, and `capabilities` above. */
  private readonly capabilityCtx: CapabilityContext;
  private readonly pinned: TrustSet | null;
  private readonly offline: OfflineStore | null;
  /** The re-verified offline state (device id + imported bundle), once loaded. */
  private offlineState: OfflineState | null = null;
  private readonly updateConfig: BrowserUpdateConfig | null;
  private readonly updateOutlet: ResolvedOutlet | null;
  private readonly updateDetected: DetectedOutlet | null;
  /** The verified discovery document, once it answered. */
  private discovery_: DiscoveryDocument | null = null;
  private discovered: Promise<void> = Promise.resolve();
  /** The update slices when there is no offline store to keep them in. */
  private memorySlices: UpdateSlices = {};
  /** Decisions run one at a time: each is a read-modify-write of the slices. */
  private updateQueue: Promise<unknown> = Promise.resolve();
  /** How this page authenticates (§3.17). */
  readonly authMode: BrowserAuthMode;
  /** Bearer mode's engine; null in cookie mode. */
  private readonly bearer: BearerSession | null = null;
  private readonly bearerStore: BrowserStore | null = null;
  private readonly autoRegister: boolean;
  private started = false;
  /** The first load, once `start()` (or `boot()`) began it. */
  private loading: Promise<void> | null = null;
  /** Bytes of interrupted `releaseFetch` downloads, by payload SHA-256 (page-lived). */
  private readonly parts: PartStore = new Map();
  /** A configuration the adapter cannot run with that must not throw from the constructor
   *  ("auto" resolved to bearer without pinned keys). Every load and verb reports it. */
  private readonly configError: PolarisError | null = null;

  constructor(opts: BrowserAdapterOptions) {
    this.product = opts.productSlug;
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.navigate =
      opts.navigate ??
      ((url) => {
        if (typeof window !== "undefined") window.location.assign(url);
      });
    this.clock = opts.now ?? nowSec;
    this.localOverrides = opts.localOverrides ?? {};
    this.version = opts.version;
    // D-21: the pre-discovery belief. Never all-true.
    this.capabilities = copyServices(opts.expectServices ?? defaultServices());
    this.capabilityCtx = capabilityContext("web", () => this.capabilities);
    this.pinned = opts.trust?.pinnedKeys ?? null;
    this.offline =
      opts.offlineStore === undefined
        ? indexedDbOfflineStore()
        : opts.offlineStore;
    this.updateConfig = opts.update ?? null;
    this.updateOutlet = null;
    this.updateDetected = null;
    if (this.updateConfig) {
      const u = this.updateConfig;
      if (u.outlet !== undefined && !isValidHostOutlet(u.outlet))
        throw new PolarisError(
          "invalid-options",
          "update.outlet is not an outlet kind or {id, kind, subkind?}.",
        );
      // plans/P4-19.md §2.2: a delegated kid is never a pinned release key.
      if (
        Object.keys(u.pinnedReleaseKeys ?? {}).some((kid) =>
          DELEGATED_KID_PATTERN.test(kid),
        )
      )
        throw new PolarisError(
          "invalid-options",
          "update.pinnedReleaseKeys names a pkd1- kid: a delegated content key is reached only through a delegation, never pinned.",
        );
      if (releaseKeysOverlap(u.pinnedReleaseKeys ?? {}, this.pinned ?? {}))
        throw new PolarisError(
          "invalid-options",
          "A pinned release key is also a pinned product key; a release key is never a product key.",
        );
      const stamp = u.stamp === undefined ? WEB_OUTLET_STAMP : u.stamp;
      let detected = u.detected ?? null;
      // §2.9: detection runs at every launch and is never cached; a host value always wins.
      if (u.outlet === undefined && detected === null && u.detect !== false)
        detected = detectOutlet({
          stamp: detectionStamp(stamp),
          signals: readOutletSignals(u.outletEnvironment),
        });
      this.updateDetected = detected;
      this.updateOutlet = resolveUpdateOutlet({
        host: u.outlet,
        stamp,
        detected,
      });
    }
    this.authMode = resolveAuthMode(opts.auth, this.base, opts.pageOrigin);
    this.autoRegister = opts.autoRegister !== false;
    if (this.authMode === "bearer" && !this.pinned) {
      const err = new PolarisError(
        "invalid-options",
        opts.auth === "bearer"
          ? 'auth: "bearer" verifies every document in-page and needs trust.pinnedKeys.'
          : "This page is cross-origin to the Worker (or inside Tauri), so it authenticates with a device token, which verifies every document in-page and needs trust.pinnedKeys.",
      );
      if (opts.auth === "bearer") throw err;
      this.configError = err;
    } else if (this.authMode === "bearer" && this.pinned) {
      this.bearerStore =
        opts.store ??
        (opts.offlineStore === undefined
          ? indexedDbStore(this.product)
          : null) ??
        memoryStore(this.product, this.offline ?? undefined);
      this.bearer = new BearerSession({
        baseUrl: this.base,
        product: this.product,
        version: this.version ?? "0.0.0",
        fetchImpl: this.fetchImpl,
        now: this.clock,
        pinned: this.pinned,
        store: this.bearerStore,
        enabled: (slug) => this.capabilities[slug].enabled,
        ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
        facts: () => browserFacts(),
        caps: () => this.caps(),
        outlet: () =>
          this.updateOutlet
            ? ({
                id: this.updateOutlet.id,
                kind: this.updateOutlet.kind,
                ...(this.updateOutlet.subkind
                  ? { subkind: this.updateOutlet.subkind }
                  : {}),
              } as Record<string, JSONValue>)
            : null,
      });
    }
    this.store = createStore<PolarisState>(
      initialState("browser", this.capabilities, this.localOverrides),
    );
    this.updateConfig?.packs?.seedFeedDeltas?.(() =>
      this.committedFeedDeltas(),
    );
    if (opts.autoStart !== false) this.start();
  }

  /** Begin the first load. Idempotent; the constructor calls it unless `autoStart: false`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.loading = this.load();
  }

  /**
   * plans/P4-29.md §2.4 step 1: the delta menu of the most recently committed feed in the cache
   * (the highest `issuedAt` among the stored feeds that re-verify on the reload path, with no
   * freshness check: a stale menu only falls back), or null. A browser adapter has no configured
   * channel, so it is the feed the last decision committed. Reads only; never creates a record.
   */
  private async committedFeedDeltas(): Promise<FeedDeltas | null> {
    if (!this.offline || !this.pinned) return null;
    const record = await this.offline.read(this.product);
    const cache = record?.cache?.v === CACHE_VERSION ? record.cache : undefined;
    const committed = await reloadFeeds(cache?.feeds, {
      trust: this.pinned,
      expectedAud: this.product,
      platform: this.updateConfig?.installed?.platform ?? Platform.web,
    });
    let best: (typeof committed.feeds)[string] | null = null;
    for (const f of Object.values(committed.feeds))
      if (best === null || f.feed.issuedAt > best.feed.issuedAt) best = f;
    return best?.content.deltas ?? null;
  }

  /** The outlet update decisions use (`resolveUpdateOutlet`'s answer), or null without
   *  `update` options. For support diagnostics and UI. */
  get outlet(): ResolvedOutlet | null {
    return this.updateOutlet;
  }

  /** The in-page detection result `outlet` was resolved from, or the host's `detected`; null
   *  when the host named the outlet, turned detection off, or configured no updates. */
  get detected(): DetectedOutlet | null {
    return this.updateDetected;
  }

  snapshot(): PolarisState {
    return this.store.get();
  }

  subscribe(cb: (state: PolarisState) => void): () => void {
    return this.store.subscribe(cb);
  }

  private url(path: string): string {
    return `${this.base}/${this.product}${path}`;
  }

  /**
   * The same `X-PKey-*` metadata the native SDKs send, so a browser device row is not a
   * blank entry in the admin panel next to fully described native ones.
   *
   * Browsers send NO hardware fingerprint — canvas/WebGL-style fingerprinting is unreliable,
   * actively degraded by browsers, and privacy-hostile — so these headers plus the User-Agent
   * the browser adds itself are the entire honest signal available here. The values are
   * WIRE-CONTRACT-V3 §5.2's: platform `web`, SDK id `react`, and no `X-PKey-Arch` (a browser's
   * JavaScript has no architecture to report).
   */
  private metadataHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      [HEADER_PLATFORM]: Platform.web,
      [HEADER_SDK_NAME]: SdkId.react,
      [HEADER_SDK_VERSION]: SDK_VERSION,
    };
    if (this.version) headers[HEADER_VERSION] = this.version;
    return headers;
  }

  private apply(
    s: SessionResponse,
    flags: { busy?: ServiceBusyMap; error?: ServiceErrorMap } = {},
  ): void {
    if (s.csrfToken) this.csrf = s.csrfToken;
    this.hadSession = s.authenticated;
    // §7: with no session, an imported bundle is the activation. A session supersedes it.
    if (!s.authenticated && this.offlineState?.importedBundle) {
      this.applyOffline(flags);
      return;
    }
    const docs = splitSessionDoc(s.doc);
    this.store.set(
      projectState(
        "browser",
        docs,
        {
          // The cookie session stands in for the per-device token (§5).
          activation: s.authenticated ? "token" : null,
          now: this.clock(),
          // §4.2 — the floor over what this client has verified. Online-only, so the only
          // dated artifact is the session document; a browser has no cached trust manifest to
          // fold in and no offline window for a rolled-back clock to buy time inside.
          highWaterMark: highWaterMark(docs.license ? [docs.license] : []),
          lastSyncUnauthorized: false,
          blocked: s.blocked ?? null,
          lastVerifiedAt: docs.license ? this.clock() : null,
        },
        {
          ...flags,
          localOverrides: this.localOverrides,
          capabilities: this.capabilities,
        },
      ),
    );
  }

  /** Project the imported bundle's re-verified documents: `activation: "bundle"` when it
   *  carried a licence, otherwise settings only (a config-only bundle grants nothing, D-08). */
  private applyOffline(
    flags: { busy?: ServiceBusyMap; error?: ServiceErrorMap } = {},
  ): void {
    const o = this.offlineState;
    this.store.set(
      projectState(
        "browser",
        { license: o?.license ?? null, config: o?.config?.config ?? {} },
        {
          activation: o?.license ? "bundle" : null,
          now: this.clock(),
          highWaterMark: o?.highWaterMark ?? 0,
          lastSyncUnauthorized: false,
          blocked: null,
          lastVerifiedAt: o?.lastVerifiedAt ?? null,
        },
        {
          ...flags,
          localOverrides: this.localOverrides,
          capabilities: this.capabilities,
        },
      ),
    );
  }

  /** Re-verify whatever bundle IndexedDB holds. A store that cannot be read is "no bundle". */
  private async loadOfflineState(): Promise<void> {
    if (!this.offline || !this.pinned) return;
    const record = await this.offline.read(this.product);
    this.offlineState = record
      ? await loadOffline(record, {
          pinned: this.pinned,
          product: this.product,
          now: this.clock(),
        })
      : null;
  }

  /** Re-project the current snapshot with a new busy/error map (no transport round-trip). */
  private patch(mutate: (prev: PolarisState) => Partial<PolarisState>): void {
    this.store.set((prev) => {
      const next = mutate(prev);
      const changed = (Object.keys(next) as (keyof PolarisState)[]).some(
        (k) => prev[k] !== next[k],
      );
      return changed ? { ...prev, ...next } : prev;
    });
  }

  private setBusy(slug: Parameters<typeof withBusy>[1], busy: boolean): void {
    this.patch((prev) => ({ busy: withBusy(prev.busy, slug, busy) }));
  }

  private fail(
    slug: Parameters<typeof withError>[1],
    err: PolarisError,
  ): PolarisError {
    this.patch((prev) => ({
      busy: withBusy(prev.busy, slug, false),
      error: withError(prev.error, slug, err),
    }));
    return err;
  }

  /** Install the product's real capability map from discovery (D-21). A failed or rejected
   *  document leaves the constructor's `expectServices` belief in place. */
  private loadCapabilities(): Promise<void> {
    this.discovered = (async () => {
      const result = await discoverProduct({
        baseUrl: this.base,
        product: this.product,
        fetchImpl: this.fetchImpl,
      });
      if (result.kind === "ok") {
        this.capabilities = result.services;
        this.discovery_ = result.document;
      }
    })().catch(() => undefined);
    return this.discovered;
  }

  /** Read the authenticated session/config in one round-trip. */
  private async fetchSession(): Promise<SessionResponse> {
    const res = await this.fetchImpl(this.url("/identity/session"), {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json", ...this.metadataHeaders() },
    });
    if (res.status === 401) {
      // Was authenticated, now isn't → revoked; never authenticated → needs-activation.
      return { authenticated: false, doc: null };
    }
    if (!res.ok) {
      throw new PolarisError("network", `session ${res.status}`);
    }
    return (await res.json()) as SessionResponse;
  }

  private async load(): Promise<void> {
    if (this.configError) {
      this.store.set(() =>
        projectState(
          "browser",
          { license: null, config: {} },
          { activation: null, now: this.clock(), highWaterMark: 0 },
          {
            error: withError(noErrors(), "identity", this.configError!),
            localOverrides: this.localOverrides,
            capabilities: this.capabilities,
          },
        ),
      );
      return;
    }
    if (this.bearer) return this.loadBearer();
    const sessionRequest = this.fetchSession();
    const capabilities = this.loadCapabilities().catch(() => undefined);
    const offline = this.loadOfflineState().catch(() => undefined);
    try {
      const session = await sessionRequest;
      await capabilities;
      await offline;
      this.apply(session);
    } catch (e) {
      await capabilities;
      await offline;
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("network", (e as Error).message);
      // Offline is exactly when an imported bundle matters: it still activates the page.
      if (this.offlineState?.importedBundle) {
        this.applyOffline({ error: withError(noErrors(), "identity", err) });
        return;
      }
      this.store.set(() =>
        projectState(
          "browser",
          { license: null, config: {} },
          { activation: null, now: this.clock(), highWaterMark: 0 },
          {
            error: withError(noErrors(), "identity", err),
            localOverrides: this.localOverrides,
            capabilities: this.capabilities,
          },
        ),
      );
    }
  }

  // ── Bearer mode (§3.17) ────────────────────────────────────────────────────────────────

  /** Project the bearer session's verified state, exactly as the desktop adapter projects a
   *  bridge's (`BridgeState`). */
  private applyBearer(
    flags: { busy?: ServiceBusyMap; error?: ServiceErrorMap } = {},
  ): void {
    const s = this.bearer!.syncState();
    this.store.set(
      projectState(
        "browser",
        { license: s.doc, config: s.config ?? {} },
        {
          activation: s.activation,
          now: this.clock(),
          highWaterMark: s.highWaterMark ?? 0,
          lastSyncUnauthorized: s.lastSyncUnauthorized,
          blocked: s.blocked ?? null,
          lastVerifiedAt: s.lastVerifiedAt ?? null,
        },
        {
          ...flags,
          localOverrides: this.localOverrides,
          capabilities: this.capabilities,
        },
      ),
    );
  }

  /** The registration policy discovery published (`core.registration`), or null. */
  private registrationPolicy(): string | null {
    const core = this.discovery_?.core as
      | { registration?: unknown }
      | undefined;
    return typeof core?.registration === "string" ? core.registration : null;
  }

  private async loadBearer(): Promise<void> {
    const b = this.bearer!;
    const capabilities = this.loadCapabilities().catch(() => undefined);
    try {
      await b.init();
      await capabilities;
      // A config-only (or otherwise `open`) product's page becomes a device keylessly.
      if (
        !b.hasToken &&
        this.autoRegister &&
        this.registrationPolicy() === "open"
      )
        await b.register();
      if (b.hasToken) await b.sync();
      this.applyBearer();
    } catch (e) {
      await capabilities;
      this.applyBearer({
        error: withError(
          noErrors(),
          "license",
          e instanceof PolarisError
            ? e
            : new PolarisError("network", (e as Error).message),
        ),
      });
    }
  }

  /** The bearer session, or the typed refusal a cookie page gives for a bearer-only verb. */
  private requireBearer(feature: string, detail: string): BearerSession {
    if (this.bearer) return this.bearer;
    if (this.configError) throw this.configError;
    throw new UnsupportedError(
      { supported: false, feature, reason: "runtime", detail },
      feature === Feature.devicesManage
        ? "device-management-unsupported"
        : feature === Feature.devicesReport
          ? ErrorCode.reportUnsupported
          : "unsupported",
      detail,
    );
  }

  /** `POST /<p>/devices/register` (bearer mode): the keyless mint, then a sync. */
  async register(): Promise<boolean> {
    const b = this.requireBearer(Feature.devicesRegister, COOKIE_DETAIL);
    const r = await b.register();
    if (r.kind !== "ok") return false;
    await b.sync().catch(() => undefined);
    this.applyBearer({ busy: noBusy(), error: noErrors() });
    return true;
  }

  async refresh(): Promise<void> {
    if (this.configError) throw this.fail("license", this.configError);
    if (this.bearer) return this.refreshBearer();
    this.setBusy("license", true);
    this.setBusy("config", true);
    try {
      const s = await this.fetchSession();
      // Distinguish "never had a session" from "session was revoked".
      if (!s.authenticated && this.hadSession) {
        this.store.set((prev) =>
          projectState(
            "browser",
            { license: null, config: {} },
            {
              activation: "token",
              now: this.clock(),
              highWaterMark: prev.highWaterMark,
              lastSyncUnauthorized: true,
            },
            {
              localOverrides: this.localOverrides,
              capabilities: this.capabilities,
            },
          ),
        );
        return;
      }
      this.apply(s, { busy: noBusy(), error: noErrors() });
    } catch (e) {
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("refresh-failed", (e as Error).message);
      this.patch((prev) => ({
        busy: withBusy(withBusy(prev.busy, "license", false), "config", false),
        error: withError(prev.error, "license", err),
      }));
      throw err;
    }
  }

  private async refreshBearer(): Promise<void> {
    this.setBusy("license", true);
    this.setBusy("config", true);
    try {
      await this.bearer!.sync();
      this.applyBearer({ busy: noBusy(), error: noErrors() });
    } catch (e) {
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("refresh-failed", (e as Error).message);
      this.patch((prev) => ({
        busy: withBusy(withBusy(prev.busy, "license", false), "config", false),
        error: withError(prev.error, "license", err),
      }));
      throw err;
    }
  }

  /** Cookie mode: the OIDC redirect (never resolves: the page unloads). Bearer mode: a
   *  device-code sign-in whose handle carries the URL and code, completed in the background. */
  async signInWithOidc(): Promise<OidcSignInHandle | void> {
    if (this.configError) throw this.fail("identity", this.configError);
    if (this.bearer) {
      const flow = await this.beginSignIn();
      void flow.wait().catch(() => undefined);
      return {
        verificationUrl: flow.verificationUriComplete,
        userCode: flow.userCode,
      };
    }
    if (!this.capabilities.identity.enabled) {
      throw this.fail(
        "identity",
        new PolarisError(
          "service-disabled",
          "OIDC login is not enabled for this product.",
        ),
      );
    }
    // Full-page redirect to the Worker's OIDC entrypoint; it round-trips back with a
    // set-cookie. The page unloads, so this Promise intentionally never resolves.
    const ret =
      typeof window !== "undefined" ? window.location.href : this.base;
    const target = `${this.url("/identity/auth/start")}?return_to=${encodeURIComponent(ret)}`;
    this.navigate(target);
  }

  async submitKey(key: string): Promise<void> {
    if (this.configError) throw this.fail("license", this.configError);
    if (!this.capabilities.license.enabled) {
      throw this.fail(
        "license",
        new PolarisError(
          "key-entry-unsupported",
          "Key entry is not enabled for this product.",
        ),
      );
    }
    this.setBusy("license", true);
    if (this.bearer) {
      try {
        const outcome = await this.bearer.activate(key);
        if (outcome.kind !== "ok") throw activationError(outcome);
        await this.bearer.sync();
        this.applyBearer({ busy: noBusy(), error: noErrors() });
        return;
      } catch (e) {
        throw this.fail(
          "license",
          e instanceof PolarisError
            ? e
            : new PolarisError("sign-in-failed", (e as Error).message),
        );
      }
    }
    try {
      const res = await this.fetchImpl(this.url("/identity/session/license"), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...this.metadataHeaders(),
        },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) {
        // SDK-PARITY-PASS §3.1: classify by the body's code, never by status alone — an
        // unknown 403 is `refused` with the server's code, never "device limit".
        const body: unknown = await res.json().catch(() => null);
        throw activationError(
          classifyActivation(res.status, body, res.headers.get("retry-after")),
        );
      }
      this.apply(await this.fetchSession(), {
        busy: noBusy(),
        error: noErrors(),
      });
    } catch (e) {
      throw this.fail(
        "license",
        e instanceof PolarisError
          ? e
          : new PolarisError("sign-in-failed", (e as Error).message),
      );
    }
  }

  async signOut(): Promise<void> {
    if (this.configError) throw this.fail("identity", this.configError);
    this.setBusy("identity", true);
    if (this.bearer) {
      try {
        await this.bearer.deactivate();
        this.applyBearer({ busy: noBusy(), error: noErrors() });
        return;
      } catch (e) {
        throw this.fail(
          "identity",
          e instanceof PolarisError
            ? e
            : new PolarisError("sign-out-failed", (e as Error).message),
        );
      }
    }
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.csrf) headers["x-csrf-token"] = this.csrf; // CSRF echo on the write.
      const res = await this.fetchImpl(this.url("/identity/auth/logout"), {
        method: "POST",
        credentials: "include",
        headers,
      });
      if (!res.ok && res.status !== 401) {
        throw new PolarisError("sign-out-failed", `logout ${res.status}`);
      }
      this.csrf = null;
      this.hadSession = false;
      // A sign-out wipes local state, the imported bundle included (the device id stays: it is
      // this browser's identity, not a credential).
      if (this.offlineState?.importedBundle && this.offline) {
        // The update slices are signed public documents, not credentials: they stay, so a
        // channel's `seq` floor survives a sign-out.
        const prior = await this.offline.read(this.product);
        const slices = {
          ...(prior?.cache?.feeds ? { feeds: prior.cache.feeds } : {}),
          ...(prior?.cache?.releaseRecords
            ? { releaseRecords: prior.cache.releaseRecords }
            : {}),
        };
        await this.offline.write(this.product, {
          deviceId: this.offlineState.deviceId,
          ...(Object.keys(slices).length > 0
            ? { cache: { v: CACHE_VERSION, ...slices } }
            : {}),
        });
      }
      this.offlineState = null;
      this.store.set(() =>
        projectState(
          "browser",
          { license: null, config: {} },
          { activation: null, now: this.clock(), highWaterMark: 0 },
          {
            localOverrides: this.localOverrides,
            capabilities: this.capabilities,
          },
        ),
      );
    } catch (e) {
      throw this.fail(
        "identity",
        e instanceof PolarisError
          ? e
          : new PolarisError("sign-out-failed", (e as Error).message),
      );
    }
  }

  currentDevice(): DeviceInfo | null {
    return currentDeviceFromState(this.store.get());
  }

  /**
   * A cookie session holds no `pkeyt_` bearer token, and `/<p>/devices` authenticates with
   * one — so remote device management is genuinely unreachable from a browser rather than
   * merely unimplemented. `DeviceManager` renders this refusal as an explanation.
   */
  async listDevices(): Promise<DeviceInfo[]> {
    const b = this.requireBearer(
      Feature.devicesManage,
      'Listing devices needs a device token; this page uses the cookie session (auth: "bearer" adds it).',
    );
    this.setBusy("license", true);
    try {
      const rows = await b.listDevices();
      this.setBusy("license", false);
      return rows.map(deviceInfo);
    } catch (e) {
      throw this.fail("license", asError(e));
    }
  }

  async renameDevice(deviceId: string, label: string | null): Promise<void> {
    const b = this.requireBearer(
      Feature.devicesManage,
      'Renaming devices needs a device token; this page uses the cookie session (auth: "bearer" adds it).',
    );
    this.setBusy("license", true);
    try {
      await b.renameDevice(deviceId, label);
      this.setBusy("license", false);
    } catch (e) {
      throw this.fail("license", asError(e));
    }
  }

  async deauthorizeDevice(deviceId: string): Promise<void> {
    const current = this.currentDevice();
    if (current?.id === deviceId) {
      await this.signOut();
      return;
    }
    const b = this.requireBearer(
      Feature.devicesManage,
      'Disconnecting another device needs a device token; this page uses the cookie session (auth: "bearer" adds it).',
    );
    this.setBusy("license", true);
    try {
      await b.deauthorizeDevice(deviceId);
      await b.sync().catch(() => undefined);
      this.applyBearer({ busy: noBusy(), error: noErrors() });
    } catch (e) {
      throw this.fail("license", asError(e));
    }
  }

  /** `GET /<product>/update/version` — the newest build on a channel plus whether the HOST
   *  application (not the SDK) is behind it, computed with the same `compareSemver` the
   *  server's build gate uses. */
  async checkUpdate(opts: { channel?: string } = {}): Promise<VersionCheck> {
    if (!this.capabilities.update.enabled) {
      throw this.fail(
        "update",
        new PolarisError(
          "service-disabled",
          "This product does not publish updates.",
        ),
      );
    }
    this.setBusy("update", true);
    try {
      const url = new URL(this.url("/update/version"));
      if (opts.channel) url.searchParams.set("channel", opts.channel);
      const res = await this.fetchImpl(url.toString(), {
        method: "GET",
        // `update/version` is bearer-only and CORS-covered: no ambient credential. (The
        // identity session routes keep `include`: they are first-party, cookie-bearing and never
        // CORS-covered.)
        credentials: "omit",
        headers: { accept: "application/json", ...this.metadataHeaders() },
      });
      if (!res.ok) {
        throw new PolarisError("network", `update/version ${res.status}`);
      }
      const body = (await res.json()) as {
        version: string;
        tag: string;
        url: string;
      };
      this.patch((prev) => ({
        busy: withBusy(prev.busy, "update", false),
        error: withError(prev.error, "update", null),
      }));
      return {
        ...body,
        updateAvailable:
          compareSemver(this.version ?? "0.0.0", body.version) < 0,
      };
    } catch (e) {
      throw this.fail(
        "update",
        e instanceof PolarisError
          ? e
          : new PolarisError("network", (e as Error).message),
      );
    }
  }

  /**
   * The wire v4 update decision (`./update.ts`): the feed and record verified in-page, the
   * slices persisted, the `UpdateCheck` returned. Throws `not-configured` without
   * `update.pinnedReleaseKeys` (or `trust.pinnedKeys`), `service-unavailable` when discovery
   * lacks the v4 endpoints, and §2.5's code when nothing committed is left to decide from.
   */
  decideUpdate(opts: UpdateDecideOptions = {}): Promise<UpdateCheck> {
    const run = this.updateQueue.then(() => this.decideNow(opts));
    this.updateQueue = run.catch(() => undefined);
    return run;
  }

  private async decideNow(opts: UpdateDecideOptions): Promise<UpdateCheck> {
    const u = this.updateConfig;
    if (
      !u ||
      !this.updateOutlet ||
      !this.pinned ||
      Object.keys(u.pinnedReleaseKeys ?? {}).length === 0
    ) {
      throw this.fail(
        "update",
        new PolarisError(
          "not-configured",
          "Update decisions need update.pinnedReleaseKeys and trust.pinnedKeys.",
        ),
      );
    }
    this.setBusy("update", true);
    try {
      await this.discovered;
      const record = this.offline
        ? await ensureRecord(this.offline, this.product)
        : null;
      // §4.1: a cache of another version is discarded, never read.
      const cache =
        record?.cache?.v === CACHE_VERSION ? record.cache : undefined;
      const slices: UpdateSlices = record
        ? {
            feeds: cache?.feeds ?? {},
            releaseRecords: cache?.releaseRecords ?? {},
          }
        : this.memorySlices;
      // plans/P4-13.md §2.5: a page with a pack facet runs the content decision; one whose facet
      // cannot start (no OPFS, an invalid stamp) decides without it, as before P4-13.
      const content = u.packs
        ? await u.packs.contentInput().catch(() => null)
        : null;
      const result = await decideBrowserUpdate({
        ...opts,
        baseUrl: this.base,
        product: this.product,
        fetchImpl: this.fetchImpl,
        headers: this.metadataHeaders(),
        discovery: this.discovery_,
        trust: this.pinned,
        releaseKeys: u.pinnedReleaseKeys,
        // §2.5: the effective clock, max(system, highWaterMark) (V3 §4.2), so winding the
        // system clock back cannot revive an expired feed (§2.3).
        now: effectiveNow(this.clock(), this.store.get().highWaterMark),
        installId: record?.deviceId ?? null,
        installed: {
          version: this.version ?? "",
          buildNumber: null,
          platform: Platform.web,
          arch: "wasm32",
          format: null,
          engine: null,
          ...u.installed,
        },
        outlet: this.updateOutlet,
        methods: u.methods ?? ["download"],
        cache: slices,
        ...(content ? { content } : {}),
      });
      await this.writeSlices(result.cache);
      if (result.revocations && u.packs)
        await u.packs.recordRevocations(result.revocations);
      u.packs?.recordFeedDeltas?.(result.feedDeltas);
      this.patch((prev) => ({
        busy: withBusy(prev.busy, "update", false),
        error: withError(prev.error, "update", null),
      }));
      return result.check;
    } catch (e) {
      throw this.fail(
        "update",
        e instanceof PolarisError
          ? e
          : new PolarisError("network", (e as Error).message),
      );
    }
  }

  /** Core's read-modify-write of the update slices: everything else in the record stays. */
  private async writeSlices(slices: Required<UpdateSlices>): Promise<void> {
    if (!this.offline) {
      this.memorySlices = slices;
      return;
    }
    const record = await ensureRecord(this.offline, this.product);
    // A cache of another version is replaced, never relabelled (§4.1).
    const prior =
      record.cache?.v === CACHE_VERSION ? record.cache : { v: CACHE_VERSION };
    await this.offline.write(this.product, {
      ...record,
      cache: {
        ...prior,
        v: CACHE_VERSION,
        feeds: slices.feeds,
        releaseRecords: slices.releaseRecords,
      },
    });
  }

  /** A build's download URL, from discovery's `distribution.endpoints.builds` template. */
  async buildUrl(version: string, buildId: string): Promise<string | null> {
    await this.discovered;
    return buildDownloadUrlFor(this.discovery_, this.base, version, buildId);
  }

  /** The metadata a public read carries; in bearer mode, plus the device bearer, so an
   *  `entitled` changelog or a licensed download answers this device (§3.17). */
  private requestOpts() {
    const token = this.bearer?.bearer ?? null;
    return {
      baseUrl: this.base,
      product: this.product,
      fetchImpl: this.fetchImpl,
      headers: {
        ...this.metadataHeaders(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  }

  /** D-21 for Release: refuse before any dial when the product does not run it. */
  private requireRelease(): void {
    if (!this.capabilities.release.enabled) {
      throw this.fail(
        "release",
        new PolarisError(
          "service-disabled",
          "This product does not run the Release service.",
        ),
      );
    }
  }

  async fetchSchema(): Promise<ProductCatalog | null> {
    // D-21: a product without Config is not even probed. Diagnostic: never throws.
    if (!this.capabilities.config.enabled) return null;
    return fetchCatalog(this.requestOpts());
  }

  async changelog(): Promise<ChangelogEntry[]> {
    this.requireRelease();
    this.setBusy("release", true);
    try {
      const entries = await fetchChangelog(this.requestOpts());
      this.patch((prev) => ({
        busy: withBusy(prev.busy, "release", false),
        error: withError(prev.error, "release", null),
      }));
      return entries;
    } catch (e) {
      throw this.fail(
        "release",
        e instanceof PolarisError
          ? e
          : new PolarisError("network", (e as Error).message),
      );
    }
  }

  async installUrl(): Promise<string> {
    this.requireRelease();
    return buildInstallUrl(this.base, this.product);
  }

  async downloadUrl(
    version: string,
    binary: string,
    arch: string,
    opts: DownloadUrlOptions = {},
  ): Promise<string> {
    this.requireRelease();
    return buildDownloadUrl(
      this.base,
      this.product,
      version,
      binary,
      arch,
      opts,
    );
  }

  /** This browser's device id — the id an operator mints an offline bundle against. Minted
   *  (randomly) and persisted on first use; `null` where there is nowhere to keep it. In bearer
   *  mode it is also the id the device token is bound to: one device, online or offline. */
  async offlineDeviceId(): Promise<string | null> {
    if (this.bearer) {
      await this.bearer.init();
      return this.bearer.deviceId;
    }
    if (!this.offline) return null;
    return (await ensureRecord(this.offline, this.product)).deviceId;
  }

  async importBundle(jws: string): Promise<ImportBundleResult> {
    if (!this.offline || !this.pinned) {
      throw this.fail(
        "license",
        new PolarisError(
          ErrorCode.bundleImportUnsupported,
          this.offline
            ? "Offline bundles need the pinned trust keys (pass { trust: { pinnedKeys } })."
            : "This browser has no IndexedDB to keep an offline bundle in.",
        ),
      );
    }
    this.setBusy("license", true);
    try {
      const result = await importOfflineBundle(
        this.offline,
        this.product,
        jws,
        {
          pinned: this.pinned,
          now: this.clock(),
        },
      );
      await this.loadOfflineState();
      if (this.bearer) {
        await this.bearer.reload();
        this.applyBearer({ busy: noBusy(), error: noErrors() });
        return result;
      }
      if (this.hadSession) {
        // A session supersedes the bundle (§7): the gate does not move.
        this.patch((prev) => ({
          busy: withBusy(prev.busy, "license", false),
          error: withError(prev.error, "license", null),
        }));
      } else {
        this.applyOffline({ busy: noBusy(), error: noErrors() });
      }
      return result;
    } catch (e) {
      throw this.fail(
        "license",
        e instanceof PolarisError
          ? e
          : new PolarisError("unknown", (e as Error).message),
      );
    }
  }

  /** `POST /<p>/devices/report`: bearer mode only. A cookie session holds no device bearer, so
   *  it refuses with the typed `report-unsupported`, stated rather than silently skipped. */
  async report(): Promise<boolean> {
    const b = this.requireBearer(
      Feature.devicesReport,
      'Device telemetry needs a device token; this page uses the cookie session (auth: "bearer" adds it).',
    );
    return b.report();
  }

  async enroll(): Promise<void> {
    const b = this.requireBearer(Feature.licenseEnroll, COOKIE_DETAIL);
    this.setBusy("license", true);
    try {
      const outcome = await b.enroll();
      if (outcome.kind !== "ok") throw activationError(outcome);
      await b.sync();
      this.applyBearer({ busy: noBusy(), error: noErrors() });
    } catch (e) {
      throw this.fail("license", asError(e, "sign-in-failed"));
    }
  }

  async beginSignIn(opts: { deviceName?: string } = {}): Promise<DeviceSignIn> {
    if (!this.capabilities.identity.enabled)
      throw this.fail(
        "identity",
        new UnsupportedError(
          {
            supported: false,
            feature: Feature.identityDevicecode,
            reason: "product",
            detail: "the product does not run the identity service",
          },
          "service-disabled",
        ),
      );
    const b = this.requireBearer(
      Feature.identityDevicecode,
      'A browser on the cookie session signs in by redirect (signInWithOidc); device-code sign-in needs auth: "bearer".',
    );
    this.setBusy("identity", true);
    try {
      const prompt = await b.beginSignIn(opts);
      return {
        userCode: prompt.userCode,
        verificationUri: prompt.verificationUri,
        verificationUriComplete: prompt.verificationUriComplete,
        expiresAt: prompt.expiresAt,
        interval: prompt.interval,
        wait: async (w = {}) => {
          try {
            const r = await b.waitForSignIn(prompt, w);
            const out = signInResult(r);
            if (out.status === "ready")
              this.applyBearer({ busy: noBusy(), error: noErrors() });
            else
              this.fail(
                "identity",
                new PolarisError(
                  out.status === "expired"
                    ? "sign-in-expired"
                    : "sign-in-failed",
                  out.status === "error" ? out.message : out.status,
                ),
              );
            return out;
          } catch (e) {
            this.setBusy("identity", false);
            throw e;
          }
        },
      };
    } catch (e) {
      throw this.fail("identity", asError(e, "sign-in-unavailable"));
    }
  }

  async mintToken(recipeId: string): Promise<MintedToken> {
    if (!this.capabilities.config.enabled)
      throw this.fail(
        "config",
        new PolarisError(
          "service-disabled",
          "This product does not run Config.",
        ),
      );
    const b = this.requireBearer(
      Feature.configMint,
      'Edge-mint needs a device token; this page uses the cookie session (auth: "bearer" adds it).',
    );
    try {
      return await b.mint(recipeId);
    } catch (e) {
      throw this.fail("config", asError(e));
    }
  }

  private requireCommerce(): BearerSession {
    if (
      !this.capabilities.license.enabled ||
      !this.capabilities.distribution.enabled
    )
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.commerceReceipt,
          reason: "product",
          detail: "commerce needs the license and distribution services",
        },
        "service-unavailable",
      );
    return this.requireBearer(
      Feature.commerceReceipt,
      'A commerce claim needs a device token; this page uses the cookie session (auth: "bearer" adds it).',
    );
  }

  async commerceBinding(): Promise<CommerceBinding> {
    return this.requireCommerce().commerceBinding();
  }

  async commerceClaim(
    store: CommerceStore,
    payload: CommercePayload,
  ): Promise<CommerceClaimResult> {
    const b = this.requireCommerce();
    const r = await b.commerceClaim(store, payload);
    if (r.kind === "ok") {
      await b.sync().catch(() => undefined);
      this.applyBearer({ busy: noBusy(), error: noErrors() });
    }
    return r;
  }

  async discovery(): Promise<Record<string, unknown> | null> {
    await this.discovered;
    return this.discovery_ ?? null;
  }

  async storeStatus(): Promise<StoreStatus | null> {
    if (!this.bearerStore) return null;
    try {
      return await this.bearerStore.status();
    } catch {
      return null;
    }
  }

  entitledChannels(): string[] {
    return readEntitledChannels(this.store.get());
  }

  getConfig<T = JSONValue>(key: string, fallback: T): T {
    return readConfig(this.store.get(), key, fallback);
  }

  listUserConfig(): UserConfigEntry[] {
    return listUserConfig(this.store.get());
  }

  getConfigSource(key: string): ConfigSource {
    return configSource(this.store.get(), key);
  }

  getSecret(_key: string): string | null {
    // Secrets are never delivered to a browser session: the `config.secret` web N/A, stated as
    // a typed refusal rather than an indistinguishable `null`.
    refuse(this.capabilityCtx, Feature.configSecret, {
      detail: "Secrets are never delivered to a browser session.",
    });
  }

  supports(feature: string): Support {
    // A cookie page cannot do what needs a device token, whatever the web row says (§3.17):
    // the same `runtime` answer the registry allows for the web, with the reason in `detail`.
    if (!this.bearer && BEARER_ONLY.has(feature)) {
      const s = supportsIn(this.capabilityCtx, feature);
      return s.supported
        ? {
            supported: false,
            feature,
            reason: "runtime",
            detail: COOKIE_DETAIL,
          }
        : s;
    }
    return supportsIn(this.capabilityCtx, feature);
  }

  caps(): string[] {
    return capsIn(this.capabilityCtx).filter(
      (f) => this.bearer !== null || !BEARER_ONLY.has(f),
    );
  }

  isEntitled(name: string): boolean {
    return readEntitled(this.store.get(), name);
  }

  // ── SP-12: boot, the verified download, the download model, feed URLs, crash tags ──────

  /** Discovery, once: the in-flight load's, or a fetch of its own before `start()`. */
  private async ensureDiscovery(): Promise<void> {
    if (this.discovery_) return;
    if (this.started) await this.discovered;
    if (!this.discovery_) await this.loadCapabilities();
  }

  /** The decision a boot makes, when the page configured update decisions. */
  private bootDecide(): BootDriver["decide"] | undefined {
    const u = this.updateConfig;
    if (!u || Object.keys(u.pinnedReleaseKeys ?? {}).length === 0)
      return undefined;
    return async () => {
      const check = await this.decideUpdate();
      return { decision: bootDecisionOf(check), check };
    };
  }

  /** One-call boot (ui.boot). See `PolarisAdapter.boot` and core/boot.ts. */
  async boot(opts: BootRunOptions = {}): Promise<BootResult> {
    if (this.configError) throw this.fail("identity", this.configError);
    // A Provider may already have started the first load: let it land, then boot over it.
    if (this.started) await this.loading?.catch(() => undefined);
    const fresh = !this.started;
    this.started = true;
    const decide = this.bootDecide();
    const driver: BootDriver = this.bearer
      ? bearerBootDriver({
          session: this.bearer,
          discover: () => this.ensureDiscovery(),
          registrationPolicy: () => this.registrationPolicy(),
          licenseEnabled: () => this.capabilities.license.enabled,
          status: () => {
            this.applyBearer();
            return this.store.get().status;
          },
          changed: () => this.applyBearer(),
          ...(decide ? { decide } : {}),
        })
      : this.cookieBootDriver(fresh, decide);
    const run = runBoot(driver, opts);
    if (fresh) this.loading = run.then(() => undefined);
    const result = await run;
    if (this.bearer) this.applyBearer();
    return result;
  }

  /** The cookie page's driver: the first load (discovery, the session, an imported bundle), then
   *  a session refresh for each later pass. No keyless registration: a cookie page is signed in
   *  by redirect, and holds no device token. */
  private cookieBootDriver(
    fresh: boolean,
    decide: BootDriver["decide"] | undefined,
  ): BootDriver {
    let loaded = !fresh;
    return {
      discover: async () => {
        if (!loaded) {
          await this.load();
          loaded = true;
          // The first pass is this load's; report it as the sync below.
          return;
        }
        await this.ensureDiscovery();
      },
      hasToken: () => this.hadSession,
      registrationPolicy: () => this.registrationPolicy(),
      licenseEnabled: () => this.capabilities.license.enabled,
      enroll: async () => {
        await this.enroll();
        return true;
      },
      sync: (() => {
        let first = fresh;
        return async () => {
          if (first) {
            first = false;
            const err = this.store.get().error.identity;
            return err && err.code === "network" ? "offline" : "ok";
          }
          try {
            await this.refresh();
            return "ok";
          } catch (e) {
            return (e as PolarisError).code === "refresh-failed" ||
              (e as PolarisError).code === "network"
              ? "offline"
              : "error";
          }
        };
      })(),
      status: () => this.store.get().status,
      ...(decide ? { decide } : {}),
    };
  }

  /** The verified download (release.fetch): bearer delivery, Range resume, size and SHA-256
   *  checked against the verified record. Resolves to the payload as a `Blob`. */
  async releaseFetch(
    target: FetchTarget,
    opts: ReleaseFetchOptions = {},
  ): Promise<ReleaseFetchResult> {
    await this.ensureDiscovery();
    requireSupported(this.capabilityCtx, Feature.releaseFetch);
    // Before `start()` (or a boot) the session has not read its stored token yet.
    await this.bearer?.init();
    const record =
      "record" in target ? target.record : await this.verifiedRecord(target);
    const buildId = "action" in target ? target.build : target.buildId;
    try {
      return await fetchReleaseBuild({
        baseUrl: this.base,
        product: this.product,
        fetchImpl: this.fetchImpl,
        discovery: this.discovery_,
        headers: this.bearer ? this.bearer.headers() : this.metadataHeaders(),
        bearer: this.bearer?.bearer ?? null,
        record,
        ...(buildId ? { buildId } : {}),
        parts: this.parts,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      throw e instanceof PolarisError ? this.fail("release", e) : e;
    }
  }

  /** The release record a hash (or a `binary` decision) names, verified against the pinned
   *  release keys only. */
  private async verifiedRecord(
    target: Exclude<FetchTarget, { record: unknown }>,
  ) {
    const sha256 = "action" in target ? target.release.sha256 : target.sha256;
    const releaseKeys = this.updateConfig?.pinnedReleaseKeys ?? {};
    if (!sha256)
      throw new PolarisError(
        "invalid-options",
        "This decision names no release record hash.",
      );
    if (!this.pinned || Object.keys(releaseKeys).length === 0)
      throw new PolarisError(
        "not-configured",
        "Fetching a release record by hash needs update.pinnedReleaseKeys and trust.pinnedKeys; pass the verified record instead.",
      );
    return fetchVerifiedRecord({
      baseUrl: this.base,
      product: this.product,
      fetchImpl: this.fetchImpl,
      discovery: this.discovery_,
      headers: this.metadataHeaders(),
      sha256,
      releaseKeys,
      productTrust: this.pinned,
    });
  }

  /** The public download model (release.distribution). No credential goes with it. */
  async downloadModel(opts: { channel?: string } = {}): Promise<DownloadModel> {
    await this.ensureDiscovery();
    requireSupported(this.capabilityCtx, Feature.releaseDistribution);
    return fetchDownloadModel({
      baseUrl: this.base,
      product: this.product,
      fetchImpl: this.fetchImpl,
      ...(opts.channel ? { channel: opts.channel } : {}),
    });
  }

  /** The visitor's platform's group of the download model (or `platform`'s). */
  async thisPlatform(
    opts: { channel?: string; platform?: string } = {},
  ): Promise<ThisPlatform> {
    const model = await this.downloadModel(
      opts.channel ? { channel: opts.channel } : {},
    );
    return pickPlatform(model, opts.platform ?? browserPlatform());
  }

  /** A page has no native updater: the registry's runtime N/A, as a result. */
  async feedUrl(kind: FeedKind, opts: FeedUrlOptions = {}): Promise<FeedUrl> {
    void kind;
    void opts;
    const s = supportsIn(this.capabilityCtx, Feature.updateFeeds);
    if (!s.supported) return s;
    throw new Error(
      "update.feeds: the capability table says it is supported on web, but a page has no native updater feed",
    );
  }

  /** The crash-reporter tags (crash.tags): the page's version, its channel and the outlet update
   *  decisions resolved (`unknown` without update options). */
  async crashTags(opts: CrashTagsOptions = {}): Promise<CrashTags> {
    const version = this.version ?? "0.0.0";
    return crashTagsFor({
      version,
      channel: channelForVersion(version),
      outlet: this.updateOutlet?.id ?? null,
      ...opts,
    });
  }

  dispose(): void {
    // No long-lived listeners/timers to clean up in browser mode.
  }
}

/** What a cookie page says about a verb that needs a device token. */
const COOKIE_DETAIL =
  'This page uses the cookie session, which holds no device token; pass auth: "bearer" (with trust.pinnedKeys and the page under the product\'s web.origins) to enable it.';

/** The features only bearer mode serves on the web (the rows SP-R02 moved from N/A). */
const BEARER_ONLY = new Set<string>([
  Feature.coreStore,
  Feature.coreCache,
  Feature.devicesRegister,
  Feature.devicesManage,
  Feature.devicesReport,
  Feature.licenseEnroll,
  Feature.licenseReregister,
  Feature.identityDevicecode,
  Feature.configMint,
  Feature.commerceReceipt,
]);

/** True when the page runs inside a Tauri webview: Tauri's injected globals, or its custom
 *  protocol / `tauri.localhost` origin. A Tauri page is never first-party to the Worker. */
export function isTauriPage(pageOrigin?: string | null): boolean {
  const g = globalThis as Record<string, unknown>;
  if (g.__TAURI_INTERNALS__ !== undefined || g.__TAURI__ !== undefined)
    return true;
  if (!pageOrigin || pageOrigin === "null") return false;
  try {
    const u = new URL(pageOrigin);
    return u.protocol === "tauri:" || u.hostname === "tauri.localhost";
  } catch {
    return false;
  }
}

/** The page's own origin, SSR-safe: null where there is no `window.location`. */
function currentPageOrigin(): string | null {
  try {
    return typeof window !== "undefined" && window.location
      ? window.location.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * `auth` resolved (owner decision Q1). "auto" (the default) is bearer when the page runs inside
 * Tauri or on another origin than the Worker (an opaque `"null"` origin counts as another),
 * and cookie when the page is first-party. With no page at all (a server render) it is cookie:
 * nothing loads there anyway.
 */
export function resolveAuthMode(
  requested: "cookie" | "bearer" | "auto" | undefined,
  base: string,
  pageOrigin?: string,
): BrowserAuthMode {
  if (requested === "bearer") return "bearer";
  if (requested === "cookie") return "cookie";
  const page = pageOrigin ?? currentPageOrigin();
  if (isTauriPage(page)) return "bearer";
  if (page === null) return "cookie";
  if (page === "null") return "bearer";
  try {
    return new URL(base).origin === page ? "cookie" : "bearer";
  } catch {
    return "cookie";
  }
}

function deviceInfo(d: AccountDevice): DeviceInfo {
  return {
    id: d.id,
    current: d.current === true,
    status: (d.status as DeviceInfo["status"]) ?? "ok",
    ...(d.licenseId ? { licenseId: d.licenseId } : {}),
    ...(d.lastSeen !== undefined ? { lastVerifiedAt: d.lastSeen } : {}),
    label: d.label ?? null,
    platform: d.platform ?? null,
    arch: d.arch ?? null,
    appVersion: d.appVersion ?? null,
    sdkName: d.sdkName ?? null,
    sdkVersion: d.sdkVersion ?? null,
  };
}

function signInResult(r: SignInResult): DeviceSignInResult {
  if (r.status === "ready")
    return r.identity
      ? { status: "ready", identity: r.identity }
      : { status: "ready" };
  if (r.status === "expired") return { status: "expired" };
  return { status: "error", message: r.message };
}

function asError(
  e: unknown,
  fallback: "network" | "sign-in-failed" | "sign-in-unavailable" = "network",
): PolarisError {
  return e instanceof PolarisError
    ? e
    : new PolarisError(fallback, (e as Error)?.message ?? String(e));
}

/** Construct a browser adapter (the canonical factory the Provider uses). */
export function browserAdapter(opts: BrowserAdapterOptions): PolarisAdapter {
  return new BrowserAdapter(opts);
}
