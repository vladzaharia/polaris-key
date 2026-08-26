// @plrs/react/core — the mode-agnostic surface (no React, no DOM transport
// specifics). Useful for tests, custom adapters, or non-React consumers that still want
// the shared gate + state model.

export {
  licenseState,
  isUsable,
  type LicenseState,
  type GateInput,
} from "./gateModel.js";
export {
  PolarisError,
  initialState,
  type PolarisAdapter,
  type PolarisMode,
  type PolarisPhase,
  type PolarisErrorCode,
  type PolarisState,
  type OidcSignInHandle,
  type DeviceInfo,
  type ConfigSource,
  type UserConfigEntry,
} from "./types.js";
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
} from "./adapter.js";
export type {
  ManagedConfigDoc,
  ManagedPayload,
  ManagedEntry,
  DocProfile,
  LicenseStatus,
  BlockReason,
  AllowedRange,
  JSONValue,
} from "@plrs/protocol";
