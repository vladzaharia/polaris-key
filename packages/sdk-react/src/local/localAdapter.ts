// The local-only adapter (SDK parity pass §3.1 `core.local`, SP-R12): a `PolarisAdapter` that
// NEVER touches the network, for tests, previews, Storybook and kiosk builds. `@polaris-key/node`'s
// `createLocalClient()` is its counterpart (packages/sdk-node/src/local/index.ts).
//
// It serves the documents the build bundles with it (a licence document, config entries) and a
// FIXED licence state, projected through the same `projectState` the other two adapters use, so
// a hook reads the same shapes from it as from either of them. There is no first load: the
// snapshot is `ready` from construction, and construction does no I/O of any kind.
//
// ── HOW "NEVER" IS ENFORCED ─────────────────────────────────────────────────────────────────
//
// By construction, not by habit: this module takes no `fetch` and imports no transport, so there
// is no call it could make. Every verb that would dial (sync, sign-in, activation, devices, the
// release and update reads, the verified download) REJECTS with `local-only`, loudly and at
// once, rather than hanging on a connect timeout or resolving to an empty answer: the host asked
// a transportless client to reach the network, which is a configuration error and not a
// transport outcome (the same split `@polaris-key/node/local` documents). What stays offline
// keeps working: the gate, config resolution, device-local overrides (`config.local`), the crash
// tags, the boot guard and a whole `boot()` pass (whose sync is a no-op that answers `ok`).
//
// `supports()` says the same in the table's vocabulary: a feature that needs the network is
// `runtime`-unsupported here, whatever the web or desktop row says.

import { channelForVersion } from "@polaris-key/client-core";
import type {
  CapabilityContext,
  ConfigSource,
  Support,
} from "@polaris-key/client-core";
import type { ProductCatalog } from "@polaris-key/catalog";
import type { JSONValue, ManagedEntry } from "@polaris-key/protocol/core";
import type { LicenseDoc, LicenseStatus } from "@polaris-key/protocol/license";
import type { UpdateCheck, UpdateDecision } from "@polaris-key/protocol/update";
import { Feature, type UpdateEvent } from "../constants.generated.js";
import {
  configSource,
  currentDeviceFromState,
  listUserConfig,
  projectState,
  readConfig,
  readEntitled,
  readEntitledChannels,
  withOverrides,
} from "../core/adapter.js";
import {
  BootGuard,
  browserBootSlotStore,
  type BootAttempt,
  type BootSlotStore,
} from "../core/bootGuard.js";
import { runBoot, type BootResult, type BootRunOptions } from "../core/boot.js";
import {
  UnsupportedError,
  capabilityContext,
  capsIn,
  supportsIn,
} from "../core/caps.js";
import {
  crashTagsFor,
  type CrashTags,
  type CrashTagsOptions,
} from "../core/crash.js";
import {
  unsupportedOutcome,
  type InstallOptions,
  type InstallOutcome,
} from "../core/install.js";
import {
  LocalConfigEngine,
  browserLocalConfigBackend,
  type ConfigStorage,
} from "../core/localConfig.js";
import type { ReactPresentationSource } from "../core/presentation.js";
import { expectedServicesOf } from "../core/expectedServices.js";
import {
  copyServices,
  type ServiceSlug,
  type ServicesMap,
} from "../core/services.js";
import { createStore, type Store } from "../core/store.js";
import {
  PolarisError,
  type ChangelogEntry,
  type CommerceBinding,
  type CommerceClaimResult,
  type CommercePayload,
  type CommerceStore,
  type DeviceInfo,
  type DeviceSignIn,
  type AttachResult,
  type DownloadUrlOptions,
  type KeyActivation,
  type SignOutResult,
  type FeedKind,
  type FeedUrl,
  type FeedUrlOptions,
  type ImportBundleResult,
  type MintedToken,
  type OidcSignInHandle,
  type PolarisAdapter,
  type PolarisState,
  type UpdateDecideOptions,
  type UserConfigEntry,
  type VersionCheck,
} from "../core/types.js";
import {
  buildUpdateEvent,
  type UpdateEventEntry,
  type UpdateEventInput,
} from "../core/updateEvents.js";
import type {
  FetchTarget,
  ReleaseFetchOptions,
  ReleaseFetchResult,
} from "../browser/releaseFetch.js";
import type { DownloadModel, ThisPlatform } from "../browser/distribution.js";

