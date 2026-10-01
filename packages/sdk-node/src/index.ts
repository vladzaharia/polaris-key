// `@polaris-key/node` — the Polaris Key Node SDK.
//
// The barrel is the convenience surface: `PolarisKeyClient` plus the types a host touches. Every
// module also has a subpath (`@polaris-key/node/core`, `/license`, `/config`, `/devices`, `/release`,
// `/update`, `/local`, `/cli`) so a config-only daemon can import the Config client without
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
  type Store,
} from "./core/store.js";
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
  type UserConfigEntry,
} from "./config/client.js";
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
  rawComponents,
} from "./devices/fingerprint.js";
export {
  collectFacts,
  runProbes,
  type ProbeDeclaration,
} from "./devices/facts.js";
export { ReleaseClient, type ChangelogEntry } from "./release/client.js";
export { UpdateClient, type VersionCheck } from "./update/client.js";

export {
  appcastUrlFrom,
  discoverProduct,
  DEFAULT_SERVICES,
  SERVICE_SLUGS,
  servicesFromList,
  type DiscoverProductOptions,
  type DiscoverProductResult,
  type ProductDiscoveryDocument,
  type ProductDiscoveryTrust,
  type ServiceFragment,
  type ServicesMap,
} from "./discovery.js";

// ── Generated constants (`pnpm gen:constants`, tools/gen-sdk-constants.ts) ──
// Error codes, header names, enums, feature ids and versions, spelled identically (up to
// casing) in every SDK. `ServiceSlug` is exported from here as a value and a type; it is the same
// union the discovery module uses.
export {
  ErrorCode,
  ERROR_CODE_VALUES,
  ERROR_CODE_KINDS,
  type ErrorCodeKind,
  Feature,
  FEATURE_VALUES,
  UnsupportedReason,
  UNSUPPORTED_REASON_VALUES,
  Platform,
  PLATFORM_VALUES,
  Arch,
  ARCH_VALUES,
  HeaderName,
  HEADER_NAME_VALUES,
  ServiceSlug,
  SERVICE_SLUG_VALUES,
  PROTOCOL_VERSION,
  CORPUS_VERSION,
  GATE_MATRIX_VERSION,
  FINGERPRINT_VERSION,
} from "./constants.generated.js";

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
export type { TrustSet } from "@polaris-key/jws";
export type { BlockedState, LicenseState } from "@polaris-key/client-core";
// The one error type the transport/orchestration layers throw. Its `.code` carries the wire
// error code, the §7 bundle refusal step, `local-only`, or `service-unavailable`.
export { PolarisError } from "@polaris-key/client-core";
