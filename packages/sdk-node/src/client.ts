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
//     here, sync anyway". Now the license client raises an EVENT and the facade decides.
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
import type {
  BlockedState,
  LicenseState,
  StoreStatus,
} from "@polaris-key/client-core";
import { CacheManager } from "./core/cache.js";
import { CoreContext, nowSec, type CoreOptions } from "./core/context.js";
import { importBundle, type ImportBundleResult } from "./core/bundle.js";
import { sync, type SyncOptions, type SyncResult } from "./core/sync.js";
import { TokenManager } from "./core/token.js";
import { TrustManager } from "./core/trust.js";
import { buildSnapshot, reportSnapshot } from "./core/telemetry.js";
import { ConfigClient, type ConfigClientOptions } from "./config/client.js";
import { LicenseClient, type LicenseClientOptions } from "./license/client.js";
import { reacquireToken } from "./license/endpoints.js";
import {
  DevicesClient,
  DeviceManagementUnsupportedError,
  type DevicesClientOptions,
} from "./devices/client.js";
import { ReleaseClient } from "./release/client.js";
import { UpdateClient } from "./update/client.js";
import {
  discoverProduct,
  type DiscoverProductResult,
  type ProductDiscoveryDocument,
  type ServicesMap,
} from "./discovery.js";

export { DeviceManagementUnsupportedError };

export interface PolarisKeyClientOptions extends CoreOptions {
  /** Config service inputs (override layers). */
  config?: ConfigClientOptions;
  /** License service inputs. */
  license?: LicenseClientOptions;
  /** Devices inputs (probes, fingerprint opt-out). */
  devices?: DevicesClientOptions;
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
  readonly release: ReleaseClient;
  readonly update: UpdateClient;

  private readonly cache: CacheManager;
  private readonly tokens: TokenManager;
  private readonly trust: TrustManager;
  private readonly refreshIntervalSeconds?: number;
  private readonly onChange?: (state: LicenseState) => void;
  private readonly probes: DevicesClientOptions["probes"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private discoveryDoc: ProductDiscoveryDocument | null = null;

  constructor(opts: PolarisKeyClientOptions & { localOnly?: boolean }) {
    this.product = opts.productSlug;
    this.core = new CoreContext(opts);
    this.trust = new TrustManager(this.core);
    this.cache = new CacheManager(this.core, this.trust);
    // The re-acquire path is injected so Core does not depend on the license module; §5's
    // single-attempt rule lives in `TokenManager` and the ROUTE lives in license/endpoints.
    this.tokens = new TokenManager(
      this.core,
      this.core.store,
      async (ctx, current) => {
        const r = await reacquireToken(ctx, current);
        return r.kind === "ok" ? r.token : null;
      },
    );
    this.probes = opts.devices?.probes;

    this.devices = new DevicesClient(
      this.core,
      this.cache,
      this.tokens,
      opts.devices ?? {},
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
    this.config = new ConfigClient(this.core, this.cache, opts.config ?? {});
    this.release = new ReleaseClient(this.core, this.tokens);
    this.update = new UpdateClient(
      this.core,
      this.tokens,
      () => this.discoveryDoc,
    );

    this.refreshIntervalSeconds = opts.refreshIntervalSeconds;
    this.onChange = opts.onChange;
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
    await this.tokens.load();
    await this.cache.load();
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

  /** What this client currently believes the product runs. */
  capabilities(): ServicesMap {
    return this.core.services();
  }

  // ── Sync ──────────────────────────────────────────────────────────────────────────────
  /**
   * One Core pass: trust refresh → enabled documents in parallel → verify → cache → floor →
   * report. See `core/sync.ts` for the full ordering rationale.
   */
  async sync(opts: SyncOptions = {}): Promise<SyncResult> {
    const before = this.cache.etag("license");
    const beforeConfig = this.cache.etag("config");
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
    return result;
  }

  private async reportOnce(): Promise<void> {
    const token = this.tokens.current;
    if (!token) return;
    await reportSnapshot(
      this.core,
      token,
      buildSnapshot(this.cache, this.probes ?? []),
    );
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
    return importBundle(this.core, this.cache, jws, now);
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
    if (typeof store.status !== "function") return null;
    try {
      return await store.status();
    } catch {
      return null;
    }
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

  /** Stop the refresh timer. Safe to call more than once. */
  close(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
