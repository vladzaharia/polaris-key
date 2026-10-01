// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen:constants` (tools/gen-sdk-constants.ts) from conformance/parity/
// errors.json, enums.json and features.json, tools/services.json, @polaris-key/protocol/core
// and the conformance corpus. `pnpm gen:constants -- --check` fails the green gate on any
// difference. To change a constant, edit its source and regenerate.

// `ServiceSlug` is not here: ServiceSlug.generated.swift (pnpm gen:services) declares it.
// `StoreBackend` and `StoreDegradedReason` are not here: Store.swift declares them as
// `String`-backed enums.

/// Every error code the Worker answers with or an SDK raises (conformance/parity/errors.json). Hosts match on these strings.
public enum ErrorCode {
    public static let unauthorized = "unauthorized"
    public static let notFound = "not_found"
    public static let badRequest = "bad_request"
    public static let forbidden = "forbidden"
    public static let rateLimited = "rate_limited"
    public static let bodyTooLarge = "body_too_large"
    public static let methodNotAllowed = "method_not_allowed"
    public static let misconfigured = "misconfigured"
    public static let registrationClosed = "registration_closed"
    public static let deviceLimit = "device_limit"
    public static let licenseDisabled = "license_disabled"
    public static let licenseExpired = "license_expired"
    public static let notEntitled = "not_entitled"
    public static let versionBlocked = "version_blocked"
    public static let channelNotAllowed = "channel_not_allowed"
    public static let hardwareMismatch = "hardware_mismatch"
    public static let fingerprintRequired = "fingerprint_required"
    public static let enrollDisabled = "enroll_disabled"
    public static let enrollClaimed = "enroll_claimed"
    public static let enrollFailed = "enroll_failed"
    public static let managedByAdmin = "managed_by_admin"
    public static let catalogUnavailable = "catalog_unavailable"
    public static let disabled = "disabled"
    public static let oidcError = "oidc_error"
    public static let unavailable = "unavailable"
    public static let authMethodDisabled = "auth_method_disabled"
    public static let emailNotConfigured = "email_not_configured"
    public static let downloadAuthRequired = "download_auth_required"
    public static let upstreamRateLimited = "upstream_rate_limited"
    public static let serverMisconfigured = "server_misconfigured"
    public static let internalError = "internal_error"
    public static let releaseRecordRejected = "release_record_rejected"
    public static let feedNotComposable = "feed_not_composable"
    public static let serviceUnavailable = "service-unavailable"
    public static let serviceDisabled = "service-disabled"
    public static let localOnly = "local-only"
    public static let insecureBaseUrl = "insecure-base-url"
    public static let bundleJwsRejected = "bundle-jws-rejected"
    public static let bundleClaimsRejected = "bundle-claims-rejected"
    public static let bundleTrustRejected = "bundle-trust-rejected"
    public static let innerDocRejected = "inner-doc-rejected"
    public static let bundle = "bundle"
    public static let transport = "transport"
    public static let network = "network"
    public static let refreshFailed = "refresh-failed"
    public static let syncFailed = "sync-failed"
    public static let fetchFailed = "fetch-failed"
    public static let bridgeMissing = "bridge-missing"
    public static let unknown = "unknown"
    public static let releaseRefused = "release-refused"
    public static let bundleRejected = "bundle-rejected"
    public static let bundleImportUnsupported = "bundle-import-unsupported"
    public static let reportUnsupported = "report-unsupported"
    public static let deviceManagementUnsupported = "device-management-unsupported"
    public static let deviceListFailed = "device_list_failed"
    public static let deviceRenameFailed = "device_rename_failed"
    public static let deviceDeauthorizeFailed = "device_deauthorize_failed"
    public static let keyEntryUnsupported = "key-entry-unsupported"
    public static let signInFailed = "sign-in-failed"
    public static let signOutFailed = "sign-out-failed"
    public static let badResponse = "bad_response"
    public static let networkError = "network-error"
    public static let serverError = "server-error"
    public static let cancelled = "cancelled"
    public static let signInUnavailable = "sign-in-unavailable"
    public static let invalidOptions = "invalid-options"
    public static let notConfigured = "not-configured"
    public static let unsupported = "unsupported"
    public static let timeout = "timeout"
    public static let responseTooLarge = "response-too-large"
    public static let tooManyRedirects = "too-many-redirects"
    public static let insecureRedirect = "insecure-redirect"
    public static let httpError = "http-error"
    public static let invalidResponse = "invalid-response"
    public static let storeFailed = "store-failed"
    public static let noToken = "no-token"
    public static let mintUnavailable = "mint-unavailable"
    public static let feedRejected = "feed-rejected"
    public static let feedRollback = "feed-rollback"
    public static let recordRejected = "record-rejected"
    public static let recordMismatch = "record-mismatch"
}

