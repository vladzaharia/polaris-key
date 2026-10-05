// `PolarisKeyClient` — the suite facade: Core plus one sub-client per service.
//
// The pre-suite `PolarisKeyClient` was a 780-line god object that fused the device principal,
// the credential, the trust set, the cache, the gate, config resolution, device management and
// the refresh loop into one class with a 20-field option bag. Every one of those is now owned
// by exactly one module, and this file does nothing but compose them and wire the two things
// that genuinely need a whole-client view:
//
//   * `onLicenseAcquired` → `sync()`. Activation used to call refresh inline, so every mint
//     path had to remember to, and a config-only product had no way to say "there is no licence
//     here, sync anyway". Now the license client — and the identity client, when a device-code
//     sign-in completes — raises an EVENT and the facade decides.
//   * `getSyncState()`, the React bridge contract — one snapshot of everything the UI layer
//     needs, assembled from the managers that own each piece.
//
// SECURITY (wire contract v3): every security-relevant value the client holds is DERIVED from a
// signature it has just checked. The cache stores compact JWSs and nothing else; the trust set
// is `{...manifestKeys, ...pinnedKeys}` with the pins terminal; the per-type anti-replay floors,
// the monotonic clock floor and `lastVerifiedAt` are recomputed on every load. There is no
// unsigned field left for a local attacker to poison.

import type { JSONValue } from "@polaris-key/protocol/core";
import type {
  ActivationSource,
  DocProfile,
  LicenseDoc,
} from "@polaris-key/protocol/license";
import {
  detectorKey,
  detectorProblems,
  evaluateSupport,
  supportedFeatures,
  type BlockedState,
  type CapabilityContext,
  type CapabilityDetectors,
  type LicenseState,
  type StoreStatus,
  type Support,
} from "@polaris-key/client-core";
import {
  CAPABILITIES,
  CAPABILITY_RUNTIMES,
  Feature,
  UnsupportedReason,
} from "./constants.generated.js";
import { SERVICE_SLUGS, type ServiceSlug } from "./services.generated.js";
import { SDK_NAME, SDK_VERSION } from "./version.js";
import { CacheManager } from "./core/cache.js";
import { CoreContext, nowSec, type CoreOptions } from "./core/context.js";
import { importBundle, type ImportBundleResult } from "./core/bundle.js";
import { sync, type SyncOptions, type SyncResult } from "./core/sync.js";
import {
  chooseReacquireRoute,
  TokenManager,
  type Reacquired,
  type TokenSource,
} from "./core/token.js";
import { TrustManager } from "./core/trust.js";
import { ConfigClient, type ConfigClientOptions } from "./config/client.js";
import { LicenseClient, type LicenseClientOptions } from "./license/client.js";
import { reacquireToken } from "./license/endpoints.js";
import {
  DevicesClient,
  DeviceManagementUnsupportedError,
  type DevicesClientOptions,
} from "./devices/client.js";
import { IdentityClient } from "./identity/client.js";
import { ReleaseClient } from "./release/client.js";
import { CommerceClient } from "./commerce/client.js";
import { DistributionClient } from "./distribution/client.js";
import { PolarisEventEmitter } from "./core/events.js";
import { crashTagsFor, type CrashTags } from "./server.js";
import { UpdateClient, type UpdateClientOptions } from "./update/client.js";
import {
  ensureActivated,
  runBoot,
  type BootOutcome,
  type ClientBootOptions,
  type EnsureActivatedResult,
} from "./boot.js";
import {
  discoverProduct,
  type DiscoverProductResult,
  type ProductDiscoveryDocument,
  type ServicesMap,
} from "./discovery.js";

export { DeviceManagementUnsupportedError };

/** The registry runtime id of this SDK (packages/sdk-node/parity.json). */
const NODE_RUNTIME = "node";

export interface PolarisKeyClientOptions extends CoreOptions {
  /** Config service inputs (override layers). */
  config?: ConfigClientOptions;
  /** License service inputs. */
  license?: LicenseClientOptions;
  /** Devices inputs (probes, fingerprint opt-out). */
  devices?: DevicesClientOptions;
  /** Update inputs for wire v4's signed decision (`client.update.decide()`): the pinned release
   *  keys, the outlet, the installed build's format and build number, the host's methods.
   *  Validated here: a bad value, or a release key that is also a trust pin, throws
   *  `invalid-options` from the constructor. */
  update?: UpdateClientOptions;
  /**
   * Poll on this interval (seconds). OFF by default — enabling it would silently add network
   * traffic and background wakeups to every already-shipped integration. Call `close()` to
   * stop the timer.
   */
  refreshIntervalSeconds?: number;
  /** Fired after a sync that actually changed a document. */
  onChange?: (state: LicenseState) => void;
}

