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
  compareSemver,
  detectOutlet,
  detectionStamp,
  effectiveNow,
  highWaterMark,
  isValidHostOutlet,
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
  capabilityContext,
  capsIn,
  initialState,
  refuse,
  supportsIn,
  type ConfigSource,
  type Support,
  type DeviceInfo,
  type JSONValue,
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
  private discovery: DiscoveryDocument | null = null;
  private discovered: Promise<void> = Promise.resolve();
  /** The update slices when there is no offline store to keep them in. */
  private memorySlices: UpdateSlices = {};
  /** Decisions run one at a time: each is a read-modify-write of the slices. */
  private updateQueue: Promise<unknown> = Promise.resolve();

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
    this.store = createStore<PolarisState>(
      initialState("browser", this.capabilities, this.localOverrides),
    );
    void this.load();
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
        this.discovery = result.document;
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

  async refresh(): Promise<void> {
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

  async signInWithOidc(): Promise<void> {
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
      if (res.status === 401) {
        throw new PolarisError("sign-in-failed", "That key was not accepted.");
      }
      if (res.status === 403) {
        let message = `activation ${res.status}`;
        try {
          const body = (await res.json()) as {
            error?: string | { code?: string; message?: string };
            message?: string;
          };
          const code =
            typeof body.error === "string" ? body.error : body.error?.code;
          message =
            code === "device_limit"
              ? "This license has reached its device limit."
              : ((typeof body.error === "object"
                  ? body.error?.message
                  : undefined) ??
                body.message ??
                message);
        } catch {
          // Keep the generic message when the response is not JSON.
        }
        throw new PolarisError("sign-in-failed", message);
      }
      if (!res.ok) {
        throw new PolarisError("sign-in-failed", `activation ${res.status}`);
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
    this.setBusy("identity", true);
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
    refuse(this.capabilityCtx, Feature.devicesManage, {
      code: "device-management-unsupported",
      detail: "Listing devices is not supported from a browser session.",
    });
  }

  async renameDevice(_deviceId: string, _label: string | null): Promise<void> {
    refuse(this.capabilityCtx, Feature.devicesManage, {
      code: "device-management-unsupported",
      detail: "Renaming devices is not supported from a browser session.",
    });
  }

  async deauthorizeDevice(deviceId: string): Promise<void> {
    const current = this.currentDevice();
    if (current?.id === deviceId) {
      await this.signOut();
      return;
    }
    refuse(this.capabilityCtx, Feature.devicesManage, {
      code: "device-management-unsupported",
      detail:
        "Disconnecting another device is not supported from a browser session.",
    });
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
        discovery: this.discovery,
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
    return buildDownloadUrlFor(this.discovery, this.base, version, buildId);
  }

  /** The metadata a public read carries. */
  private requestOpts() {
    return {
      baseUrl: this.base,
      product: this.product,
      fetchImpl: this.fetchImpl,
      headers: this.metadataHeaders(),
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
   *  (randomly) and persisted on first use; `null` where there is nowhere to keep it. */
  async offlineDeviceId(): Promise<string | null> {
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

  /** `POST /<p>/devices/report` takes a device bearer, which a cookie session does not hold:
   *  the `devices.report` web N/A (`runtime`), stated rather than silently skipped. */
  async report(): Promise<boolean> {
    refuse(this.capabilityCtx, Feature.devicesReport, {
      code: ErrorCode.reportUnsupported,
      detail:
        "Device telemetry needs a device token; a browser session has none.",
    });
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
    return supportsIn(this.capabilityCtx, feature);
  }

  caps(): string[] {
    return capsIn(this.capabilityCtx);
  }

  isEntitled(name: string): boolean {
    return readEntitled(this.store.get(), name);
  }

  dispose(): void {
    // No long-lived listeners/timers to clean up in browser mode.
  }
}

/** Construct a browser adapter (the canonical factory the Provider uses). */
export function browserAdapter(opts: BrowserAdapterOptions): PolarisAdapter {
  return new BrowserAdapter(opts);
}