/// Every `ErrorCode` value, in source order.
public let ERROR_CODE_VALUES: [String] = [
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
    "release_record_rejected",
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
]

/// The registry: every error code and its kind (`wire` or `client`).
public let ERROR_CODE_KINDS: [String: String] = [
    "unauthorized": "wire",
    "not_found": "wire",
    "bad_request": "wire",
    "forbidden": "wire",
    "rate_limited": "wire",
    "body_too_large": "wire",
    "method_not_allowed": "wire",
    "misconfigured": "wire",
    "registration_closed": "wire",
    "device_limit": "wire",
    "license_disabled": "wire",
    "license_expired": "wire",
    "not_entitled": "wire",
    "version_blocked": "wire",
    "channel_not_allowed": "wire",
    "hardware_mismatch": "wire",
    "fingerprint_required": "wire",
    "enroll_disabled": "wire",
    "enroll_claimed": "wire",
    "enroll_failed": "wire",
    "managed_by_admin": "wire",
    "catalog_unavailable": "wire",
    "disabled": "wire",
    "oidc_error": "wire",
    "unavailable": "wire",
    "auth_method_disabled": "wire",
    "email_not_configured": "wire",
    "download_auth_required": "wire",
    "upstream_rate_limited": "wire",
    "server_misconfigured": "wire",
    "internal_error": "wire",
    "release_record_rejected": "wire",
    "feed_not_composable": "wire",
    "service-unavailable": "client",
    "service-disabled": "client",
    "local-only": "client",
    "insecure-base-url": "client",
    "bundle-jws-rejected": "client",
    "bundle-claims-rejected": "client",
    "bundle-trust-rejected": "client",
    "inner-doc-rejected": "client",
    "bundle": "client",
    "transport": "client",
    "network": "client",
    "refresh-failed": "client",
    "sync-failed": "client",
    "fetch-failed": "client",
    "bridge-missing": "client",
    "unknown": "client",
    "release-refused": "client",
    "bundle-rejected": "client",
    "bundle-import-unsupported": "client",
    "report-unsupported": "client",
    "device-management-unsupported": "client",
    "device_list_failed": "client",
    "device_rename_failed": "client",
    "device_deauthorize_failed": "client",
    "key-entry-unsupported": "client",
    "sign-in-failed": "client",
    "sign-out-failed": "client",
    "bad_response": "client",
    "network-error": "client",
    "server-error": "client",
    "cancelled": "client",
    "sign-in-unavailable": "client",
    "invalid-options": "client",
    "not-configured": "client",
    "unsupported": "client",
    "timeout": "client",
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
]