/**
 * The bridge contract (§P5's React lane consumes exactly this shape).
 *
 * `doc` is the license document because that is what a gate UI renders; config values are read
 * through `client.config`, which has its own accessors and no reason to hand out a whole doc.
 */
export interface SyncState {
  activation: ActivationSource | null;
  doc: LicenseDoc | null;
  lastSyncUnauthorized: boolean;
  blocked: BlockedState | null;
  /** Epoch MILLIseconds, or null. Offline this is derived from the newest document's signed
   *  `issuedAt`, so it is never a value an attacker chose (R4-04). */
  lastVerifiedAt: number | null;
  /** §4.2's monotonic floor, in epoch SECONDS. */
  highWaterMark: number;
}

/** One device as the facade reports it, blending the roster with locally-derived state. */
export interface DeviceInfo {
  id: string;
  current: boolean;
  status: LicenseState["status"];
  licenseId?: string;
  profile?: DocProfile;
  lastVerifiedAt?: number;
  label?: string | null;
  platform?: string | null;
  arch?: string | null;
  appVersion?: string | null;
  sdkName?: string | null;
  sdkVersion?: string | null;
}

export class PolarisKeyClient {
  readonly product: string;
  readonly core: CoreContext;
  readonly license: LicenseClient;
  readonly config: ConfigClient;
  readonly devices: DevicesClient;
  readonly identity: IdentityClient;
  readonly release: ReleaseClient;
  readonly update: UpdateClient;
  /** What changed: license, config, updateAvailable, packs, store (§3.11). */
  readonly events = new PolarisEventEmitter();
  /** The public download model (§3.8). */
  readonly distribution: DistributionClient;
  /** Store purchases to licence flags (§3.9). */
  readonly commerce: CommerceClient;

