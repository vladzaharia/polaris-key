// @polaris-key/protocol/core — wire contract v4 Core substrate types: the shared document
// envelope, device principal, telemetry, errors, and transport headers. Types only, no
// runtime, no crypto. Normative source: docs/security/WIRE-CONTRACT-V4.md. Any field drift
// is wire-breaking: bump PROTOCOL_VERSION and regenerate conformance/corpus/v2.
//
// Times are epoch SECONDS (matching the JOSE world the Worker signs in), never millis.

/** Bumped on any wire-breaking change to the document shapes or HTTP contract. */
export const PROTOCOL_VERSION = 4;

/** The largest value an integer claim may carry, 2^53 − 1 (WIRE-CONTRACT-V4 §3). An integer
 *  claim is a plain integer token (`-?(0|[1-9][0-9]*)`, no fraction, no exponent) from the
 *  claim's minimum to this value, decided from the token and never from a parsed number. */
export const MAX_WIRE_INTEGER = 9007199254740991;

/** The deepest an object or array may nest in a signed header or payload, counting the
 *  top-level object as level 1 (WIRE-CONTRACT-V4 §1.2 rule 9). */
export const MAX_JSON_DEPTH = 64;

/** The longest compact JWS that can be a release record a feed pins: `verifyJws`'s own encoded
 *  caps, 1 370 + 1 + 87 386 + 1 + 86 bytes. A longer body, or one with a byte outside ASCII,
 *  is refused before it is hashed (WIRE-CONTRACT-V4 §3, client step 12). */
export const MAX_RECORD_JWS_BYTES = 88844;

// ── Packs on the wire (plans/P4-01.md §2.3, §2.4, §2.7, §2.8; WIRE-CONTRACT-V4 §2.5.1–§2.7) ──
// Bounds a v1 SDK and the claims share. `MAX_FILES_INDEX_BYTES` is a client limit, not a
// claim: a later version may raise it, and a v1 SDK then finds a larger index unusable.

/** `variants`: 1–this many per pack record. */
export const MAX_PACK_VARIANTS = 32;
/** `variants[].deltas`: at most this many per variant. */
export const MAX_VARIANT_DELTAS = 16;
/** `content.pins` and `content.expects`: at most this many each. */
export const MAX_CONTENT_PINS = 256;
/** `builds[].embeds`: at most this many per build. */
export const MAX_BUILD_EMBEDS = 64;
/** `pkey-files/1` and `pkey-patch/1`: at most this many entries. */
export const MAX_INDEX_FILES = 100000;
/** The largest decoded files index (or patch descriptor) a client fetches: 32 MiB. */
export const MAX_FILES_INDEX_BYTES = 33554432;
/** A pack file path: 1–this many UTF-8 bytes. */
export const MAX_PACK_PATH_BYTES = 1024;
/** The files index's `format`. */
export const FILES_FORMAT = "pkey-files/1";
/** A `files`-scope delta set's descriptor `format`. */
export const PATCH_FORMAT = "pkey-patch/1";
/** An embedded pack's marker `format`. */
export const MARKER_FORMAT = "pkey-marker/1";
/** The content stamp's `format`. */
export const CONTENT_STAMP_FORMAT = "pkey-content/1";
/** The install planner's cost of one request, in bytes (plans/P4-01.md §2.9, A7 §4.2):
 *  `cost = bytes + requests × PLAN_REQUEST_WEIGHT`. `plan-matrix.json` pins it. */
export const PLAN_REQUEST_WEIGHT = 16384;

/** The `iss` every Polaris Key document carries. A FIXED string, never derived from the base URL
 *  or the serving host — an attacker-controlled host must not be able to name its own issuer.
 *  (Amendment A1: the host-neutral `plrs.im` spelling was withdrawn; a future host move is a
 *  sanctioned pre-launch wire break, not something this constant absorbs.) */
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

/**
 * The shared claims envelope carried by every per-service signed document
 * (WIRE-CONTRACT-V3 §2). `aud` (product slug) + `iss` scope a document to one
 * product/tenant as defense-in-depth on top of the per-product signing key; clients MUST
 * assert `aud === their configured product` and `deviceId === their local device id`.
 * `expiresAt` is short (`issuedAt + DOC_EXPIRY_SECONDS`); `graceUntil` carries the long,
 * server-signed offline window (`issuedAt + maxOfflineDays * 86400`).
 */
export interface DocClaims {
  /** Always `ISSUER` ("key.plrs.im"). */
  iss: string;
  /** Product slug — the audience this document is scoped to. */
  aud: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  graceUntil: number;
}

/**
 * Offline activation bundle payload (`typ: "pkey-bundle+jws"`, WIRE-CONTRACT-V3 §7).
 * Wraps up to three inner compact JWSs; the bundle payload cap is 262 144 bytes (unlike
 * the 65 536-byte cap on ordinary documents). `expiresAt` is the IMPORT window for the
 * bundle itself (network-path freshness at import); the inner documents carry the long
 * `graceUntil` and are validated with the reload profile.
 */
export interface BundleDoc {
  /** ULID; the audit anchor for the mint event. */
  bundleId: string;
  /** Product slug the bundle is scoped to. */
  aud: string;
  /** The requesting device's id — bundles are device-bound (request-code flow). */
  deviceId: string;
  issuedAt: number;
  /** Import deadline for the bundle artifact itself. */
  expiresAt: number;
  /** Inner compact JWSs: `pkey-license+jws` and optionally `pkey-config+jws`. */
  docs: { license?: string; config?: string };
  /** The current trust manifest (`pkey-trust+jws`), so an air-gapped device can build its
   *  effective trust set at import time. */
  trust: string;
}