/// Every feature id in the parity registry (conformance/parity/features.json).
public enum Feature {
    public static let coreVerify = "core.verify"
    public static let coreCache = "core.cache"
    public static let coreBundle = "core.bundle"
    public static let coreDiscover = "core.discover"
    public static let coreSync = "core.sync"
    public static let coreLocal = "core.local"
    public static let coreHeaders = "core.headers"
    public static let coreErrors = "core.errors"
    public static let coreCaps = "core.caps"
    public static let coreStore = "core.store"
    public static let licenseGate = "license.gate"
    public static let licenseActivate = "license.activate"
    public static let licenseEnroll = "license.enroll"
    public static let licenseDeactivate = "license.deactivate"
    public static let licenseEntitlements = "license.entitlements"
    public static let licenseChannels = "license.channels"
    public static let licenseReregister = "license.reregister"
    public static let configResolve = "config.resolve"
    public static let configList = "config.list"
    public static let configSecret = "config.secret"
    public static let configSchema = "config.schema"
    public static let configMint = "config.mint"
    public static let configMirror = "config.mirror"
    public static let devicesFingerprint = "devices.fingerprint"
    public static let devicesFacts = "devices.facts"
    public static let devicesRegister = "devices.register"
    public static let devicesManage = "devices.manage"
    public static let devicesReport = "devices.report"
    public static let identityOidc = "identity.oidc"
    public static let identityDevicecode = "identity.devicecode"
    public static let releaseChangelog = "release.changelog"
    public static let releaseDownload = "release.download"
    public static let releaseRecord = "release.record"
    public static let updateCheck = "update.check"
    public static let updateFeed = "update.feed"
    public static let updateDecide = "update.decide"
    public static let updateDriver = "update.driver"
    public static let updateBootguard = "update.bootguard"
    public static let outletDetect = "outlet.detect"
    public static let packsPlan = "packs.plan"
    public static let packsIndex = "packs.index"
    public static let packsApplyFull = "packs.apply.full"
    public static let packsApplyFile = "packs.apply.file"
    public static let packsApplyChunk = "packs.apply.chunk"
    public static let packsApplyDelta = "packs.apply.delta"
    public static let packsState = "packs.state"
    public static let packsHandlers = "packs.handlers"
    public static let packsProvides = "packs.provides"
    public static let packsTransportApple = "packs.transport.apple"
    public static let packsTransportPlay = "packs.transport.play"
    public static let packsTransportSteam = "packs.transport.steam"
    public static let packsTransportMsix = "packs.transport.msix"
    public static let packsTransportFlatpak = "packs.transport.flatpak"
    public static let uiStages = "ui.stages"
    public static let uiKit = "ui.kit"
    public static let commerceReceipt = "commerce.receipt"
}

/// Every `Feature` value, in source order.
public let FEATURE_VALUES: [String] = [
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
]

/// Why a feature is unsupported here: the `supports()` reason enum (PARITY §2.2).
public enum UnsupportedReason {
    public static let runtime = "runtime"
    public static let outlet = "outlet"
    public static let product = "product"
    public static let dependency = "dependency"
    public static let version = "version"
}

/// Every `UnsupportedReason` value, in source order.
public let UNSUPPORTED_REASON_VALUES: [String] = [
    "runtime",
    "outlet",
    "product",
    "dependency",
    "version",
]

/// OS family, the canonical `X-PKey-Platform` value (README §3.1). iPadOS is `ios`.
public enum Platform {
    public static let macos = "macos"
    public static let ios = "ios"
    public static let android = "android"
    public static let windows = "windows"
    public static let linux = "linux"
    public static let web = "web"
}

/// Every `Platform` value, in source order.
public let PLATFORM_VALUES: [String] = [
    "macos",
    "ios",
    "android",
    "windows",
    "linux",
    "web",
]

/// CPU architecture, the canonical `X-PKey-Arch` value (README §3.1). `universal` and `any` are artifact values, not header values, and are not listed.
public enum Arch {
    public static let arm64 = "arm64"
    public static let x86_64 = "x86_64"
    public static let armv7 = "armv7"
    public static let wasm32 = "wasm32"
}

/// Every `Arch` value, in source order.
public let ARCH_VALUES: [String] = [
    "arm64",
    "x86_64",
    "armv7",
    "wasm32",
]

/// The canonical X-PKey-SDK value (WIRE-CONTRACT-V3 §5.2): which SDK made the request. The SDK's version is X-PKey-SDK-Version. An SDK adds its id when it lands.
public enum SdkId {
    public static let node = "node"
    public static let react = "react"
    public static let python = "python"
    public static let swift = "swift"
    public static let godot = "godot"
}

/// Every `SdkId` value, in source order.
public let SDK_ID_VALUES: [String] = [
    "node",
    "react",
    "python",
    "swift",
    "godot",
]

/// The 17 outlet kinds, in `OUTLET_KINDS` order (README §3.1, plans/P3-01.md §2.9). `unknown` is a detection result, not a kind, and is not listed.
public enum OutletKind {
    public static let direct = "direct"
    public static let appStore = "app-store"
    public static let testflight = "testflight"
    public static let altstore = "altstore"
    public static let altstorePal = "altstore-pal"
    public static let play = "play"
    public static let playTesting = "play-testing"
    public static let obtainium = "obtainium"
    public static let fdroidRepo = "fdroid-repo"
    public static let msStore = "ms-store"
    public static let appInstaller = "app-installer"
    public static let steam = "steam"
    public static let itch = "itch"
    public static let flathub = "flathub"
    public static let snap = "snap"
    public static let winget = "winget"
    public static let web = "web"
}

