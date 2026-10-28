// @polaris-key/react — one hook API over two transports (browser cookie-session OIDC and
// desktop Electron/Tauri bridge), with the production UI in `@polaris-key/react/kit`.
//
// TWO AXES OF SUBPATH ENTRIES, and they compose:
//
//   transport   ./core ./browser ./desktop      — HOW you talk to the control plane
//   service     ./license ./config ./identity ./update
//                                               — WHAT you are talking to
//
// The root owns transport configuration and headless hooks. Import screens and their scoped
// presentation contract from `@polaris-key/react/kit`.
// ── React layer ──────────────────────────────────────────────────────────────
export {
  PolarisKeyProvider,
  type PolarisKeyConfig,
  type PolarisKeyProviderProps,
} from "./react/Provider.js";
export { PolarisContext, type PolarisContextValue } from "./react/context.js";
export {
  usePolarisKey,
  useCapabilities,
  useLicense,
  useManagedConfig,
  useConfigSetting,
  useEntitlement,
  usePolarisAuth,
  useLicenseGate,
  useImportBundle,
  screenFor,
  type UsePolarisKey,
  type UseLicense,
  type UseImportBundle,
  type UseManagedConfig,
  type UseConfigSetting,
  type UsePolarisAuth,
  type UseLicenseGate,
  type GateScreen,
} from "./react/hooks.js";
// sync.keyring (U-38.2): the key ring's lock state and the recovery-code actions.
export { useSyncLock, useRecoveryCode } from "./react/useKeyring.js";
// connect.app (CC-09.2): Cloud Connect over the relay, the only path a page has.
export {
  useCloudConnect,
  type UseCloudConnect,
} from "./react/useCloudConnect.js";
export type {
  CloudConnectClient,
  CloudConnectOptions,
  CloudConnectStatus,
  CloudPeer,
  ConnectNotice,
  ConnectSession,
} from "./browser/connect/index.js";
export { RelayError, LanError } from "./browser/connect/index.js";
export type {
  SyncLockState,
  UseSyncLock,
  UseRecoveryCode,
} from "./react/useKeyring.js";
export type {
  RingCode,
  RingState,
  RingStatus,
  KeyringClient,
} from "./core/keyring.js";
// identity.choice (I-10a.11): `useLicenseChoice(grant)` over `usePolarisAuth().choice`.
export {
  useLicenseChoice,
  DEFAULT_GRANT_SECONDS,
  type LicenseChoiceStatus,
  type UseLicenseChoice,
  type UseLicenseChoiceOptions,
} from "./react/useLicenseChoice.js";
// `client.backend` (SP-58): a fetch that carries the licence document to the app's own backend.
export { usePolarisFetch } from "./react/usePolarisFetch.js";
export {
  createPolarisFetch,
  normalizeBackendOrigin,
  type BackendHeaders,
  type BackendOptions,
  type PolarisFetch,
} from "./core/backend.js";
// Discovery's `core.presentation` (HA-13): the hook, and the seam the kits read.
export {
  usePresentation,
  type UsePresentation,
  type UsePresentationOptions,
} from "./react/usePresentation.js";
export type {
  PresentationSource,
  ProductPresentation,
  ReactPresentationSource,
} from "./core/presentation.js";
export {
  useLatestVersion,
  type UseLatestVersion,
  type UseLatestVersionOptions,
} from "./update/useLatestVersion.js";
export {
  useUpdateDecision,
  type UseUpdateDecision,
  type UseUpdateDecisionOptions,
} from "./update/useUpdateDecision.js";
// `update.packs` (createBrowserPacks, the pack handlers, opfsPackStore) lives on
// `@polaris-key/react/packs`: it is not part of the root, so a Provider-only app bundles none of it.
export {
  useChangelog,
  type UseChangelog,
  type UseChangelogOptions,
} from "./release/useChangelog.js";
// ui.boot (SP-12): the one-call boot as a hook.
export { useBoot, type UseBoot, type UseBootOptions } from "./react/useBoot.js";

// ── Transport helpers ───────────────────────────────────────────────────────
// The refusal link helpers are transport semantics, useful to a fully custom host UI.
export {
  isManageUrl,
  readManageUrl,
  withManageKey,
  withManageReturn,
} from "@polaris-key/client-core";

// ── Adapters (so callers can build/inject them directly) ─────────────────────
export {
  browserAdapter,
  BrowserAdapter,
  InsecureBaseUrlError,
  splitSessionDoc,
  type BrowserAdapterOptions,
} from "./browser/browserAdapter.js";
export { fetchCatalog } from "./browser/catalog.js";
// release.fetch and release.distribution for the browser transport (SP-12).
export {
  fetchReleaseBuild,
  fetchVerifiedRecord,
  type FetchTarget,
  type PartStore,
  type ReleaseFetchOptions,
  type ReleaseFetchResult,
} from "./browser/releaseFetch.js";
export {
  browserPlatform,
  fetchDownloadModel,
  pickPlatform,
  type DownloadAction,
  type DownloadBuild,
  type DownloadModel,
  type DownloadPlatformGroup,
  type ThisPlatform,
} from "./browser/distribution.js";
// Outlet detection (plans/P3-01.md §2.9): the mapping is client-core's, re-exported so a React
// host reaches it through this package; the reader is the page's own.
export {
  detectOutlet,
  detectionStamp,
  type DetectedOutlet,
  type DetectionStamp,
  type OutletSignals,
} from "@polaris-key/client-core";
export {
  readOutletSignals,
  type WebOutletEnvironment,
} from "./browser/outlet.js";
export {
  buildDownloadUrl,
  buildInstallUrl,
  fetchChangelog,
} from "./browser/release.js";
export {
  indexedDbOfflineStore,
  type OfflineRecord,
  type OfflineStore,
} from "./browser/offline.js";
export {
  discoverProduct,
  parseDiscovery,
  parseServices,
  type DiscoveryDocument,
  type DiscoveryResult,
  type ServiceFragment,
} from "./browser/discovery.js";
export {
  desktopAdapter,
  DesktopAdapter,
  type DesktopAdapterOptions,
} from "./desktop/desktopAdapter.js";
// core.local (SP-15): the network-free adapter.
export {
  localAdapter,
  LocalAdapter,
  type LocalAdapterOptions,
} from "./local/localAdapter.js";
export {
  BRIDGE_VERSION,
  resolveBridge,
  type PolarisBridge,
  type PolarisBridgeWindow,
  type BridgeState,
  type BridgeOidcBegin,
  type BridgeOidcPoll,
  type BridgeActivation,
  type BridgeImportBundle,
} from "./desktop/bridge.js";

