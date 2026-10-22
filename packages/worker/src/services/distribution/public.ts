/**
 * Distribution's public surface for the console (P0-17): the one module under
 * `services/distribution/` that `console/` may import (`test/boundaries.test.ts`). It re-exports exactly
 * what the console uses; anything new the console needs from this service is added here.
 */

export {
  checkSteamPublisherKey,
  listPlatformSteamApps,
} from "../../core/stores/steam/publisher.js";
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
} from "../../core/stores/credentialCheck.js";
export {
  checkMsPartnerCenter,
  listPlatformMsStoreApps,
} from "./connectors/msstore/platform.js";
export {
  type PlatformAppsListing,
  PlatformStoreNotConfigured,
  PlatformStoreUnavailable,
} from "../../core/stores/platformApps.js";
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
export {
  writeFeedSettings,
  writePlatformPolicy,
} from "./registry/feedWrites.js";
export { forgetRegistrySettings } from "./registry/settings.js";
export {
  packageFeedsOf,
  stmtEnsureFeed,
  stmtSetPackageFeeds,
} from "./registryFeeds.js";
export {
  outletIdentityMismatches,
  type OutletIdentityMismatch,
} from "./outletIdentity.js";
export {
  expiringCredentials,
  type ExpiringCredential,
  type MissingStoreAccount,
  storesMissingAccount,
} from "./attentionFacts.js";
export {
  liveBuilds,
  productPlatforms,
  type LiveBuild,
  type ProductPlatform,
  type ProductPlatforms,
} from "./facts.js";
export {
  channelFacts,
  type DeliveryAttention,
  type DeliveryFacet,
  type DeliveryState,
} from "./channels.js";
