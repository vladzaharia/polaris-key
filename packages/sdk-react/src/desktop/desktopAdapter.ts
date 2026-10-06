// The desktop adapter: a renderer-side `PolarisAdapter` that proxies every operation to a
// `PolarisBridge` (the privileged Electron/Tauri process owning `@polaris-key/node`). It derives the
// gate locally from the bridge's `BridgeState` using `@polaris-key/client-core`'s `licenseState` — the
// same function the Node side would run — so a desktop snapshot is byte-identical in shape to a
// browser snapshot (mode-parity), clock floor included.
//
// All credential/keyring/loopback-OIDC work lives behind the bridge; this file is pure glue +
// state projection. `submitKey` IS supported here (unlike browser): desktop apps allow typed-key
// activation as an offline-friendly path.
//
// Device management, update checks, the Release verbs and telemetry go through the bridge's
// versioned `invoke()` escape hatch rather than dedicated methods, so a host that predates them
// reports them unsupported instead of failing to satisfy the interface. Offline bundle import is
// bridge protocol v3's optional `importBundle` (P1b-07): the host's Node client verifies and
// writes the cache, and the renderer re-reads the state it left.

import {
  configSource,
  currentDeviceFromState,
  listUserConfig,
  projectState,
  readConfig,
  readEntitled,
  readEntitledChannels,
} from "../core/adapter.js";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CapabilityContext } from "@polaris-key/client-core";
import { isManageUrl } from "@polaris-key/client-core";
import { createStore, type Store } from "../core/store.js";
import {
  PolarisError,
  UnsupportedError,
  capabilityContext,
  capsIn,
  initialState,
  refuse,
  supportsIn,
  type ConfigSource,
  type Support,
  type DeviceInfo,
  type JSONValue,
  type OidcSignInHandle,
  type PolarisAdapter,
  type PolarisState,
  type UserConfigEntry,
  type VersionCheck,
  type ChangelogEntry,
  type DownloadUrlOptions,
  type ImportBundleResult,
  type ProductCatalog,
  type UpdateCheck,
  type UpdateDecideOptions,
} from "../core/index.js";
import type {
  CommerceBinding,
  CommerceClaimResult,
  CommercePayload,
  CommerceStore,
  DeviceSignIn,
  DeviceSignInResult,
  MintedToken,
} from "../core/types.js";
import type { StoreStatus } from "@polaris-key/client-core";
import { isCatalog } from "../browser/catalog.js";
import { activationError } from "../core/activationError.js";
import type { ActivationOutcome } from "../core/activation.js";
import {
  copyServices,
  defaultServices,
  noBusy,
  noErrors,
  withBusy,
  withError,
  type ServiceSlug,
  type ServicesMap,
} from "../core/services.js";
import { classifyActivation } from "../core/activation.js";
import {
  BRIDGE_VERSION,
  resolveBridge,
  type BridgeActivation,
  type BridgeOidcBegin,
  type BridgeState,
  type PolarisBridge,
} from "./bridge.js";

/** The features the renderer reaches only through bridge v4 `invoke` verbs. */
const V4_FEATURES = new Set<string>([
  Feature.configMint,
  Feature.commerceReceipt,
]);

