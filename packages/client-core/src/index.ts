// @plrs/client-core — the isomorphic client substrate shared by every JS Polaris SDK.
//
// WebCrypto only, zero Node APIs, no I/O: everything here is a pure function over bytes,
// claims, and clocks, so the identical implementation runs in @plrs/node, in @plrs/react's
// browser bundle, and in a Worker. Transport, storage, and keyrings belong to the hosts.
//
// Subpath exports mirror these modules one-for-one (`@plrs/client-core/gate`, …) for hosts
// that want a single concern without pulling the barrel.

export {
  CLOCK_SKEW_SECONDS,
  MAX_GRACE_SECONDS,
  REFRESH_MARGIN_SECONDS,
} from "./claims.js";

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

export {
  channelForVersion,
  compareSemver,
  isDevBuild,
  parseSemver,
} from "./semver.js";

export { effectiveNow, highWaterMark, type DatedArtifact } from "./clock.js";

export { PolarisError } from "./errors.js";

export { CACHE_VERSION, type CacheRecordV3, type Store } from "./store.js";
