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
//
// ── THE COOKIE-SESSION TRUST MODEL (say it out loud) ────────────────────────────────────────
//
// In cookie mode, the default for a first-party page, this adapter runs NO signature
// verification, and that is a property of the SERVER, not a gap here: `GET /<p>/identity/session`
// deliberately answers with the fused document as PLAIN JSON inside the response body, never as
// a compact JWS. There is nothing to verify: the Worker mints that document for a page rather
// than for an SDK, and a page has no cache or disk boundary for a signature to survive across.
//
// So authenticity here rests on exactly two things:
//
//   1. TLS to the control-plane origin, enforced at construction by `normalizeBaseUrl` below
//      (`https:`, or `http:` on loopback for `wrangler dev`); and
//   2. a first-party `HttpOnly; Secure; SameSite=Lax` session cookie the Worker set on that
//      same origin.
//
// `SameSite=Lax` is not incidental: a browser does not attach a Lax cookie to a CROSS-SITE
// subresource request, so `fetch(..., { credentials: "include" })` from a page on another origin
// carries no session at all. Cookie mode is therefore SAME-ORIGIN ONLY. A cross-origin page
// uses bearer mode instead (`auth: "bearer"`, or `"auto"` resolving to it): a `pkeyt_` device
// token over the CORS-covered routes, with every document verified in the page against the
// pinned keys. The token needs the same TLS, so the same rule gates both modes.

