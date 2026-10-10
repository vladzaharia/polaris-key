/**
 * Distribution's public surface for the console (P0-17): the one module under
 * `services/distribution/` that `console/` may import (`test/boundaries.test.ts`). It re-exports exactly
 * what the console uses; anything new the console needs from this service is added here.
 */

export {
  checkSteamPublisherKey,
  listPlatformSteamApps,
} from "./commerce/steam.js";
export {
  checkAscApiKey,
  listPlatformAscApps,
  platformAscClient,
} from "./connectors/asc/platform.js";
export {
  checked,
  type CredentialCheck,
  credentialCheckAllowed,
  formatFailure,
} from "./connectors/credentialCheck.js";
export {
  checkMsPartnerCenter,
  listPlatformMsStoreApps,
} from "./connectors/msstore/platform.js";
export {
  type PlatformAppsListing,
  PlatformStoreNotConfigured,
  PlatformStoreUnavailable,
} from "./connectors/platformApps.js";
export {
  checkPlayServiceAccount,
  listPlatformPlayApps,
} from "./connectors/play/platform.js";
export { listingSlotMirror } from "./listing/hostedMirror.js";
export { readListing } from "./listing/store.js";
export {
  feedCapabilityView,
  type FeedCapabilityView,
  requireFeedAdapter,
} from "./registry/index.js";
export { forgetRegistrySettings } from "./registry/settings.js";
export {
  packageFeedsOf,
  stmtEnsureFeed,
  stmtSetPackageFeeds,
} from "./registryFeeds.js";