/// Every `OutletKind` value, in source order.
public let OUTLET_KIND_VALUES: [String] = [
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
]

/// How sure outlet detection is, strongest first (`OUTLET_CONFIDENCES`, plans/P3-01.md §2.9).
public enum OutletConfidence {
    public static let attested = "attested"
    public static let declared = "declared"
    public static let heuristic = "heuristic"
    public static let stamp = "stamp"
}

/// Every `OutletConfidence` value, in source order.
public let OUTLET_CONFIDENCE_VALUES: [String] = [
    "attested",
    "declared",
    "heuristic",
    "stamp",
]

/// How a `direct` install was put on the device, where that changes who updates it (`OUTLET_SUBKINDS`, plans/P3-01.md §2.9).
public enum OutletSubkind {
    public static let homebrew = "homebrew"
    public static let npm = "npm"
    public static let pnpm = "pnpm"
    public static let npx = "npx"
    public static let scoop = "scoop"
    public static let chocolatey = "chocolatey"
    public static let flatpak = "flatpak"
    public static let appimage = "appimage"
}

/// Every `OutletSubkind` value, in source order.
public let OUTLET_SUBKIND_VALUES: [String] = [
    "homebrew",
    "npm",
    "pnpm",
    "npx",
    "scoop",
    "chocolatey",
    "flatpak",
    "appimage",
]

/// The update decision's action (`UPDATE_ACTIONS`, plans/P3-01.md §2.8). `packs` is reserved for P4-01 and not listed.
public enum UpdateAction {
    public static let none = "none"
    public static let codeReady = "code-ready"
    public static let binary = "binary"
    public static let store = "store"
    public static let platform = "platform"
    public static let blocked = "blocked"
}

/// Every `UpdateAction` value, in source order.
public let UPDATE_ACTION_VALUES: [String] = [
    "none",
    "code-ready",
    "binary",
    "store",
    "platform",
    "blocked",
]

/// Why the update decision is `none` (`NONE_REASONS`, plans/P3-01.md §2.8).
public enum UpdateNoneReason {
    public static let upToDate = "up-to-date"
    public static let behind = "behind"
    public static let notAvailable = "not-available"
    public static let halted = "halted"
    public static let outOfBucket = "out-of-bucket"
    public static let stale = "stale"
    public static let skipped = "skipped"
    public static let noMethod = "no-method"
    public static let noBuild = "no-build"
    public static let unknownVersion = "unknown-version"
}

/// Every `UpdateNoneReason` value, in source order.
public let UPDATE_NONE_REASON_VALUES: [String] = [
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
]

/// Why the update decision is `blocked` (`BLOCKED_REASONS`, plans/P3-01.md §2.8). `content-floor` and `revoked-content` are reserved for P4-13 and not listed.
public enum UpdateBlockedReason {
    public static let appFloor = "app-floor"
}

/// Every `UpdateBlockedReason` value, in source order.
public let UPDATE_BLOCKED_REASON_VALUES: [String] = [
    "app-floor",
]

/// How a `binary` decision installs the new build (`BINARY_METHODS`, plans/P3-01.md §2.8).
public enum BinaryMethod {
    public static let native = "native"
    public static let download = "download"
    public static let sidecarPck = "sidecar-pck"
}

/// Every `BinaryMethod` value, in source order.
public let BINARY_METHOD_VALUES: [String] = [
    "native",
    "download",
    "sidecar-pck",
]

/// The update telemetry event names on the unsigned `devices/report` (plans/P3-01.md §2.10). The shapes and the Worker allowlist are P6-03's.
public enum UpdateEvent {
    public static let updateOffered = "update_offered"
    public static let updateDownloaded = "update_downloaded"
    public static let updateApplied = "update_applied"
    public static let updateConfirmed = "update_confirmed"
    public static let updateReverted = "update_reverted"
    public static let packFailed = "pack_failed"
    public static let bootRolledBack = "boot_rolled_back"
}

/// Every `UpdateEvent` value, in source order.
public let UPDATE_EVENT_VALUES: [String] = [
    "update_offered",
    "update_downloaded",
    "update_applied",
    "update_confirmed",
    "update_reverted",
    "pack_failed",
    "boot_rolled_back",
]