  private readonly cache: CacheManager;
  private readonly tokens: TokenManager;
  private readonly trust: TrustManager;
  private readonly refreshIntervalSeconds?: number;
  private readonly onChange?: (state: LicenseState) => void;
  private readonly probes: DevicesClientOptions["probes"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private discoveryDoc: ProductDiscoveryDocument | null = null;
  /** Whether the host pinned `expectedServices` (then boot skips discovery). */
  private readonly pinnedServices: boolean;
  /** The token store's last `status()`, read at `init()` and before every report, so
   *  `supports()` can answer offline and synchronously. */
  private lastStoreStatus: StoreStatus | null = null;
  /** The gate status `events.license` last reported. */
  private lastStatus: LicenseState["status"] | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly capabilityContext: CapabilityContext;

  constructor(opts: PolarisKeyClientOptions & { localOnly?: boolean }) {
    this.product = opts.productSlug;
    this.core = new CoreContext(opts);
    this.trust = new TrustManager(this.core);
    this.cache = new CacheManager(this.core, this.trust);
    // The re-acquire path is injected so Core does not depend on the license or devices
    // modules; §5's single-attempt rule lives in `TokenManager`, the route CHOICE in
    // `chooseReacquireRoute`, and the two routes in license/endpoints and devices/client.
    this.tokens = new TokenManager(
      this.core,
      this.core.store,
      (ctx, current, source) => this.reacquire(ctx, current, source),
    );
    this.probes = opts.devices?.probes;

    this.devices = new DevicesClient(
      this.core,
      this.cache,
      this.tokens,
      // Every report carries `caps`, the explicit `devices.report()` as well as the one after a
      // sync. Evaluated per report, after the constructor has built the capability context.
      { ...opts.devices, caps: () => this.caps() },
    );
    this.license = new LicenseClient(
      this.core,
      this.cache,
      this.tokens,
      this.devices,
      // The activation event: mint a credential, then sync. Only LICENSE acquisition fires it
      // — `devices.register()` deliberately does not, because a keyless registration is a
      // provisioning step a host may want to take long before it wants documents (an installer
      // that registers at setup and syncs on first launch). The CLI's `register` verb syncs
      // explicitly for exactly that reason; the SDK does not decide it for the host.
      () => this.onLicenseAcquired(),
      opts.license ?? {},
    );
    this.config = new ConfigClient(
      this.core,
      this.cache,
      opts.config ?? {},
      this.tokens,
    );
    // Device-code sign-in raises the same acquisition event activation does: a signed-in
    // device holds a licensed token exactly as an activated one does, and syncs the same way.
    this.identity = new IdentityClient(
      this.core,
      this.tokens,
      () => this.onLicenseAcquired(),
      () => this.license.deactivate(),
    );
    this.release = new ReleaseClient(
      this.core,
      this.tokens,
      () => this.discoveryDoc,
      () => this.update,
    );
    this.distribution = new DistributionClient(this.core);
    this.commerce = new CommerceClient(this.core, this.tokens, () =>
      this.sync({ force: true }).then(() => undefined),
    );
    this.update = new UpdateClient(
      this.core,
      this.tokens,
      () => this.discoveryDoc,
      {
        cache: this.cache,
        trust: this.trust,
        discover: () => this.discover(),
        ...(opts.update !== undefined ? { options: opts.update } : {}),
      },
    );

    // `devices/report` carries the active pack set's id (plans/P4-01.md §2.11).
    this.devices.packSetId = () => this.update.packs.packSetId();
    this.devices.packInstalls = () => this.update.packs.packInstalls();
    // The update-health half of the report (§3.13): the gate, the outlet and the journal's
    // pending events, marked sent once a report carrying them was accepted.
    this.devices.reportExtras = async () => ({
      gate: this.license.status().status,
      outlet: this.update.outlet?.id ?? null,
      updates: await this.update.journal.pending().catch(() => []),
    });
    this.devices.reportAccepted = async (extras) => {
      const ids = (extras.updates ?? []).map((e) => e.eventId);
      if (ids.length > 0) await this.update.journal.markSent(ids);
    };

    this.pinnedServices = opts.expectedServices !== undefined;
    // client.events (§3.11): config changes, pack progress and update offers forward here.
    this.config.onConfigChange("*", (c) => this.events.safeEmit("config", c));
    this.update.packs.on((p) => this.events.safeEmit("packs", p));
    this.update.onUpdateAvailable = (check) =>
      this.events.safeEmit("updateAvailable", check);
    this.license.onDeactivated = async () => {
      await this.identity.forget();
      this.noteLicense();
    };
    this.refreshIntervalSeconds = opts.refreshIntervalSeconds;
    this.onChange = opts.onChange;

    // The conditional N/As parity.json declares for Node, each decided here from state the
    // client already holds (P1b-10). `detectorProblems` refuses a table and detector set that
    // disagree, so a manifest edit cannot ship without the code that decides it.
    const detectors: CapabilityDetectors = {
      [detectorKey(Feature.coreStore, UnsupportedReason.dependency)]: () => {
        const degraded = this.lastStoreStatus?.degraded;
        if (degraded?.reason !== "keyring-unavailable") return null;
        return `no OS keyring: the token is kept in a 0600 file${degraded.detail ? ` (${degraded.detail})` : ""}`;
      },
    };
    const problems = detectorProblems(
      CAPABILITIES,
      NODE_RUNTIME,
      CAPABILITY_RUNTIMES,
      detectors,
    );
    if (problems.length > 0)
      throw new Error(
        `capability table and detectors disagree: ${problems.join("; ")}`,
      );
    this.capabilityContext = {
      table: CAPABILITIES,
      runtime: NODE_RUNTIME,
      sdkLabel: `${SDK_NAME} ${SDK_VERSION}`,
      serviceSlugs: SERVICE_SLUGS,
      serviceEnabled: (slug) => this.core.enabled(slug as ServiceSlug),
      detectors,
    };
  }

  static async create(
    opts: PolarisKeyClientOptions,
  ): Promise<PolarisKeyClient> {
    const c = new PolarisKeyClient(opts);
    await c.init();
    return c;
  }

  /** Load device id + token + cached documents. NO NETWORK — an offline-first host must be
   *  able to render its gate before it has ever reached the control plane. */
  async init(): Promise<void> {
    await this.core.init();
    await this.storeStatus();
    await this.tokens.load();
    await this.cache.load();
    this.lastStatus = this.license.status().status;
    // Wire v4's update slices go through the same reload path: every committed feed and record
    // is re-verified against what this load trusts, and each channel's `seq` floor comes from
    // the feed that survives.
    await this.update.reload();
    this.startTimer();
  }

  // ── Capabilities ──────────────────────────────────────────────────────────────────────
  /**
   * Fetch `/.well-known/polaris.json` and install the product's real capability map.
   *
   * Explicit rather than automatic, because it is a NETWORK read and `sync()` must stay
   * predictable: a client that has never called this resolves capabilities from
   * `expectedServices` or the suite default (see `CoreContext.services`). Once a document is
   * loaded it wins over both — discovery is the authority when it is available.
   */
  async discover(): Promise<DiscoverProductResult> {
    // `fetcher()` is called EAGERLY, and its local-only refusal is allowed to propagate.
    // Passing `undefined` here instead would let `discoverProduct` fall back to the module
    // global `fetch` — which is how a transportless client would end up opening a socket to
    // the control plane, the one thing `./local` exists to make impossible.
    const fetchImpl = this.core.fetcher();
    const result = await discoverProduct({
      baseUrl: this.core.baseUrl,
      product: this.product,
      fetchImpl,
      signal: this.core.deadline(),
    });
    if (result.kind === "ok") {
      this.discoveryDoc = result.manifest;
      this.core.setServices(result.services);
    }
    return result;
  }

  /** The discovery document this session loaded, or null. */
  discovery(): ProductDiscoveryDocument | null {
    return this.discoveryDoc;
  }

  /** Whether the build pinned `expectedServices` (boot then needs no discovery round trip). */
  get servicesPinned(): boolean {
    return this.pinnedServices;
  }

  // ── One-call boot (SDK parity pass §3.4) ──────────────────────────────────────────────
  /**
   * Boot to a working, gated, updated app: discovery (when no services are pinned) → boot guard
   * → sync → reacquire per `core.registration` → gate → update decision → required packs →
   * mount, driving client-core's stage machine and reporting every step to `onStage`. Never
   * prompts: a gate that needs the player ends `waiting`, and the host shows its activation UI.
   */
  boot(opts: ClientBootOptions = {}): Promise<BootOutcome> {
    return runBoot(this, opts);
  }

  /** Steps 1–3 of `boot()`: sync, then register or enrol where the product allows it. */
  ensureActivated(
    opts: { registration?: boolean } = {},
  ): Promise<EnsureActivatedResult> {
    return ensureActivated(this, {
      discover: !this.pinnedServices && this.discoveryDoc === null,
      ...opts,
    });
  }

  /** What this client currently believes the product runs. */
  capabilities(): ServicesMap {
    return this.core.services();
  }

  /**
   * Whether `feature` works here, and if not why (PARITY §2.2): `{ supported: true }`, or
   * `{ supported: false, reason, detail }` with `reason` one of `runtime` (Node cannot do it),
   * `product` (discovery, or the fail-closed fallback before it, says the owning service is
   * off), `dependency` (no loadable OS keyring for `core.store`) or `version` (this SDK does not
   * implement the feature yet, or does not know the id). Offline, synchronous and side-effect
   * free: it reads the generated capability table, the cached capability map and the store
   * status read at `init()`.
   */
  supports(feature: Feature | string): Support {
    return evaluateSupport(this.capabilityContext, feature);
  }

  /** The feature ids `supports()` answers Supported for, in registry order. Every device
   *  report carries this list as `caps`. */
  caps(): string[] {
    return supportedFeatures(this.capabilityContext);
  }

  // ── Sync ──────────────────────────────────────────────────────────────────────────────
  /**
   * One Core pass: trust refresh → enabled documents in parallel → verify → cache → floor →
   * report. See `core/sync.ts` for the full ordering rationale.
   */
  async sync(opts: SyncOptions = {}): Promise<SyncResult> {
    const before = this.cache.etag("license");
    const beforeConfig = this.cache.etag("config");
    const beforeValues = this.config.snapshot();
    const result = await sync(
      {
        ctx: this.core,
        trust: this.trust,
        cache: this.cache,
        tokens: this.tokens,
        report: () => this.reportOnce(),
      },
      opts,
    );
    // The ETags are the change signal: they exclude the per-request timestamps, so a differing
    // tag means the CONTENT changed rather than that the document was merely re-signed.
    const changed =
      this.cache.etag("license") !== before ||
      this.cache.etag("config") !== beforeConfig;
    if (this.onChange && result.applied && changed) {
      this.onChange(this.license.status());
    }
    this.config.emitChanges(beforeValues);
    this.noteLicense();
    return result;
  }

  /**
   * The §5 single re-acquire: `POST /<p>/license/token` for a licensed device, or
   * `POST /<p>/devices/register` (keyless, no bearer) for a registered-without-licence device
   * or a product with License off. Null means the one attempt failed (403
   * `registration_closed`, 401, 404, 429 or transport) and the hard-401 path applies.
   */
  private async reacquire(
    ctx: CoreContext,
    current: string,
    source: TokenSource | null,
  ): Promise<Reacquired | null> {
    const route = chooseReacquireRoute({
      licenseEnabled: ctx.enabled("license"),
      source,
    });
    if (route === "devices-register") {
      const r = await this.devices.requestRegistration();
      return r.kind === "ok" ? { token: r.token, source: "register" } : null;
    }
    const r = await reacquireToken(ctx, current);
    return r.kind === "ok" ? { token: r.token, source: "reacquire" } : null;
  }

  private async reportOnce(): Promise<void> {
    const token = this.tokens.current;
    if (!token) return;
    // A token write since init() may have fallen back to the file; report what is true now.
    await this.storeStatus();
    await this.devices.report();
  }

  private async onLicenseAcquired(): Promise<void> {
    await this.sync({ force: true });
  }

  /** The React bridge contract — one snapshot of everything a UI layer renders from. */
  getSyncState(): SyncState {
    return {
      activation: this.license.activation(),
      doc: this.cache.state.license?.doc ?? null,
      lastSyncUnauthorized: this.cache.state.lastSyncUnauthorized,
      blocked: this.cache.state.blocked,
      lastVerifiedAt: this.cache.state.lastVerifiedAt,
      highWaterMark: this.core.highWaterMark,
    };
  }

  // ── Offline bundles (§7) ──────────────────────────────────────────────────────────────
  /**
   * Verify and install an offline activation bundle. All-or-nothing; no token is created.
   * Throws `PolarisError` carrying the §7 step that refused.
   */
  async importBundle(jws: string, now = nowSec()): Promise<ImportBundleResult> {
    const beforeValues = this.config.snapshot();
    const r = await importBundle(this.core, this.cache, jws, now);
    this.config.emitChanges(beforeValues);
    this.noteLicense();
    return r;
  }

  /** Emit `events.license` when the gate's status moved since it was last reported. */
  private noteLicense(): void {
    const state = this.license.status();
    if (state.status === this.lastStatus) return;
    const previous = this.lastStatus;
    this.lastStatus = state.status;
    this.events.safeEmit("license", { state, previous });
  }

  /**
   * The crash-reporter tags for this install (SDK parity pass §3.14): `release`
   * (`app@<version>[+<build>]`), `environment` (the channel) and `pkey.outlet`. Pass them to a
   * Sentry init as `release`, `environment` and a tag; the Worker's Sentry hook maps an alert on
   * them to the staged rollout it came from.
   */
  crashTags(
    opts: { deliverable?: string; build?: string | null } = {},
  ): CrashTags {
    return crashTagsFor({
      version: this.core.version,
      channel: this.core.channel,
      outlet: this.update.outlet?.id ?? null,
      ...opts,
    });
  }

  // ── Convenience passthroughs ──────────────────────────────────────────────────────────
  // Kept deliberately small. The suite's shape is `client.<service>.<verb>`; these exist only
  // for the calls a host makes before it knows which service it is talking to.
  status(now = nowSec()): LicenseState {
    return this.license.status(now);
  }

  /**
   * Where the token store keeps the token, and why if that is weaker than this platform's best
   * option (P1b-09, R4-11): `{ backend: "file", degraded: { reason: "keyring-unavailable" } }`
   * on a host whose OS keyring is missing. `null` when the store does not report (a host store
   * without `status()`). Never throws.
   */
  async storeStatus(): Promise<StoreStatus | null> {
    const store = this.core.store;
    let status: StoreStatus | null = null;
    if (typeof store.status === "function") {
      try {
        status = await store.status();
      } catch {
        status = null;
      }
    }
    if (JSON.stringify(status) !== JSON.stringify(this.lastStoreStatus))
      this.events.safeEmit("store", status);
    this.lastStoreStatus = status;
    return status;
  }

  isLicensed(now = nowSec()): boolean {
    return this.license.isLicensed(now);
  }

  getConfig<T = JSONValue>(key: string, fallback: T): T {
    return this.config.getConfig(key, fallback);
  }

  getCurrentDevice(): DeviceInfo {
    const out: DeviceInfo = {
      id: this.core.deviceId,
      current: true,
      status: this.license.status().status,
    };
    const licenseId = this.license.getLicenseId();
    if (licenseId !== null) out.licenseId = licenseId;
    const profile = this.license.getProfile();
    if (profile !== null) out.profile = profile;
    const lastVerifiedAt = this.cache.state.lastVerifiedAt;
    if (lastVerifiedAt !== null) out.lastVerifiedAt = lastVerifiedAt;
    return out;
  }

  /** The device roster, blended with this device's locally-derived state. Without a credential
   *  there is no roster to fetch, so the answer is this device alone — which is the honest
   *  offline answer, not an error. */
  async listDevices(): Promise<DeviceInfo[]> {
    const current = this.getCurrentDevice();
    let roster;
    try {
      roster = await this.devices.list();
    } catch (e) {
      if (e instanceof DeviceManagementUnsupportedError) return [current];
      throw e;
    }
    return roster.map((device) => ({
      id: device.id,
      current: device.current,
      status: device.current ? current.status : "ok",
      licenseId:
        device.licenseId ?? (device.current ? current.licenseId : undefined),
      profile: device.current ? current.profile : undefined,
      lastVerifiedAt: device.current ? current.lastVerifiedAt : undefined,
      label: device.label,
      platform: device.platform,
      arch: device.arch,
      appVersion: device.appVersion,
      sdkName: device.sdkName,
      sdkVersion: device.sdkVersion,
    }));
  }

  /** Deauthorizing THIS device is a full local deactivation; any other device is a roster
   *  operation that needs a credential. */
  async deauthorizeDevice(deviceId: string): Promise<void> {
    if (deviceId === this.core.deviceId) {
      await this.license.deactivate();
      return;
    }
    await this.devices.deauthorize(deviceId);
  }

  async renameDevice(deviceId: string, label: string | null): Promise<void> {
    await this.devices.rename(deviceId, label);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────
  private startTimer(): void {
    const seconds = this.refreshIntervalSeconds;
    if (!seconds || seconds <= 0 || this.timer || this.core.localOnly) return;
    this.timer = setInterval(() => {
      void this.sync().catch(() => undefined);
    }, seconds * 1000);
    // Don't hold a CLI or short-lived process open just to poll.
    this.timer.unref?.();
  }

  /**
   * The default refresh for a long-running host (SDK parity pass §3.11): sync every
   * `intervalSeconds` (default 3600), at once after a wake (the timer fired much later than
   * scheduled: the machine slept), and with backoff after a failed sync (30 s doubling up to the
   * interval) so a host that comes back online syncs within a minute. Each sync honours the
   * documents' ETags. Off unless called; `close()` stops it. The timer never holds the process
   * open.
   */
  startRefresh(
    opts: {
      intervalSeconds?: number;
      /** Test seam: the timer and clock (default `setTimeout` and `Date.now`). */
      timers?: {
        setTimeout: (fn: () => void, ms: number) => unknown;
        now: () => number;
      };
    } = {},
  ): void {
    if (this.refreshTimer || this.core.localOnly) return;
    const interval = Math.max(60, opts.intervalSeconds ?? 3600) * 1000;
    const now = opts.timers?.now ?? Date.now;
    const arm =
      opts.timers?.setTimeout ??
      ((fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    let backoff = 30_000;
    const failed = (r: SyncResult): boolean => {
      const docs = Object.values(r.documents).filter(
        (d) => d && d.kind !== "skipped",
      );
      return docs.length > 0 && docs.every((d) => d!.kind === "error");
    };
    const schedule = (delay: number): void => {
      const due = now() + delay;
      this.refreshTimer = arm(() => {
        if (this.refreshTimer === null) return;
        // Slept through the deadline by more than a minute: a wake, so force past the ETags.
        const woke = now() - due > 60_000;
        void this.sync(woke ? { force: true } : {})
          .then(
            (r) => !failed(r),
            () => false,
          )
          .then((ok) => {
            if (this.refreshTimer === null) return;
            if (ok) {
              backoff = 30_000;
              schedule(interval);
            } else {
              schedule(Math.min(backoff, interval));
              backoff = Math.min(backoff * 2, interval);
            }
          });
      }, delay) as ReturnType<typeof setTimeout>;
    };
    schedule(interval);
  }

  /** Stop the refresh timers. Safe to call more than once. */
  close(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
