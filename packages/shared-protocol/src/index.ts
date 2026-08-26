// @polaris-key/protocol — the Polaris Key wire contract types ONLY (no runtime, no
// crypto). These shapes are the source of truth every SDK + the Worker mirror. The
// managed-config document is the JWS payload (see @polaris-key/jws for the encoding);
// any field drift here silently breaks cross-platform verification, so treat changes as
// wire-breaking and bump PROTOCOL_VERSION + regenerate the conformance corpus.
//
// Times are epoch SECONDS (matching the JOSE world the Worker signs in), never millis.

/** Bumped on any wire-breaking change to the document shape or HTTP contract. */
export const PROTOCOL_VERSION = 2;

/** The `iss` every Polaris Key document carries — the control-plane origin host. */
export const ISSUER = "key.plrs.im";

/** A JSON-serialisable value — the type every managed entry carries. */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/** Per-key MDM-style management state.
 *  - `enforced` ⇒ the server value wins; the client CANNOT override it (shown read-only).
 *  - `hidden`   ⇒ `enforced` AND withheld from user-facing enumeration (still applied).
 *  - `default`  ⇒ the server's `value` is a default; the client may override it via a
 *    local/user override or an environment variable (precedence: enforced|hidden > local >
 *    env > remote-default > schema-default). */
export type ManagementState = "default" | "enforced" | "hidden";

/** A managed value, its management state, and when an admin last changed it. */
export interface ManagedEntry {
  state: ManagementState;
  value: JSONValue;
  /** Epoch seconds of the last admin change to this key (for client change-detection). */
  updatedAt: number;
}

/** The three payload kinds, each routed to a different store on arrival: `config` →
 *  plaintext, `secrets` → OS keyring, `entitlements` → the capability map. Keys are the
 *  product catalog's dotted entry keys (e.g. `run.concurrency`, `polarisVpn`). */
export interface ManagedPayload {
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedEntry>;
  entitlements: Record<string, ManagedEntry>;
}

/** How a catalog secret reaches a runtime. */
export type SecretDelivery = "serverOnly" | "clientScoped" | "edgeMint";

/** Release visibility used by release metadata/artifact contracts. */
export type ReleaseAccess = "public" | "authenticated" | "licensed";

export interface ReleaseAccessPolicy {
  metadata: ReleaseAccess;
  artifacts: ReleaseAccess;
}

export const DEFAULT_RELEASE_ACCESS: ReleaseAccessPolicy = {
  metadata: "public",
  artifacts: "public",
};

/** The profile block for the client's offline, tamper-proof greeting (signed, so it
 *  can't be spoofed locally). */
export interface DocProfile {
  name: string;
  firstName: string;
  email: string;
  /** Epoch seconds the key was first activated. */
  activatedAt: number;
}

/**
 * The JWS payload — the whole object the Worker signs (EdDSA/Ed25519) and every client
 * verifies. `aud` (product slug) + `iss` scope the document to one product/tenant as
 * defense-in-depth on top of the per-product signing key; clients MUST assert
 * `aud === their configured product`. It binds `licenseId`+`deviceId`+`issuedAt`+
 * `expiresAt`+`graceUntil`+`schemaVersion` so a doc can't be replayed across devices or
 * spliced to extend grace. `expiresAt` is short (~1h); `graceUntil` carries the long,
 * server-signed offline window.
 */
export interface ManagedConfigDoc {
  schemaVersion: number;
  /** Product slug — the audience this document is scoped to. */
  aud: string;
  /** Issuer — always `ISSUER`. */
  iss: string;
  licenseId: string;
  deviceId: string;
  issuedAt: number;
  /** Short — `issuedAt + DOC_EXPIRY_SECONDS`. */
  expiresAt: number;
  /** Offline-grace anchor — `issuedAt + maxOfflineDays * 86400`. */
  graceUntil: number;
  profile: DocProfile;
  payload: ManagedPayload;
}

export type SigningKeyStatus = "staged" | "active" | "retired" | "revoked";

export interface TrustManifestKey {
  kid: string;
  alg: "EdDSA";
  kty: "OKP";
  crv: "Ed25519";
  publicKey: string;
  status: Exclude<SigningKeyStatus, "revoked">;
}

/** Signed by the currently trusted active product key and used by SDKs to refresh their
 *  verification key set without trusting unsigned JWKS data. */
export interface TrustManifestDoc {
  schemaVersion: 1;
  aud: string;
  iss: string;
  issuedAt: number;
  expiresAt: number;
  jwksUrl: string;
  cacheSeconds: number;
  keys: TrustManifestKey[];
}

export interface DeviceMetadata {
  label?: string;
  platform?: string;
  arch?: string;
  appVersion?: string;
  sdkName?: string;
  sdkVersion?: string;
}

/** One hashed hardware signal in a device fingerprint. `machineUuid` is the ANCHOR: when it
 *  matches, drift tolerance widens by one — the same shape as Windows activation treating the
 *  NIC as a privileged component. */
