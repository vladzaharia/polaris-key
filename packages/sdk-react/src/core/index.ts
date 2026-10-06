// @polaris-key/react/core — the mode-agnostic surface (no React, no DOM transport specifics).
// Useful for tests, custom adapters, or non-React consumers that still want the shared
// state model.
//
// The gate is re-exported from `@polaris-key/client-core` rather than reimplemented: this package
// used to carry a hand-kept port of it, which is exactly how the monotonic clock floor went
// missing here while every other SDK enforced it. One implementation, one corpus.

export {
  licenseState,
  isUsable,
  effectiveNow,
  highWaterMark,
  type LicenseState,
  type GateInput,
  type BlockedState,
  type ConfigSource,
} from "@polaris-key/client-core";

export {
  PolarisError,
  initialState,
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
  type UpdateDecideOptions,
} from "./types.js";
export type {
  StagedUpdate,
  UpdateCheck,
  UpdateDecision,
} from "@polaris-key/protocol/update";
export type { ProductCatalog } from "@polaris-key/catalog";

export {
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
  type ServiceSlug,
  type ServicesMap,
  type ServiceBusyMap,
  type ServiceErrorMap,
} from "./services.js";

export { createStore, type Store } from "./store.js";
export {
  UnsupportedError,
  capabilityContext,
  capsIn,
  refuse,
  requireSupported,
  supportsIn,
  type ReactRuntime,
  type Support,
  type Supported,
  type Unsupported,
} from "./caps.js";
export {
  projectState,
  flattenEntries,
  readConfig,
  readEntitled,
  readEntitlementValue,
  readEntitledChannels,
  resolveConfig,
  resolveConfigValue,
  configSource,
  currentDeviceFromState,
  listUserConfig,
  type ProjectFlags,
} from "./adapter.js";

export {
  bodyCode,
  classifyActivation,
  networkOutcome,
  retryAfterSeconds,
  type ActivationKind,
  type ActivationOutcome,
} from "./activation.js";
export { activationError } from "./activationError.js";
export {
  copyLocales,
  copyMessage,
  copyTitle,
  describeError,
  hasCopy,
  registerCopyLocale,
  type CopyBundle,
} from "./copy.js";

export type { ManagedEntry, JSONValue } from "@polaris-key/protocol/core";
export type {
  ActivationSource,
  AllowedRange,
  BlockReason,
  DocProfile,
  LicenseDoc,
  LicenseStatus,
} from "@polaris-key/protocol/license";
export type { ConfigDoc } from "@polaris-key/protocol/config";
