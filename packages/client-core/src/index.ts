// @polaris-key/client-core — the isomorphic client substrate shared by every JS Polaris Key SDK.
//
// WebCrypto only, zero Node APIs, no I/O: everything here is a pure function over bytes,
// claims, and clocks, so the identical implementation runs in @polaris-key/node, in @polaris-key/react's
// browser bundle, and in a Worker. Transport, storage, and keyrings belong to the hosts.
//
// Subpath exports mirror these modules one-for-one (`@polaris-key/client-core/gate`, …) for hosts
// that want a single concern without pulling the barrel.

export {
  CLOCK_SKEW_SECONDS,
  MAX_GRACE_SECONDS,
  NO_NON_WIRE_INTEGERS,
  REFRESH_MARGIN_SECONDS,
  isWireInteger,
} from "./claims.js";

export {
  compareVersions,
  parseVersion,
  type ParsedVersion,
} from "./version.js";

export {
  boundChannels,
  commitFeed,
  feedClaims,
  feedFloor,
  reloadFeeds,
  verifyFeed,
  type CommittedFeed,
  type FeedClaimsOptions,
  type FeedClaimsRefusal,
  type FeedFloor,
  type FeedRefusal,
  type ReloadedFeeds,
  type VerifyFeedOptions,
  type VerifyFeedResult,
} from "./feed.js";

export {
  recordHash,
  releaseRecordClaims,
  reloadReleaseRecords,
  verifyReleaseRecord,
  type ReleaseRecordClaimsOptions,
  type ReleaseRecordPin,
  type ReleaseRecordStep,
  type VerifyReleaseRecordOptions,
  type VerifyReleaseRecordResult,
} from "./record.js";

export {
  checkPaths,
  contentClaims,
  isPackId,
  objectRef,
  parseContentStamp,
  parseFilesIndex,
  treeDigest,
  variantKey,
  type CheckPathsResult,
  type ContentClaimsOptions,
  type FilesErrorCode,
  type FilesIndexRef,
  type ParseContentStampResult,
  type ParseFilesIndexOptions,
  type ParseFilesIndexResult,
  type ZstdDecode,
} from "./packs/index.js";

export {
  OUTLET_CAPABILITY_DEFAULTS,
  PLATFORM_NARROWING,
  SUBKIND_NARROWING,
  bootDecision,
  decideUpdate,
  effectiveCapabilities,
  feedTarget,
  isUndismissable,
  isValidHostOutlet,
  outletEntry,
  resolveUpdateOutlet,
  rolloutBucket,
  type DetectedOutlet,
  type EffectiveCapabilitiesOptions,
  type HostOutlet,
  type OutletStamp,
  type ResolvedOutlet,
} from "./decide.js";

export {
  OUTLET_PLATFORM_DATA,
  OUTLET_SIGNALS,
  UNKNOWN_DETECTION,
  WEB_DETECTION_STAMP,
  detectOutlet,
  detectionStamp,
  type DetectionStamp,
  type OutletIds,
  type OutletSignalSpec,
  type OutletSignals,
} from "./outlet.js";

export {
  runUpdateCheck,
  type FetchOutcome,
  type RunUpdateCheckOptions,
  type RunUpdateCheckResult,
  type UpdateCheckError,
} from "./check.js";

export {
  CONFIG_DOC,
  LICENSE_DOC,
  verifyConfigDoc,
  verifyDoc,
  verifyLicenseDoc,
  type DocTypeSpec,
  type VerifyOptions,
} from "./verify.js";

export {
  mergeTrust,
  verifyTrustManifest,
  type TrustManifestOptions,
  type TrustManifestResult,
} from "./trust.js";

export {
  MAX_BUNDLE_BYTES,
  inspectBundle,
  verifyBundle,
  type BundleInspection,
  type BundleOptions,
  type BundleRefusalReason,
  type VerifiedBundle,
  type VerifiedBundleDoc,
} from "./bundle.js";

export {
  isUsable,
  licenseState,
  type BlockedState,
  type GateInput,
  type LicenseState,
} from "./gate.js";

export {
  listUserEntries,
  resolveSource,
  resolveValue,
  type ConfigSource,
  type ResolveContext,
  type UserConfigEntry,
} from "./config.js";

export { canonicalArch, canonicalPlatform } from "./headers.js";

export {
  channelForVersion,
  compareSemver,
  isDevBuild,
  parseSemver,
} from "./semver.js";

export { effectiveNow, highWaterMark, type DatedArtifact } from "./clock.js";

export { PolarisError } from "./errors.js";

export {
  UNSUPPORTED_CODE,
  UnsupportedError,
  detectorKey,
  detectorProblems,
  evaluateSupport,
  supportedFeatures,
  type CapabilityContext,
  type CapabilityDetector,
  type CapabilityDetectors,
  type CapabilityNaLike,
  type CapabilityRowLike,
  type Support,
  type Supported,
  type Unsupported,
  type UnsupportedReason,
} from "./caps.js";

export {
  CACHE_VERSION,
  STORE_BACKENDS,
  STORE_DEGRADED_REASONS,
  type CacheRecordV3,
  type Store,
  type StoreBackend,
  type StoreDegradedReason,
  type StoreStatus,
} from "./store.js";

export {
  BOOT_CONFIRMATIONS,
  BOOT_DECISIONS,
  BOOT_OK_SECONDS,
  bootConfirmation,
  type BootConfirmation,
  BOOT_EMIT_TYPES,
  BOOT_EVENT_TYPES,
  BOOT_GUARD_ACTIONS,
  BOOT_OUTCOMES,
  BOOT_STAGES,
  MAX_FAILED_BOOTS,
  bootGuardAction,
  bootTransition,
  initialBootState,
  type BootBlockedReason,
  type BootDecision,
  type BootEmit,
  type BootEmitType,
  type BootEvent,
  type BootEventType,
  type BootFetchResult,
  type BootGuardAction,
  type BootGuardResult,
  type BootOptions,
  type BootOutcome,
  type BootStage,
  type BootState,
  type BootSyncResult,
  type BootTransition,
} from "./stages.js";
