// `@polaris-key/node/license` — the License service's client surface.

export {
  LicenseClient,
  type ActivationResult,
  type LicenseAcquiredListener,
  type LicenseClientOptions,
  type LicenseInfo,
} from "./client.js";

export {
  activateWithKey,
  activationRefusal,
  deauthorize,
  enroll,
  fetchLicenseDocument,
  reacquireToken,
} from "./endpoints.js";
