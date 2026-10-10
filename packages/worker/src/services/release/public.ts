/**
 * Release's public surface for the console (P0-17): the one module under
 * `services/release/` that `console/` may import (`test/boundaries.test.ts`). It re-exports exactly
 * what the console uses; anything new the console needs from this service is added here.
 */

export { hasArtifactMap } from "./artifactMap.js";
export { shipsDmgs } from "./config.js";
export { manifestDeliverableStatements } from "./deliverables.js";
export { readAppDeliverable } from "./descriptor.js";
export {
  type FetchImpl,
  getAppInfo,
  type GithubAppInfo,
  type GithubInstallation,
  type GithubRepository,
  listInstallationRepositories,
  listInstallations,
  probeManifests,
} from "./githubApp.js";
export { isSafeBinaryName } from "./install.js";
export {
  checkSlug,
  parseRepoUrl,
  prepareCreate,
  productsByRepository,
} from "./linkRepo.js";
export { readManifestFilesAt } from "./manifestFetch.js";
export { mirrorNow } from "./mirror.js";
export { packageCatalog } from "./packages/catalog.js";
export {
  prunePackages,
  pruneRetentionOf,
  setPruneRetention,
} from "./packages/prune.js";
export {
  type PolicyRefusal,
  setPackageDeprecation,
  unyank,
  yank,
} from "./policy.js";
export {
  readLinkedManifest,
  screenCatalog,
  withStoredSecrets,
} from "./resync.js";
export { latestReleaseHasDmg } from "./store.js";
export { linkRepo, MAX_MANIFEST_BYTES } from "./sync.js";
