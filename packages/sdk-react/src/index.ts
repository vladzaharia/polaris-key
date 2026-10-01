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
  useChangelog,
  type UseChangelog,
  type UseChangelogOptions,
} from "./release/useChangelog.js";

// ── Components ───────────────────────────────────────────────────────────────
export {
  LicenseGate,
  type LicenseGateProps,
  type LicenseGateSlots,
} from "./components/LicenseGate.js";
export {
  PolarisLogin,
  type PolarisLoginProps,
} from "./components/PolarisLogin.js";
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
  defaultTheme,
  highContrastTheme,
  mergeTheme,
  themeVars,
  type PolarisTheme,
  type PolarisThemeTokens,
  type PolarisThemeCopy,
  type PartialTheme,
} from "./components/theme.js";

// ── Primitives (build a custom screen with the same a11y contract) ───────────
export {
  MessageScreen,
  Button,
  Panel,
  TextField,
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
  type Store,
  type PolarisAdapter,
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
