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
  valueNotRepresentable: "value_not_representable",
  documentNotRepresentable: "document_not_representable",
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
  deliveryGateMissing: "delivery_gate_missing",
  upstreamRateLimited: "upstream_rate_limited",
  serverMisconfigured: "server_misconfigured",
  internalError: "internal_error",
  releaseRecordRejected: "release_record_rejected",
  releaseTagIsPackRelease: "release_tag_is_pack_release",
  feedNotComposable: "feed_not_composable",
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
  feedRejected: "feed-rejected",
  feedRollback: "feed-rollback",
  recordRejected: "record-rejected",
  recordMismatch: "record-mismatch",
  payloadMismatch: "payload-mismatch",
  swapRefused: "swap-refused",
  swapFailed: "swap-failed",
  filesIndexInvalid: "files-index-invalid",
  filesUnsafePath: "files-unsafe-path",
  filesDuplicatePath: "files-duplicate-path",
  filesCaseCollision: "files-case-collision",
  filesPathConflict: "files-path-conflict",
  filesLayoutMismatch: "files-layout-mismatch",
  contentStampInvalid: "content-stamp-invalid",
  fullCorrupt: "full-corrupt",
  deltaArtifactMismatch: "delta-artifact-mismatch",
  deltaBaseMismatch: "delta-base-mismatch",
  deltaApplyFailed: "delta-apply-failed",
  fileCorrupt: "file-corrupt",
  fileSourceMissing: "file-source-missing",
  payloadHashMismatch: "payload-hash-mismatch",
  chunksRefMismatch: "chunks-ref-mismatch",
  chunksBadLength: "chunks-bad-length",
  chunksBadMagic: "chunks-bad-magic",
  chunksUnsupportedVersion: "chunks-unsupported-version",
  chunksBadRecordSize: "chunks-bad-record-size",
  chunksBadFlags: "chunks-bad-flags",
  chunksReservedNonzero: "chunks-reserved-nonzero",
  chunksZeroLength: "chunks-zero-length",
  chunksBadClen: "chunks-bad-clen",
  chunksBadBundleRef: "chunks-bad-bundle-ref",
  chunksBadBundleRange: "chunks-bad-bundle-range",
  chunksSizeMismatch: "chunks-size-mismatch",
  chunksPayloadMismatch: "chunks-payload-mismatch",
  chunkBundleTruncated: "chunk-bundle-truncated",
  chunkCorrupt: "chunk-corrupt",
  planTransportUnsupported: "plan-transport-unsupported",
  planInsufficientDisk: "plan-insufficient-disk",
  planNoStrategy: "plan-no-strategy",
  packNoVariant: "pack-no-variant",
  packTypeUnsupported: "pack-type-unsupported",
  packNotPinned: "pack-not-pinned",
  packNotEntitled: "pack-not-entitled",
  packStateUnreadable: "pack-state-unreadable",
  packRevoked: "pack-revoked",
  markerRejected: "marker-rejected",
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
  "value_not_representable",
  "document_not_representable",
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
  "delivery_gate_missing",
  "upstream_rate_limited",
  "server_misconfigured",
  "internal_error",
  "release_record_rejected",
  "release_tag_is_pack_release",
  "feed_not_composable",
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
  "feed-rejected",
  "feed-rollback",
  "record-rejected",
  "record-mismatch",
  "payload-mismatch",
  "swap-refused",
  "swap-failed",
  "files-index-invalid",
  "files-unsafe-path",
  "files-duplicate-path",
  "files-case-collision",
  "files-path-conflict",
  "files-layout-mismatch",
  "content-stamp-invalid",
  "full-corrupt",
  "delta-artifact-mismatch",
  "delta-base-mismatch",
  "delta-apply-failed",
  "file-corrupt",
  "file-source-missing",
  "payload-hash-mismatch",
  "chunks-ref-mismatch",
  "chunks-bad-length",
  "chunks-bad-magic",
  "chunks-unsupported-version",
  "chunks-bad-record-size",
  "chunks-bad-flags",
  "chunks-reserved-nonzero",
  "chunks-zero-length",
  "chunks-bad-clen",
  "chunks-bad-bundle-ref",
  "chunks-bad-bundle-range",
  "chunks-size-mismatch",
  "chunks-payload-mismatch",
  "chunk-bundle-truncated",
  "chunk-corrupt",
  "plan-transport-unsupported",
  "plan-insufficient-disk",
  "plan-no-strategy",
  "pack-no-variant",
  "pack-type-unsupported",
  "pack-not-pinned",
  "pack-not-entitled",
  "pack-state-unreadable",
  "pack-revoked",
  "marker-rejected",
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
  value_not_representable: "wire",
  document_not_representable: "wire",
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
  delivery_gate_missing: "wire",
  upstream_rate_limited: "wire",
  server_misconfigured: "wire",
  internal_error: "wire",
  release_record_rejected: "wire",
  release_tag_is_pack_release: "wire",
  feed_not_composable: "wire",
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
  "feed-rejected": "client",
  "feed-rollback": "client",
  "record-rejected": "client",
  "record-mismatch": "client",
  "payload-mismatch": "client",
  "swap-refused": "client",
  "swap-failed": "client",
  "files-index-invalid": "client",
  "files-unsafe-path": "client",
  "files-duplicate-path": "client",
  "files-case-collision": "client",
  "files-path-conflict": "client",
  "files-layout-mismatch": "client",
  "content-stamp-invalid": "client",
  "full-corrupt": "client",
  "delta-artifact-mismatch": "client",
  "delta-base-mismatch": "client",
  "delta-apply-failed": "client",
  "file-corrupt": "client",
  "file-source-missing": "client",
  "payload-hash-mismatch": "client",
  "chunks-ref-mismatch": "client",
  "chunks-bad-length": "client",
  "chunks-bad-magic": "client",
  "chunks-unsupported-version": "client",
  "chunks-bad-record-size": "client",
  "chunks-bad-flags": "client",
  "chunks-reserved-nonzero": "client",
  "chunks-zero-length": "client",
  "chunks-bad-clen": "client",
  "chunks-bad-bundle-ref": "client",
  "chunks-bad-bundle-range": "client",
  "chunks-size-mismatch": "client",
  "chunks-payload-mismatch": "client",
  "chunk-bundle-truncated": "client",
  "chunk-corrupt": "client",
  "plan-transport-unsupported": "client",
  "plan-insufficient-disk": "client",
  "plan-no-strategy": "client",
  "pack-no-variant": "client",
  "pack-type-unsupported": "client",
  "pack-not-pinned": "client",
  "pack-not-entitled": "client",
  "pack-state-unreadable": "client",
  "pack-revoked": "client",
  "marker-rejected": "client",
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
  updateContent: "update.content",
  updateDriver: "update.driver",
  updateBootguard: "update.bootguard",
  outletDetect: "outlet.detect",
  packsRecord: "packs.record",
  packsRevoke: "packs.revoke",
  packsPlan: "packs.plan",
  packsIndexFiles: "packs.index.files",
  packsIndexChunks: "packs.index.chunks",
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
  "update.content",
  "update.driver",
  "update.bootguard",
  "outlet.detect",
  "packs.record",
  "packs.revoke",
  "packs.plan",
  "packs.index.files",
  "packs.index.chunks",
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