import type { ManagedEntry } from "@polaris-key/protocol/core";
import {
  BrowserPresentationSource,
  memoryPresentationCache,
  type PresentationCache,
  type ReactPresentationSource,
} from "../core/presentation.js";
import { DELEGATED_KID_PATTERN } from "@polaris-key/protocol/release";
import {
  HEADER_DEVICE,
  HEADER_LICENSE,
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_VERSION,
} from "@polaris-key/protocol/core";
import { isBlockReason } from "@polaris-key/protocol/license";
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
import type {
  CapabilityContext,
  DeviceKeyPort,
} from "@polaris-key/client-core";
import type { RootVault } from "./ring/rootVault.js";
import {
  lazyKeyring,
  unsupportedKeyring,
  type KeyringClient,
} from "../core/keyring.js";
import {
  lazyCloudSync,
  unsupportedCloudSync,
  type CloudSyncClient,
} from "../core/cloudSync.js";
import type { CloudSyncHostOptions } from "./cloudSync/host.js";
import type { CloudSyncOwner } from "./cloudSync/create.js";
import {
  createCloudConnect,
  lazyConnect,
  unsupportedCloudConnect,
  unsupportedConnect,
  type CloudConnectClient,
  type ConnectClient,
} from "./connect/index.js";
import { stopForSignOut as stopCloudConnectForSignOut } from "./connect/signout.js";
import { clientBackendAction } from "@polaris-key/client-core/backend";
import type {
  BinaryMethod,
  FeedDeltas,
  InstalledBuild,
  UpdateCheck,
  UpdateDecision,
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
  refreshFailure,
  standingRefusals,
  withOverrides,
} from "../core/adapter.js";
import {
  ErrorCode,
  Feature,
  Platform,
  SdkId,
  UpdateEvent,
} from "../constants.generated.js";
import type {
  UpdateEventEntry,
  UpdateEventInput,
} from "../core/updateEvents.js";
import { createStore, type Store } from "../core/store.js";
import { developerError } from "../core/devNotice.js";
import {
  PolarisError,
  UnsupportedError,
  capabilityContext,
  capsIn,
  initialState,
  isSecureTransportUrl,
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
import { expectedServicesOf } from "../core/expectedServices.js";
import {
  copyServices,
  type ServiceSlug,
  noBusy,
  noErrors,
  withBusy,
  withError,
  type ServiceBusyMap,
  type ServiceErrorMap,
  type ServicesMap,
  licenseGateEnabled,
} from "../core/services.js";
import {
  discoverProduct,
  exchangeDiscoveryOf,
  type DiscoveryDocument,
} from "./discovery.js";
import { BearerSession, type AccountDevice } from "./bearer/session.js";
import {
  BearerDeviceCodeSession,
  BearerRedirectSession,
  completeRedirect,
  type SettleHooks,
} from "./bearer/signInSessions.js";
import { choiceEndpointsOf, type ChoiceNamespace } from "../core/choice.js";
import {
  callbackState,
  redirectEndpointsOf,
  sessionStorageStash,
  type AutoSignInOptions,
  type AutoSignInResult,
  type DeviceCodeSignInSession,
  type PlatformIdentityProvider,
  type RedirectSignInSession,
  type SignInNamespace,
  type SignInOptions,
  type SignInOutcome,
} from "../core/signIn.js";
import {
  indexedDbStore,
  memoryStore,
  type BrowserStore,
} from "./bearer/store.js";
import { browserFacts } from "./bearer/facts.js";
import { bearerBootDriver } from "./boot.js";
import type {
  FetchTarget,
  PartStore,
  ReleaseFetchOptions,
  ReleaseFetchResult,
} from "./releaseFetch.js";
import {
  browserPlatform,
  fetchDownloadModel,
  pickPlatform,
  type DownloadModel,
  type ThisPlatform,
} from "./distribution.js";
import type { BootDriver, BootResult, BootRunOptions } from "../core/boot.js";
import {
  crashTagsFor,
  type CrashTags,
  type CrashTagsOptions,
} from "../core/crash.js";
import type { BootAttempt } from "../core/bootGuard.js";
import type { InstallOptions, InstallOutcome } from "../core/install.js";
import type { BrowserBootGuard } from "./bootGuard.js";
import type { SwContainer } from "./serviceWorkerUpdate.js";
import type { FeedKind, FeedUrl, FeedUrlOptions } from "../core/types.js";
import type { LinkClient } from "../core/link.js";
import { classifyActivation, readKeyEntries } from "../core/activation.js";
import {
  AccountFeature,
  accountEndpointsOf,
  accountUnavailable,
  openPortal,
} from "../core/account.js";
import { activationError } from "../core/activationError.js";
import type { HardwareFingerprint } from "@polaris-key/protocol/core";
import type { StoreStatus } from "@polaris-key/client-core";
import type {
  AttachResult,
  BrowserAuthMode,
  KeyActivation,
  SignOutResult,
  CommerceBinding,
  CommerceClaimResult,
  CommercePayload,
  CommerceStore,
  MintedToken,
} from "../core/types.js";
import { buildDownloadUrlFor } from "./urls.js";
import type { UpdateSlices } from "./update.js";
import { fetchCatalog } from "./catalog.js";
import {
  LocalConfigEngine,
  browserLocalConfigBackend,
  type ConfigStorage,
} from "../core/localConfig.js";
import { storageNamespace, storeNamespace } from "../core/storeNamespace.js";
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

/**
 * Thrown at construction for a `baseUrl` that would carry the session cookie, or the device
 * bearer, in the clear. The other SDKs refuse the same URLs under the same class name
 * (`@polaris-key/node`'s `InsecureBaseUrlError`); it extends `PolarisError`, so this package's
 * one `e instanceof PolarisError` convention and its `.code` keep working for callers.
 */
export class InsecureBaseUrlError extends PolarisError {
  constructor(message: string) {
    super(ErrorCode.insecureBaseUrl, message);
    this.name = "InsecureBaseUrlError";
  }
}

/** Strip the trailing slash, but only after refusing a base URL the credential cannot be sent to
 *  safely. A plaintext control plane makes session theft a coffee-shop attack rather than a
 *  local one, and a `Secure` cookie is not even sent over `http:` off loopback, so an unenforced
 *  scheme is a silent, permanently signed-out client at best. */
function normalizeBaseUrl(raw: string): string {
  if (!isSecureTransportUrl(raw)) {
    throw new InsecureBaseUrlError(
      `baseUrl must be https: (got ${raw}); ` +
        "plaintext http:// is only accepted for localhost/127.0.0.1.",
    );
  }
  return raw.replace(/\/+$/, "");
}

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
  /** The control-plane origin, and in cookie mode the origin the page itself must be served from
   *  (the session cookie is `SameSite=Lax`). MUST be `https:`, or `http://localhost` /
   *  `http://127.0.0.1` for local development: anything else throws `InsecureBaseUrlError` at
   *  construction. Defaults to `https://key.plrs.im`. */
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
  /** Where `config.set()` keeps device-local overrides (`config.local`). Defaults to
   *  `localStorage`, under one key per product; `null` (or storage that throws) keeps them in
   *  memory, which `config.persistent()` reports. */
  configStorage?: ConfigStorage | null;
  /** The product catalog `config.set()` validates against. Absent ⇒ fetched once
   *  (`fetchSchema()`) on the first write. */
  catalog?: ProductCatalog | null;
  /** The host app's version, reported as `X-PKey-Version` so a browser device row carries
   *  the same app-version metadata a native one does. Also the basis of `updateAvailable`. */
  version?: string;
  /** What the host EXPECTS this product to run, used only while discovery has not answered
   *  (D-21). Defaults to license + config; never all-true. */
  expectedServices?: readonly ServiceSlug[];
  /** The pinned trust keys (kid → raw Ed25519 public key, base64url). An offline bundle
   *  verifies against these ONLY (§7.1), so without them `importBundle` throws
   *  `bundle-import-unsupported` and no stored bundle is ever loaded. */
  trust?: { pinnedKeys: TrustSet };
  /** Where the random device id and an imported bundle live. Defaults to IndexedDB; `null`
   *  (or a runtime without IndexedDB) makes bundle import unsupported. */
  offlineStore?: OfflineStore | null;
  /** Where discovery's presentation member and its icon are kept (HA-13). Defaults to IndexedDB
   *  (its own database); memory when there is none, or when `offlineStore` is given. */
  presentationCache?: PresentationCache | null;
  /** Wire v4 update decisions (`decideUpdate()`). Absent ⇒ it throws `not-configured`. Needs
   *  `trust.pinnedKeys` too: a feed verifies against the pinned product keys. */
  update?: BrowserUpdateConfig;
  /**
   * The platform identity the `autoSignIn()` ladder asks (default: Google through FedCM, using
   * the server client id discovery names). `null`: no provider, so the ladder stops at the form.
   */
  platformIdentity?: PlatformIdentityProvider | null;
  /**
   * Cloud Sync for settings (sync.settings, bearer mode only). `encryption` is the product's mode
   * (default `"e2e"`; app code only, never read from the Worker), `catalog` the compiled mirror
   * (`pkey mirror`, authoritative for every key it names) and `aliases` the renames the app
   * declares. Nothing loads until `adapter.cloudSync.host()`.
   */
  cloudSync?: CloudSyncHostOptions;
  /**
   * The Cloud Sync key ring (sync.keyring, bearer mode only). `deviceKeys` is the device key store
   * (default `createWebDeviceKeyStore()`, IndexedDB with a memory fallback); a memory-only store
   * makes the ring unlock-only (recovery code), with the root held in memory. `vault` is where the
   * root's non-extractable handle lives (default IndexedDB, per product).
   */
  keyring?: {
    deviceKeys?: DeviceKeyPort;
    vault?: RootVault;
    /** Seconds the root stays in memory as bytes after it was made or recovered. Default 300. */
    sessionRootSeconds?: number;
  };
  /**
   * Cloud Connect identity (connect.identity, bearer mode only). `deviceKeys` is the device key
   * store (default: the one the key ring uses, `createWebDeviceKeyStore()`); a memory-only store
   * is refused with `invalid-options` unless `allowEphemeralKeys` is set, because every reload
   * would register a new key pair and the Worker allows four a day.
   */
  connect?: { deviceKeys?: DeviceKeyPort; allowEphemeralKeys?: boolean };
  /**
   * The update driver's service worker (update.driver): the container the install hand-off
   * looks for a waiting worker in (default `navigator.serviceWorker`; `null`: this page has
   * none, and `installUpdate()` answers `unsupported`) and the reload that follows the hand-off
   * (default `window.location.reload()`). A waiting worker is also what the boot guard reads as
   * a staged update.
   */
  serviceWorker?: { container?: SwContainer | null; reload?: () => void };
  /**
   * The app boot guard (update.bootguard): where its slots live (default `localStorage`, one
   * entry per product; `null`, or storage that throws, keeps them in memory) and the host's
   * rollback, which re-serves the previous build and answers whether it did. A page has no
   * rollback of its own: without one a rollback is reported as `boot_rolled_back` with code
   * `no-previous` and the failed version is remembered as the `skipVersion`.
   */
  bootGuard?: {
    storage?: ConfigStorage | null;
    rollback?: (previousVersion: string) => Promise<boolean>;
  };
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
  /** Bearer mode: this device's label (WIRE-CONTRACT-V4 §12.7.1), sent on registration,
   *  activation and sign-in. A browser has no platform name, so none is sent by default. */
  deviceName?: string;
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
  /** The host's `localOverrides`, then the persisted `config.set()` layer over them. */
  private localOverrides: Record<string, JSONValue>;
  /** Device-local overrides (`config.local`), persisted in `localStorage`. */
  readonly config: LocalConfigEngine;
  private readonly version?: string;
  private csrf: string | null = null;
  private hadSession = false;
  private capabilities: ServicesMap;
  /** The build's own belief (`expectedServices`, else the default): the gate's floor. */
  private readonly expectedServices: ServicesMap;
  /** `supports()`'s inputs: the generated table, runtime `web`, and `capabilities` above. */
  private readonly capabilityCtx: CapabilityContext;
  private readonly pinned: TrustSet | null;
  private readonly offline: OfflineStore | null;
  /** The re-verified offline state (device id + imported bundle), once loaded. */
  private offlineState: OfflineState | null = null;
  private readonly updateConfig: BrowserUpdateConfig | null;
  /** The update driver's service-worker options, resolved only when an update is used. */
  private readonly sw: BrowserAdapterOptions["serviceWorker"];
  /** The boot guard, built on first use: most page loads never count a launch. */
  private guard_: Promise<BrowserBootGuard> | null = null;
  private readonly bootGuardOptions: BrowserAdapterOptions["bootGuard"];
  private readonly updateOutlet: ResolvedOutlet | null;
  private readonly updateDetected: DetectedOutlet | null;
  /** The verified discovery document, once it answered. */
  private discovery_: DiscoveryDocument | null = null;
  /** Discovery's `core.presentation` and its verified icon (HA-13). */
  private readonly presentation_: BrowserPresentationSource;
  private discovered: Promise<void> = Promise.resolve();
  /** The discovery fetch on the wire now, if any. */
  private discovering: Promise<void> | null = null;
  /** The update slices when there is no offline store to keep them in. */
  private memorySlices: UpdateSlices = {};
  /** Decisions run one at a time: each is a read-modify-write of the slices. */
  private updateQueue: Promise<unknown> = Promise.resolve();
  /** How this page authenticates (§3.17). */
  readonly authMode: BrowserAuthMode;
  /** Bearer mode's engine; null in cookie mode. */
  private readonly bearer: BearerSession | null = null;
  /** The sync every concurrent `backendHeaders()` shares (SP-58). */
  private backendSync: { force: boolean; promise: Promise<boolean> } | null =
    null;
  /** The releases an update_offered was journalled for this page (§3.13). */
  private readonly offered = new Set<string>();
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
    // Throws before anything else is wired up: an insecure control plane is a construction
    // error, not a per-request one to discover on the first 4xx.
    this.base = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE);
    const hostStorage = storageNamespace(this.base);
    const productStorage = storeNamespace(this.product, this.base);
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.navigate =
      opts.navigate ??
      ((url) => {
        if (typeof window !== "undefined") window.location.assign(url);
      });
    this.clock = opts.now ?? nowSec;
    const hostOverrides = opts.localOverrides ?? {};
    const localBackend = browserLocalConfigBackend(
      productStorage,
      opts.configStorage,
    );
    this.localOverrides = { ...hostOverrides, ...localBackend.read() };
    this.version = opts.version;
    // D-21: the pre-discovery belief. Never all-true.
    this.expectedServices = expectedServicesOf(opts);
    this.capabilities = copyServices(this.expectedServices);
    this.capabilityCtx = capabilityContext("web", () => this.capabilities);
    this.presentation_ = new BrowserPresentationSource({
      product: this.product,
      fetchImpl: () => this.fetchImpl,
      storageNamespace: hostStorage,
      cache:
        opts.presentationCache !== undefined
          ? opts.presentationCache
          : opts.offlineStore !== undefined
            ? memoryPresentationCache()
            : undefined,
    });
    void this.presentation_.load();
    this.pinned = opts.trust?.pinnedKeys ?? null;
    this.offline =
      opts.offlineStore === undefined
        ? indexedDbOfflineStore(undefined, hostStorage)
        : opts.offlineStore;
    this.updateConfig = opts.update ?? null;
    this.sw = opts.serviceWorker;
    this.bootGuardOptions = opts.bootGuard;
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
    this.ringOptions = opts.keyring;
    this.cloudSyncOptions = opts.cloudSync;
    this.catalogOption = opts.catalog ?? undefined;
    this.platformIdentity = opts.platformIdentity;
    this.connectOptions = opts.connect;
    if (this.authMode === "bearer" && !this.pinned) {
      const err = new PolarisError(
        "invalid-options",
        opts.auth === "bearer"
          ? 'auth: "bearer" verifies every document in-page and needs trust.pinnedKeys.'
          : "This page is cross-origin to the Worker (or inside Tauri), so it authenticates with a device token, which verifies every document in-page and needs trust.pinnedKeys.",
      );
      if (opts.auth === "bearer") throw err;
      this.configError = err;
      // The developer's mistake, said once in development; the page's users see a neutral screen.
      developerError(
        "missing-pins",
        `${this.product}: this page is cross-origin to ${this.base} (or inside Tauri), so it signs in with a device token and verifies every document in the page. Put trust: { pinnedKeys } in the config passed to <PolarisKeyProvider>: the pins are in your generated Polaris config (\`pkey sdk --lang react\`). Until then the kit shows its error screen.`,
      );
    } else if (this.authMode === "bearer" && this.pinned) {
      this.bearerStore =
        opts.store ??
        (opts.offlineStore === undefined
          ? indexedDbStore(this.product, { namespace: hostStorage })
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
        identityEndpoints: () => accountEndpointsOf(this.discovery_),
        redirectEndpoints: () => redirectEndpointsOf(this.discovery_),
        choiceEndpoints: () => choiceEndpointsOf(this.discovery_),
        exchangeEndpoints: () => exchangeDiscoveryOf(this.discovery_),
        ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
        ...(opts.deviceName !== undefined
          ? { deviceName: opts.deviceName }
          : {}),
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
    this.config = new LocalConfigEngine({
      backend: localBackend,
      hostOverrides,
      snapshot: () => this.store.get(),
      subscribe: (cb) => this.store.subscribe(cb),
      applyOverrides: (merged) => {
        this.localOverrides = merged;
        this.store.set((s) => withOverrides(s, merged));
      },
      fetchSchema: () => this.fetchSchema(),
      ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
    });
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
    if (!s.authenticated && this.offlineState?.bundle) {
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
          // The reason is lifted from the session JSON, which this adapter deliberately does not
          // verify (see the trust-model note above), and the gate returns it AS the
          // `LicenseStatus`. `isBlockReason` is the membership check the erased `BlockReason`
          // type could never perform: a response claiming `{"blocked":{"reason":"ok"}}` must
          // not license the client. Out of vocabulary means no hint at all, which is the weaker
          // of the two states it could name.
          blocked: isBlockReason(s.blocked?.reason) ? s.blocked : null,
          lastVerifiedAt: docs.license ? this.clock() : null,
        },
        {
          ...flags,
          localOverrides: this.localOverrides,
          capabilities: this.capabilities,
          licenseGate: this.licenseGate(),
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
          // The cached bundle re-verified with its licence document cached (§7).
          activation: o?.bundle?.activates && o.license ? "bundle" : null,
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
          licenseGate: this.licenseGate(),
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
   *  document leaves the constructor's `expectedServices` belief in place. */
  /** The licence gate's input: build expectation OR a discovery loaded this session. */
  private licenseGate(): boolean {
    return licenseGateEnabled(this.expectedServices, this.capabilities);
  }

  private loadCapabilities(): Promise<void> {
    // One fetch at a time per adapter: a boot, a release call and the first load that ask while
    // discovery is on the wire all get that fetch's answer.
    if (this.discovering) return this.discovering;
    this.discovered = this.discovering = (async () => {
      const result = await discoverProduct({
        baseUrl: this.base,
        product: this.product,
        fetchImpl: this.fetchImpl,
      });
      if (result.kind === "ok") {
        this.capabilities = result.services;
        this.discovery_ = result.document;
        await this.presentation_.accept(result.document);
      } else if (
        result.kind === "error" &&
        result.status === 0 &&
        this.bearer
      ) {
        // No status at all: the browser refused the cross-origin read (CORS) or the network is
        // down. For a bearer page the usual cause is an origin the product does not list.
        developerError(
          "origin-not-allowed",
          `${this.product}: discovery at ${this.base} could not be read from this page${
            typeof window !== "undefined" && window.location?.origin
              ? ` (${window.location.origin})`
              : ""
          }. If you are online, add this origin to the product's web.origins in .pkey/product, then publish it.`,
        );
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.discovering = null;
      });
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
            licenseGate: this.licenseGate(),
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
      if (this.offlineState?.bundle) {
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
            licenseGate: this.licenseGate(),
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
          licenseGate: this.licenseGate(),
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
      this.syncFollowsSession(false);
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

  async refresh(opts: { force?: boolean } = {}): Promise<void> {
    if (this.configError) throw this.fail("license", this.configError);
    if (this.bearer) return this.refreshBearer(opts.force === true);
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
              error: standingRefusals(prev.error),
              localOverrides: this.localOverrides,
              capabilities: this.capabilities,
              licenseGate: this.licenseGate(),
            },
          ),
        );
        return;
      }
      this.apply(s, {
        busy: noBusy(),
        error: standingRefusals(this.store.get().error),
      });
    } catch (e) {
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("refresh-failed", (e as Error).message);
      this.patch((prev) => ({
        busy: withBusy(withBusy(prev.busy, "license", false), "config", false),
        error: refreshFailure(prev.error, err),
      }));
      throw err;
    }
  }

  private async refreshBearer(force: boolean): Promise<void> {
    this.setBusy("license", true);
    this.setBusy("config", true);
    try {
      await this.bearer!.sync({ force });
      this.applyBearer({
        busy: noBusy(),
        error: standingRefusals(this.store.get().error),
      });
    } catch (e) {
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("refresh-failed", (e as Error).message);
      this.patch((prev) => ({
        busy: withBusy(withBusy(prev.busy, "license", false), "config", false),
        error: refreshFailure(prev.error, err),
      }));
      throw err;
    }
  }

  /** Cookie mode: the OIDC redirect (never resolves: the page unloads). Bearer mode: a
   *  device-code sign-in whose handle carries the URL and code, completed in the background. */
  async signInWithOidc(): Promise<OidcSignInHandle | void> {
    if (this.configError) throw this.fail("identity", this.configError);
    if (this.bearer) {
      const flow = await this.signIn.start({ channel: "device-code" });
      void flow.wait().catch(() => undefined);
      return {
        verificationUrl: flow.verificationUriComplete,
        verificationUri: flow.verificationUri,
        userCode: flow.userCode,
        expiresAt: flow.expiresAt,
        // Cancelling is not a failure: the wait ends and the identity slice goes idle.
        cancel: () => flow.cancel(),
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
    await this.activateWithKey(key);
  }

  async activateWithKey(key: string): Promise<KeyActivation> {
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
        return { keyEntries: outcome.keyEntries ?? null };
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
      const ok: unknown = await res.json().catch(() => null);
      this.apply(await this.fetchSession(), {
        busy: noBusy(),
        error: noErrors(),
      });
      return { keyEntries: readKeyEntries(ok) ?? null };
    } catch (e) {
      throw this.fail(
        "license",
        e instanceof PolarisError
          ? e
          : new PolarisError("sign-in-failed", (e as Error).message),
      );
    }
  }

  async signOut(): Promise<SignOutResult> {
    if (this.configError) throw this.fail("identity", this.configError);
    this.setBusy("identity", true);
    // Fail closed: from here no silent rung signs this device in again until a person signs in.
    // Any ladder already running is abandoned before it stores a token.
    this.signOutGeneration += 1;
    this.linkFor_ = undefined;
    this.linkHandle(null);
    const warn: Pick<SignOutResult, "warning"> = (await this.setExplicitSignOut(
      true,
    ))
      ? {}
      : { warning: "sign-out-flag-not-saved" };
    // Stop the provider re-selecting the account on the next visit. Loaded on demand so the page
    // bundle stays within its size budget.
    await import("./bearer/autoSignIn.js").then(
      async (m) => m.runSignOutCleanup(await this.platformProvider(m)),
      () => undefined,
    );
    if (this.bearer) {
      try {
        await this.ensureDiscovery();
        // With the account endpoints the server releases the device; without them (a key-only
        // product) sign-out is the device deauthorization it always was.
        if (accountEndpointsOf(this.discovery_)?.signout) {
          const r = await this.bearer.signOut();
          this.applyBearer({ busy: noBusy(), error: noErrors() });
          return { ...r, ...warn };
        }
        await this.bearer.deactivate();
        this.applyBearer({ busy: noBusy(), error: noErrors() });
        return { released: true, ...warn };
      } catch (e) {
        throw this.fail(
          "identity",
          e instanceof PolarisError
            ? e
            : new PolarisError("sign-out-failed", (e as Error).message),
        );
      } finally {
        await this.forgetRing();
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
      if (this.offlineState?.bundle && this.offline) {
        // The update slices are signed public documents, not credentials: they stay, so a
        // channel's `seq` floor survives a sign-out.
        const prior = await this.offline.read(this.product);
        const slices = {
          ...(prior?.cache?.feeds ? { feeds: prior.cache.feeds } : {}),
          ...(prior?.cache?.releaseRecords
            ? { releaseRecords: prior.cache.releaseRecords }
            : {}),
          // A pinned key's revocation is security state, not a grant: it stays too.
          ...(Object.keys(this.offlineState.pinRevocations).length > 0
            ? { pinRevocations: this.offlineState.pinRevocations }
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
            licenseGate: this.licenseGate(),
          },
        ),
      );
      return { released: true };
    } catch (e) {
      throw this.fail(
        "identity",
        e instanceof PolarisError
          ? e
          : new PolarisError("sign-out-failed", (e as Error).message),
      );
    }
  }

  /** The bearer session and the endpoint an account call needs, or the typed refusal: a cookie
   *  page holds no device token, and a product whose discovery names no endpoint has no account. */
  private async accountSession(
    feature: string,
    endpoint: "subject" | "signout" | "attach" | "accountPortal",
  ): Promise<BearerSession> {
    const b = this.requireBearer(feature, COOKIE_DETAIL);
    await this.ensureDiscovery();
    if (!accountEndpointsOf(this.discovery_)?.[endpoint])
      throw accountUnavailable(feature, endpoint);
    return b;
  }

  /** Run an account call, keeping a refusal as the identity slice's error. */
  private async account<T>(run: () => Promise<T>): Promise<T> {
    this.setBusy("identity", true);
    try {
      const r = await run();
      this.setBusy("identity", false);
      return r;
    } catch (e) {
      throw this.fail("identity", asError(e));
    }
  }

  async subject(): Promise<string | null> {
    const b = await this.accountSession(AccountFeature.account, "subject");
    return this.account(() => b.subject());
  }

  async attach(opts: { confirm: boolean }): Promise<AttachResult> {
    const b = await this.accountSession(AccountFeature.attach, "attach");
    return this.account(async () => {
      const r = await b.attach(opts.confirm === true);
      if (r.kind === "ok") {
        await b.sync();
        this.applyBearer({ busy: noBusy(), error: noErrors() });
      }
      return r;
    });
  }

  /** `identity.choice.*`: bearer mode, over the `choice*` endpoints discovery names. */
  readonly choice: ChoiceNamespace = {
    licenses: (grant) => this.choiceCall((b) => b.choiceLicenses(grant)),
    devices: (grant, licenseId) =>
      this.choiceCall((b) => b.choiceDevices(grant, licenseId)),
    complete: (grant, choice, opts) =>
      this.choiceCall(async (b) => {
        const r = await b.choiceComplete(grant, choice, opts);
        if (r.kind === "ok") {
          await this.setExplicitSignOut(false);
          this.applyBearer({ busy: noBusy(), error: noErrors() });
          this.syncFollowsSession(true);
        }
        return r;
      }),
    cancel: (grant) => this.choiceCall((b) => b.choiceCancel(grant)),
  };

  private async choiceCall<T>(
    run: (b: BearerSession) => Promise<T>,
  ): Promise<T> {
    if (this.configError) throw this.fail("identity", this.configError);
    const b = this.requireBearer(Feature.identityChoice, COOKIE_DETAIL);
    await this.ensureDiscovery();
    return this.account(() => run(b));
  }

  async openAccount(): Promise<void> {
    const b = await this.accountSession(
      AccountFeature.account,
      "accountPortal",
    );
    const url = b.accountPortal();
    if (url) openPortal(url);
  }

  onBeforeSignOut(hook: () => Promise<void> | void): () => void {
    const b = this.requireBearer(AccountFeature.account, COOKIE_DETAIL);
    return b.onBeforeSignOut(hook);
  }

  currentDevice(): DeviceInfo | null {
    return currentDeviceFromState(this.store.get());
  }

  /**
   * A cookie session holds no `pkeyt_` bearer token, and `/<p>/devices` authenticates with
   * one — so remote device management is genuinely unreachable from a browser rather than
   * merely unimplemented. `Devices` renders this refusal as an explanation.
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
      // This device's own seat: the deauthorization `signOut()` makes for a key-only product.
      if (this.bearer) {
        await this.bearer.deactivate();
        await this.forgetRing();
        this.applyBearer({ busy: noBusy(), error: noErrors() });
      } else await this.signOut();
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
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: "GET",
          // `update/version` is bearer-only and CORS-covered: no ambient credential. (The
          // identity session routes keep `include`: they are first-party, cookie-bearing and
          // never CORS-covered.)
          credentials: "omit",
          headers: { accept: "application/json", ...this.metadataHeaders() },
        });
      } catch (e) {
        throw new PolarisError(ErrorCode.networkError, (e as Error).message);
      }
      if (!res.ok) throw updateRefusal(res.status);
      const body = (await res.json().catch(() => null)) as {
        version?: unknown;
        tag?: unknown;
        url?: unknown;
      } | null;
      // A 200 that is not a release is a broken answer, never "no update".
      if (
        !body ||
        typeof body.version !== "string" ||
        typeof body.tag !== "string" ||
        typeof body.url !== "string"
      )
        throw new PolarisError(
          ErrorCode.serverError,
          "update/version answered no release.",
        );
      this.patch((prev) => ({
        busy: withBusy(prev.busy, "update", false),
        error: withError(prev.error, "update", null),
      }));
      return {
        version: body.version,
        tag: body.tag,
        url: body.url,
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
      const result = await (
        await import("./update.js")
      ).decideBrowserUpdate({
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
      this.journalOffer(result.check);
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

  /** update_offered (§3.13): a decision that offers a newer build, once per release per page,
   *  as Node's `update.decide()`. Bearer mode only: a cookie page has no journal to feed. */
  private journalOffer(check: UpdateCheck): void {
    const d = check.decision;
    if (!this.bearer || d.action === "none" || !("release" in d)) return;
    const release = d.release.version;
    if (this.offered.has(release)) return;
    this.offered.add(release);
    this.bearer.recordUpdateEvent(UpdateEvent.updateOffered, {
      release,
      fromRelease: this.version ?? null,
      channel: check.channel,
    });
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

  /**
   * `client.backend.headers()` (SP-58): the held licence document and the device id, for the
   * app's own backend. A document within the refresh margin of its expiry is synced first;
   * concurrent callers share one sync. `force` always syncs and throws `refresh-failed` when the
   * licence document did not come back. A cookie page holds no signed document and refuses typed.
   */
  async backendHeaders(
    opts: { force?: boolean } = {},
  ): Promise<Record<string, string>> {
    const b = this.requireBearer(Feature.coreBackend, COOKIE_DETAIL);
    const held = () => b.backendLicense();
    const action = clientBackendAction({
      document: held(),
      now: b.effectiveTime(),
      response: null,
    });
    if (opts.force === true || action === "refresh-then-send") {
      const ok = await this.sharedBackendSync(opts.force === true);
      if (opts.force === true && !ok)
        throw new PolarisError(
          "refresh-failed",
          "The licence document could not be refreshed.",
        );
    }
    const doc = held();
    return {
      ...(doc ? { [HEADER_LICENSE]: doc.jws } : {}),
      [HEADER_DEVICE]: b.deviceId,
    };
  }

  /** One sync for every concurrent `backendHeaders()`; a forced caller joins only a forced one.
   *  True when the licence document is current (applied or unchanged). */
  private sharedBackendSync(force: boolean): Promise<boolean> {
    const live = this.backendSync;
    if (live && (live.force || !force)) return live.promise;
    const promise = this.bearer!.sync({ force })
      .then(
        (r) => {
          this.applyBearer({
            busy: this.store.get().busy,
            error: this.store.get().error,
          });
          return (
            r.documents.license?.kind === "applied" ||
            r.documents.license?.kind === "unchanged"
          );
        },
        () => false,
      )
      .finally(() => {
        if (this.backendSync?.promise === promise) this.backendSync = null;
      });
    this.backendSync = { force, promise };
    return promise;
  }

  /** Bearer mode's in-page journal (telemetry.updates); a cookie page refuses typed. */
  async recordUpdateEvent(
    event: UpdateEvent,
    input: UpdateEventInput,
  ): Promise<UpdateEventEntry | null> {
    const b = this.requireBearer(Feature.telemetryUpdates, COOKIE_DETAIL);
    return b.recordUpdateEvent(event, input);
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

  private ring_: KeyringClient | null = null;
  private cloudSync_: CloudSyncClient | null = null;
  private readonly cloudSyncOptions: CloudSyncHostOptions | undefined;
  private readonly catalogOption: ProductCatalog | undefined;
  private readonly ringOptions: BrowserAdapterOptions["keyring"];
  private deviceKeys_: Promise<DeviceKeyPort> | null = null;

  /**
   * The page's device key store: one port per adapter, shared by the key ring, the sign-in
   * ladder's exchange and Connect. The default store loads on the first call, never at import.
   */
  private deviceKeyPort(): Promise<DeviceKeyPort> {
    return (this.deviceKeys_ ??= this.ringOptions?.deviceKeys
      ? Promise.resolve(this.ringOptions.deviceKeys)
      : import("./deviceKeys.js").then((m) => m.webDeviceKeys()));
  }

  // ── Automatic sign-in (identity.autosignin, I-46.4) ──────────────────────────────────────

  /** The sign-out flag held in memory too, so a store that cannot be written still holds this page. */
  private signedOutHere = false;
  private defaultProvider_: PlatformIdentityProvider | null = null;
  private platformIdentity: PlatformIdentityProvider | null | undefined;

  /** Bumped by every `signOut()`; a running ladder compares it before it stores a token. */
  private signOutGeneration = 0;

  /** Sets the flag in memory, then in the store. False when the store could not keep it (the
   *  in-memory flag still holds for this page); never throws. */
  private async setExplicitSignOut(on: boolean): Promise<boolean> {
    if (!this.bearer) return true;
    this.signedOutHere = on;
    try {
      await this.bearerStore?.explicitSignOut?.set(on);
      return true;
    } catch {
      return false;
    }
  }

  private async explicitSignOut(): Promise<boolean> {
    if (this.signedOutHere) return true;
    try {
      return (await this.bearerStore?.explicitSignOut?.get()) === true;
    } catch {
      // Fail closed: a flag that cannot be read is a sign-out.
      return true;
    }
  }

  private platformProvider(
    m: typeof import("./bearer/autoSignIn.js"),
  ): PlatformIdentityProvider | null {
    if (this.platformIdentity !== undefined) return this.platformIdentity;
    return (this.defaultProvider_ ??= m.fedcmGoogleProvider(
      () => exchangeDiscoveryOf(this.discovery_)?.google?.serverClientId,
    ));
  }

  /** `identity.autoSignIn(opts?)`: the ladder. Bearer mode; elsewhere `unavailable`. */
  async autoSignIn(opts: AutoSignInOptions = {}): Promise<AutoSignInResult> {
    const b = this.bearer;
    if (this.configError || !b) return { kind: "unavailable", code: "runtime" };
    try {
      // A person-initiated sign-in lifts the sign-out flag (a boot-time ladder honours it).
      if (opts.explicit === true) await this.setExplicitSignOut(false);
      await this.ensureDiscovery();
      const m = await import("./bearer/autoSignIn.js");
      const result = await m.runAutoSignIn(
        {
          bearer: b,
          port: await this.deviceKeyPort(),
          provider: this.platformProvider(m),
          endpoints: exchangeDiscoveryOf(this.discovery_),
          explicitSignOut: () => this.explicitSignOut(),
          generation: () => this.signOutGeneration,
          syncKey: () =>
            this.bearer && this.capabilities.sync.enabled
              ? m.ringSyncKey(this.keyring)
              : Promise.resolve(undefined),
        },
        opts,
      );
      if (result.kind === "signedIn" && result.via === "platform")
        this.applyBearer({ busy: noBusy(), error: noErrors() });
      // `no_link` carries a handle for the link offer: held across the sign-in redirect.
      if (result.kind === "needsSignIn" && result.linkHandle !== undefined)
        this.linkHandle(`${this.clock()} ${result.linkHandle}`);
      if (result.kind === "signedIn") this.syncFollowsSession(true);
      return result;
    } catch (e) {
      // Only a cancellation leaves the ladder as a throw.
      if ((e as { name?: string } | null)?.name === "AbortError") throw e;
      return { kind: "unavailable", code: "refused" };
    }
  }

  // ── The link offer (identity.link, I-46.13) ───────────────────────────────────────────────

  /** The engine behind `link`: loaded on first use, after a redirect sign-in. It reads this
   *  adapter's own state by name (`LinkHost`), so no accessor table is carried here. */
  private linkEngine(): Promise<LinkClient> {
    // The module loads once; the client holds no state of its own (it reads this adapter's).
    return import("./bearer/link.js").then((m) =>
      m.createLinkClient(this as never),
    );
  }

  /** The account whose redirect sign-in landed on this page, `""` while its subject is not yet
   *  known: the link offer may be made (the kit asks `link.pending()`). Per page: a reload is
   *  "not now". Read and cleared by the lazy engine (`LinkHost`). */
  private linkFor_: string | undefined;
  /** The subject of the last sign-in on this page, for `linkHandle`'s owner check. */
  private lastSubject_: string | undefined;

  /** Keep (or, with `null`, drop) the `no_link` handle across the sign-in redirect: the one thing
   *  that has to outlive the page. Written here so it is there before the person leaves. */
  private linkHandle(set: string | null): void {
    try {
      const k = `pkey-link-handle:${this.product}`;
      if (set === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, set);
    } catch {
      // No storage: the offer falls back to a fresh provider token.
    }
  }

  /** `identity.link`: bearer mode; elsewhere typed `unavailable`. `pending` is the only call that
   *  runs before the engine loads: the marker a redirect sign-in (or a `no_link` handle) left in
   *  sessionStorage. */
  readonly link: LinkClient = {
    pending: () => this.linkFor_ !== undefined,
    ...(Object.fromEntries(
      (["offer", "accept", "decline", "dismiss"] as const).map((k) => [
        k,
        async () => (await this.linkEngine())[k](),
      ]),
    ) as Omit<LinkClient, "pending">),
  };

  private readonly connectOptions: BrowserAdapterOptions["connect"];
  private connect_: ConnectClient | null = null;
  private cloud_: CloudConnectClient | null = null;

  /**
   * The Cloud Sync key ring (sync.keyring). Bearer mode runs the engine; a cookie page holds no
   * device token and gets the typed runtime N/A.
   */
  get keyring(): KeyringClient {
    if (this.ring_) return this.ring_;
    const b = this.bearer;
    if (!b) return (this.ring_ = unsupportedKeyring("runtime", COOKIE_DETAIL));
    const o = this.ringOptions ?? {};
    // The engine, its crypto and the default device key store load on the first ring call.
    return (this.ring_ = lazyKeyring(async () =>
      (await import("./ring/create.js")).createRingEngine({
        product: this.product,
        bearer: b,
        options: { ...o, deviceKeys: await this.deviceKeyPort() },
      }),
    ));
  }

  /**
   * Cloud Sync for settings (sync.settings). Bearer mode runs the host, loaded on first use, with
   * the state in IndexedDB `pkey-sync-<product>` and one writer tab; a cookie page holds no device
   * token and gets the typed runtime N/A, as does a browser without Web Locks.
   */
  get cloudSync(): CloudSyncClient {
    if (this.cloudSync_) return this.cloudSync_;
    const b = this.bearer;
    if (!b)
      return (this.cloudSync_ = unsupportedCloudSync("runtime", COOKIE_DETAIL));
    const dbName = `pkey-sync-${storeNamespace(this.product, this.base)}`;
    // Sign-out sends what is waiting first (bounded); nothing loaded means nothing to send.
    b.onBeforeSignOut(() => this.cloudSync.beforeSignOut());
    return (this.cloudSync_ = lazyCloudSync({
      dbName,
      signInOrigin: new URL(this.base).origin,
      enabled: () => this.capabilities.sync.enabled,
      load: async () =>
        (await import("./cloudSync/create.js")).createBrowserCloudSync(
          this as unknown as CloudSyncOwner,
          b,
          dbName,
        ),
    }));
  }

  /** The signed-in person for Cloud Sync: null for none, undefined when it could not be read (an
   *  unreachable network is not a sign-out). */
  private async syncSubject(): Promise<string | null | undefined> {
    const b = this.bearer;
    if (!b || !b.hasToken) return null;
    // No discovery (an offline boot) cannot say who is signed in: that is not a sign-out.
    if (this.discovery_ === null) return undefined;
    if (!accountEndpointsOf(this.discovery_)?.subject) return null;
    try {
      return await b.subject();
    } catch {
      return undefined;
    }
  }

  /** Cloud Sync follows the session: start it (once the product runs Sync), or tell it who just
   *  signed in. Never throws; a Sync failure is not a sign-in failure. */
  private syncFollowsSession(signedIn: boolean): void {
    if (!this.bearer || !this.capabilities.sync.enabled) return;
    const run = signedIn
      ? this.syncSubject().then((subject) =>
          typeof subject === "string"
            ? this.cloudSync.identity({ kind: "signedIn", subject })
            : this.cloudSync.attach(),
        )
      : this.cloudSync.attach();
    void run.catch(() => undefined);
  }

  /**
   * The Cloud Connect identity (connect.identity). Bearer mode runs the engine; a cookie page
   * holds no device token and gets the typed runtime N/A.
   */
  get connect(): ConnectClient {
    if (this.connect_) return this.connect_;
    const b = this.bearer;
    if (!b) return (this.connect_ = unsupportedConnect(COOKIE_DETAIL));
    const o = this.connectOptions ?? {};
    const name = `pkey-connect-${storeNamespace(this.product, this.base)}`;
    return (this.connect_ = lazyConnect(
      { now: () => this.clock(), lockName: `pkey-connect:${name}` },
      async () =>
        (await import("./connect/create.js")).createBrowserConnect({
          product: this.product,
          base: this.base,
          bearer: b,
          options: o,
          now: () => this.clock(),
          lockName: `pkey-connect:${name}`,
          discovery: async () => {
            await this.ensureDiscovery().catch(() => undefined);
            return this.discovery_;
          },
          deviceKeys: () => this.deviceKeyPort(),
        }),
    ));
  }

  /**
   * Cloud Connect over the relay (connect.app, CC-09.2): the only path a page has. Bearer mode
   * runs it; a cookie page holds no device token and gets the typed runtime N/A. Nothing loads
   * until `start()`.
   */
  get cloudConnect(): CloudConnectClient {
    if (this.cloud_) return this.cloud_;
    if (!this.bearer)
      return (this.cloud_ = unsupportedCloudConnect("runtime", COOKIE_DETAIL));
    const cloud = (this.cloud_ = createCloudConnect(this.connect));
    // Connect stops before the server hears of the sign-out, within a bound (D-12): a session
    // must not outlive the roster it was admitted under, and a stuck stop cannot hold sign-out.
    this.bearer.onBeforeSignOut(() => stopCloudConnectForSignOut(cloud));
    return cloud;
  }

  /**
   * Sign-out and deactivation end the person's use of this device: Connect is left (its roster,
   * certificate and K_disc go; a failure reaches the caller, so a sign-out never leaves them
   * behind unnoticed) and the ring locks, the stored
   * root and the pin go, so a shared browser keeps nothing of the last person's ring. A storage
   * failure reaches the caller; a sign-out that threw still runs it.
   */
  private async forgetRing(): Promise<void> {
    if (!this.bearer) return;
    try {
      await this.keyring.forget();
    } finally {
      try {
        // The person's synced settings go with the ring (a failure reaches the caller).
        await this.cloudSync.purge();
      } finally {
        // Tell Cloud Sync the person is gone, so a tab that loaded mid-sign-out cannot bring
        // the snapshot back (the pre-sign-out hook ran before the server's answer).
        await this.cloudSync
          .identity({ kind: "signedOut" })
          .catch(() => undefined);
        // The relay stops first: a session must not outlive the roster it was admitted under.
        await this.cloudConnect.stop().catch(() => undefined);
        await this.connect.leave();
      }
    }
  }

  /** `signIn.start` / `signIn.complete` (identity.signIn). */
  readonly signIn: SignInNamespace = {
    start: ((opts: SignInOptions) =>
      this.startSignIn(opts)) as SignInNamespace["start"],
    complete: (callbackUrl) => this.completeSignIn(callbackUrl),
  };

  /** A `no_link` handle is one person's: another account signing in drops it. */
  private noteSubject(sub: string | null): void {
    if (sub === null || this.lastSubject_ === sub) return;
    if (this.lastSubject_ !== undefined) this.linkHandle(null);
    this.lastSubject_ = sub;
  }

  /** What a settled sign-in does to the adapter: the state, the busy flag, the subject. */
  private signInHooks(redirect = false): SettleHooks {
    return {
      onSettled: async (outcome) => {
        // A redirect sign-in landed: the link offer may follow (the kit asks `link.pending()`).
        // The marker is there before the state change below, for the kit to read. A `no_link`
        // handle is one person's: a landing account other than the last one drops it.
        if (outcome.kind === "signedIn") {
          this.noteSubject(outcome.subject);
          if (redirect) this.linkFor_ = outcome.subject ?? "";
        }
        this.applyBearer({ busy: noBusy(), error: noErrors() });
        if (outcome.kind === "signedIn") await this.setExplicitSignOut(false);
        if (outcome.kind !== "signedIn") return outcome;
        if (outcome.subject !== null) {
          this.syncFollowsSession(true);
          return outcome;
        }
        // Device code answers no subject: read it when discovery names the endpoint.
        const subject = accountEndpointsOf(this.discovery_)?.subject
          ? await this.bearer!.subject().catch(() => null)
          : null;
        this.noteSubject(subject);
        this.syncFollowsSession(true);
        return { ...outcome, subject };
      },
      onFailed: (error) => {
        this.fail("identity", error);
      },
      onStopped: () => this.setBusy("identity", false),
    };
  }

  private async startSignIn(
    opts: SignInOptions,
  ): Promise<DeviceCodeSignInSession | RedirectSignInSession> {
    if (this.configError) throw this.fail("identity", this.configError);
    const feature =
      opts.channel === "redirect"
        ? Feature.identityRedirectWeb
        : Feature.identityDevicecode;
    if (!this.capabilities.identity.enabled)
      throw this.fail(
        "identity",
        new UnsupportedError(
          {
            supported: false,
            feature,
            reason: "product",
            detail: "the product does not run the identity service",
          },
          ErrorCode.serviceUnavailable,
        ),
      );
    const b = this.requireBearer(
      feature,
      'A browser on the cookie session signs in by redirect (signInWithOidc); signIn.start needs auth: "bearer".',
    );
    this.setBusy("identity", true);
    try {
      await this.ensureDiscovery();
      const hooks = this.signInHooks(opts.channel === "redirect");
      if (opts.channel === "device-code")
        return new BearerDeviceCodeSession(b, await b.beginSignIn(opts), hooks);
      if (opts.channel !== "redirect")
        throw new PolarisError(
          ErrorCode.signInUnavailable,
          `unknown sign-in channel: ${String((opts as { channel?: unknown }).channel)}`,
        );
      const stash = sessionStorageStash(this.product, this.clock);
      if (!stash)
        throw new PolarisError(
          ErrorCode.signInUnavailable,
          "a redirect sign-in keeps its verifier in sessionStorage across the navigation, and this page has none.",
        );
      const pending = await b.startRedirect(opts);
      const deviceName = b.deviceLabel(opts.deviceName);
      stash.save({ ...pending, deviceName, at: this.clock() });
      this.setBusy("identity", false);
      return new BearerRedirectSession(b, pending, deviceName, hooks, (state) =>
        stash.drop(state),
      );
    } catch (e) {
      throw this.fail("identity", asError(e, "sign-in-unavailable"));
    }
  }

  private async completeSignIn(callbackUrl: string): Promise<SignInOutcome> {
    if (this.configError) throw this.fail("identity", this.configError);
    const b = this.requireBearer(
      Feature.identityRedirectWeb,
      'A browser on the cookie session signs in by redirect (signInWithOidc); signIn.complete needs auth: "bearer".',
    );
    const state = callbackState(callbackUrl);
    const pending =
      state === null
        ? null
        : (sessionStorageStash(this.product, this.clock)?.take(state) ?? null);
    if (pending === null)
      throw this.fail(
        "identity",
        new PolarisError(
          ErrorCode.signInFailed,
          "no redirect sign-in is waiting for this callback; start a new one.",
        ),
      );
    this.setBusy("identity", true);
    return completeRedirect(
      b,
      pending,
      callbackUrl,
      pending.deviceName,
      this.signInHooks(true),
    );
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
    if (!this.capabilities.commerce.enabled)
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.commerceReceipt,
          reason: "product",
          detail: "commerce needs the commerce service",
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

  presentationSource(): ReactPresentationSource {
    return this.presentation_;
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
      const check = await this.decideUpdate({
        skipVersion: (await this.guard()).skipVersion(),
      });
      return {
        decision: check.decision.action === "none" ? "none" : "optional",
        check,
      };
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
          ...this.guardStage(),
          ...(decide ? { decide } : {}),
        })
      : this.cookieBootDriver(fresh, decide);
    const run = import("../core/boot.js").then(({ runBoot }) =>
      runBoot(driver, opts),
    );
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
      ...this.guardStage(),
      ...(decide ? { decide } : {}),
    };
  }

  /** The boot driver's guard and confirmation, when the page has a version to count launches of. */
  private guardStage(): Pick<BootDriver, "guard" | "confirm"> {
    if (this.version === undefined) return {};
    return {
      guard: async () => (await this.guard()).markBootAttempt(),
      confirm: async () => (await this.guard()).confirmBoot(),
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
      return await (
        await import("./releaseFetch.js")
      ).fetchReleaseBuild({
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
    return (await import("./releaseFetch.js")).fetchVerifiedRecord({
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

  /**
   * The update driver (update.driver): hand off to the waiting service worker and reload. See
   * `serviceWorkerUpdate.ts`. Journals `update_downloaded` and `update_applied` in bearer mode
   * and sends that journal before the reload, which would take it along.
   */
  async installUpdate(
    decision: UpdateDecision,
    opts: InstallOptions = {},
  ): Promise<InstallOutcome> {
    // Loaded on first use: most page loads never install an update.
    const { installViaServiceWorker } =
      await import("./serviceWorkerInstall.js");
    return installViaServiceWorker(
      {
        container: this.sw?.container,
        record: (event, input) => this.recordUpdateEvent(event, input),
        flush: async () => this.bearer?.flushUpdateEvents(),
        currentVersion: this.version ?? null,
        ...(this.sw?.reload ? { reload: this.sw.reload } : {}),
      },
      decision,
      opts,
    );
  }

  /** The boot guard's launch decision (update.bootguard); `boot()` calls it as its guard stage.
   *  Needs the page's `version`: the guard counts launches of a build. */
  async markBootAttempt(): Promise<BootAttempt> {
    return (await this.guard()).markBootAttempt();
  }

  /** Mark this launch healthy (update.bootguard). */
  async confirmBoot(): Promise<void> {
    return (await this.guard()).confirmBoot();
  }

  /** The version the guard rolled back from, for `decideUpdate({ skipVersion })`. */
  async bootGuardSkipVersion(): Promise<string | null> {
    return (await this.guard()).skipVersion();
  }

  private guard(): Promise<BrowserBootGuard> {
    this.guard_ ??= import("./bootGuard.js").then(
      ({ BrowserBootGuard }) =>
        new BrowserBootGuard({
          product: this.product,
          version: this.version,
          storage: this.bootGuardOptions?.storage,
          container: this.sw?.container,
          record: (event, input) => this.recordUpdateEvent(event, input),
          flush: async () => this.bearer?.flushUpdateEvents(),
          ...(this.bootGuardOptions?.rollback
            ? { rollback: this.bootGuardOptions.rollback }
            : {}),
        }),
    );
    return this.guard_;
  }

  dispose(): void {
    this.config.dispose();
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
  Feature.telemetryUpdates,
  Feature.licenseEnroll,
  Feature.licenseReregister,
  Feature.identityDevicecode,
  Feature.identityAccount,
  Feature.identityAttach,
  Feature.configMint,
  Feature.commerceReceipt,
  // SP-58: a cookie page holds no signed licence document to send.
  Feature.coreBackend,
  // CC-09.1: Connect rides the device token.
  Feature.connectIdentity,
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

/** The typed refusal for a non-2xx `update/version`: the SDK-wide codes, so a host and the kit
 *  tell "no such release feed" (404) from "the server is down" (5xx) and "slow down" (429). */
function updateRefusal(status: number): PolarisError {
  const code =
    status === 404
      ? ErrorCode.notFound
      : status === 429
        ? ErrorCode.rateLimited
        : status >= 500
          ? ErrorCode.serverError
          : ErrorCode.httpError;
  return new PolarisError(
    code,
    `update/version ${status}`,
    undefined,
    undefined,
    {
      status,
    },
  );
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
