// `@plrs/node/license` — the License service's client surface.

export {
  LicenseClient,
  type ActivationResult,
  type LicenseAcquiredListener,
  type LicenseClientOptions,
} from "./client.js";

export {
  activateWithKey,
  deauthorize,
  enroll,
  fetchLicenseDocument,
  reacquireToken,
} from "./endpoints.js";
