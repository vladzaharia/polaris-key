// @polaris-key/react — one hook API over two transports (browser cookie-session OIDC and
// desktop Electron/Tauri bridge) plus a brandable drop-in <LicenseGate>/<PolarisLogin>.
// Subpath entries (./core, ./browser, ./desktop) exist for tree-shaking + targeted imports;
// this barrel re-exports the full surface for the common case.

// ── React layer ──────────────────────────────────────────────────────────────
export { PolarisKeyProvider, type PolarisKeyProviderProps } from "./react/Provider.js";
export { PolarisContext, type PolarisContextValue } from "./react/context.js";
export {
  usePolarisKey,
  useLicense,
  useManagedConfig,
  useEntitlement,
  usePolarisAuth,
  useLicenseGate,
  usePolarisTheme,
  type UsePolarisKey,
  type UsePolarisAuth,
  type UseLicenseGate,
  type GateScreen,
} from "./react/hooks.js";

// ── Components ───────────────────────────────────────────────────────────────
export { LicenseGate, type LicenseGateProps, type LicenseGateSlots } from "./components/LicenseGate.js";
export { PolarisLogin, type PolarisLoginProps } from "./components/PolarisLogin.js";
export {
  defaultTheme,
  mergeTheme,
  themeVars,
  type PolarisTheme,
  type PolarisThemeTokens,
  type PolarisThemeCopy,
  type PartialTheme,
} from "./components/theme.js";

// ── Adapters (so callers can build/inject them directly) ─────────────────────
export { browserAdapter, BrowserAdapter, type BrowserAdapterOptions } from "./browser/browserAdapter.js";
export { desktopAdapter, DesktopAdapter, type DesktopAdapterOptions } from "./desktop/desktopAdapter.js";
export {
  resolveBridge,
  type PolarisBridge,
  type PolarisBridgeWindow,
  type BridgeState,
  type BridgeOidcBegin,
  type BridgeOidcPoll,
  type BridgeEnroll,
} from "./desktop/bridge.js";

// ── Core (mode-agnostic types + helpers) ─────────────────────────────────────
export {
  licenseState,
  isUsable,
  createStore,
  projectState,
  flattenEntries,
  readConfig,
  readEntitled,
  resolveConfig,
  resolveConfigValue,
  configSource,
  listUserConfig,
  PolarisError,
  initialState,
  type LicenseState,
  type GateInput,
  type Store,
  type PolarisAdapter,
  type PolarisMode,
  type PolarisPhase,
  type PolarisErrorCode,
  type PolarisState,
  type OidcSignInHandle,
  type ConfigSource,
  type UserConfigEntry,
} from "./core/index.js";

export type {
  ManagedConfigDoc,
  ManagedPayload,
  ManagedEntry,
  DocProfile,
  LicenseStatus,
  BlockReason,
  AllowedRange,
  JSONValue,
} from "@polaris-key/protocol";
