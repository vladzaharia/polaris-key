// @polaris-key/react/license — the license hook and types. Render the shared gate, activation
// and device parts from `@polaris-key/react/kit`.
//
// A product that does not enable the license service still imports this safely — `useLicense`
// reports `enabled: false`, and the kit gate renders its children straight through.
export {
  useLicense,
  useLicenseGate,
  useImportBundle,
  screenFor,
} from "../react/hooks.js";
export type {
  UseLicense,
  UseLicenseGate,
  UseImportBundle,
  GateScreen,
} from "../react/hooks.js";
export type { ImportBundleResult } from "../core/index.js";
export { useEntitlement } from "../react/hooks.js";
export type { DeviceInfo, LicenseState } from "../core/index.js";
export { isUsable, licenseState } from "@polaris-key/client-core";
export type {
  LicenseStatus,
  ActivationSource,
} from "@polaris-key/protocol/license";
