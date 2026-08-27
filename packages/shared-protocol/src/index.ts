// @polaris-key/protocol — the Polaris Key wire-contract types ONLY (no runtime, no crypto).
// Organized by service since wire contract v3. There is exactly ONE identifier set: this
// barrel re-exports core's values verbatim (`ISSUER` = `key.plrs.im`, the `X-PKey-*` headers),
// so an import from here and an import from `@polaris-key/protocol/core` can never disagree.
// Prefer the service subpaths (`/core`, `/license`, `/config`, `/release`, `/update`, `/trust`)
// in new code; the barrel exists for consumers that want one import.

export {
  ISSUER,
  HEADER_DEVICE,
  HEADER_VERSION,
  HEADER_CHANNEL,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_PLATFORM,
  HEADER_ARCH,
  PROTOCOL_VERSION,
  MAX_BUNDLE_BYTES,
  FINGERPRINT_COMPONENTS,
  FINGERPRINT_ANCHOR,
  FINGERPRINT_HASH_PREFIX,
  FINGERPRINT_COMPONENT_LENGTH,
  FINGERPRINT_HWID_LENGTH,
  FINGERPRINT_TOLERANCE,
  MAX_DEVICE_PROBES,
  DOC_EXPIRY_SECONDS,
  SECONDS_PER_DAY,
} from "./core.js";
export type {
  JSONValue,
  ManagementState,
  ManagedEntry,
  DocClaims,
  BundleDoc,
  RegistrationPolicy,
  DeviceMetadata,
  FingerprintComponent,
  HardwareFingerprint,
  FingerprintMode,
  DeviceProbeResult,
  DeviceFacts,
  PolarisErrorCode,
  PolarisErrorBody,
} from "./core.js";

export type {
  DocProfile,
  LicenseDoc,
  LicenseStatus,
  BlockReason,
  AllowedRange,
  ActivationSource,
} from "./license.js";

export type { ConfigDoc, SecretDelivery } from "./config.js";

export { DEFAULT_RELEASE_ACCESS } from "./release.js";
export type { ReleaseAccess, ReleaseAccessPolicy } from "./release.js";

export type { UpdateArch } from "./update.js";

export type {
  SigningKeyStatus,
  TrustManifestKey,
  TrustManifestDoc,
} from "./trust.js";
