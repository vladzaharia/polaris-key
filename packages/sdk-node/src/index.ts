export {
  PolarisKeyClient,
  DeviceManagementUnsupportedError,
  InsecureBaseUrlError,
  type PolarisKeyOptions,
  type RefreshResult,
  type DeviceInfo,
  type ConfigSource,
  type UserConfigEntry,
} from "./client.js";
export {
  licenseState,
  isUsable,
  type LicenseState,
  type GateInput,
} from "./gate.js";
export { verifyDoc, type VerifyOptions } from "./verify.js";
export {
  mergeTrust,
  verifyTrustManifest,
  type TrustManifestOptions,
  type TrustManifestResult,
} from "./trust.js";
export {
  CLOCK_SKEW_SECONDS,
  MAX_GRACE_SECONDS,
  REFRESH_MARGIN_SECONDS,
} from "./claims.js";
export {
  fetchManagedConfig,
  type FetchResult,
  type FetchOptions,
} from "./fetch.js";
export {
  discoverProduct,
  type DiscoverProductOptions,
  type DiscoverProductResult,
  type ProductDiscoveryDocument,
  type ProductDiscoveryEndpoints,
  type ProductDiscoveryTrust,
} from "./discovery.js";
export {
  activateWithKey,
  enroll,
  reacquireToken,
  deauthorize,
  reportSnapshot,
  type ActivationResult,
} from "./endpoints.js";
export {
  FileStore,
  KeyringStore,
  InMemoryStore,
  deriveDeviceId,
  deviceIdFromRaw,
  CACHE_VERSION,
  type Store,
  type CacheRecord,
} from "./store.js";
export {
  collectFingerprint,
  hashComponents,
  rawComponents,
} from "./fingerprint.js";
export { collectFacts, runProbes, type ProbeDeclaration } from "./facts.js";
export {
  parseSemver,
  compareSemver,
  channelForVersion,
  isDevBuild,
} from "./semver.js";
export type {
  ManagedConfigDoc,
  ManagedPayload,
  ManagedEntry,
  DocProfile,
  LicenseStatus,
  BlockReason,
  AllowedRange,
  JSONValue,
  DeviceFacts,
  DeviceProbeResult,
  FingerprintComponent,
  HardwareFingerprint,
} from "@plrs/protocol";
export type { TrustSet } from "@plrs/jws";