export type FingerprintComponent =
  | "machineUuid"
  | "boardSerial"
  | "cpuModel"
  | "primaryMac"
  | "bootVolumeUuid"
  | "ramBucket"
  | "machineModel";

/** Canonical component order — the `hwid` digest is built from this order, so every SDK must
 *  iterate it rather than a language-native map ordering. */
export const FINGERPRINT_COMPONENTS = [
  "machineUuid",
  "boardSerial",
  "cpuModel",
  "primaryMac",
  "bootVolumeUuid",
  "ramBucket",
  "machineModel",
] as const satisfies readonly FingerprintComponent[];

/** The component whose match widens the drift tolerance by one. */
export const FINGERPRINT_ANCHOR: FingerprintComponent = "machineUuid";

/** Domain-separation prefix for per-component hashes, parallel to the device id's
 *  `pkey-device:`. Raw hardware values are hashed ON DEVICE and never transmitted; the server
 *  only ever compares opaque digests. */
export const FINGERPRINT_HASH_PREFIX = "pkey-hw";

/** base64url chars kept from each per-component digest. */
export const FINGERPRINT_COMPONENT_LENGTH = 22;

/** base64url chars kept from the composite digest. */
export const FINGERPRINT_HWID_LENGTH = 32;

/** A device's hardware identity. Components the device could not read are OMITTED — never
 *  substituted with a placeholder, so a partial read degrades match precision instead of
 *  silently colliding with every other partial reader. */
export interface HardwareFingerprint {
  components: Partial<Record<FingerprintComponent, string>>;
  /** Composite hash over the present components — the coarse dedupe key. Because it covers
   *  only what was read, losing a component changes it; component-wise matching is the
   *  authority and this is the fast path. */
  hwid: string;
}

/** Per-tier enforcement strength. `strict` additionally REQUIRES a fingerprint. */
export type FingerprintMode = "off" | "lenient" | "normal" | "strict";

/** Drift tolerance per mode, before the anchor bonus. `off` never enforces. */
export const FINGERPRINT_TOLERANCE: Record<FingerprintMode, number> = {
  off: Number.POSITIVE_INFINITY,
  lenient: 4,
  normal: 2,
  strict: 0,
};

/** A product-declared companion-application check, answered by the client. */
export interface DeviceProbeResult {
  present: boolean;
  version?: string;
}

/** The device's current software snapshot, reported through `POST /<product>/config/report`.
 *  Deliberately narrow: no full installed-app enumeration, only product-declared probes. */
export interface DeviceFacts {
  os: { name: string; version?: string; build?: string; kernel?: string };
  hardware?: {
    cpuModel?: string;
    cpuCores?: number;
    ramMb?: number;
    machineModel?: string;
  };
  runtime?: { name: string; version: string };
  locale?: string;
  timezone?: string;
  probes?: Record<string, DeviceProbeResult>;
}

/** Upper bound on probe results accepted in one report, so `probes` can't become an
 *  unbounded inventory smuggled past the report's size cap. */
export const MAX_DEVICE_PROBES = 32;

export type PolarisErrorCode =
  | "unauthorized"
  | "device_limit"
  | "license_disabled"
  | "license_expired"
  | "version_blocked"
  | "channel_not_allowed"
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "forbidden"
  | "hardware_mismatch"
  | "fingerprint_required"
  | "enroll_disabled";

export interface PolarisErrorBody {
  error: {
    code: PolarisErrorCode | string;
    message?: string;
    fields?: string[];
    [key: string]: unknown;
  };
}

/** The terminal gate state a client renders from. */
export type LicenseStatus =
  | "ok"
  | "grace"
  | "expired"
  | "revoked"
  | "needs-activation"
  | "version-too-old"
  | "version-too-new"
  | "channel-not-entitled";

/** A 403 block reason returned by `GET /<product>/config`. */
export type BlockReason =
  | "version-too-old"
  | "version-too-new"
  | "channel-not-entitled";

/** The version window a blocked client may run within. */
export interface AllowedRange {
  min?: string;
  max?: string;
}

/** Short signed-token lifetime (seconds) — a replayed doc needs constant re-signing. */
export const DOC_EXPIRY_SECONDS = 3600;

/** Seconds per day, for the offline-grace computation. */
export const SECONDS_PER_DAY = 86_400;

/** Client→Worker request headers (replaces djdl's `X-DJDL-*`). */
export const HEADER_DEVICE = "X-PKey-Device";
export const HEADER_VERSION = "X-PKey-Version";
export const HEADER_CHANNEL = "X-PKey-Channel";
export const HEADER_SDK_NAME = "X-PKey-SDK";
export const HEADER_SDK_VERSION = "X-PKey-SDK-Version";
export const HEADER_PLATFORM = "X-PKey-Platform";
export const HEADER_ARCH = "X-PKey-Arch";
