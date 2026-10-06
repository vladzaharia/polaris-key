// @polaris-key/react — one hook API over two transports (browser cookie-session OIDC and
// desktop Electron/Tauri bridge) plus brandable drop-in UIs.
//
// TWO AXES OF SUBPATH ENTRIES, and they compose:
//
//   transport   ./core ./browser ./desktop      — HOW you talk to the control plane
//   service     ./license ./config ./identity ./update
//                                               — WHAT you are talking to
//
// This barrel re-exports the full surface for the common case; the service hooks and
// components are re-exported here while callers migrate to their subpaths.

// ── React layer ──────────────────────────────────────────────────────────────
export {
  PolarisKeyProvider,
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
  usePolarisTheme,
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
// `update.packs` for the web transport (P4-06).
export {
  DataJsonHandler,
  L10nTableHandler,
  MlModelHandler,
  type L10nTable,
  type MlModel,
  type PackCheckRefusal,
  type StagedPack,
  PackError,
  WASM_MEM_BUDGET,
  createBrowserPacks,
  defaultWebMemBudget,
  opfsPackStore,
  type BrowserPacks,
  type BrowserPacksOptions,
} from "./packs/index.js";
export {
  useChangelog,
  type UseChangelog,
  type UseChangelogOptions,
} from "./release/useChangelog.js";
// ui.boot (SP-12): the one-call boot as a hook.
export { useBoot, type UseBoot, type UseBootOptions } from "./react/useBoot.js";

// ── Components ───────────────────────────────────────────────────────────────
export {
  LicenseGate,
  type LicenseGateProps,
  type LicenseGateSlots,
} from "./components/LicenseGate.js";
export {
  PolarisLogin,
  openManageUrl,
  type PolarisLoginProps,
} from "./components/PolarisLogin.js";
// The refusal link (PX-W8): validate `manageUrl`, add the app's return URL or the key fragment.
export {
  isManageUrl,
  readManageUrl,
  withManageKey,
  withManageReturn,
} from "@polaris-key/client-core";
export {
  PolarisLogout,
  type PolarisLogoutProps,
} from "./components/PolarisLogout.js";
export {
  ConfigPanel,
  type ConfigPanelProps,
  type ConfigPanelSlots,
  type ConfigRow,
} from "./components/ConfigPanel.js";
export {
  UpdatePrompt,
  type UpdatePromptProps,
  type UpdatePromptSlots,
} from "./components/UpdatePrompt.js";
export {
  DeviceManager,
  type DeviceManagerProps,
  type DeviceManagerSlots,
} from "./components/DeviceManager.js";
export {
  baseTokens,
  defaultTheme,
  highContrastTheme,
  lightTheme,
  mergeTheme,
  neutralDarkTokens,
  neutralLightTokens,
  polarisKeyDarkTokens,
  polarisKeyLightTokens,
  polarisKeyTheme,
  themeVars,
  type PolarisBranding,
  type PolarisColorScheme,
  type PolarisResolvedScheme,
  type PolarisTheme,
  type PolarisThemeTokens,
  type PolarisThemeCopy,
  type PartialTheme,
  type PoweredByLayout,
} from "./components/theme.js";
// The "Powered by Polaris Key" badge for an integrator's about/credits/account screen
// (docs/design/BRAND.md §7.2).
export {
  PoweredByPolarisKey,
  type PoweredByPolarisKeyProps,
} from "./components/brand.js";

// ── Primitives (build a custom screen with the same a11y contract) ───────────
export {
  MessageScreen,
  Button,
  Panel,
  TextField,
  useFocusRing,
  type MessageScreenProps,
  type ButtonProps,
  type ButtonVariant,
  type PanelProps,
  type TextFieldProps,
} from "./components/primitives/index.js";

// ── Adapters (so callers can build/inject them directly) ─────────────────────
export {
  browserAdapter,
  BrowserAdapter,
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
  SERVICE_SLUGS,
  anyBusy,
  copyServices,
  defaultServices,
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
} from "./core/index.js";

// ── Generated constants (`pnpm gen:constants`, tools/gen-sdk-constants.ts) ──
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