// ── Core (mode-agnostic types + helpers) ─────────────────────────────────────
// identity.signIn (I-10a.10): `usePolarisAuth().signIn.start(opts)` and `.complete(callbackUrl)`.
export type {
  ChoiceCancelResult,
  ChoiceCompleteResult,
  ChoiceNamespace,
  ChoiceRefusal,
  ChoiceViewResult,
  LicenseChoice,
  LicenseChoiceView,
  ReplaceView,
} from "./core/index.js";
export type {
  DeviceCodeSignInOptions,
  DeviceCodeSignInSession,
  RedirectSignInOptions,
  RedirectSignInSession,
  SignInHints,
  SignInNamespace,
  SignInOptions,
  SignInOutcome,
  SignInSession,
} from "./core/signIn.js";
export {
  licenseState,
  isUsable,
  effectiveNow,
  highWaterMark,
  createStore,
  projectState,
  flattenEntries,
  readConfig,
  readEntitled,
  readEntitledChannels,
  resolveConfig,
  resolveConfigValue,
  configSource,
  currentDeviceFromState,
  listUserConfig,
  PolarisError,
  UnsupportedError,
  initialState,
  isSecureTransportUrl,
  SERVICE_SLUGS,
  anyBusy,
  copyServices,
  defaultServices,
  // The core copy helpers (the catalog's sentences for a failure, a status, an activation
  // outcome), for an app that renders its own screens.
  activationMessage,
  activationTitle,
  copyLocales,
  copyMessage,
  copyTitle,
  describeError,
  hasCopy,
  registerCopyLocale,
  type CopyBundle,
  type CopyParams,
  firstError,
  noBusy,
  noErrors,
  noServices,
  servicesEqual,
  servicesFromList,
  withBusy,
  withError,
  type LicenseState,
  type GateInput,
  type BlockedState,
  type ConfigSource,
  type ConfigChange,
  type ConfigSetting,
  type ConfigStorage,
  type LocalConfig,
  type Store,
  type PolarisAdapter,
  type Support,
  type Supported,
  type Unsupported,
  type PolarisDocs,
  type PolarisMode,
  type PolarisPhase,
  type PolarisErrorCode,
  type PolarisState,
  type OidcSignInHandle,
  type DeviceInfo,
  type UserConfigEntry,
  type VersionCheck,
  type ChangelogEntry,
  type DownloadUrlOptions,
  type ImportBundleResult,
  type ProductCatalog,
  type ServicesMap,
  type ServiceBusyMap,
  type ServiceErrorMap,
  // ui.boot / ui.stages (SP-12)
  runBoot,
  reacquire,
  bootDecisionOf,
  BOOT_CONFIRMATIONS,
  BOOT_OK_SECONDS,
  BOOT_OUTCOMES,
  BOOT_STAGES,
  bootConfirmation,
  bootTransition,
  initialBootState,
  type BootDriver,
  type BootPacks,
  type BootResult,
  type BootRunOptions,
  type BootStep,
  type ReacquireResult,
  type BootDecision,
  type BootEmit,
  type BootEvent,
  type BootOptions,
  type BootState,
  type BootStage,
  // crash.tags and update.feeds (SP-12)
  crashTagsFor,
  type CrashTags,
  type CrashTagsOptions,
  type FeedKind,
  type FeedUrl,
  type FeedUrlOptions,
  // telemetry.updates (SP-14): adapter.recordUpdateEvent
  type UpdateEventEntry,
  type UpdateEventInput,
  // update.driver and update.bootguard (SP-15)
  MAX_FAILED_BOOTS,
  type BootAttempt,
  type BootSlots,
  type InstallOptions,
  type InstallOutcome,
} from "./core/index.js";

// ── Generated constants (`pnpm gen constants`, tools/gen-sdk-constants.ts) ──
// Error codes, header names, enums, feature ids, versions and the channel vocabulary, spelled
// identically (up to casing) in every SDK. Re-exported wholesale so a constant the generator gains
// (a new enum, P0-04's channel constants) reaches the package root without editing this file;
// test/errorCodes.test.ts checks every generated export is reachable from here. `ServiceSlug` is
// exported as a value and a type; it is the same union the discovery module uses.
export * from "./constants.generated.js";

// ── Wire types (re-exported for convenience; the protocol package is the source) ──
export type {
  JSONValue,
  ManagedEntry,
  ManagementState,
} from "@polaris-key/protocol/core";
export type {
  ActivationSource,
  AllowedRange,
  BlockReason,
  DocProfile,
  LicenseDoc,
  LicenseStatus,
} from "@polaris-key/protocol/license";
export type { ConfigDoc } from "@polaris-key/protocol/config";