export interface LocalAdapterOptions {
  /** The product slug: keys the device-local overrides and the boot guard's slots. */
  productSlug: string;
  /** The licence document the build bundles, for the profile, device id and entitlements. The
   *  gate does NOT evaluate it: the state below is fixed. */
  license?: LicenseDoc | null;
  /** The config document's entries the build bundles. */
  config?: Record<string, ManagedEntry>;
  /** The fixed licence state. Default `ok` when the product runs License, else
   *  `not-applicable`. */
  status?: LicenseStatus;
  /** What the product runs. Defaults to licence + config; never all-true. */
  expectedServices?: readonly ServiceSlug[];
  /** The app's version: the boot guard's key and the crash tags' release. Without one the guard
   *  has no build to count launches of, and `markBootAttempt()` throws `not-configured`. */
  version?: string;
  /** Client-supplied local overrides for `default`-state config keys. */
  localOverrides?: Record<string, JSONValue>;
  /** Where `config.set()` keeps overrides and the boot guard keeps its slots. Defaults to
   *  `localStorage`; `null` (or storage that throws) keeps them in memory, which
   *  `config.persistent()` and `bootGuardPersistent()` report. */
  storage?: ConfigStorage | null;
  /** The product catalog `config.set()` validates against, and `fetchSchema()` answers. */
  catalog?: ProductCatalog | null;
  /** Override the clock (seconds) — for tests. */
  now?: () => number;
}

/** The features this adapter serves, whatever the web table says: the ones that need no network.
 *  Every `ui.*` feature follows the table (the kit renders from the snapshot). */
const OFFLINE_FEATURES: Record<string, true> = {
  [Feature.coreLocal]: true,
  [Feature.coreCaps]: true,
  [Feature.coreErrors]: true,
  [Feature.coreHeaders]: true,
  [Feature.coreCopy]: true,
  [Feature.licenseGate]: true,
  [Feature.licenseEntitlements]: true,
  [Feature.licenseChannels]: true,
  [Feature.configResolve]: true,
  [Feature.configList]: true,
  [Feature.configLocal]: true,
  [Feature.updateBootguard]: true,
  [Feature.crashTags]: true,
  [Feature.telemetryUpdates]: true,
};

const LOCAL_ONLY_DETAIL =
  "This adapter is local-only: it makes no network calls, so this feature is not available.";

