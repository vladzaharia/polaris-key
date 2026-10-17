/**
 * Release's facade for the composition modules (P0-19): the one module under `services/release/`
 * that `dispatch.ts`, `githubWebhook.ts`, `platformDeploy.ts`, `assetQueue.ts` and `deltasEntry.ts`
 * may import besides `index.ts` (`test/boundaries.test.ts`). It re-exports exactly what they use;
 * anything new a surface needs from this service is added here. The console has its own,
 * `public.ts`, and `scheduled.ts` imports neither: it iterates descriptors
 * (`contributes.maintenance`).
 */

export { resolveRepoAssetSource } from "./assetSource.js";
export { MANIFEST_FILE_NAMES } from "./manifestFiles.js";
export {
  processReleaseMirror,
  readReleaseMirrorMessage,
  type ReleaseMirrorMessage,
} from "./mirror.js";
export { reconcilePackageFileRefs } from "./packages/refReconcile.js";
export {
  handleDeltaBatch,
  type DeltaConsumerDeps,
  type DeltaOutcome,
} from "./packs/deltas/consumer.js";
export {
  type FetchImpl,
  getReleaseConfig,
  isManifestPath,
  resyncNotes,
  resyncRepo,
  syncReleaseStoreReport,
} from "./sync.js";
