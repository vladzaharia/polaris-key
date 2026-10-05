// `@polaris-key/node/update/drivers`: every install driver (§3.16). Each is also importable on
// its own (`@polaris-key/node/update/drivers/velopack`, …); none imports its updater.

export {
  unsupported,
  type InstallContext,
  type InstallDriver,
  type InstallOptions,
  type InstallOutcome,
  type InstallableDecision,
} from "./types.js";
export {
  electronUpdaterDriver,
  type AutoUpdaterLike,
  type ElectronUpdaterDriverOptions,
} from "./electronUpdater.js";
export {
  velopackDriver,
  type VelopackDriverOptions,
  type VelopackManagerLike,
  type VelopackUpdateInfo,
} from "./velopack.js";
export {
  seaSelfReplaceDriver,
  type SeaSelfReplaceDriverOptions,
} from "./sea.js";
export { storeLinkDriver, type StoreLinkDriverOptions } from "./storeLink.js";