export interface DesktopAdapterOptions {
  /** The bridge to drive. Defaults to `window.polarisKey`. */
  bridge?: PolarisBridge;
  /** Override the clock (seconds) — for tests. */
  now?: () => number;
  /** Client-supplied local/user overrides for `default`-state config keys. Never override
   *  `enforced`/`hidden` keys (server wins). The node host owns env layering, not this. */
  localOverrides?: Record<string, JSONValue>;
  /** What the host EXPECTS this product to run, used only while the bridge has not reported
   *  a capability map (D-21). Defaults to license + config; never all-true. */
  expectServices?: ServicesMap;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export class DesktopAdapter implements PolarisAdapter {
  readonly mode = "desktop" as const;
  private readonly bridge: PolarisBridge;
  private readonly store: Store<PolarisState>;
  private readonly clock: () => number;
  private readonly localOverrides: Record<string, JSONValue>;
  private readonly fallbackServices: ServicesMap;
  private capabilities: ServicesMap;
  /** `supports()`'s inputs: the generated table, runtime `desktop-bridge`, and `capabilities`. */
  private readonly capabilityCtx: CapabilityContext;
  private offBridge: (() => void) | null = null;

  constructor(opts: DesktopAdapterOptions = {}) {
    const bridge = resolveBridge(opts.bridge);
    if (!bridge) {
      throw new PolarisError(
        "bridge-missing",
        "No PolarisBridge found. Pass { bridge } or expose window.polarisKey from your preload.",
      );
    }
    this.bridge = bridge;
    this.clock = opts.now ?? nowSec;
    this.localOverrides = opts.localOverrides ?? {};
    this.fallbackServices = copyServices(
      opts.expectServices ?? defaultServices(),
    );
    this.capabilities = copyServices(this.fallbackServices);
    this.capabilityCtx = capabilityContext(
      "desktop-bridge",
      () => this.capabilities,
    );
    this.store = createStore<PolarisState>(
      initialState("desktop", this.capabilities, this.localOverrides),
    );
    // Subscribe to state changes from the privileged process.
    this.offBridge = this.bridge.on("stateChanged", (s) => this.apply(s));
    // Kick off the first load. Errors surface into the snapshot, not as a throw.
    void this.load();
  }

  snapshot(): PolarisState {
    return this.store.get();
  }

  subscribe(cb: (state: PolarisState) => void): () => void {
    return this.store.subscribe(cb);
  }

  private apply(
    s: BridgeState,
    flags: {
      busy?: PolarisState["busy"];
      error?: PolarisState["error"];
    } = {},
  ): void {
    // D-21: honour a reported map; otherwise keep the configured expectation. Never all-true.
    this.capabilities = s.capabilities
      ? copyServices(s.capabilities)
      : this.fallbackServices;
    this.store.set(
      projectState(
        "desktop",
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

  private async load(): Promise<void> {
    try {
      this.apply(await this.bridge.getSyncState());
    } catch (e) {
      // First load failed: present a ready, error-bearing, needs-activation state.
      this.apply(
        { activation: null, doc: null },
        {
          error: withError(
            noErrors(),
            "license",
            new PolarisError("network", (e as Error).message),
          ),
        },
      );
    }
  }

  private patch(mutate: (prev: PolarisState) => Partial<PolarisState>): void {
    this.store.set((prev) => {
      const next = mutate(prev);
      const changed = (Object.keys(next) as (keyof PolarisState)[]).some(
        (k) => prev[k] !== next[k],
      );
      return changed ? { ...prev, ...next } : prev;
    });
  }

  private setBusy(slug: ServiceSlug, busy: boolean): void {
    this.patch((prev) => ({ busy: withBusy(prev.busy, slug, busy) }));
  }

  private fail(slug: ServiceSlug, err: PolarisError): PolarisError {
    this.patch((prev) => ({
      busy: withBusy(prev.busy, slug, false),
      error: withError(prev.error, slug, err),
    }));
    return err;
  }

  /** Call a sub-client verb through the bridge's escape hatch, mapping an absent `invoke` to
   *  the honest capability refusal rather than a mysterious TypeError. */
  private async invoke<T>(
    service: string,
    method: string,
    args?: unknown,
    unsupported = new PolarisError(
      "device-management-unsupported",
      "This desktop bridge does not expose that capability.",
    ),
  ): Promise<T> {
    if (!this.bridge.invoke) throw unsupported;
    return (await this.bridge.invoke(service, method, args)) as T;
  }

  async refresh(): Promise<void> {
    this.setBusy("license", true);
    this.setBusy("config", true);
    try {
      this.apply(await this.bridge.refresh(), {
        busy: noBusy(),
        error: noErrors(),
      });
    } catch (e) {
      this.patch((prev) => ({
        busy: withBusy(withBusy(prev.busy, "license", false), "config", false),
      }));
      throw this.fail(
        "license",
        new PolarisError("refresh-failed", (e as Error).message),
      );
    }
  }

  async signInWithOidc(): Promise<OidcSignInHandle | void> {
    if (!this.capabilities.identity.enabled) {
      throw this.fail(
        "identity",
        new PolarisError(
          "service-disabled",
          "OIDC login is not enabled for this product.",
        ),
      );
    }
    this.setBusy("identity", true);
    try {
      const begin = await this.bridge.beginSignIn();
      // Poll in the background; flip out of busy + apply the fresh state on completion.
      void this.pollUntilSettled(begin.flowId);
      return {
        verificationUrl: begin.verificationUrl,
        userCode: begin.userCode,
      };
    } catch (e) {
      throw this.fail(
        "identity",
        new PolarisError("sign-in-failed", (e as Error).message),
      );
    }
  }

  private async pollUntilSettled(flowId: string): Promise<void> {
    try {
      // The bridge owns the real backoff; the renderer just re-asks until terminal.
      for (;;) {
        const r = await this.bridge.pollSignIn(flowId);
        if (r.kind === "pending") {
          await delay(1500);
          continue;
        }
        if (r.kind === "ok") {
          this.apply(await this.bridge.getSyncState(), {
            busy: noBusy(),
            error: noErrors(),
          });
          return;
        }
        this.fail(
          "identity",
          new PolarisError(
            "sign-in-failed",
            r.kind === "error" ? r.message : r.kind,
          ),
        );
        return;
      }
    } catch (e) {
      this.fail(
        "identity",
        new PolarisError("sign-in-failed", (e as Error).message),
      );
    }
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
      const r = await this.bridge.submitKey(key);
      if (r.kind !== "ok") throw activationError(bridgeActivationOutcome(r));
      this.apply(await this.bridge.getSyncState(), {
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
      await this.bridge.signOut();
      this.apply(await this.bridge.getSyncState(), {
        busy: noBusy(),
        error: noErrors(),
      });
    } catch (e) {
      throw this.fail(
        "identity",
        new PolarisError("sign-out-failed", (e as Error).message),
      );
    }
  }

  currentDevice(): DeviceInfo | null {
    return currentDeviceFromState(this.store.get());
  }

  async listDevices(): Promise<DeviceInfo[]> {
    this.setBusy("license", true);
    try {
      const rows = await this.invoke<DeviceInfo[]>("devices", "list");
      this.setBusy("license", false);
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      throw this.fail("license", asPolarisError(e));
    }
  }

  async renameDevice(deviceId: string, label: string | null): Promise<void> {
    this.setBusy("license", true);
    try {
      await this.invoke("devices", "rename", { deviceId, label });
      this.setBusy("license", false);
    } catch (e) {
      throw this.fail("license", asPolarisError(e));
    }
  }

  async deauthorizeDevice(deviceId: string): Promise<void> {
    // Deauthorizing THIS device is a full local deactivation, which the bridge already owns.
    const current = this.currentDevice();
    if (current?.id === deviceId) {
      await this.signOut();
      return;
    }
    this.setBusy("license", true);
    try {
      await this.invoke("devices", "deauthorize", { deviceId });
      this.apply(await this.bridge.getSyncState(), {
        busy: noBusy(),
        error: noErrors(),
      });
    } catch (e) {
      throw this.fail("license", asPolarisError(e));
    }
  }

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
      const result = await this.invoke<VersionCheck>(
        "update",
        "check",
        opts,
        new PolarisError(
          "service-disabled",
          "This desktop bridge does not expose update checks.",
        ),
      );
      this.patch((prev) => ({
        busy: withBusy(prev.busy, "update", false),
        error: withError(prev.error, "update", null),
      }));
      return result;
    } catch (e) {
      throw this.fail("update", asPolarisError(e));
    }
  }

  /**
   * The wire v4 update decision, made by the host: `invoke("update", "decide", opts)`, which an
   * Electron host answers with `@polaris-key/node`'s `client.update.decide(opts)` (P3-04) and
   * a Tauri host with its own (X-02). The privileged process holds the cache slices, the pinned
   * release keys and the outlet; the renderer forwards the three arguments and returns the
   * `UpdateCheck` it gets. `service-unavailable` when the product runs no Update service or the
   * host has no `invoke`; a host refusal arrives as its own code.
   */
  async decideUpdate(opts: UpdateDecideOptions = {}): Promise<UpdateCheck> {
    const unavailable = new PolarisError(
      "service-unavailable",
      "This desktop host does not decide signed updates; use checkUpdate().",
    );
    if (!this.capabilities.update.enabled)
      throw this.fail("update", unavailable);
    this.setBusy("update", true);
    try {
      const args: UpdateDecideOptions = {};
      if (opts.channel !== undefined) args.channel = opts.channel;
      if (opts.staged !== undefined) args.staged = opts.staged;
      if (opts.skipVersion !== undefined) args.skipVersion = opts.skipVersion;
      const result = await this.invoke<UpdateCheck>(
        "update",
        "decide",
        args,
        unavailable,
      );
      this.patch((prev) => ({
        busy: withBusy(prev.busy, "update", false),
        error: withError(prev.error, "update", null),
      }));
      return result;
    } catch (e) {
      throw this.fail("update", updateError(e));
    }
  }

  async fetchSchema(): Promise<ProductCatalog | null> {
    // D-21: not even asked for. Diagnostic: every failure, an absent host method included, is
    // null — the catalog drives no decision, so there is nothing to refuse.
    if (!this.capabilities.config.enabled || !this.bridge.fetchSchema)
      return null;
    try {
      const body: unknown = await this.bridge.fetchSchema();
      return isCatalog(body) ? body : null;
    } catch {
      return null;
    }
  }

  /** D-21 for Release: refuse before crossing the bridge when the product does not run it. */
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

  private releaseUnsupported(): PolarisError {
    return new PolarisError(
      "service-disabled",
      "This desktop bridge does not expose the release client.",
    );
  }

  async changelog(): Promise<ChangelogEntry[]> {
    this.requireRelease();
    this.setBusy("release", true);
    try {
      const rows = await this.invoke<ChangelogEntry[]>(
        "release",
        "changelog",
        undefined,
        this.releaseUnsupported(),
      );
      this.patch((prev) => ({
        busy: withBusy(prev.busy, "release", false),
        error: withError(prev.error, "release", null),
      }));
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      throw this.fail("release", releaseError(e));
    }
  }

  async installUrl(): Promise<string> {
    this.requireRelease();
    return this.invoke<string>(
      "release",
      "installUrl",
      undefined,
      this.releaseUnsupported(),
    );
  }

  async downloadUrl(
    version: string,
    binary: string,
    arch: string,
    opts: DownloadUrlOptions = {},
  ): Promise<string> {
    this.requireRelease();
    return this.invoke<string>(
      "release",
      "downloadUrl",
      { version, binary, arch, ...opts },
      this.releaseUnsupported(),
    );
  }

  async importBundle(jws: string): Promise<ImportBundleResult> {
    if (!this.bridge.importBundle) {
      throw this.fail(
        "license",
        new PolarisError(
          ErrorCode.bundleImportUnsupported,
          `This desktop bridge (protocol v${this.bridge.version ?? 1}) cannot import offline bundles; protocol v3 adds importBundle.`,
        ),
      );
    }
    this.setBusy("license", true);
    try {
      const result = await this.bridge.importBundle(jws);
      this.apply(await this.bridge.getSyncState(), {
        busy: noBusy(),
        error: noErrors(),
      });
      return result;
    } catch (e) {
      // The host's refusal carries the §7 step as its code (`@polaris-key/node`'s PolarisError).
      const code = errorCode(e);
      throw this.fail(
        "license",
        e instanceof PolarisError
          ? e
          : new PolarisError(
              ErrorCode.bundleRejected,
              (e as Error)?.message ?? String(e),
              code,
            ),
      );
    }
  }

  /** Device telemetry through the privileged process's Node client (`devices.report()`). */
  async report(): Promise<boolean> {
    const ok = await this.invoke<boolean>(
      "devices",
      "report",
      undefined,
      new PolarisError(
        ErrorCode.reportUnsupported,
        "This desktop bridge does not expose device telemetry.",
      ),
    );
    return ok === true;
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

  getSecret(key: string): string | null {
    // The renderer never holds secrets (the `config.secret` desktop-bridge N/A): a typed refusal
    // rather than an indistinguishable `null`. A privileged host that truly needs to hand a
    // renderer a secret exposes its own bridge verb for it.
    void key;
    refuse(this.capabilityCtx, Feature.configSecret, {
      detail:
        "The renderer never holds secrets; a host that must hand one over exposes its own bridge verb.",
    });
  }

  supports(feature: string): Support {
    if (V4_FEATURES.has(feature) && !this.speaksV4())
      return {
        supported: false,
        feature,
        reason: "version",
        detail: `This desktop bridge (protocol v${this.bridge.version ?? 1}) predates bridge protocol v4, which carries ${feature}.`,
      };
    return supportsIn(this.capabilityCtx, feature);
  }

  caps(): string[] {
    return capsIn(this.capabilityCtx).filter(
      (f) => this.speaksV4() || !V4_FEATURES.has(f),
    );
  }

  isEntitled(name: string): boolean {
    return readEntitled(this.store.get(), name);
  }

  // ── Bridge v4 (SP-R07): more sub-client verbs over `invoke`, each refused with the typed
  //    `UnsupportedError` when the host predates them. ──

  /** Enrolment happens in the host's own boot (`license.enroll` is a desktop-bridge N/A). */
  async enroll(): Promise<void> {
    refuse(this.capabilityCtx, Feature.licenseEnroll, {
      detail:
        "The host process enrols (its Node SDK's license.enroll()); the renderer does not.",
    });
  }

  async beginSignIn(opts: { deviceName?: string } = {}): Promise<DeviceSignIn> {
    if (!this.capabilities.identity.enabled)
      throw this.fail(
        "identity",
        new PolarisError(
          "service-disabled",
          "OIDC login is not enabled for this product.",
        ),
      );
    this.setBusy("identity", true);
    let begin: BridgeOidcBegin;
    try {
      begin = await this.bridge.beginSignIn(
        opts.deviceName ? { deviceName: opts.deviceName } : undefined,
      );
    } catch (e) {
      throw this.fail(
        "identity",
        new PolarisError("sign-in-unavailable", (e as Error).message),
      );
    }
    const interval = begin.interval ?? 2;
    return {
      userCode: begin.userCode ?? "",
      verificationUri: begin.verificationUri ?? begin.verificationUrl ?? "",
      verificationUriComplete:
        begin.verificationUrl ?? begin.verificationUri ?? "",
      expiresAt: begin.expiresAt ?? this.clock() + 600,
      interval,
      wait: async (w = {}) => {
        for (;;) {
          w.signal?.throwIfAborted();
          const r = await this.bridge.pollSignIn(begin.flowId);
          if (r.kind === "pending") {
            await delay(Math.max(1, interval) * 1000);
            continue;
          }
          if (r.kind === "ok") {
            this.apply(await this.bridge.getSyncState(), {
              busy: noBusy(),
              error: noErrors(),
            });
            return r.identity
              ? { status: "ready", identity: r.identity }
              : { status: "ready" };
          }
          const out: DeviceSignInResult =
            r.kind === "error"
              ? { status: "error", message: r.message }
              : { status: r.kind };
          this.fail(
            "identity",
            new PolarisError(
              r.kind === "expired"
                ? "sign-in-expired"
                : r.kind === "denied"
                  ? "sign-in-denied"
                  : "sign-in-failed",
              r.kind === "error" ? r.message : r.kind,
            ),
          );
          return out;
        }
      },
    };
  }

  /** `invoke("config", "mint", {recipeId})`: the host's `client.config.mintToken()`. */
  async mintToken(recipeId: string): Promise<MintedToken> {
    const r = await this.invokeV4<MintedToken>(
      Feature.configMint,
      "edge-mint",
      "config",
      "mint",
      { recipeId },
    ).catch((e: unknown) => {
      throw this.fail("config", asPolarisError(e));
    });
    return r;
  }

  /** `invoke("commerce", "binding")`: the host's `client.commerce.binding()`. */
  async commerceBinding(): Promise<CommerceBinding> {
    return this.invokeV4<CommerceBinding>(
      Feature.commerceReceipt,
      "commerce",
      "commerce",
      "binding",
    );
  }

  /** `invoke("commerce", "claim", {store, payload})`, then the host's fresh state. */
  async commerceClaim(
    store: CommerceStore,
    payload: CommercePayload,
  ): Promise<CommerceClaimResult> {
    const r = await this.invokeV4<CommerceClaimResult>(
      Feature.commerceReceipt,
      "commerce",
      "commerce",
      "claim",
      { store, payload },
    );
    if (r?.kind === "ok")
      this.apply(await this.bridge.getSyncState(), {
        busy: noBusy(),
        error: noErrors(),
      });
    return r;
  }

  /** `invoke("core", "discovery")`, or null on a host that does not answer it. */
  async discovery(): Promise<Record<string, unknown> | null> {
    if (!this.bridge.invoke || !this.speaksV4()) return null;
    try {
      const d = await this.bridge.invoke("core", "discovery");
      return d && typeof d === "object" ? (d as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** `invoke("devices", "id")`: the host's device id (what an offline bundle is minted for). */
  async offlineDeviceId(): Promise<string | null> {
    if (!this.bridge.invoke || !this.speaksV4()) return null;
    try {
      const id = await this.bridge.invoke("devices", "id");
      return typeof id === "string" && id !== "" ? id : null;
    } catch {
      return null;
    }
  }

  /** `invoke("core", "storeStatus")`: where the host keeps the token. */
  async storeStatus(): Promise<StoreStatus | null> {
    if (!this.bridge.invoke || !this.speaksV4()) return null;
    try {
      const st = (await this.bridge.invoke(
        "core",
        "storeStatus",
      )) as StoreStatus | null;
      return st && typeof st === "object" && typeof st.backend === "string"
        ? st
        : null;
    } catch {
      return null;
    }
  }

  /** True when the host reports bridge protocol v4 or later (an absent `version` is 1). A v3
   *  host's `invoke` may answer only the v3 verbs, so a v4 verb is never sent to it. */
  private speaksV4(): boolean {
    return (this.bridge.version ?? 1) >= BRIDGE_VERSION;
  }

  /** A bridge v4 `invoke` verb: refused with the typed version N/A before anything crosses the
   *  bridge when the host reports an older protocol or has no `invoke` at all. */
  private async invokeV4<T>(
    feature: string,
    what: string,
    service: string,
    method: string,
    args?: unknown,
  ): Promise<T> {
    const unsupported = this.v4Unsupported(feature, what);
    if (!this.speaksV4()) throw unsupported;
    return this.invoke<T>(service, method, args, unsupported);
  }

  private v4Unsupported(feature: string, what: string): PolarisError {
    return new UnsupportedError(
      {
        supported: false,
        feature,
        reason: "version",
        detail: `This desktop bridge (protocol v${this.bridge.version ?? 1}) does not expose ${what}; bridge protocol v4 adds it.`,
      },
      "unsupported",
    );
  }

  dispose(): void {
    this.offBridge?.();
    this.offBridge = null;
  }
}

/** Map a host's activation answer onto the §3.1 table. A host's `error` keeps its message: with
 *  a code it is classified by that code (`refused` for an unknown one), never `deviceLimit`;
 *  without one it is `error` with code `server`. A v3 host's code-less `error` covers a 429, a
 *  5xx and a transport failure alike (`@polaris-key/node`'s ActivationResult), so "offline"
 *  (`network`) is not provable and is never claimed. */
export function bridgeActivationOutcome(
  r: Exclude<BridgeActivation, { kind: "ok" }>,
): ActivationOutcome {
  switch (r.kind) {
    case "device-limit":
      return {
        kind: "deviceLimit",
        code: "device_limit",
        ...(r.limit !== undefined ? { limit: r.limit } : {}),
        ...(r.deviceCount !== undefined ? { deviceCount: r.deviceCount } : {}),
        // PX-W8: re-validated here, because the bridge is a process boundary.
        ...(isManageUrl(r.manageUrl) ? { manageUrl: r.manageUrl } : {}),
      };
    case "unauthorized":
      return { kind: "unauthorized", code: "unauthorized" };
    case "fingerprint-required":
      return { kind: "fingerprintRequired", code: "fingerprint_required" };
    case "enroll-disabled":
      return { kind: "enrollDisabled", code: "enroll_disabled" };
    case "hardware-mismatch":
      return { kind: "hardwareMismatch", code: "hardware_mismatch" };
    case "refused":
      return classifyRefused(r.code, r.status, r.message);
    case "error":
      return r.code
        ? classifyRefused(r.code, undefined, r.message)
        : { kind: "error", code: "server", message: r.message };
  }
}

function classifyRefused(
  code: string,
  status?: number,
  message?: string,
): ActivationOutcome {
  const o = classifyActivation(status ?? 403, { error: { code, message } });
  return o;
}

function asPolarisError(e: unknown): PolarisError {
  if (e instanceof PolarisError) return e;
  return new PolarisError("unknown", (e as Error)?.message ?? String(e));
}

/** The `code` a host-side error carries across the bridge, when it kept one. */
function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/** A release refusal from the host: its code is the refusal body's (`@polaris-key/node`). */
function releaseError(e: unknown): PolarisError {
  if (e instanceof PolarisError) return e;
  const code = errorCode(e);
  const message = (e as Error)?.message ?? String(e);
  if (code === "service-unavailable")
    return new PolarisError("service-disabled", message, code);
  // The Node client's own failure codes (a non-refusal status, local-only mode) are transport
  // trouble, not an entitlement answer.
  if (code === "not_found" || code === "local-only")
    return new PolarisError("network", message, code);
  return code
    ? new PolarisError(ErrorCode.releaseRefused, message, code)
    : new PolarisError("unknown", message);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Construct a desktop adapter (the canonical factory the Provider uses). */
export function desktopAdapter(
  opts: DesktopAdapterOptions = {},
): PolarisAdapter {
  return new DesktopAdapter(opts);
}

/** The host's §2.5 codes, which React's vocabulary carries as they are. */
const UPDATE_CODES = [
  "service-unavailable",
  "not-configured",
  "invalid-options",
  "feed-rejected",
  "feed-rollback",
  "record-rejected",
  "record-mismatch",
] as const;

/** An update-decision refusal from the host (`@polaris-key/node`'s `PolarisError`): a §2.5 code
 *  keeps its name (and `detail`), a transport failure is `network`, anything else `unknown`; the
 *  host's own code is always `wireCode`. */
function updateError(e: unknown): PolarisError {
  if (e instanceof PolarisError) return e;
  const code = errorCode(e);
  const message = (e as Error)?.message ?? String(e);
  const rawDetail = (e as { detail?: unknown } | null)?.detail;
  const detail = typeof rawDetail === "string" ? rawDetail : undefined;
  const known = (UPDATE_CODES as readonly string[]).includes(code ?? "");
  if (known)
    return new PolarisError(
      code as (typeof UPDATE_CODES)[number],
      message,
      code,
      detail,
    );
  if (code === "network-error" || code === "network")
    return new PolarisError("network", message, code);
  return new PolarisError("unknown", message, code);
}
