// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen:constants` (tools/gen-sdk-constants.ts) from conformance/parity/
// errors.json, enums.json and features.json, tools/services.json, @polaris-key/protocol/core
// and the conformance corpus. `pnpm gen:constants -- --check` fails the green gate on any
// difference. To change a constant, edit its source and regenerate.

/** Every error code the Worker answers with or an SDK raises (conformance/parity/errors.json). Hosts match on these strings. */
export const ErrorCode = {
  unauthorized: "unauthorized",
  notFound: "not_found",
  badRequest: "bad_request",
  forbidden: "forbidden",
  rateLimited: "rate_limited",
  bodyTooLarge: "body_too_large",
  methodNotAllowed: "method_not_allowed",
  misconfigured: "misconfigured",
  registrationClosed: "registration_closed",
  deviceLimit: "device_limit",
  licenseDisabled: "license_disabled",
  licenseExpired: "license_expired",
  notEntitled: "not_entitled",
  versionBlocked: "version_blocked",
  channelNotAllowed: "channel_not_allowed",
  hardwareMismatch: "hardware_mismatch",
  fingerprintRequired: "fingerprint_required",
  enrollDisabled: "enroll_disabled",
  enrollClaimed: "enroll_claimed",
  enrollFailed: "enroll_failed",
  managedByAdmin: "managed_by_admin",
  catalogUnavailable: "catalog_unavailable",
  disabled: "disabled",
  oidcError: "oidc_error",
  unavailable: "unavailable",
  authMethodDisabled: "auth_method_disabled",
  emailNotConfigured: "email_not_configured",
  downloadAuthRequired: "download_auth_required",
  upstreamRateLimited: "upstream_rate_limited",
  serverMisconfigured: "server_misconfigured",
  internalError: "internal_error",
  serviceUnavailable: "service-unavailable",
  serviceDisabled: "service-disabled",
  localOnly: "local-only",
  insecureBaseUrl: "insecure-base-url",
  bundleJwsRejected: "bundle-jws-rejected",
  bundleClaimsRejected: "bundle-claims-rejected",
  bundleTrustRejected: "bundle-trust-rejected",
  innerDocRejected: "inner-doc-rejected",
  bundle: "bundle",
  transport: "transport",
  network: "network",
  refreshFailed: "refresh-failed",
  syncFailed: "sync-failed",
  fetchFailed: "fetch-failed",
  bridgeMissing: "bridge-missing",
  unknown: "unknown",
  releaseRefused: "release-refused",
  bundleRejected: "bundle-rejected",
  bundleImportUnsupported: "bundle-import-unsupported",
  reportUnsupported: "report-unsupported",
  deviceManagementUnsupported: "device-management-unsupported",
  deviceListFailed: "device_list_failed",
  deviceRenameFailed: "device_rename_failed",
  deviceDeauthorizeFailed: "device_deauthorize_failed",
  keyEntryUnsupported: "key-entry-unsupported",
  signInFailed: "sign-in-failed",
  signOutFailed: "sign-out-failed",
  badResponse: "bad_response",
  networkError: "network-error",
  serverError: "server-error",
  cancelled: "cancelled",
  signInExpired: "sign-in-expired",
  signInDenied: "sign-in-denied",
  signInUnavailable: "sign-in-unavailable",
  invalidOptions: "invalid-options",
  notConfigured: "not-configured",
  unsupported: "unsupported",
  timeout: "timeout",
  responseTooLarge: "response-too-large",
  tooManyRedirects: "too-many-redirects",
  insecureRedirect: "insecure-redirect",
  httpError: "http-error",
  invalidResponse: "invalid-response",
  storeFailed: "store-failed",
  noToken: "no-token",
  mintUnavailable: "mint-unavailable",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Every `ErrorCode` value, in source order. */
export const ERROR_CODE_VALUES: readonly ErrorCode[] = [
  "unauthorized",
  "not_found",
  "bad_request",
  "forbidden",
  "rate_limited",
  "body_too_large",
  "method_not_allowed",
  "misconfigured",
  "registration_closed",
  "device_limit",
  "license_disabled",
  "license_expired",
  "not_entitled",
  "version_blocked",
  "channel_not_allowed",
  "hardware_mismatch",
  "fingerprint_required",
  "enroll_disabled",
  "enroll_claimed",
  "enroll_failed",
  "managed_by_admin",
  "catalog_unavailable",
  "disabled",
  "oidc_error",
  "unavailable",
  "auth_method_disabled",
  "email_not_configured",
  "download_auth_required",
  "upstream_rate_limited",
  "server_misconfigured",
  "internal_error",
  "service-unavailable",
  "service-disabled",
  "local-only",
  "insecure-base-url",
  "bundle-jws-rejected",
  "bundle-claims-rejected",
  "bundle-trust-rejected",
  "inner-doc-rejected",
  "bundle",
  "transport",
  "network",
  "refresh-failed",
  "sync-failed",
  "fetch-failed",
  "bridge-missing",
  "unknown",
  "release-refused",
  "bundle-rejected",
  "bundle-import-unsupported",
  "report-unsupported",
  "device-management-unsupported",
  "device_list_failed",
  "device_rename_failed",
  "device_deauthorize_failed",
  "key-entry-unsupported",
  "sign-in-failed",
  "sign-out-failed",
  "bad_response",
  "network-error",
  "server-error",
  "cancelled",
  "sign-in-expired",
  "sign-in-denied",
  "sign-in-unavailable",
  "invalid-options",
  "not-configured",
  "unsupported",
  "timeout",
  "response-too-large",
  "too-many-redirects",
  "insecure-redirect",
  "http-error",
  "invalid-response",
  "store-failed",
  "no-token",
  "mint-unavailable",
];

/** `wire`: appears in a Worker response body. `client`: raised only by an SDK. */
export type ErrorCodeKind = "wire" | "client";

/** The registry: every error code and its kind. */
export const ERROR_CODE_KINDS: Readonly<Record<ErrorCode, ErrorCodeKind>> = {
  unauthorized: "wire",
  not_found: "wire",
  bad_request: "wire",
  forbidden: "wire",
  rate_limited: "wire",
  body_too_large: "wire",
  method_not_allowed: "wire",
  misconfigured: "wire",
  registration_closed: "wire",
  device_limit: "wire",
  license_disabled: "wire",
  license_expired: "wire",
  not_entitled: "wire",
  version_blocked: "wire",
  channel_not_allowed: "wire",
  hardware_mismatch: "wire",
  fingerprint_required: "wire",
  enroll_disabled: "wire",
  enroll_claimed: "wire",
  enroll_failed: "wire",
  managed_by_admin: "wire",
  catalog_unavailable: "wire",
  disabled: "wire",
  oidc_error: "wire",
  unavailable: "wire",
  auth_method_disabled: "wire",
  email_not_configured: "wire",
  download_auth_required: "wire",
  upstream_rate_limited: "wire",
  server_misconfigured: "wire",
  internal_error: "wire",
  "service-unavailable": "client",
  "service-disabled": "client",
  "local-only": "client",
  "insecure-base-url": "client",
  "bundle-jws-rejected": "client",
  "bundle-claims-rejected": "client",
  "bundle-trust-rejected": "client",
  "inner-doc-rejected": "client",
  bundle: "client",
  transport: "client",
  network: "client",
  "refresh-failed": "client",
  "sync-failed": "client",
  "fetch-failed": "client",
  "bridge-missing": "client",
  unknown: "client",
  "release-refused": "client",
  "bundle-rejected": "client",
  "bundle-import-unsupported": "client",
  "report-unsupported": "client",
  "device-management-unsupported": "client",
  device_list_failed: "client",
  device_rename_failed: "client",
  device_deauthorize_failed: "client",
  "key-entry-unsupported": "client",
  "sign-in-failed": "client",
  "sign-out-failed": "client",
  bad_response: "client",
  "network-error": "client",
  "server-error": "client",
  cancelled: "client",
  "sign-in-expired": "client",
  "sign-in-denied": "client",
  "sign-in-unavailable": "client",
  "invalid-options": "client",
  "not-configured": "client",
  unsupported: "client",
  timeout: "client",
  "response-too-large": "client",
  "too-many-redirects": "client",
  "insecure-redirect": "client",
  "http-error": "client",
  "invalid-response": "client",
  "store-failed": "client",
  "no-token": "client",
  "mint-unavailable": "client",
};

/** Every feature id in the parity registry (conformance/parity/features.json). */
export const Feature = {
  coreVerify: "core.verify",
  coreCache: "core.cache",
  coreBundle: "core.bundle",
  coreDiscover: "core.discover",
  coreSync: "core.sync",
  coreLocal: "core.local",
  coreHeaders: "core.headers",
  coreErrors: "core.errors",
  coreCaps: "core.caps",
  coreStore: "core.store",
  licenseGate: "license.gate",
  licenseActivate: "license.activate",
  licenseEnroll: "license.enroll",
  licenseDeactivate: "license.deactivate",
  licenseEntitlements: "license.entitlements",
  licenseChannels: "license.channels",
  licenseReregister: "license.reregister",
  configResolve: "config.resolve",
  configList: "config.list",
  configSecret: "config.secret",
  configSchema: "config.schema",
  configMint: "config.mint",
  configMirror: "config.mirror",
  devicesFingerprint: "devices.fingerprint",
  devicesFacts: "devices.facts",
  devicesRegister: "devices.register",
  devicesManage: "devices.manage",
  devicesReport: "devices.report",
  identityOidc: "identity.oidc",
  identityDevicecode: "identity.devicecode",
  releaseChangelog: "release.changelog",
  releaseDownload: "release.download",
  releaseRecord: "release.record",
  updateCheck: "update.check",
  updateFeed: "update.feed",
  updateDecide: "update.decide",
  updateDriver: "update.driver",
  updateBootguard: "update.bootguard",
  outletDetect: "outlet.detect",
  packsPlan: "packs.plan",
  packsIndex: "packs.index",
  packsApplyFull: "packs.apply.full",
  packsApplyFile: "packs.apply.file",
  packsApplyChunk: "packs.apply.chunk",
  packsApplyDelta: "packs.apply.delta",
  packsState: "packs.state",
  packsHandlers: "packs.handlers",
  packsProvides: "packs.provides",
  packsTransportApple: "packs.transport.apple",
  packsTransportPlay: "packs.transport.play",
  packsTransportSteam: "packs.transport.steam",
  packsTransportMsix: "packs.transport.msix",
  packsTransportFlatpak: "packs.transport.flatpak",
  uiStages: "ui.stages",
  uiKit: "ui.kit",
  commerceReceipt: "commerce.receipt",
} as const;
export type Feature = (typeof Feature)[keyof typeof Feature];

/** Every `Feature` value, in source order. */
export const FEATURE_VALUES: readonly Feature[] = [
  "core.verify",
  "core.cache",
  "core.bundle",
  "core.discover",
  "core.sync",
  "core.local",
  "core.headers",
  "core.errors",
  "core.caps",
  "core.store",
  "license.gate",
  "license.activate",
  "license.enroll",
  "license.deactivate",
  "license.entitlements",
  "license.channels",
  "license.reregister",
  "config.resolve",
  "config.list",
  "config.secret",
  "config.schema",
  "config.mint",
  "config.mirror",
  "devices.fingerprint",
  "devices.facts",
  "devices.register",
  "devices.manage",
  "devices.report",
  "identity.oidc",
  "identity.devicecode",
  "release.changelog",
  "release.download",
  "release.record",
  "update.check",
  "update.feed",
  "update.decide",
  "update.driver",
  "update.bootguard",
  "outlet.detect",
  "packs.plan",
  "packs.index",
  "packs.apply.full",
  "packs.apply.file",
  "packs.apply.chunk",
  "packs.apply.delta",
  "packs.state",
  "packs.handlers",
  "packs.provides",
  "packs.transport.apple",
  "packs.transport.play",
  "packs.transport.steam",
  "packs.transport.msix",
  "packs.transport.flatpak",
  "ui.stages",
  "ui.kit",
  "commerce.receipt",
];

/** Why a feature is unsupported here: the `supports()` reason enum (PARITY §2.2). */
export const UnsupportedReason = {
  runtime: "runtime",
  outlet: "outlet",
  product: "product",
  dependency: "dependency",
  version: "version",
} as const;
export type UnsupportedReason =
  (typeof UnsupportedReason)[keyof typeof UnsupportedReason];

/** Every `UnsupportedReason` value, in source order. */
export const UNSUPPORTED_REASON_VALUES: readonly UnsupportedReason[] = [
  "runtime",
  "outlet",
  "product",
  "dependency",
  "version",
];

/** OS family, the canonical `X-PKey-Platform` value (README §3.1). iPadOS is `ios`. */
export const Platform = {
  macos: "macos",
  ios: "ios",
  android: "android",
  windows: "windows",
  linux: "linux",
  web: "web",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

/** Every `Platform` value, in source order. */
export const PLATFORM_VALUES: readonly Platform[] = [
  "macos",
  "ios",
  "android",
  "windows",
  "linux",
  "web",
];

/** CPU architecture, the canonical `X-PKey-Arch` value (README §3.1). `universal` and `any` are artifact values, not header values, and are not listed. */
export const Arch = {
  arm64: "arm64",
  x86_64: "x86_64",
  armv7: "armv7",
  wasm32: "wasm32",
} as const;
export type Arch = (typeof Arch)[keyof typeof Arch];

/** Every `Arch` value, in source order. */
export const ARCH_VALUES: readonly Arch[] = [
  "arm64",
  "x86_64",
  "armv7",
  "wasm32",
];

/** Where a token store keeps the token, the `backend` of `Store.status()` (P1b-09). Mirrors `STORE_BACKENDS` in `@polaris-key/client-core/store`; a test keeps them equal. */
export const StoreBackend = {
  keyring: "keyring",
  keychain: "keychain",
  keystore: "keystore",
  file: "file",
  memory: "memory",
  indexeddb: "indexeddb",
  custom: "custom",
} as const;
export type StoreBackend = (typeof StoreBackend)[keyof typeof StoreBackend];

/** Every `StoreBackend` value, in source order. */
export const STORE_BACKEND_VALUES: readonly StoreBackend[] = [
  "keyring",
  "keychain",
  "keystore",
  "file",
  "memory",
  "indexeddb",
  "custom",
];

/** Why a token store is weaker than its platform's best option, the `degraded.reason` of `Store.status()` (P1b-09). Mirrors `STORE_DEGRADED_REASONS` in `@polaris-key/client-core/store`; a test keeps them equal. */
export const StoreDegradedReason = {
  keyringUnavailable: "keyring-unavailable",
  keyringError: "keyring-error",
  legacyKeychain: "legacy-keychain",
  notPersistent: "not-persistent",
} as const;
export type StoreDegradedReason =
  (typeof StoreDegradedReason)[keyof typeof StoreDegradedReason];

/** Every `StoreDegradedReason` value, in source order. */
export const STORE_DEGRADED_REASON_VALUES: readonly StoreDegradedReason[] = [
  "keyring-unavailable",
  "keyring-error",
  "legacy-keychain",
  "not-persistent",
];

/** The `X-PKey-*` request header names (wire contract v3 §5). */
export const HeaderName = {
  arch: "X-PKey-Arch",
  channel: "X-PKey-Channel",
  device: "X-PKey-Device",
  platform: "X-PKey-Platform",
  sdkName: "X-PKey-SDK",
  sdkVersion: "X-PKey-SDK-Version",
  version: "X-PKey-Version",
} as const;
export type HeaderName = (typeof HeaderName)[keyof typeof HeaderName];

/** Every `HeaderName` value, in source order. */
export const HEADER_NAME_VALUES: readonly HeaderName[] = [
  "X-PKey-Arch",
  "X-PKey-Channel",
  "X-PKey-Device",
  "X-PKey-Platform",
  "X-PKey-SDK",
  "X-PKey-SDK-Version",
  "X-PKey-Version",
];

/** The opt-in services (tools/services.json). Core is not a service — it is always on. */
export const ServiceSlug = {
  license: "license",
  config: "config",
  release: "release",
  distribution: "distribution",
  update: "update",
  identity: "identity",
} as const;
export type ServiceSlug = (typeof ServiceSlug)[keyof typeof ServiceSlug];

/** Every `ServiceSlug` value, in source order. */
export const SERVICE_SLUG_VALUES: readonly ServiceSlug[] = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
];

/** The wire contract version (`@polaris-key/protocol/core`). */
export const PROTOCOL_VERSION = 3;

/** `corpusVersion` of conformance/corpus/v2/cases.json. */
export const CORPUS_VERSION = 2;

/** `gateMatrixVersion` of conformance/corpus/v2/gate-matrix.json. */
export const GATE_MATRIX_VERSION = 2;

/** `fingerprintVersion` of conformance/corpus/v2/fingerprint.json. */
export const FINGERPRINT_VERSION = 1;

/** Channel constant `CHANNEL_ALIASES` (`@polaris-key/protocol/core`). */
export const CHANNEL_ALIASES = {
  staging: "beta",
  latest: "stable",
} as const;

/** Channel constant `CHANNEL_BETA` (`@polaris-key/protocol/core`). */
export const CHANNEL_BETA = "beta";

/** Channel constant `CHANNEL_DEV` (`@polaris-key/protocol/core`). */
export const CHANNEL_DEV = "dev";

/** Channel constant `CHANNEL_NAME_PATTERN` (`@polaris-key/protocol/core`). */
export const CHANNEL_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

/** Channel constant `CHANNEL_PR` (`@polaris-key/protocol/core`). */
export const CHANNEL_PR = "pr";

/** Channel constant `CHANNEL_STABLE` (`@polaris-key/protocol/core`). */
export const CHANNEL_STABLE = "stable";

/** Channel constant `PR_CHANNEL_PATTERN` (`@polaris-key/protocol/core`). */
export const PR_CHANNEL_PATTERN = "^pr-?([0-9]+)$";

/** Channel constant `PR_NUMBER_MAX_DIGITS` (`@polaris-key/protocol/core`). */
export const PR_NUMBER_MAX_DIGITS = 7;
