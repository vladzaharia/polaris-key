// @polaris-key/client-core/packs — packs on the wire (plans/P4-01.md §2.3–§2.8), the functions
// P4-21 lands: the pack-id and object-ref rules, the `content` claims, the files index, its path
// rules and `treeDigest`, the variant key and the content stamp; P4-04's `packSetId`,
// `windowLogMax` and `frameWindow` (§2.7 rule 3, §2.9); and P4-06's `selectVariant`,
// `planTarget`, `plan`, the appliers, `parsePatch`, `verifyMarker`, the install-state machine and
// the pipeline (`PackEngine`), every one over injected ports; and P4-10's `parseChunkIndex`
// (`pkey-chunks/1`). Nothing here does I/O.
// `releaseRecordClaims` (`../record.ts`) applies the pack and app claims at step 14.

export {
  contentClaims,
  holdsOf,
  isPackId,
  objectRef,
  type ContentClaimsOptions,
} from "./claims.js";
export {
  checkPaths,
  parseFilesIndex,
  strictParse,
  treeDigest,
  type CheckPathsResult,
  type FilesErrorCode,
  type FilesIndexRef,
  type ParseFilesIndexOptions,
  type ParseFilesIndexResult,
  type ZstdDecode,
} from "./files.js";
export {
  parseChunkIndex,
  parseChunkIndexBytes,
  readU64,
  type ChunkIndexErrorCode,
  type ChunkIndexRef,
  type ParseChunkIndexOptions,
  type ParseChunkIndexResult,
} from "./chunks.js";
export {
  applyChunk,
  chunkRangeFetch,
  chunkRuns,
  seedMap,
  type ApplyChunkOptions,
  type ApplyChunkPorts,
  type ChunkApplyErrorCode,
  type ChunkApplyFailure,
  type ChunkOutput,
  type ChunkRangeFetch,
  type ChunkRangeResponse,
  type ChunkRun,
  type ChunkSeed,
  type ChunkVerdict,
  type ChunkVerdictOk,
} from "./chunkApply.js";
export { packSetId, type PackSetEntry } from "./set.js";
export {
  CONTENT_ID_PATTERN,
  MAX_PROVIDES,
  providesFacts,
  providesOf,
  verifiedPayloadOf,
  type PackProvider,
  type ProvidesFacts,
} from "./provides.js";
export {
  dataOnlyExtension,
  dataOnlyFileRefusal,
  dataOnlyPathRefusal,
  dataOnlyRefusal,
  dataOnlyTextRefusal,
  dataOnlyTreeSink,
  DATA_ONLY_SCRIPT_MARKERS,
  DATA_ONLY_TEXT_EXTENSIONS,
  type DataOnlyRefusalSeen,
  type DataOnlyRule,
} from "./dataonly.js";
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
  type ChunkIndexStore,
  type EmbeddedBaseline,
  type InstalledPayload,
  type ObjectFetch,
  type ObjectResponse,
  type PackEngineOptions,
  type PackCheckRefusal,
  type PackHandler,
  type PackEstimate,
  type PackPayloadAccess,
  type PackProgress,
  type PacksSnapshot,
  type PackStorage,
  type RecordFetch,
  type RevocationsSnapshot,
  type StagedObject,
  type StagedPack,
} from "./engine.js";
export {
  DEFAULT_MAX_TYPE_FILE_BYTES,
  DataJsonHandler,
  L10nTableHandler,
  MAX_DESCRIPTOR_BYTES,
  MlModelHandler,
  TYPE_TOKEN_PATTERN,
  readL10nTables,
  readModelDescriptor,
  type DataJsonHandlerOptions,
  type L10nTableHandlerOptions,
  type MlModel,
  type MlModelHandlerOptions,
  type ModelDescriptor,
} from "./handlers/types.js";
export {
  bcp47Canonical,
  parseL10nFile,
  sameLocale,
  type L10nMessage,
  type L10nParse,
  type L10nTable,
} from "./handlers/l10n.js";
export {
  MAX_STORED_REVOCATIONS,
  REVOCATIONS_VERSION,
  capRevocations,
  clearRelearn,
  emptyRevocations,
  parseRevocations,
  reloadRevocations,
  serializeRevocations,
  stampHolds,
  storeRevocation,
  type RevocationsDoc,
  type StoredRevocation,
} from "./revocations.js";
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
  type PlanChunkIndex,
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
