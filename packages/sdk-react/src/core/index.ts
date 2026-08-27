// @plrs/react/core — the mode-agnostic surface (no React, no DOM transport specifics).
// Useful for tests, custom adapters, or non-React consumers that still want the shared
// state model.
//
// The gate is re-exported from `@plrs/client-core` rather than reimplemented: this package
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
} from "@plrs/client-core";

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
} from "./types.js";

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
  projectState,
  flattenEntries,
  readConfig,
  readEntitled,
  resolveConfig,
  resolveConfigValue,
  configSource,
  currentDeviceFromState,
  listUserConfig,
  type ProjectFlags,
} from "./adapter.js";

export type { ManagedEntry, JSONValue } from "@plrs/protocol/core";
export type {
  ActivationSource,
  AllowedRange,
  BlockReason,
  DocProfile,
  LicenseDoc,
  LicenseStatus,
} from "@plrs/protocol/license";
export type { ConfigDoc } from "@plrs/protocol/config";
