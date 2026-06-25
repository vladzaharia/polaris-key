export {
  PolarisKeyClient,
  type PolarisKeyOptions,
  type RefreshResult,
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
  enrollWithKey,
  reacquireToken,
  deauthorize,
  reportSnapshot,
  type EnrollResult,
} from "./endpoints.js";
export {
  FileStore,
  KeyringStore,
  InMemoryStore,
  deriveDeviceId,
  type Store,
  type CacheRecord,
} from "./store.js";
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
} from "@polaris-key/protocol";
export type { TrustSet } from "@polaris-key/jws";
