// @polaris-key/client-core/packs — packs on the wire (plans/P4-01.md §2.3–§2.8), the functions
// P4-21 lands: the pack-id and object-ref rules, the `content` claims, the files index, its path
// rules and `treeDigest`, the variant key and the content stamp; P4-04's `packSetId`,
// `windowLogMax` and `frameWindow` (§2.7 rule 3, §2.9); and P4-06's `selectVariant`,
// `planTarget`, `plan`, the appliers, `parsePatch`, `verifyMarker`, the install-state machine and
// the pipeline (`PackEngine`), every one over injected ports. Nothing here does I/O.
// `releaseRecordClaims` (`../record.ts`) applies the pack and app claims at step 14.

export {
  contentClaims,
  isPackId,
  objectRef,
  type ContentClaimsOptions,
} from "./claims.js";
export {
  checkPaths,
  parseFilesIndex,
  treeDigest,
  type CheckPathsResult,
  type FilesErrorCode,
  type FilesIndexRef,
  type ParseFilesIndexOptions,
  type ParseFilesIndexResult,
  type ZstdDecode,
} from "./files.js";
export { packSetId, type PackSetEntry } from "./set.js";
export { parseContentStamp, type ParseContentStampResult } from "./stamp.js";
export { variantKey } from "./variant.js";
export { frameWindow, windowAllowed, windowLogMax } from "./window.js";
export {
  applyDelta,
  applyFile,
  applyFull,
  type ApplyCounters,
  type ApplyDeltaOptions,
  type ApplyErrorCode,
  type ApplyFailure,
  type ApplyPorts,
  type ApplyResult,
  type ApplyVerdict,
  type ContainerVerdict,
  type TreeVerdict,
} from "./apply.js";
export {
  FILES_TREE_HANDLER,
  PackEngine,
  PackError,
  type EmbeddedBaseline,
  type InstalledPayload,
  type ObjectFetch,
  type ObjectResponse,
  type PackEngineOptions,
  type PackHandler,
  type PackEstimate,
  type PackProgress,
  type PacksSnapshot,
  type PackStorage,
  type RecordFetch,
  type StagedObject,
} from "./engine.js";
export {
  matchEmbedded,
  verifyMarker,
  type EmbeddedPayload,
  type MarkerStep,
  type VerifyMarkerOptions,
  type VerifyMarkerResult,
} from "./marker.js";
export { openObject, parsePatch } from "./patch.js";
export {
  PLAN_STRATEGIES,
  plan,
  type PlanCandidate,
  type PlanCaps,
  type PlanError,
  type PlanInput,
  type PlanInstalled,
  type PlanResult,
  type PlanStrategy,
} from "./plan.js";
export {
  READ_CHUNK,
  hashSource,
  memorySource,
  readAll,
  sha256Of,
  sliceSource,
  webCryptoSha256,
  type ByteSink,
  type ByteSource,
  type InstalledFile,
  type ObjectPort,
  type Sha256Hasher,
  type Sha256Port,
  type TreeSink,
  type ZstdPort,
} from "./ports.js";
export {
  indexReadable,
  indexRebuildable,
  planTarget,
  selectVariant,
  usableCodec,
  variantUsable,
  type PlanDelta,
  type PlanTarget,
  type VariantPrefs,
} from "./select.js";
export {
  PACK_STATE_VERSION,
  abandonInstall,
  beginInstall,
  checkpoint,
  commitInstall,
  confirmBoot,
  emptyPackState,
  gcRoots,
  parsePackState,
  reloadPackState,
  rollbackInstall,
  serializePackState,
  type JournalObject,
  type PackGcRoots,
  type PackInstall,
  type PackJournal,
  type PackStateDoc,
  type PackStateStore,
  type PackStateVerifier,
} from "./state.js";
export {
  memoryPackStateStore,
  memoryPackStorage,
  type MemoryPackStorage,
  type MemoryPayload,
} from "./memory.js";
export {
  bootPackOptions,
  runBootFetch,
  type RunBootFetchOptions,
} from "./boot.js";
