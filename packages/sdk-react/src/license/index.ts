// @polaris-key/react/license — the License service's UI surface: the gate, the device roster, and
// the hook they read from. Layered OVER the transport subpaths (`./browser`, `./desktop`):
// a service entry says WHAT you are talking to, a transport entry says HOW.
//
// A product that does not enable the license service still imports this safely — `useLicense`
// reports `enabled: false`, the gate's status is `not-applicable`, and `<LicenseGate>` renders
// its children straight through (D-08).

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
export {
  LicenseGate,
  type LicenseGateProps,
  type LicenseGateSlots,
} from "../components/LicenseGate.js";
export {
  DeviceManager,
  type DeviceManagerProps,
  type DeviceManagerSlots,
} from "../components/DeviceManager.js";
export type { DeviceInfo, LicenseState } from "../core/index.js";
export { isUsable, licenseState } from "@polaris-key/client-core";
export type {
  LicenseStatus,
  ActivationSource,
} from "@polaris-key/protocol/license";