/** The refusal of a verb that would have dialled. */
function dial(what: string): PolarisError {
  return new PolarisError(
    "local-only",
    `${what} needs the network; this adapter is local-only.`,
  );
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export class LocalAdapter implements PolarisAdapter {
  readonly mode = "local" as const;
  private readonly product: string;
  private readonly version: string | undefined;
  private readonly store: Store<PolarisState>;
  readonly config: LocalConfigEngine;
  private readonly capabilities: ServicesMap;
  private readonly capabilityCtx: CapabilityContext;
  private readonly guard: BootGuard;
  private readonly slots: BootSlotStore;
  private readonly catalog: ProductCatalog | null;
  /** The update-health events recorded here. They never leave: there is no report to carry them. */
  private readonly events: UpdateEventEntry[] = [];
  private eventCount = 0;
  private readonly clock: () => number;
  private readonly presentation_: ReactPresentationSource = {
    current: () => null,
    icon: async () => null,
    iconUrl: async () => null,
    subscribe: () => () => undefined,
  };

  constructor(opts: LocalAdapterOptions) {
    this.product = opts.productSlug;
    this.version = opts.version;
    this.clock = opts.now ?? nowSec;
    this.catalog = opts.catalog ?? null;
    this.capabilities = expectedServicesOf(opts);
    this.capabilityCtx = capabilityContext("web", () => this.capabilities);
    const hostOverrides = opts.localOverrides ?? {};
    const backend = browserLocalConfigBackend(this.product, opts.storage);
    const localOverrides = { ...hostOverrides, ...backend.read() };
    const status =
      opts.status ??
      (this.capabilities.license.enabled ? "ok" : "not-applicable");
    const license = opts.license ?? null;
    const projected = projectState(
      "local",
      { license, config: opts.config ?? {} },
      { activation: license ? "bundle" : null, now: this.clock() },
      { capabilities: this.capabilities, localOverrides },
    );
    this.store = createStore<PolarisState>({
      ...projected,
      gate: { status },
      status,
    });
    this.config = new LocalConfigEngine({
      backend,
      hostOverrides,
      snapshot: () => this.store.get(),
      subscribe: (cb) => this.store.subscribe(cb),
      applyOverrides: (merged) =>
        this.store.set((s) => withOverrides(s, merged)),
      fetchSchema: () => this.fetchSchema(),
      ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
    });
    this.slots = browserBootSlotStore(this.product, opts.storage);
    this.guard = new BootGuard({
      version: this.version ?? "",
      store: this.slots,
      record: (event, input) => this.recordUpdateEvent(event, input),
    });
  }

  /** The update-health events recorded here, oldest first (`boot_rolled_back`,
   *  `update_confirmed`, …). Local only: nothing reports them. */
  journal(): readonly UpdateEventEntry[] {
    return this.events;
  }

  /** Whether the boot guard's slots survive a reload (false: memory only). */
  bootGuardPersistent(): boolean {
    return this.slots.persistent();
  }

  supports(feature: string): Support {
    const s = supportsIn(this.capabilityCtx, feature);
    if (
      !s.supported ||
      feature.startsWith("ui.") ||
      feature in OFFLINE_FEATURES
    )
      return s;
    return {
      supported: false as const,
      feature,
      reason: "runtime" as const,
      detail: LOCAL_ONLY_DETAIL,
    };
  }

  caps(): string[] {
    return capsIn(this.capabilityCtx).filter((f) => this.supports(f).supported);
  }

  snapshot(): PolarisState {
    return this.store.get();
  }

  subscribe(cb: (state: PolarisState) => void): () => void {
    return this.store.subscribe(cb);
  }

  /** There is nothing to re-pull: the documents are the build's. */
  async refresh(): Promise<void> {
    return undefined;
  }

  async signInWithOidc(): Promise<OidcSignInHandle | void> {
    throw dial("Signing in");
  }

  async submitKey(_key: string): Promise<void> {
    throw dial("Activating a key");
  }

  async activateWithKey(_key: string): Promise<KeyActivation> {
    throw dial("Activating a key");
  }

  async subject(): Promise<string | null> {
    throw dial("The account");
  }

  async attach(_opts: { confirm: boolean }): Promise<AttachResult> {
    throw dial("Adding a licence to an account");
  }

  async openAccount(): Promise<void> {
    throw dial("The account page");
  }

  onBeforeSignOut(_hook: () => Promise<void> | void): () => void {
    throw dial("Signing out");
  }

  /** The licence state is fixed, so there is nothing to wipe: said, not silently skipped. */
  async signOut(): Promise<SignOutResult> {
    throw new PolarisError(
      "local-only",
      "This adapter's licence state is fixed; there is nothing to sign out of.",
    );
  }

  currentDevice(): DeviceInfo | null {
    return currentDeviceFromState(this.store.get());
  }

  async listDevices(): Promise<DeviceInfo[]> {
    throw dial("Listing devices");
  }

  async renameDevice(_deviceId: string, _label: string | null): Promise<void> {
    throw dial("Renaming a device");
  }

  async deauthorizeDevice(_deviceId: string): Promise<void> {
    throw dial("Deauthorizing a device");
  }

  async checkUpdate(_opts?: { channel?: string }): Promise<VersionCheck> {
    throw dial("The update check");
  }

  async decideUpdate(_opts?: UpdateDecideOptions): Promise<UpdateCheck> {
    throw dial("The update decision");
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
    throw new UnsupportedError(
      {
        supported: false,
        feature: Feature.configSecret,
        reason: "runtime",
        detail: "Secrets are never held by a page or a local-only adapter.",
      },
      "unsupported",
    );
  }

  isEntitled(name: string): boolean {
    return readEntitled(this.store.get(), name);
  }

  entitledChannels(): string[] {
    return readEntitledChannels(this.store.get());
  }

  /** The catalog the host passed, else `null`: this adapter fetches nothing. */
  async fetchSchema(): Promise<ProductCatalog | null> {
    return this.catalog;
  }

  async changelog(): Promise<ChangelogEntry[]> {
    throw dial("The changelog");
  }

  async installUrl(): Promise<string> {
    throw dial("The install URL (this adapter has no control-plane origin)");
  }

  async downloadUrl(
    _version: string,
    _binary: string,
    _arch: string,
    _opts?: DownloadUrlOptions,
  ): Promise<string> {
    throw dial("The download URL (this adapter has no control-plane origin)");
  }

  async importBundle(_jws: string): Promise<ImportBundleResult> {
    throw new UnsupportedError(
      {
        supported: false,
        feature: Feature.coreBundle,
        reason: "runtime",
        detail:
          "This adapter is local-only and holds no pinned keys: pass the bundle's documents as `license` and `config`.",
      },
      "bundle-import-unsupported",
    );
  }

  async backendHeaders(): Promise<Record<string, string>> {
    throw new UnsupportedError(
      {
        supported: false,
        feature: Feature.coreBackend,
        reason: "runtime",
        detail: LOCAL_ONLY_DETAIL,
      },
      "unsupported",
    );
  }

  async report(): Promise<boolean> {
    throw new UnsupportedError(
      {
        supported: false,
        feature: Feature.devicesReport,
        reason: "runtime",
        detail: LOCAL_ONLY_DETAIL,
      },
      "report-unsupported",
    );
  }

  /** Journal an event in memory (see `journal()`); null when a value is malformed. */
  async recordUpdateEvent(
    event: UpdateEvent,
    input: UpdateEventInput,
  ): Promise<UpdateEventEntry | null> {
    this.eventCount += 1;
    const entry = buildUpdateEvent(event, input, {
      outlet: null,
      channel: channelForVersion(this.version ?? "0.0.0"),
      now: this.clock(),
      eventId: `local-${this.eventCount}-${event}`,
    });
    if (entry) this.events.push(entry);
    return entry;
  }

  async enroll(): Promise<void> {
    throw dial("Enrolling");
  }

  async beginSignIn(_opts?: { deviceName?: string }): Promise<DeviceSignIn> {
    throw dial("Signing in");
  }

  async mintToken(_recipeId: string): Promise<MintedToken> {
    throw dial("Minting a token");
  }

  async commerceBinding(): Promise<CommerceBinding> {
    throw dial("The commerce binding");
  }

  async commerceClaim(
    _store: CommerceStore,
    _payload: CommercePayload,
  ): Promise<CommerceClaimResult> {
    throw dial("A commerce claim");
  }

  async discovery(): Promise<Record<string, unknown> | null> {
    return null;
  }

  presentationSource(): ReactPresentationSource {
    return this.presentation_;
  }

  async offlineDeviceId(): Promise<string | null> {
    return null;
  }

  async storeStatus(): Promise<null> {
    return null;
  }

  /**
   * One-call boot over no transport: discovery and the sync are no-ops that answer `ok`, the
   * gate reads the fixed state, no update is decided, and the boot guard counts the launch and
   * confirms it as the stage matrix says. The same `runBoot` the other adapters run.
   */
  async boot(opts: BootRunOptions = {}): Promise<BootResult> {
    return runBoot(
      {
        discover: async () => undefined,
        hasToken: () => true,
        registrationPolicy: () => null,
        licenseEnabled: () => this.capabilities.license.enabled,
        guard: () => this.markBootAttempt(),
        confirm: () => this.confirmBoot(),
        sync: async () => "ok",
        status: () => this.store.get().status,
      },
      opts,
    );
  }

  async releaseFetch(
    _target: FetchTarget,
    _opts?: ReleaseFetchOptions & { to?: string },
  ): Promise<ReleaseFetchResult> {
    throw dial("The verified download");
  }

  async downloadModel(_opts?: { channel?: string }): Promise<DownloadModel> {
    throw dial("The download model");
  }

  async thisPlatform(_opts?: {
    channel?: string;
    platform?: string;
  }): Promise<ThisPlatform> {
    throw dial("The download model");
  }

  /** There is no native updater feed to point at: the typed runtime N/A, as a result. */
  async feedUrl(_kind: FeedKind, _opts?: FeedUrlOptions): Promise<FeedUrl> {
    return {
      supported: false,
      feature: Feature.updateFeeds,
      reason: "runtime",
      detail: LOCAL_ONLY_DETAIL,
    };
  }

  async crashTags(opts: CrashTagsOptions = {}): Promise<CrashTags> {
    const version = this.version ?? "0.0.0";
    return crashTagsFor({
      version,
      channel: channelForVersion(version),
      ...opts,
    });
  }

  /** A local-only adapter installs nothing: there is no updater to hand off to. */
  async installUpdate(
    _decision: UpdateDecision,
    _opts?: InstallOptions,
  ): Promise<InstallOutcome> {
    return unsupportedOutcome("runtime", LOCAL_ONLY_DETAIL);
  }

  async markBootAttempt(): Promise<BootAttempt> {
    this.requireVersion();
    return this.guard.markBootAttempt();
  }

  async confirmBoot(): Promise<void> {
    this.requireVersion();
    return this.guard.confirmBoot();
  }

  private requireVersion(): void {
    if (this.version === undefined)
      throw new PolarisError(
        "not-configured",
        "The boot guard counts launches of a build: pass `version` to the adapter.",
      );
  }

  dispose(): void {
    this.config.dispose();
  }
}

/** A network-free adapter: see the file header. */
export function localAdapter(opts: LocalAdapterOptions): LocalAdapter {
  return new LocalAdapter(opts);
}