/** The canonical X-PKey-SDK value (WIRE-CONTRACT-V3 §5.2): which SDK made the request. The SDK's version is X-PKey-SDK-Version. An SDK adds its id when it lands. */
export const SdkId = {
  node: "node",
  react: "react",
  python: "python",
  swift: "swift",
  godot: "godot",
} as const;
export type SdkId = (typeof SdkId)[keyof typeof SdkId];

/** Every `SdkId` value, in source order. */
export const SDK_ID_VALUES: readonly SdkId[] = [
  "node",
  "react",
  "python",
  "swift",
  "godot",
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

/** The 17 outlet kinds, in `OUTLET_KINDS` order (README §3.1, plans/P3-01.md §2.9). `unknown` is a detection result, not a kind, and is not listed. */
export const OutletKind = {
  direct: "direct",
  appStore: "app-store",
  testflight: "testflight",
  altstore: "altstore",
  altstorePal: "altstore-pal",
  play: "play",
  playTesting: "play-testing",
  obtainium: "obtainium",
  fdroidRepo: "fdroid-repo",
  msStore: "ms-store",
  appInstaller: "app-installer",
  steam: "steam",
  itch: "itch",
  flathub: "flathub",
  snap: "snap",
  winget: "winget",
  web: "web",
} as const;
export type OutletKind = (typeof OutletKind)[keyof typeof OutletKind];

/** Every `OutletKind` value, in source order. */
export const OUTLET_KIND_VALUES: readonly OutletKind[] = [
  "direct",
  "app-store",
  "testflight",
  "altstore",
  "altstore-pal",
  "play",
  "play-testing",
  "obtainium",
  "fdroid-repo",
  "ms-store",
  "app-installer",
  "steam",
  "itch",
  "flathub",
  "snap",
  "winget",
  "web",
];

/** How sure outlet detection is, strongest first (`OUTLET_CONFIDENCES`, plans/P3-01.md §2.9). */
export const OutletConfidence = {
  attested: "attested",
  declared: "declared",
  heuristic: "heuristic",
  stamp: "stamp",
} as const;
export type OutletConfidence =
  (typeof OutletConfidence)[keyof typeof OutletConfidence];

/** Every `OutletConfidence` value, in source order. */
export const OUTLET_CONFIDENCE_VALUES: readonly OutletConfidence[] = [
  "attested",
  "declared",
  "heuristic",
  "stamp",
];

/** How a `direct` install was put on the device, where that changes who updates it (`OUTLET_SUBKINDS`, plans/P3-01.md §2.9). */
export const OutletSubkind = {
  homebrew: "homebrew",
  npm: "npm",
  pnpm: "pnpm",
  npx: "npx",
  scoop: "scoop",
  chocolatey: "chocolatey",
  flatpak: "flatpak",
  appimage: "appimage",
} as const;
export type OutletSubkind = (typeof OutletSubkind)[keyof typeof OutletSubkind];

/** Every `OutletSubkind` value, in source order. */
export const OUTLET_SUBKIND_VALUES: readonly OutletSubkind[] = [
  "homebrew",
  "npm",
  "pnpm",
  "npx",
  "scoop",
  "chocolatey",
  "flatpak",
  "appimage",
];

/** The update decision's action (`UPDATE_ACTIONS`, plans/P3-01.md §2.8; `packs` added by plans/P4-13.md §2.6). */
export const UpdateAction = {
  none: "none",
  codeReady: "code-ready",
  binary: "binary",
  store: "store",
  platform: "platform",
  blocked: "blocked",
  packs: "packs",
} as const;
export type UpdateAction = (typeof UpdateAction)[keyof typeof UpdateAction];

/** Every `UpdateAction` value, in source order. */
export const UPDATE_ACTION_VALUES: readonly UpdateAction[] = [
  "none",
  "code-ready",
  "binary",
  "store",
  "platform",
  "blocked",
  "packs",
];

/** Why the update decision is `none` (`NONE_REASONS`, plans/P3-01.md §2.8). */
export const UpdateNoneReason = {
  upToDate: "up-to-date",
  behind: "behind",
  notAvailable: "not-available",
  halted: "halted",
  outOfBucket: "out-of-bucket",
  stale: "stale",
  skipped: "skipped",
  noMethod: "no-method",
  noBuild: "no-build",
  unknownVersion: "unknown-version",
} as const;
export type UpdateNoneReason =
  (typeof UpdateNoneReason)[keyof typeof UpdateNoneReason];

/** Every `UpdateNoneReason` value, in source order. */
export const UPDATE_NONE_REASON_VALUES: readonly UpdateNoneReason[] = [
  "up-to-date",
  "behind",
  "not-available",
  "halted",
  "out-of-bucket",
  "stale",
  "skipped",
  "no-method",
  "no-build",
  "unknown-version",
];

/** Why the update decision is `blocked` (`BLOCKED_REASONS`, plans/P3-01.md §2.8; `content-floor` and `revoked-content` added by plans/P4-13.md §2.6). */
export const UpdateBlockedReason = {
  appFloor: "app-floor",
  contentFloor: "content-floor",
  revokedContent: "revoked-content",
} as const;
export type UpdateBlockedReason =
  (typeof UpdateBlockedReason)[keyof typeof UpdateBlockedReason];

/** Every `UpdateBlockedReason` value, in source order. */
export const UPDATE_BLOCKED_REASON_VALUES: readonly UpdateBlockedReason[] = [
  "app-floor",
  "content-floor",
  "revoked-content",
];

/** How a `binary` decision installs the new build (`BINARY_METHODS`, plans/P3-01.md §2.8). */
export const BinaryMethod = {
  native: "native",
  download: "download",
  sidecarPck: "sidecar-pck",
} as const;
export type BinaryMethod = (typeof BinaryMethod)[keyof typeof BinaryMethod];

/** Every `BinaryMethod` value, in source order. */
export const BINARY_METHOD_VALUES: readonly BinaryMethod[] = [
  "native",
  "download",
  "sidecar-pck",
];

/** The update telemetry event names on the unsigned `devices/report` (plans/P3-01.md §2.10). The shapes and the Worker allowlist are P6-03's. */
export const UpdateEvent = {
  updateOffered: "update_offered",
  updateDownloaded: "update_downloaded",
  updateApplied: "update_applied",
  updateConfirmed: "update_confirmed",
  updateReverted: "update_reverted",
  packFailed: "pack_failed",
  bootRolledBack: "boot_rolled_back",
} as const;
export type UpdateEvent = (typeof UpdateEvent)[keyof typeof UpdateEvent];

/** Every `UpdateEvent` value, in source order. */
export const UPDATE_EVENT_VALUES: readonly UpdateEvent[] = [
  "update_offered",
  "update_downloaded",
  "update_applied",
  "update_confirmed",
  "update_reverted",
  "pack_failed",
  "boot_rolled_back",
];

/** The pack types a v1 SDK can hold (`PACK_TYPES`, plans/P4-01.md §2.2): `files.tree` everywhere, `godot.pck` in Godot. A record may name any `PACK_TYPE_PATTERN` type; an unknown one makes the pack unusable (`pack-type-unsupported`). */
export const PackType = {
  godotPck: "godot.pck",
  filesTree: "files.tree",
} as const;
export type PackType = (typeof PackType)[keyof typeof PackType];

/** Every `PackType` value, in source order. */
export const PACK_TYPE_VALUES: readonly PackType[] = [
  "godot.pck",
  "files.tree",
];

/** An app record's `content.expects[].delivery` (`PACK_DELIVERIES`, plans/P4-01.md §2.4). Any other `VOCAB_TOKEN_PATTERN` value is read as `on-demand`. */
export const PackDelivery = {
  essential: "essential",
  prefetch: "prefetch",
  onDemand: "on-demand",
} as const;
export type PackDelivery = (typeof PackDelivery)[keyof typeof PackDelivery];

/** Every `PackDelivery` value, in source order. */
export const PACK_DELIVERY_VALUES: readonly PackDelivery[] = [
  "essential",
  "prefetch",
  "on-demand",
];

/** A pack record's `handler.activation` (`PACK_ACTIVATIONS`, plans/P4-01.md §2.3). An unknown value makes the pack unusable. */
export const PackActivation = {
  restart: "restart",
  hot: "hot",
} as const;
export type PackActivation =
  (typeof PackActivation)[keyof typeof PackActivation];

/** Every `PackActivation` value, in source order. */
export const PACK_ACTIVATION_VALUES: readonly PackActivation[] = [
  "restart",
  "hot",
];

/** A pack variant's `files.layout` (`FILES_LAYOUTS`, plans/P4-01.md §2.3): a single-file payload with offsets and gaps, or a directory of files. An unknown layout makes the variant unusable. */
export const FilesLayout = {
  container: "container",
  tree: "tree",
} as const;
export type FilesLayout = (typeof FilesLayout)[keyof typeof FilesLayout];

/** Every `FilesLayout` value, in source order. */
export const FILES_LAYOUT_VALUES: readonly FilesLayout[] = [
  "container",
  "tree",
];

/** An object ref's `codec` (`CONTENT_CODECS`, plans/P4-01.md §2.3): one zstd frame with its content size, or stored raw (`bytes === size`). An unknown codec makes that object unusable. */
export const ContentCodec = {
  zstd: "zstd",
  none: "none",
} as const;
export type ContentCodec = (typeof ContentCodec)[keyof typeof ContentCodec];

/** Every `ContentCodec` value, in source order. */
export const CONTENT_CODEC_VALUES: readonly ContentCodec[] = ["zstd", "none"];

/** A pack delta's `method` v1 applies (`PATCH_METHODS`, plans/P4-01.md §2.3). `godot-delta-pck`, `hdiffpatch` and `bsdiff` are reserved and not listed; an unknown method makes the delta infeasible. */
export const PatchMethod = {
  zstdPatchFrom: "zstd-patch-from",
} as const;
export type PatchMethod = (typeof PatchMethod)[keyof typeof PatchMethod];

/** Every `PatchMethod` value, in source order. */
export const PATCH_METHOD_VALUES: readonly PatchMethod[] = ["zstd-patch-from"];

/** A pack delta's `scope` (`PATCH_SCOPES`, plans/P4-01.md §2.3): the whole payload, or the per-entry set. A delta of another scope is dropped. */
export const PatchScope = {
  payload: "payload",
  files: "files",
} as const;
export type PatchScope = (typeof PatchScope)[keyof typeof PatchScope];

/** Every `PatchScope` value, in source order. */
export const PATCH_SCOPE_VALUES: readonly PatchScope[] = ["payload", "files"];

/** The variant axis names a v1 manifest may declare (`VARIANT_AXES`, plans/P4-01.md §2.2). A record may name any `VARIANT_AXIS_PATTERN` axis; a variant on an axis the host has no preferences for is ineligible. */
export const VariantAxis = {
  texture: "texture",
  locale: "locale",
  quality: "quality",
} as const;
export type VariantAxis = (typeof VariantAxis)[keyof typeof VariantAxis];

/** Every `VariantAxis` value, in source order. */
export const VARIANT_AXIS_VALUES: readonly VariantAxis[] = [
  "texture",
  "locale",
  "quality",
];

/** The install planner's strategies (plans/P4-01.md §2.9, A7 §4.2): a plan result's `strategy` and a host's `caps.strategies`. `plan-matrix.json` pins them. */
export const PatchStrategy = {
  noop: "noop",
  platform: "platform",
  delta: "delta",
  chunk: "chunk",
  file: "file",
  full: "full",
} as const;
export type PatchStrategy = (typeof PatchStrategy)[keyof typeof PatchStrategy];

/** Every `PatchStrategy` value, in source order. */
export const PATCH_STRATEGY_VALUES: readonly PatchStrategy[] = [
  "noop",
  "platform",
  "delta",
  "chunk",
  "file",
  "full",
];

/** How a deliverable's bytes arrive (`TRANSPORTS` in `@polaris-key/manifest`, P2b-02; README §3.1): the planner's `caps.transports` and a platform target's `transport` (plans/P4-01.md §2.9). */
export const Transport = {
  embedded: "embedded",
  pkeyCdn: "pkey-cdn",
  appleBa: "apple-ba",
  playPad: "play-pad",
  steamDepot: "steam-depot",
  msixOptional: "msix-optional",
  flatpakExt: "flatpak-ext",
  web: "web",
} as const;
export type Transport = (typeof Transport)[keyof typeof Transport];

/** Every `Transport` value, in source order. */
export const TRANSPORT_VALUES: readonly Transport[] = [
  "embedded",
  "pkey-cdn",
  "apple-ba",
  "play-pad",
  "steam-depot",
  "msix-optional",
  "flatpak-ext",
  "web",
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
export const PROTOCOL_VERSION = 4;

/** `corpusVersion` of conformance/corpus/v2/cases.json. */
export const CORPUS_VERSION = 2;

/** `gateMatrixVersion` of conformance/corpus/v2/gate-matrix.json. */
export const GATE_MATRIX_VERSION = 2;

/** `fingerprintVersion` of conformance/corpus/v2/fingerprint.json. */
export const FINGERPRINT_VERSION = 1;

/** `stageMatrixVersion` of conformance/corpus/v2/stage-matrix.json. */
export const STAGE_MATRIX_VERSION = 3;

/** `updateMatrixVersion` of conformance/corpus/v2/update-matrix.json. */
export const UPDATE_MATRIX_VERSION = 1;

/** `outletMatrixVersion` of conformance/corpus/v2/outlet-matrix.json. */
export const OUTLET_MATRIX_VERSION = 1;

/** `planMatrixVersion` of conformance/corpus/v2/plan-matrix.json. */
export const PLAN_MATRIX_VERSION = 1;

/** `contentCorpusVersion` of conformance/corpus/v2/content/cases.json. */
export const CONTENT_CORPUS_VERSION = 1;

/** Wire contract v4 limit `MAX_WIRE_INTEGER` (`@polaris-key/protocol/core`). */
export const MAX_WIRE_INTEGER = 9007199254740991;

/** Wire contract v4 limit `MAX_JSON_DEPTH` (`@polaris-key/protocol/core`). */
export const MAX_JSON_DEPTH = 64;

/** Wire contract v4 limit `MAX_RECORD_JWS_BYTES` (`@polaris-key/protocol/core`). */
export const MAX_RECORD_JWS_BYTES = 88844;

/** Wire contract v4 limit `MAX_FEED_REVOCATIONS` (`@polaris-key/protocol/core`). */
export const MAX_FEED_REVOCATIONS = 64;

/** Wire contract v4 limit `REVOCATION_REASON_MAX_BYTES` (`@polaris-key/protocol/core`). */
export const REVOCATION_REASON_MAX_BYTES = 512;

/** Packs on the wire: `MAX_PACK_VARIANTS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const MAX_PACK_VARIANTS = 32;

/** Packs on the wire: `MAX_VARIANT_DELTAS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const MAX_VARIANT_DELTAS = 16;

/** Packs on the wire: `MAX_CONTENT_PINS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const MAX_CONTENT_PINS = 256;

/** Packs on the wire: `MAX_BUILD_EMBEDS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const MAX_BUILD_EMBEDS = 64;

/** Packs on the wire: `MAX_INDEX_FILES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const MAX_INDEX_FILES = 100000;

/** Packs on the wire: `MAX_FILES_INDEX_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const MAX_FILES_INDEX_BYTES = 33554432;

/** Packs on the wire: `MAX_PACK_PATH_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const MAX_PACK_PATH_BYTES = 1024;

/** Packs on the wire: `FILES_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const FILES_FORMAT = "pkey-files/1";

/** Packs on the wire: `PATCH_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const PATCH_FORMAT = "pkey-patch/1";

/** Packs on the wire: `MARKER_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const MARKER_FORMAT = "pkey-marker/1";

/** Packs on the wire: `CONTENT_STAMP_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const CONTENT_STAMP_FORMAT = "pkey-content/1";

/** Packs on the wire: `PLAN_REQUEST_WEIGHT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
export const PLAN_REQUEST_WEIGHT = 16384;

/** Packs on the wire: `CHUNKS_FORMAT` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`). */
export const CHUNKS_FORMAT = "pkey-chunks/1";

/** Packs on the wire: `MAX_CHUNK_INDEX_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`). */
export const MAX_CHUNK_INDEX_BYTES = 16777216;

/** Packs on the wire: `MAX_CHUNK_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`). */
export const MAX_CHUNK_BYTES = 4194304;

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

/** Header-value table `ARCH_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`). */
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

/** Header-value table `PLATFORM_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`). */
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

/** The parity-registry id of the SDK this module belongs to. */
export const CAPABILITY_SDK = "node";

/** The runtimes this SDK's manifest lists. */
export const CAPABILITY_RUNTIMES = ["node"] as const;

/** One declared N/A: on `runtime`, the feature is unsupported for `reason`. */
export interface CapabilityNa {
  readonly runtime: string;
  readonly reason: UnsupportedReason;
}

/** One feature's row in `CAPABILITIES`. */
export interface CapabilityRow {
  readonly status: "implemented" | "planned" | "na";
  readonly service: string;
  readonly na: readonly CapabilityNa[];
}

/** This SDK's capability table, generated from its parity manifest (tools/capabilities.ts): per feature, the manifest's status, the owning service and every declared (runtime, reason) N/A. `supports()` reads it (P1b-10, PARITY §2.2). */
export const CAPABILITIES: Readonly<Record<Feature, CapabilityRow>> = {
  "core.verify": { status: "implemented", service: "core", na: [] },
  "core.cache": { status: "implemented", service: "core", na: [] },
  "core.bundle": { status: "implemented", service: "core", na: [] },
  "core.discover": { status: "implemented", service: "core", na: [] },
  "core.sync": { status: "implemented", service: "core", na: [] },
  "core.local": { status: "implemented", service: "core", na: [] },
  "core.headers": { status: "implemented", service: "core", na: [] },
  "core.errors": { status: "implemented", service: "core", na: [] },
  "core.caps": { status: "implemented", service: "core", na: [] },
  "core.store": {
    status: "implemented",
    service: "core",
    na: [{ runtime: "node", reason: "dependency" }],
  },
  "license.gate": { status: "implemented", service: "license", na: [] },
  "license.activate": { status: "implemented", service: "license", na: [] },
  "license.enroll": { status: "implemented", service: "license", na: [] },
  "license.deactivate": { status: "implemented", service: "license", na: [] },
  "license.entitlements": { status: "implemented", service: "license", na: [] },
  "license.channels": { status: "implemented", service: "license", na: [] },
  "license.reregister": { status: "implemented", service: "license", na: [] },
  "config.resolve": { status: "implemented", service: "config", na: [] },
  "config.list": { status: "implemented", service: "config", na: [] },
  "config.secret": { status: "implemented", service: "config", na: [] },
  "config.schema": { status: "implemented", service: "config", na: [] },
  "config.mint": { status: "implemented", service: "config", na: [] },
  "config.mirror": { status: "implemented", service: "config", na: [] },
  "devices.fingerprint": { status: "implemented", service: "core", na: [] },
  "devices.facts": { status: "implemented", service: "core", na: [] },
  "devices.register": { status: "implemented", service: "core", na: [] },
  "devices.manage": { status: "implemented", service: "core", na: [] },
  "devices.report": { status: "implemented", service: "core", na: [] },
  "identity.oidc": { status: "planned", service: "identity", na: [] },
  "identity.devicecode": { status: "implemented", service: "identity", na: [] },
  "release.changelog": { status: "implemented", service: "release", na: [] },
  "release.download": { status: "implemented", service: "release", na: [] },
  "release.record": { status: "implemented", service: "release", na: [] },
  "update.check": { status: "implemented", service: "update", na: [] },
  "update.feed": { status: "implemented", service: "update", na: [] },
  "update.decide": { status: "implemented", service: "update", na: [] },
  "update.content": { status: "implemented", service: "update", na: [] },
  "update.driver": { status: "planned", service: "update", na: [] },
  "update.bootguard": { status: "planned", service: "update", na: [] },
  "outlet.detect": { status: "implemented", service: "update", na: [] },
  "packs.record": { status: "implemented", service: "release", na: [] },
  "packs.revoke": { status: "implemented", service: "release", na: [] },
  "packs.plan": { status: "implemented", service: "release", na: [] },
  "packs.index.files": { status: "implemented", service: "release", na: [] },
  "packs.index.chunks": { status: "planned", service: "release", na: [] },
  "packs.apply.full": { status: "implemented", service: "release", na: [] },
  "packs.apply.file": { status: "implemented", service: "release", na: [] },
  "packs.apply.chunk": { status: "planned", service: "release", na: [] },
  "packs.apply.delta": { status: "implemented", service: "release", na: [] },
  "packs.state": { status: "implemented", service: "release", na: [] },
  "packs.handlers": { status: "implemented", service: "release", na: [] },
  "packs.provides": { status: "planned", service: "release", na: [] },
  "packs.transport.apple": {
    status: "na",
    service: "distribution",
    na: [{ runtime: "node", reason: "runtime" }],
  },
  "packs.transport.play": {
    status: "na",
    service: "distribution",
    na: [{ runtime: "node", reason: "runtime" }],
  },
  "packs.transport.steam": {
    status: "planned",
    service: "distribution",
    na: [],
  },
  "packs.transport.msix": {
    status: "planned",
    service: "distribution",
    na: [],
  },
  "packs.transport.flatpak": {
    status: "planned",
    service: "distribution",
    na: [],
  },
  "ui.stages": { status: "implemented", service: "sdk", na: [] },
  "ui.kit": {
    status: "na",
    service: "sdk",
    na: [{ runtime: "node", reason: "runtime" }],
  },
  "commerce.receipt": { status: "planned", service: "license", na: [] },
};

/** SHA-256 of the canonical table; `pnpm parity:check` recomputes it from the manifest. */
export const CAPABILITY_DIGEST =
  "24cc02fb206c89c4f1c22c9681eba68fe26371a45dceebca640fb411b0bc40b6";