/// The `X-PKey-*` request header names (wire contract v3 §5).
public enum HeaderName {
    public static let arch = "X-PKey-Arch"
    public static let channel = "X-PKey-Channel"
    public static let device = "X-PKey-Device"
    public static let platform = "X-PKey-Platform"
    public static let sdkName = "X-PKey-SDK"
    public static let sdkVersion = "X-PKey-SDK-Version"
    public static let version = "X-PKey-Version"
}

/// Every `HeaderName` value, in source order.
public let HEADER_NAME_VALUES: [String] = [
    "X-PKey-Arch",
    "X-PKey-Channel",
    "X-PKey-Device",
    "X-PKey-Platform",
    "X-PKey-SDK",
    "X-PKey-SDK-Version",
    "X-PKey-Version",
]

/// The wire contract version (`@polaris-key/protocol/core`).
public let PROTOCOL_VERSION = 4

/// `corpusVersion` of conformance/corpus/v2/cases.json.
public let CORPUS_VERSION = 2

/// `gateMatrixVersion` of conformance/corpus/v2/gate-matrix.json.
public let GATE_MATRIX_VERSION = 2

/// `fingerprintVersion` of conformance/corpus/v2/fingerprint.json.
public let FINGERPRINT_VERSION = 1

/// `stageMatrixVersion` of conformance/corpus/v2/stage-matrix.json.
public let STAGE_MATRIX_VERSION = 2

/// `updateMatrixVersion` of conformance/corpus/v2/update-matrix.json.
public let UPDATE_MATRIX_VERSION = 1

/// `outletMatrixVersion` of conformance/corpus/v2/outlet-matrix.json.
public let OUTLET_MATRIX_VERSION = 1

/// Wire contract v4 limit `MAX_WIRE_INTEGER` (`@polaris-key/protocol/core`).
public let MAX_WIRE_INTEGER = 9007199254740991

/// Wire contract v4 limit `MAX_JSON_DEPTH` (`@polaris-key/protocol/core`).
public let MAX_JSON_DEPTH = 64

/// Wire contract v4 limit `MAX_RECORD_JWS_BYTES` (`@polaris-key/protocol/core`).
public let MAX_RECORD_JWS_BYTES = 88844

/// Channel constant `CHANNEL_ALIASES` (`@polaris-key/protocol/core`).
public let CHANNEL_ALIASES: [String: String] = [
    "staging": "beta",
    "latest": "stable",
]

/// Channel constant `CHANNEL_BETA` (`@polaris-key/protocol/core`).
public let CHANNEL_BETA = "beta"

/// Channel constant `CHANNEL_DEV` (`@polaris-key/protocol/core`).
public let CHANNEL_DEV = "dev"

/// Channel constant `CHANNEL_NAME_PATTERN` (`@polaris-key/protocol/core`).
public let CHANNEL_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$"

/// Channel constant `CHANNEL_PR` (`@polaris-key/protocol/core`).
public let CHANNEL_PR = "pr"

/// Channel constant `CHANNEL_STABLE` (`@polaris-key/protocol/core`).
public let CHANNEL_STABLE = "stable"

/// Channel constant `PR_CHANNEL_PATTERN` (`@polaris-key/protocol/core`).
public let PR_CHANNEL_PATTERN = "^pr-?([0-9]+)$"

/// Channel constant `PR_NUMBER_MAX_DIGITS` (`@polaris-key/protocol/core`).
public let PR_NUMBER_MAX_DIGITS = 7

/// Header-value table `ARCH_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`).
public let ARCH_SPELLINGS: [String: String] = [
    "arm64": "arm64",
    "aarch64": "arm64",
    "arm64-v8a": "arm64",
    "x86_64": "x86_64",
    "x64": "x86_64",
    "amd64": "x86_64",
    "armv7": "armv7",
    "armv7l": "armv7",
    "armv8l": "armv7",
    "arm": "armv7",
    "arm32": "armv7",
    "armeabi-v7a": "armv7",
    "wasm32": "wasm32",
]

/// Header-value table `PLATFORM_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`).
public let PLATFORM_SPELLINGS: [String: String] = [
    "macos": "macos",
    "darwin": "macos",
    "maccatalyst": "macos",
    "ios": "ios",
    "ipados": "ios",
    "android": "android",
    "windows": "windows",
    "win32": "windows",
    "linux": "linux",
    "web": "web",
    "browser": "web",
]