/** Maximum decoded payload bytes for `pkey-bundle+jws` (WIRE-CONTRACT-V3 §1). */
export const MAX_BUNDLE_BYTES = 262_144;

/** Per-product device registration policy (WIRE-CONTRACT-V3 §6). Default is derived:
 *  `requires-license` if the license service is enabled, else `requires-identity` if the
 *  identity service is enabled, else `open`. */
export type RegistrationPolicy =
  | "open"
  | "requires-identity"
  | "requires-license";

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

/** Domain-separation prefix for per-component hashes. Deliberately NOT rebranded in v3:
 *  it is a hash domain baked into every stored digest (fingerprintVersion 1 is unchanged),
 *  not a user-visible identifier — changing it would orphan every enrolled fingerprint. */
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

/** The device's current software snapshot, reported through `POST /<product>/devices/report`.
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
  | "enroll_disabled"
  | "registration_closed";

export interface PolarisErrorBody {
  error: {
    code: PolarisErrorCode | string;
    message?: string;
    fields?: string[];
    [key: string]: unknown;
  };
}

/** Short signed-document lifetime (seconds) — a replayed doc needs constant re-signing. */
export const DOC_EXPIRY_SECONDS = 3600;

/** Seconds per day, for the offline-grace computation. */
export const SECONDS_PER_DAY = 86_400;

/** Client→Worker request headers. The `X-PKey-*` spellings are NORMATIVE for wire contract v3
 *  (Amendment A1) — not a legacy carry-over — so a client that sends them is current. */
export const HEADER_DEVICE = "X-PKey-Device";
export const HEADER_VERSION = "X-PKey-Version";
export const HEADER_CHANNEL = "X-PKey-Channel";
export const HEADER_SDK_NAME = "X-PKey-SDK";
export const HEADER_SDK_VERSION = "X-PKey-SDK-Version";
export const HEADER_PLATFORM = "X-PKey-Platform";
export const HEADER_ARCH = "X-PKey-Arch";

/**
 * The channel vocabulary (WIRE-CONTRACT-V3 §5.1). One set of names for the licence build gate,
 * the `entitled` release check and every SDK's `X-PKey-Channel`: `stable`, `beta`, `pr-<n>`
 * (`pr` is the family; as a grant it covers every PR), a product's manual channels, and `dev`,
 * the gate's pseudo-channel for `0.0.0-dev*` builds. Release has no `dev` channel.
 */
export const CHANNEL_STABLE = "stable";
export const CHANNEL_BETA = "beta";
export const CHANNEL_PR = "pr";
export const CHANNEL_DEV = "dev";

/** Accepted aliases, never emitted by an SDK: `staging` is the legacy spelling of `beta`, and
 *  `latest` names `stable`. Grants are never rewritten through this table; only `staging` widens
 *  a grant (a `staging` grant also covers `beta`, §5.1 rule 4). */
export const CHANNEL_ALIASES = { staging: "beta", latest: "stable" } as const;

/** Every channel name matches this: the intersection of the manifest's `CHANNEL_RE` and the
 *  feed routes' `^[a-z0-9-]+$`. */
export const CHANNEL_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

/** A PR channel, hyphen optional (`pr-42`, `pr42`); group 1 is the PR number. */
export const PR_CHANNEL_PATTERN = "^pr-?([0-9]+)$";

/** A PR number longer than this is not a `pr-<n>` channel; the gate reads it as the `pr` family. */
export const PR_NUMBER_MAX_DIGITS = 7;

/** The coarse channel family a build's version implies, as an SDK sends it. Only the Worker's
 *  `impliedChannel` narrows `pr` to `pr-<n>`. */
export type BuildChannel = "stable" | "beta" | "pr" | "dev";

/** WIRE-CONTRACT-V3 §5.2. Every spelling an OS or runtime reports, ASCII-lowercased, mapped to
 *  its canonical value; each canonical value maps to itself. Anything else has no value, and an
 *  SDK omits `X-PKey-Platform` rather than inventing one. `headers.json` pins the table. */
export const PLATFORM_SPELLINGS = {
  macos: "macos",
  darwin: "macos",
  maccatalyst: "macos",
  ios: "ios",
  ipados: "ios",
  android: "android",
  windows: "windows",
  win32: "windows",
  linux: "linux",
  web: "web",
  browser: "web",
} as const;
export type ClientPlatform =
  (typeof PLATFORM_SPELLINGS)[keyof typeof PLATFORM_SPELLINGS];

/** WIRE-CONTRACT-V3 §5.2. Every CPU-architecture spelling a runtime reports, ASCII-lowercased,
 *  mapped to its canonical `X-PKey-Arch` value. Anything else has no value (the header is
 *  omitted). `headers.json` pins the table. */
export const ARCH_SPELLINGS = {
  arm64: "arm64",
  aarch64: "arm64",
  "arm64-v8a": "arm64",
  x86_64: "x86_64",
  x64: "x86_64",
  amd64: "x86_64",
  armv7: "armv7",
  armv7l: "armv7",
  armv8l: "armv7",
  arm: "armv7",
  arm32: "armv7",
  "armeabi-v7a": "armv7",
  wasm32: "wasm32",
} as const;
export type ClientArch = (typeof ARCH_SPELLINGS)[keyof typeof ARCH_SPELLINGS];
