// `@polaris-key/node` — the Polaris Key Node SDK.
//
// The barrel is the convenience surface: `PolarisKeyClient` plus the types a host touches. Every
// module also has a subpath (`@polaris-key/node/core`, `/license`, `/config`, `/devices`, `/identity`,
// `/release`, `/update`, `/local`, `/cli`) so a config-only daemon can import the Config client without
// pulling the license module, and a bundler can drop what nobody imported.
//
// Pure verification logic is NOT re-exported here. `verifyLicenseDoc`, `licenseState`,
// `mergeTrust`, `compareSemver` and friends live in `@polaris-key/client-core`, the isomorphic package
// this SDK consumes and that React, and the conformance runners, consume too. The pre-suite
// `@polaris-key/node` shipped its own copies; keeping re-exports would have preserved the illusion
// that there are two implementations to keep in step.

export {
  PolarisKeyClient,
  DeviceManagementUnsupportedError,
  type PolarisKeyClientOptions,
  type DeviceInfo,
  type SyncState,
} from "./client.js";

export {
  CoreContext,
  InsecureBaseUrlError,
  type CoreOptions,
  type DocumentResult,
} from "./core/context.js";
export {
  CACHE_VERSION,
  FileStore,
  InMemoryStore,
  KeyringStore,
  type CacheRecordV3,
  type KeyringStoreOptions,
  type Store,
  type StoreStatus,
} from "./core/store.js";
export {
  CACHEDIR_TAG_SIGNATURE,
  defaultDirBases,
  excludeFromBackup,
  resolveDirs,
  type BackupExclusion,
  type BackupHost,
  type DirOverrides,
  type DirsHost,
  type ProductDirs,
} from "./core/dirs.js";

export { type ImportBundleResult } from "./core/bundle.js";
export {
  type DocOutcome,
  type SyncOptions,
  type SyncResult,
} from "./core/sync.js";

export {
  LicenseClient,
  type ActivationResult,
  type LicenseClientOptions,
} from "./license/client.js";
export {
  ConfigClient,
  type ConfigClientOptions,
  type ConfigSource,
  type MintedToken,
  type UserConfigEntry,
} from "./config/client.js";
export {
  IdentityClient,
  type SignInPoll,
  type SignInPrompt,
  type SignInResult,
  type WaitForSignInOptions,
} from "./identity/client.js";
export {
  DevicesClient,
  type AccountDevice,
  type DevicesClientOptions,
  type RegisterResult,
} from "./devices/client.js";
export { deriveDeviceId, deviceIdFromRaw } from "./devices/deviceId.js";
export {
  collectFingerprint,
  hashComponents,
  linuxAnchorSource,
  parseWindowsCim,
  ramBucket,
  rawComponents,
  WINDOWS_CIM_COMMAND,
  type AnchorSource,
  type FingerprintIo,
  type RawComponentsOptions,
  type WindowsCimComponents,
} from "./devices/fingerprint.js";
export {
  collectFacts,
  runProbes,
  type ProbeDeclaration,
} from "./devices/facts.js";
export { ReleaseClient, type ChangelogEntry } from "./release/client.js";
export {
  UpdateClient,
  UpdateError,
  type FeedCheck,
  type ReleaseRecordCheck,
  type UpdateClientOptions,
  type UpdateDecideOptions,
  type VersionCheck,
} from "./update/client.js";
// Outlet detection (plans/P3-01.md §2.9): this runtime's readers, and client-core's mapping.
export {
  processOutletEnvironment,
  readOutletSignals,
  type OutletFs,
  type OutletReaderEnvironment,
} from "./update/outlet.js";
export {
  detectOutlet,
  detectionStamp,
  type DetectedOutlet,
  type DetectionStamp,
  type OutletIds,
  type OutletSignals,
  type OutletStamp,
  type ResolvedOutlet,
} from "@polaris-key/client-core";

export {
  appcastUrlFrom,
  discoverProduct,
  DEFAULT_SERVICES,
  SERVICE_SLUGS,
  serviceEndpoint,
  servicesFromList,
  updateEndpointsFrom,
  type DiscoverProductOptions,
  type DiscoverProductResult,
  type ProductDiscoveryDocument,
  type ProductDiscoveryTrust,
  type ServiceFragment,
  type ServicesMap,
  type UpdateEndpoints,
} from "./discovery.js";

// ── Generated constants (`pnpm gen:constants`, tools/gen-sdk-constants.ts) ──
// Error codes, header names, enums, feature ids, versions and the channel vocabulary, spelled
// identically (up to casing) in every SDK. Re-exported wholesale so a constant the generator gains
// (a new enum, P0-04's channel constants) reaches the package root without editing this file;
// test/errorCodes.test.ts checks every generated export is reachable from here. `ServiceSlug` is
// exported as a value and a type; it is the same union the discovery module uses.
export * from "./constants.generated.js";

export { SDK_NAME, SDK_VERSION } from "./version.js";

export type {
  ManagedEntry,
  DocClaims,
  BundleDoc,
  JSONValue,
  DeviceFacts,
  DeviceProbeResult,
  FingerprintComponent,
  HardwareFingerprint,
} from "@polaris-key/protocol/core";
export type {
  ActivationSource,
  AllowedRange,
  BlockReason,
  DocProfile,
  LicenseDoc,
  LicenseStatus,
} from "@polaris-key/protocol/license";
export type { ConfigDoc } from "@polaris-key/protocol/config";
export type {
  ChannelFeedDoc,
  DecisionRelease,
  InstalledBuild,
  StagedUpdate,
  UpdateCheck,
  UpdateDecision,
  UpdateOutlet,
} from "@polaris-key/protocol/update";
export type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
export type { TrustSet } from "@polaris-key/jws";
export type { BlockedState, LicenseState } from "@polaris-key/client-core";
// `StoreBackend` and `StoreDegradedReason` (the type and its constants) come from the generated
// constants above; enums.json pins them to these arrays.
export {
  STORE_BACKENDS,
  STORE_DEGRADED_REASONS,
} from "@polaris-key/client-core";
// The one error type the transport/orchestration layers throw. Its `.code` carries the wire
// error code, the §7 bundle refusal step, `local-only`, or `service-unavailable`.
export { PolarisError } from "@polaris-key/client-core";
// Typed "unsupported here" (PARITY §2.2, P1b-10): `client.supports(feature)` answers a `Support`;
// a call into an unsupported feature throws `UnsupportedError` (code `unsupported`) with the same
// `feature`, `reason` and `detail`.
export {
  UnsupportedError,
  type Support,
  type Supported,
  type Unsupported,
} from "@polaris-key/client-core";

// Packs (`client.update.packs`, P4-06): the facet's class, its options and its error.
export {
  PackError,
  PacksClient,
  type NodeEmbeddedPack,
  type NodePacksOptions,
} from "./packs/index.js";
// The v3 pack-type handlers (P4-16).
export {
  DataJsonHandler,
  L10nTableHandler,
  MlModelHandler,
  type L10nTable,
  type MlModel,
  type PackCheckRefusal,
  type StagedPack,
} from "./packs/index.js";
