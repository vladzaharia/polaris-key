// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen constants` (tools/gen-sdk-constants.ts) from conformance/parity/
// errors.json, enums.json and features.json, tools/services.json, @polaris-key/protocol/core
// and the conformance corpus. `pnpm gen constants --check` fails the green gate on any
// difference. To change a constant, edit its source and regenerate.

// `ServiceSlug` is not here: ServiceSlug.generated.swift (pnpm gen services) declares it.
// `StoreBackend` and `StoreDegradedReason` are not here: Store.swift declares them as
// `String`-backed enums.

/// Every error code the Worker answers with or an SDK raises (conformance/parity/errors.json). Hosts match on these strings.
public enum ErrorCode {
    public static let unauthorized = "unauthorized"
    public static let notFound = "not_found"
    public static let badRequest = "bad_request"
    public static let forbidden = "forbidden"
    public static let attestationRequired = "attestation_required"
    public static let attestationRejected = "attestation_rejected"
    public static let attestationUnavailable = "attestation_unavailable"
    public static let rateLimited = "rate_limited"
    public static let bodyTooLarge = "body_too_large"
    public static let methodNotAllowed = "method_not_allowed"
    public static let misconfigured = "misconfigured"
    public static let registrationClosed = "registration_closed"
    public static let valueNotRepresentable = "value_not_representable"
    public static let documentNotRepresentable = "document_not_representable"
    public static let deviceLimit = "device_limit"
    public static let keyEntryLimit = "key_entry_limit"
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
    public static let licenseUnusable = "license_unusable"
    public static let disabled = "disabled"
    public static let oidcError = "oidc_error"
    public static let unavailable = "unavailable"
    public static let identityDisabled = "identity_disabled"
    public static let authMethodDisabled = "auth_method_disabled"
    public static let emailUnavailable = "email_unavailable"
    public static let turnstileFailed = "turnstile_failed"
    public static let signinExpired = "signin_expired"
    public static let invalidCode = "invalid_code"
    public static let emailInUse = "email_in_use"
    public static let termsRequired = "terms_required"
    public static let licenseOwned = "license_owned"
    public static let licenseEmailBound = "license_email_bound"
    public static let accountRequired = "account_required"
    public static let emailMismatch = "email_mismatch"
    public static let linkConflict = "link_conflict"
    public static let lastLink = "last_link"
    public static let stepUpRequired = "step_up_required"
    public static let notEligible = "not_eligible"
    public static let notRemovable = "not_removable"
    public static let downloadAuthRequired = "download_auth_required"
    public static let deliveryGateMissing = "delivery_gate_missing"
    public static let upstreamRateLimited = "upstream_rate_limited"
    public static let serverMisconfigured = "server_misconfigured"
    public static let internalError = "internal_error"
    public static let releaseRecordRejected = "release_record_rejected"
    public static let releaseTagIsPackRelease = "release_tag_is_pack_release"
    public static let assetUnreachable = "asset_unreachable"
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
    public static let signInExpired = "sign-in-expired"
    public static let signInDenied = "sign-in-denied"
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
    public static let platformError = "platform-error"
    public static let noToken = "no-token"
    public static let mintUnavailable = "mint-unavailable"
    public static let feedRejected = "feed-rejected"
    public static let feedRollback = "feed-rollback"
    public static let recordRejected = "record-rejected"
    public static let recordMismatch = "record-mismatch"
    public static let payloadMismatch = "payload-mismatch"
    public static let swapRefused = "swap-refused"
    public static let swapFailed = "swap-failed"
    public static let filesIndexInvalid = "files-index-invalid"
    public static let filesUnsafePath = "files-unsafe-path"
    public static let filesDuplicatePath = "files-duplicate-path"
    public static let filesCaseCollision = "files-case-collision"
    public static let filesPathConflict = "files-path-conflict"
    public static let filesLayoutMismatch = "files-layout-mismatch"
    public static let contentStampInvalid = "content-stamp-invalid"
    public static let fullCorrupt = "full-corrupt"
    public static let deltaArtifactMismatch = "delta-artifact-mismatch"
    public static let deltaBaseMismatch = "delta-base-mismatch"
    public static let deltaApplyFailed = "delta-apply-failed"
    public static let fileCorrupt = "file-corrupt"
    public static let fileSourceMissing = "file-source-missing"
    public static let payloadHashMismatch = "payload-hash-mismatch"
    public static let chunksRefMismatch = "chunks-ref-mismatch"
    public static let chunksBadLength = "chunks-bad-length"
    public static let chunksBadMagic = "chunks-bad-magic"
    public static let chunksUnsupportedVersion = "chunks-unsupported-version"
    public static let chunksBadRecordSize = "chunks-bad-record-size"
    public static let chunksBadFlags = "chunks-bad-flags"
    public static let chunksReservedNonzero = "chunks-reserved-nonzero"
    public static let chunksZeroLength = "chunks-zero-length"
    public static let chunksBadClen = "chunks-bad-clen"
    public static let chunksBadBundleRef = "chunks-bad-bundle-ref"
    public static let chunksBadBundleRange = "chunks-bad-bundle-range"
    public static let chunksSizeMismatch = "chunks-size-mismatch"
    public static let chunksPayloadMismatch = "chunks-payload-mismatch"
    public static let chunkBundleTruncated = "chunk-bundle-truncated"
    public static let chunkCorrupt = "chunk-corrupt"
    public static let planTransportUnsupported = "plan-transport-unsupported"
    public static let planInsufficientDisk = "plan-insufficient-disk"
    public static let planNoStrategy = "plan-no-strategy"
    public static let packNoVariant = "pack-no-variant"
    public static let packTypeUnsupported = "pack-type-unsupported"
    public static let packTypeCheckFailed = "pack-type-check-failed"
    public static let packNotPinned = "pack-not-pinned"
    public static let packNotEntitled = "pack-not-entitled"
    public static let packStateUnreadable = "pack-state-unreadable"
    public static let pckDirectoryRefused = "pck-directory-refused"
    public static let pckEngineMismatch = "pck-engine-mismatch"
    public static let packRolledBack = "pack-rolled-back"
    public static let packRevoked = "pack-revoked"
    public static let packNotDataOnly = "pack-not-data-only"
    public static let markerRejected = "marker-rejected"
    public static let licenseRequired = "license_required"
    public static let licenseInvalid = "license_invalid"
    public static let licenseStale = "license_stale"
    public static let signInRequired = "sign_in_required"
}

/// Every `ErrorCode` value, in source order.
public let ERROR_CODE_VALUES: [String] = [
    "unauthorized",
    "not_found",
    "bad_request",
    "forbidden",
    "attestation_required",
    "attestation_rejected",
    "attestation_unavailable",
    "rate_limited",
    "body_too_large",
    "method_not_allowed",
    "misconfigured",
    "registration_closed",
    "value_not_representable",
    "document_not_representable",
    "device_limit",
    "key_entry_limit",
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
    "license_unusable",
    "disabled",
    "oidc_error",
    "unavailable",
    "identity_disabled",
    "auth_method_disabled",
    "email_unavailable",
    "turnstile_failed",
    "signin_expired",
    "invalid_code",
    "email_in_use",
    "terms_required",
    "license_owned",
    "license_email_bound",
    "account_required",
    "email_mismatch",
    "link_conflict",
    "last_link",
    "step_up_required",
    "not_eligible",
    "not_removable",
    "download_auth_required",
    "delivery_gate_missing",
    "upstream_rate_limited",
    "server_misconfigured",
    "internal_error",
    "release_record_rejected",
    "release_tag_is_pack_release",
    "asset_unreachable",
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
    "platform-error",
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
    "pack-type-check-failed",
    "pack-not-pinned",
    "pack-not-entitled",
    "pack-state-unreadable",
    "pck-directory-refused",
    "pck-engine-mismatch",
    "pack-rolled-back",
    "pack-revoked",
    "pack-not-data-only",
    "marker-rejected",
    "license_required",
    "license_invalid",
    "license_stale",
    "sign_in_required",
]

/// The registry: every error code and its kind (`wire` or `client`).
public let ERROR_CODE_KINDS: [String: String] = [
    "unauthorized": "wire",
    "not_found": "wire",
    "bad_request": "wire",
    "forbidden": "wire",
    "attestation_required": "wire",
    "attestation_rejected": "wire",
    "attestation_unavailable": "wire",
    "rate_limited": "wire",
    "body_too_large": "wire",
    "method_not_allowed": "wire",
    "misconfigured": "wire",
    "registration_closed": "wire",
    "value_not_representable": "wire",
    "document_not_representable": "wire",
    "device_limit": "wire",
    "key_entry_limit": "wire",
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
    "license_unusable": "wire",
    "disabled": "wire",
    "oidc_error": "wire",
    "unavailable": "wire",
    "identity_disabled": "wire",
    "auth_method_disabled": "wire",
    "email_unavailable": "wire",
    "turnstile_failed": "wire",
    "signin_expired": "wire",
    "invalid_code": "wire",
    "email_in_use": "wire",
    "terms_required": "wire",
    "license_owned": "wire",
    "license_email_bound": "wire",
    "account_required": "wire",
    "email_mismatch": "wire",
    "link_conflict": "wire",
    "last_link": "wire",
    "step_up_required": "wire",
    "not_eligible": "wire",
    "not_removable": "wire",
    "download_auth_required": "wire",
    "delivery_gate_missing": "wire",
    "upstream_rate_limited": "wire",
    "server_misconfigured": "wire",
    "internal_error": "wire",
    "release_record_rejected": "wire",
    "release_tag_is_pack_release": "wire",
    "asset_unreachable": "wire",
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
    "sign-in-expired": "client",
    "sign-in-denied": "client",
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
    "platform-error": "client",
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
    "pack-type-check-failed": "client",
    "pack-not-pinned": "client",
    "pack-not-entitled": "client",
    "pack-state-unreadable": "client",
    "pck-directory-refused": "client",
    "pck-engine-mismatch": "client",
    "pack-rolled-back": "client",
    "pack-revoked": "client",
    "pack-not-data-only": "client",
    "marker-rejected": "client",
    "license_required": "backend",
    "license_invalid": "backend",
    "license_stale": "backend",
    "sign_in_required": "backend",
]

/// Every feature id in the parity registry (conformance/parity/features.json).
public enum Feature {
    public static let coreVerify = "core.verify"
    public static let coreCache = "core.cache"
    public static let coreBundle = "core.bundle"
    public static let coreDiscover = "core.discover"
    public static let corePresentation = "core.presentation"
    public static let coreSync = "core.sync"
    public static let coreLocal = "core.local"
    public static let coreHeaders = "core.headers"
    public static let coreErrors = "core.errors"
    public static let coreCaps = "core.caps"
    public static let coreStore = "core.store"
    public static let coreCopy = "core.copy"
    public static let coreBackend = "core.backend"
    public static let licenseGate = "license.gate"
    public static let licenseActivate = "license.activate"
    public static let licenseEnroll = "license.enroll"
    public static let licenseDeactivate = "license.deactivate"
    public static let licenseManage = "license.manage"
    public static let licenseEntitlements = "license.entitlements"
    public static let licenseChannels = "license.channels"
    public static let licenseReregister = "license.reregister"
    public static let licenseRefusals = "license.refusals"
    public static let configResolve = "config.resolve"
    public static let configList = "config.list"
    public static let configSecret = "config.secret"
    public static let configSchema = "config.schema"
    public static let configMint = "config.mint"
    public static let configMirror = "config.mirror"
    public static let configLocal = "config.local"
    public static let configSync = "config.sync"
    public static let syncScenarios = "sync.scenarios"
    public static let syncSettings = "sync.settings"
    public static let syncConflict = "sync.conflict"
    public static let syncSaves = "sync.saves"
    public static let devicesFingerprint = "devices.fingerprint"
    public static let devicesFacts = "devices.facts"
    public static let devicesRegister = "devices.register"
    public static let devicesManage = "devices.manage"
    public static let devicesReport = "devices.report"
    public static let telemetryUpdates = "telemetry.updates"
    public static let devicesAttest = "devices.attest"
    public static let identityOidc = "identity.oidc"
    public static let identityDevicecode = "identity.devicecode"
    public static let identityDevicelabel = "identity.devicelabel"
    public static let identityToggle = "identity.toggle"
    public static let identityKeyentry = "identity.keyentry"
    public static let identityAttach = "identity.attach"
    public static let identityAccount = "identity.account"
    public static let releaseChangelog = "release.changelog"
    public static let releaseDownload = "release.download"
    public static let releaseRecord = "release.record"
    public static let releaseFetch = "release.fetch"
    public static let releaseDistribution = "release.distribution"
    public static let updateCheck = "update.check"
    public static let updateFeed = "update.feed"
    public static let updateFeeds = "update.feeds"
    public static let updateDecide = "update.decide"
    public static let updateContent = "update.content"
    public static let updateDriver = "update.driver"
    public static let updateBootguard = "update.bootguard"
    public static let outletDetect = "outlet.detect"
    public static let crashTags = "crash.tags"
    public static let packsRecord = "packs.record"
    public static let packsRevoke = "packs.revoke"
    public static let packsDelegation = "packs.delegation"
    public static let packsDeltaFeed = "packs.delta.feed"
    public static let packsPlan = "packs.plan"
    public static let packsIndexFiles = "packs.index.files"
    public static let packsIndexChunks = "packs.index.chunks"
    public static let packsApplyFull = "packs.apply.full"
    public static let packsApplyFile = "packs.apply.file"
    public static let packsApplyChunk = "packs.apply.chunk"
    public static let packsApplyDelta = "packs.apply.delta"
    public static let packsState = "packs.state"
    public static let packsHandlers = "packs.handlers"
    public static let packsTypeGodotZip = "packs.type.godot.zip"
    public static let packsTypeL10nTable = "packs.type.l10n.table"
    public static let packsTypeDataJson = "packs.type.data.json"
    public static let packsTypeAudioBank = "packs.type.audio.bank"
    public static let packsTypeMlModel = "packs.type.ml.model"
    public static let packsProvides = "packs.provides"
    public static let packsTransportApple = "packs.transport.apple"
    public static let packsTransportPlay = "packs.transport.play"
    public static let packsTransportSteam = "packs.transport.steam"
    public static let packsTransportMsix = "packs.transport.msix"
    public static let packsTransportFlatpak = "packs.transport.flatpak"
    public static let uiStages = "ui.stages"
    public static let uiBoot = "ui.boot"
    public static let uiKit = "ui.kit"
    public static let uiKitManage = "ui.kit.manage"
    public static let uiKitKeyentry = "ui.kit.keyentry"
    public static let uiKitAccount = "ui.kit.account"
    public static let uiCli = "ui.cli"
    public static let uiCliMount = "ui.cli.mount"
    public static let uiGate = "ui.gate"
    public static let uiActivate = "ui.activate"
    public static let uiSignin = "ui.signin"
    public static let uiDevicelimit = "ui.devicelimit"
    public static let uiDevices = "ui.devices"
    public static let uiUpdate = "ui.update"
    public static let uiSettings = "ui.settings"
    public static let uiPaywall = "ui.paywall"
    public static let uiTheme = "ui.theme"
    public static let uiI18n = "ui.i18n"
    public static let commerceReceipt = "commerce.receipt"
    public static let serverLicense = "server.license"
    public static let serverSignin = "server.signin"
    public static let serverConfig = "server.config"
    public static let serverWebhooks = "server.webhooks"
}

/// Every `Feature` value, in source order.
public let FEATURE_VALUES: [String] = [
    "core.verify",
    "core.cache",
    "core.bundle",
    "core.discover",
    "core.presentation",
    "core.sync",
    "core.local",
    "core.headers",
    "core.errors",
    "core.caps",
    "core.store",
    "core.copy",
    "core.backend",
    "license.gate",
    "license.activate",
    "license.enroll",
    "license.deactivate",
    "license.manage",
    "license.entitlements",
    "license.channels",
    "license.reregister",
    "license.refusals",
    "config.resolve",
    "config.list",
    "config.secret",
    "config.schema",
    "config.mint",
    "config.mirror",
    "config.local",
    "config.sync",
    "sync.scenarios",
    "sync.settings",
    "sync.conflict",
    "sync.saves",
    "devices.fingerprint",
    "devices.facts",
    "devices.register",
    "devices.manage",
    "devices.report",
    "telemetry.updates",
    "devices.attest",
    "identity.oidc",
    "identity.devicecode",
    "identity.devicelabel",
    "identity.toggle",
    "identity.keyentry",
    "identity.attach",
    "identity.account",
    "release.changelog",
    "release.download",
    "release.record",
    "release.fetch",
    "release.distribution",
    "update.check",
    "update.feed",
    "update.feeds",
    "update.decide",
    "update.content",
    "update.driver",
    "update.bootguard",
    "outlet.detect",
    "crash.tags",
    "packs.record",
    "packs.revoke",
    "packs.delegation",
    "packs.delta.feed",
    "packs.plan",
    "packs.index.files",
    "packs.index.chunks",
    "packs.apply.full",
    "packs.apply.file",
    "packs.apply.chunk",
    "packs.apply.delta",
    "packs.state",
    "packs.handlers",
    "packs.type.godot.zip",
    "packs.type.l10n.table",
    "packs.type.data.json",
    "packs.type.audio.bank",
    "packs.type.ml.model",
    "packs.provides",
    "packs.transport.apple",
    "packs.transport.play",
    "packs.transport.steam",
    "packs.transport.msix",
    "packs.transport.flatpak",
    "ui.stages",
    "ui.boot",
    "ui.kit",
    "ui.kit.manage",
    "ui.kit.keyentry",
    "ui.kit.account",
    "ui.cli",
    "ui.cli.mount",
    "ui.gate",
    "ui.activate",
    "ui.signin",
    "ui.devicelimit",
    "ui.devices",
    "ui.update",
    "ui.settings",
    "ui.paywall",
    "ui.theme",
    "ui.i18n",
    "commerce.receipt",
    "server.license",
    "server.signin",
    "server.config",
    "server.webhooks",
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

/// OS family, the canonical `X-PKey-Platform` value (README §3.1). iPadOS is `ios`. `tvos`, `visionos` and `watchos` are header values only; build targets are `RELEASE_PLATFORMS` (WIRE-CONTRACT-V4 §5.2 rule 5).
public enum Platform {
    public static let macos = "macos"
    public static let ios = "ios"
    public static let android = "android"
    public static let windows = "windows"
    public static let linux = "linux"
    public static let web = "web"
    public static let tvos = "tvos"
    public static let visionos = "visionos"
    public static let watchos = "watchos"
}

/// Every `Platform` value, in source order.
public let PLATFORM_VALUES: [String] = [
    "macos",
    "ios",
    "android",
    "windows",
    "linux",
    "web",
    "tvos",
    "visionos",
    "watchos",
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

/// The canonical X-PKey-SDK value (WIRE-CONTRACT-V3 §5.2): which SDK made the request. The SDK's version is X-PKey-SDK-Version. An SDK adds its id when it lands. A server core (WIRE-CONTRACT-V4 §14) sends `<language>-server` on its trust-manifest fetch.
public enum SdkId {
    public static let node = "node"
    public static let react = "react"
    public static let python = "python"
    public static let swift = "swift"
    public static let godot = "godot"
    public static let kotlin = "kotlin"
    public static let nodeServer = "node-server"
    public static let pythonServer = "python-server"
    public static let swiftServer = "swift-server"
    public static let kotlinServer = "kotlin-server"
}

/// Every `SdkId` value, in source order.
public let SDK_ID_VALUES: [String] = [
    "node",
    "react",
    "python",
    "swift",
    "godot",
    "kotlin",
    "node-server",
    "python-server",
    "swift-server",
    "kotlin-server",
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

/// The update decision's action (`UPDATE_ACTIONS`, plans/P3-01.md §2.8; `packs` added by plans/P4-13.md §2.6).
public enum UpdateAction {
    public static let none = "none"
    public static let codeReady = "code-ready"
    public static let binary = "binary"
    public static let store = "store"
    public static let platform = "platform"
    public static let blocked = "blocked"
    public static let packs = "packs"
}

/// Every `UpdateAction` value, in source order.
public let UPDATE_ACTION_VALUES: [String] = [
    "none",
    "code-ready",
    "binary",
    "store",
    "platform",
    "blocked",
    "packs",
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

/// Why the update decision is `blocked` (`BLOCKED_REASONS`, plans/P3-01.md §2.8; `content-floor` and `revoked-content` added by plans/P4-13.md §2.6).
public enum UpdateBlockedReason {
    public static let appFloor = "app-floor"
    public static let contentFloor = "content-floor"
    public static let revokedContent = "revoked-content"
}

/// Every `UpdateBlockedReason` value, in source order.
public let UPDATE_BLOCKED_REASON_VALUES: [String] = [
    "app-floor",
    "content-floor",
    "revoked-content",
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

/// The pack types a v1 SDK can hold (`PACK_TYPES`, plans/P4-01.md §2.2): `files.tree` everywhere, `godot.pck` in Godot. A record may name any `PACK_TYPE_PATTERN` type; an unknown one makes the pack unusable (`pack-type-unsupported`).
public enum PackType {
    public static let godotPck = "godot.pck"
    public static let filesTree = "files.tree"
}

/// Every `PackType` value, in source order.
public let PACK_TYPE_VALUES: [String] = [
    "godot.pck",
    "files.tree",
]

/// An app record's `content.expects[].delivery` (`PACK_DELIVERIES`, plans/P4-01.md §2.4). Any other `VOCAB_TOKEN_PATTERN` value is read as `on-demand`.
public enum PackDelivery {
    public static let essential = "essential"
    public static let prefetch = "prefetch"
    public static let onDemand = "on-demand"
}

/// Every `PackDelivery` value, in source order.
public let PACK_DELIVERY_VALUES: [String] = [
    "essential",
    "prefetch",
    "on-demand",
]

/// A pack record's `handler.activation` (`PACK_ACTIVATIONS`, plans/P4-01.md §2.3). An unknown value makes the pack unusable.
public enum PackActivation {
    public static let restart = "restart"
    public static let hot = "hot"
}

/// Every `PackActivation` value, in source order.
public let PACK_ACTIVATION_VALUES: [String] = [
    "restart",
    "hot",
]

/// A pack variant's `files.layout` (`FILES_LAYOUTS`, plans/P4-01.md §2.3): a single-file payload with offsets and gaps, or a directory of files. An unknown layout makes the variant unusable.
public enum FilesLayout {
    public static let container = "container"
    public static let tree = "tree"
}

/// Every `FilesLayout` value, in source order.
public let FILES_LAYOUT_VALUES: [String] = [
    "container",
    "tree",
]

/// An object ref's `codec` (`CONTENT_CODECS`, plans/P4-01.md §2.3): one zstd frame with its content size, or stored raw (`bytes === size`). An unknown codec makes that object unusable.
public enum ContentCodec {
    public static let zstd = "zstd"
    public static let none = "none"
}

/// Every `ContentCodec` value, in source order.
public let CONTENT_CODEC_VALUES: [String] = [
    "zstd",
    "none",
]

/// A pack delta's `method` v1 applies (`PATCH_METHODS`, plans/P4-01.md §2.3). `godot-delta-pck`, `hdiffpatch` and `bsdiff` are reserved and not listed; an unknown method makes the delta infeasible.
public enum PatchMethod {
    public static let zstdPatchFrom = "zstd-patch-from"
}

/// Every `PatchMethod` value, in source order.
public let PATCH_METHOD_VALUES: [String] = [
    "zstd-patch-from",
]

/// A pack delta's `scope` (`PATCH_SCOPES`, plans/P4-01.md §2.3): the whole payload, or the per-entry set. A delta of another scope is dropped.
public enum PatchScope {
    public static let payload = "payload"
    public static let files = "files"
}

/// Every `PatchScope` value, in source order.
public let PATCH_SCOPE_VALUES: [String] = [
    "payload",
    "files",
]

/// The variant axis names a v1 manifest may declare (`VARIANT_AXES`, plans/P4-01.md §2.2). A record may name any `VARIANT_AXIS_PATTERN` axis; a variant on an axis the host has no preferences for is ineligible.
public enum VariantAxis {
    public static let texture = "texture"
    public static let locale = "locale"
    public static let quality = "quality"
}

/// Every `VariantAxis` value, in source order.
public let VARIANT_AXIS_VALUES: [String] = [
    "texture",
    "locale",
    "quality",
]

/// The install planner's strategies (plans/P4-01.md §2.9, A7 §4.2): a plan result's `strategy` and a host's `caps.strategies`. `plan-matrix.json` pins them.
public enum PatchStrategy {
    public static let noop = "noop"
    public static let platform = "platform"
    public static let delta = "delta"
    public static let chunk = "chunk"
    public static let file = "file"
    public static let full = "full"
}

/// Every `PatchStrategy` value, in source order.
public let PATCH_STRATEGY_VALUES: [String] = [
    "noop",
    "platform",
    "delta",
    "chunk",
    "file",
    "full",
]

/// How a deliverable's bytes arrive (`TRANSPORTS` in `@polaris-key/manifest`, P2b-02; README §3.1): the planner's `caps.transports` and a platform target's `transport` (plans/P4-01.md §2.9).
public enum Transport {
    public static let embedded = "embedded"
    public static let pkeyCdn = "pkey-cdn"
    public static let appleBa = "apple-ba"
    public static let playPad = "play-pad"
    public static let steamDepot = "steam-depot"
    public static let msixOptional = "msix-optional"
    public static let flatpakExt = "flatpak-ext"
    public static let web = "web"
}

/// Every `Transport` value, in source order.
public let TRANSPORT_VALUES: [String] = [
    "embedded",
    "pkey-cdn",
    "apple-ba",
    "play-pad",
    "steam-depot",
    "msix-optional",
    "flatpak-ext",
    "web",
]

/// The pack types a delegated content key may sign (`DELEGABLE_PACK_TYPES`, plans/P4-19.md §2.5, decision 5). A delegation's `types` outside this list are ignored; `godot.pck`, `godot.zip`, `audio.bank`, `ml.model` and `custom.*` are never delegable. `delegationCases` pins them.
public enum DelegablePackType {
    public static let filesTree = "files.tree"
    public static let dataJson = "data.json"
    public static let l10nTable = "l10n.table"
}

/// Every `DelegablePackType` value, in source order.
public let DELEGABLE_PACK_TYPE_VALUES: [String] = [
    "files.tree",
    "data.json",
    "l10n.table",
]

/// The file extensions a delegated install may hold (`DATA_ONLY_EXTENSIONS`, plans/P4-19.md §2.5 rule 2): the final segment's text after its last `.`, ASCII-lowercased. An allow-list: anything else is refused (`pack-not-data-only`, rule `extension`). `dataOnlyCases` pins them.
public enum DataOnlyExtension {
    public static let json = "json"
    public static let csv = "csv"
    public static let tsv = "tsv"
    public static let po = "po"
    public static let txt = "txt"
    public static let png = "png"
    public static let jpg = "jpg"
    public static let jpeg = "jpeg"
    public static let webp = "webp"
    public static let ogg = "ogg"
    public static let wav = "wav"
    public static let mp3 = "mp3"
    public static let ttf = "ttf"
    public static let otf = "otf"
}

/// Every `DataOnlyExtension` value, in source order.
public let DATA_ONLY_EXTENSION_VALUES: [String] = [
    "json",
    "csv",
    "tsv",
    "po",
    "txt",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "ogg",
    "wav",
    "mp3",
    "ttf",
    "otf",
]

/// Every gate status a licence evaluates to (`LicenseStatus` in `@polaris-key/protocol/license`, `client-core`'s gate). A tools/gen-sdk-constants.test.ts case keeps them equal; `copy.en.json`'s `gate` keys equal it (plans/SP-00.md §4). Every value, in source order.
public let LICENSE_STATUS_VALUES: [String] = [
    "ok",
    "grace",
    "expired",
    "revoked",
    "needs-activation",
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
    "not-applicable",
]

/// The typed activation results of `license.activate` and `license.enroll` (SDK-PARITY-PASS §3.1), in the transcript (kebab) form; each SDK spells its own kinds in its casing. `copy.en.json`'s `activation` keys equal it (plans/SP-00.md §4). Every value, in source order.
public let ACTIVATION_RESULT_VALUES: [String] = [
    "ok",
    "device-limit",
    "fingerprint-required",
    "hardware-mismatch",
    "enroll-claimed",
    "license-disabled",
    "license-expired",
    "attestation-required",
    "rate-limited",
    "unauthorized",
    "enroll-disabled",
    "key-entry-limit",
    "refused",
    "error",
]

/// The `X-PKey-*` request header names (wire contract v3 §5).
public enum HeaderName {
    public static let arch = "X-PKey-Arch"
    public static let channel = "X-PKey-Channel"
    public static let device = "X-PKey-Device"
    public static let license = "X-PKey-License"
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
    "X-PKey-License",
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
public let STAGE_MATRIX_VERSION = 3

/// `updateMatrixVersion` of conformance/corpus/v2/update-matrix.json.
public let UPDATE_MATRIX_VERSION = 1

/// `outletMatrixVersion` of conformance/corpus/v2/outlet-matrix.json.
public let OUTLET_MATRIX_VERSION = 1

/// `planMatrixVersion` of conformance/corpus/v2/plan-matrix.json.
public let PLAN_MATRIX_VERSION = 2

/// `syncScenariosVersion` of conformance/corpus/v2/sync-scenarios.json.
public let SYNC_SCENARIOS_VERSION = 2

/// `deviceLabelVersion` of conformance/corpus/v2/device-label.json.
public let DEVICE_LABEL_VERSION = 1

/// `presentationMatrixVersion` of conformance/corpus/v2/presentation-matrix.json.
public let PRESENTATION_MATRIX_VERSION = 1

/// `uiMatrixVersion` of conformance/corpus/v2/ui-matrix.json.
public let UI_MATRIX_VERSION = 2

/// `backendMatrixVersion` of conformance/corpus/v2/backend-matrix.json (WIRE-CONTRACT-V4 §14).
public let BACKEND_MATRIX_VERSION = 1

/// `contentCorpusVersion` of conformance/corpus/v2/content/cases.json.
public let CONTENT_CORPUS_VERSION = 2

/// Wire contract v4 limit `MAX_WIRE_INTEGER` (`@polaris-key/protocol/core`).
public let MAX_WIRE_INTEGER = 9007199254740991

/// Wire contract v4 limit `MAX_JSON_DEPTH` (`@polaris-key/protocol/core`).
public let MAX_JSON_DEPTH = 64

/// Wire contract v4 limit `MAX_RECORD_JWS_BYTES` (`@polaris-key/protocol/core`).
public let MAX_RECORD_JWS_BYTES = 88844

/// Wire contract v4 limit `MAX_FEED_REVOCATIONS` (`@polaris-key/protocol/core`).
public let MAX_FEED_REVOCATIONS = 64

/// Wire contract v4 limit `REVOCATION_REASON_MAX_BYTES` (`@polaris-key/protocol/core`).
public let REVOCATION_REASON_MAX_BYTES = 512

/// Wire contract v4 limit `MAX_FEED_DELTAS` (`@polaris-key/protocol/core`).
public let MAX_FEED_DELTAS = 64

/// Wire contract v4 limit `MAX_FEED_DELTAS_PER_TARGET` (`@polaris-key/protocol/core`).
public let MAX_FEED_DELTAS_PER_TARGET = 4

/// Wire contract v4 limit `MAX_DELEGATION_TTL_SECONDS` (`@polaris-key/protocol/core`).
public let MAX_DELEGATION_TTL_SECONDS = 31622400

/// Wire contract v4 limit `MAX_DELEGATION_TYPES` (`@polaris-key/protocol/core`).
public let MAX_DELEGATION_TYPES = 8

/// Wire contract v4 limit `DATA_ONLY_HEAD_BYTES` (`@polaris-key/protocol/core`).
public let DATA_ONLY_HEAD_BYTES = 64

/// Wire contract v4 limit `DATA_ONLY_TAIL_BYTES` (`@polaris-key/protocol/core`).
public let DATA_ONLY_TAIL_BYTES = 65557

/// Wire contract v4 limit `MAX_DELEGATIONS_PER_CHECK` (`@polaris-key/protocol/core`).
public let MAX_DELEGATIONS_PER_CHECK = 16

/// Wire contract v4 limit `MAX_TRUST_SIGNER_ATTEMPTS` (`@polaris-key/protocol/core`).
public let MAX_TRUST_SIGNER_ATTEMPTS = 4

/// Packs on the wire: `MAX_PACK_VARIANTS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let MAX_PACK_VARIANTS = 32

/// Packs on the wire: `MAX_VARIANT_DELTAS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let MAX_VARIANT_DELTAS = 16

/// Packs on the wire: `MAX_CONTENT_PINS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let MAX_CONTENT_PINS = 256

/// Packs on the wire: `MAX_BUILD_EMBEDS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let MAX_BUILD_EMBEDS = 64

/// Packs on the wire: `MAX_INDEX_FILES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let MAX_INDEX_FILES = 100000

/// Packs on the wire: `MAX_FILES_INDEX_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let MAX_FILES_INDEX_BYTES = 33554432

/// Packs on the wire: `MAX_PACK_PATH_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let MAX_PACK_PATH_BYTES = 1024

/// Packs on the wire: `FILES_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let FILES_FORMAT = "pkey-files/1"

/// Packs on the wire: `PATCH_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let PATCH_FORMAT = "pkey-patch/1"

/// Packs on the wire: `MARKER_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let MARKER_FORMAT = "pkey-marker/1"

/// Packs on the wire: `CONTENT_STAMP_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let CONTENT_STAMP_FORMAT = "pkey-content/1"

/// Packs on the wire: `PLAN_REQUEST_WEIGHT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
public let PLAN_REQUEST_WEIGHT = 16384

/// Packs on the wire: `CHUNKS_FORMAT` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`).
public let CHUNKS_FORMAT = "pkey-chunks/1"

/// Packs on the wire: `MAX_CHUNK_INDEX_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`).
public let MAX_CHUNK_INDEX_BYTES = 16777216

/// Packs on the wire: `MAX_CHUNK_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`).
public let MAX_CHUNK_BYTES = 4194304

/// Identity passthrough: `DEVICE_LABEL_MAX_CODEPOINTS` (WIRE-CONTRACT-V4 §12.7, `@polaris-key/protocol/identity`).
public let DEVICE_LABEL_MAX_CODEPOINTS = 64

/// Identity passthrough: `REQUEST_HANDLE_PATTERN` (WIRE-CONTRACT-V4 §12.7, `@polaris-key/protocol/identity`).
public let REQUEST_HANDLE_PATTERN = "^rq_[A-Za-z0-9_-]{22}$"

/// Identity passthrough: `REQUEST_HANDLE_TTL_SECONDS` (WIRE-CONTRACT-V4 §12.7, `@polaris-key/protocol/identity`).
public let REQUEST_HANDLE_TTL_SECONDS = 600

/// Product presentation: `PRESENTATION_TEXT_MAX_BYTES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
public let PRESENTATION_TEXT_MAX_BYTES = 1024

/// Product presentation: `PRESENTATION_URL_MAX_BYTES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
public let PRESENTATION_URL_MAX_BYTES = 2048

/// Product presentation: `PRESENTATION_MAX_ICON_SIZES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
public let PRESENTATION_MAX_ICON_SIZES = 8

/// Product presentation: `PRESENTATION_MAX_ICON_WIDTH` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
public let PRESENTATION_MAX_ICON_WIDTH = 4096

/// Product presentation: `PRESENTATION_ICON_MAX_DIMENSION` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
public let PRESENTATION_ICON_MAX_DIMENSION = 16384

/// Product presentation: `PRESENTATION_ICON_MAX_BYTES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
public let PRESENTATION_ICON_MAX_BYTES = 10485760

/// Product presentation: `PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
public let PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS = 10

/// Product presentation: `PRESENTATION_CACHE_MAX_FILES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
public let PRESENTATION_CACHE_MAX_FILES = 4

/// Product presentation: `PRESENTATION_ICON_TYPES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
public let PRESENTATION_ICON_TYPES: [String] = ["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]

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
    "tvos": "tvos",
    "visionos": "visionos",
    "watchos": "watchos",
]

/// One declared N/A: on `runtime`, the feature is unsupported for `reason`.
public struct CapabilityNa: Sendable, Equatable {
    public let runtime: String
    public let reason: String

    public init(runtime: String, reason: String) {
        self.runtime = runtime
        self.reason = reason
    }
}

/// One feature's row in `CAPABILITIES`.
public struct CapabilityRow: Sendable, Equatable {
    public let status: String
    public let service: String
    public let na: [CapabilityNa]

    public init(status: String, service: String, na: [CapabilityNa]) {
        self.status = status
        self.service = service
        self.na = na
    }
}

/// The parity-registry id of the SDK this module belongs to.
public let CAPABILITY_SDK = "swift"

/// The runtimes this SDK's manifest lists.
public let CAPABILITY_RUNTIMES: [String] = ["macos", "ios"]

/// This SDK's capability table, generated from its parity manifest (tools/capabilities.ts): per feature, the manifest's status, the owning service and every declared (runtime, reason) N/A. `supports()` reads it (P1b-10, PARITY §2.2).
public let CAPABILITIES: [String: CapabilityRow] = [
    "core.verify": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.cache": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.bundle": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.discover": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.presentation": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.sync": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.local": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.headers": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.errors": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.caps": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.store": CapabilityRow(status: "implemented", service: "core", na: []),
    "core.copy": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "core.backend": CapabilityRow(status: "planned", service: "license", na: []),
    "license.gate": CapabilityRow(status: "implemented", service: "license", na: []),
    "license.activate": CapabilityRow(status: "implemented", service: "license", na: []),
    "license.enroll": CapabilityRow(status: "implemented", service: "license", na: []),
    "license.deactivate": CapabilityRow(status: "implemented", service: "license", na: []),
    "license.manage": CapabilityRow(status: "implemented", service: "license", na: []),
    "license.entitlements": CapabilityRow(status: "implemented", service: "license", na: []),
    "license.channels": CapabilityRow(status: "implemented", service: "license", na: []),
    "license.reregister": CapabilityRow(status: "implemented", service: "license", na: []),
    "license.refusals": CapabilityRow(status: "implemented", service: "license", na: []),
    "config.resolve": CapabilityRow(status: "implemented", service: "config", na: []),
    "config.list": CapabilityRow(status: "implemented", service: "config", na: []),
    "config.secret": CapabilityRow(status: "implemented", service: "config", na: []),
    "config.schema": CapabilityRow(status: "implemented", service: "config", na: []),
    "config.mint": CapabilityRow(status: "implemented", service: "config", na: []),
    "config.mirror": CapabilityRow(status: "implemented", service: "config", na: []),
    "config.local": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "config.sync": CapabilityRow(status: "planned", service: "sync", na: []),
    "sync.scenarios": CapabilityRow(status: "planned", service: "sync", na: []),
    "sync.settings": CapabilityRow(status: "planned", service: "sync", na: []),
    "sync.conflict": CapabilityRow(status: "planned", service: "sync", na: []),
    "sync.saves": CapabilityRow(status: "planned", service: "sync", na: []),
    "devices.fingerprint": CapabilityRow(status: "implemented", service: "core", na: []),
    "devices.facts": CapabilityRow(status: "implemented", service: "core", na: []),
    "devices.register": CapabilityRow(status: "implemented", service: "core", na: []),
    "devices.manage": CapabilityRow(status: "implemented", service: "core", na: []),
    "devices.report": CapabilityRow(status: "implemented", service: "core", na: []),
    "telemetry.updates": CapabilityRow(status: "implemented", service: "core", na: []),
    "devices.attest": CapabilityRow(status: "implemented", service: "core", na: [CapabilityNa(runtime: "macos", reason: "runtime"), CapabilityNa(runtime: "ios", reason: "outlet")]),
    "identity.oidc": CapabilityRow(status: "planned", service: "identity", na: []),
    "identity.devicecode": CapabilityRow(status: "implemented", service: "identity", na: []),
    "identity.devicelabel": CapabilityRow(status: "implemented", service: "identity", na: []),
    "identity.toggle": CapabilityRow(status: "planned", service: "identity", na: []),
    "identity.keyentry": CapabilityRow(status: "planned", service: "identity", na: []),
    "identity.attach": CapabilityRow(status: "planned", service: "identity", na: []),
    "identity.account": CapabilityRow(status: "planned", service: "identity", na: []),
    "release.changelog": CapabilityRow(status: "implemented", service: "release", na: []),
    "release.download": CapabilityRow(status: "implemented", service: "release", na: []),
    "release.record": CapabilityRow(status: "implemented", service: "release", na: []),
    "release.fetch": CapabilityRow(status: "implemented", service: "distribution", na: []),
    "release.distribution": CapabilityRow(status: "implemented", service: "distribution", na: []),
    "update.check": CapabilityRow(status: "implemented", service: "update", na: []),
    "update.feed": CapabilityRow(status: "implemented", service: "update", na: []),
    "update.feeds": CapabilityRow(status: "implemented", service: "update", na: []),
    "update.decide": CapabilityRow(status: "implemented", service: "update", na: []),
    "update.content": CapabilityRow(status: "implemented", service: "update", na: []),
    "update.driver": CapabilityRow(status: "implemented", service: "update", na: [CapabilityNa(runtime: "ios", reason: "outlet")]),
    "update.bootguard": CapabilityRow(status: "implemented", service: "update", na: []),
    "outlet.detect": CapabilityRow(status: "implemented", service: "update", na: []),
    "crash.tags": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "packs.record": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.revoke": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.delegation": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.delta.feed": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.plan": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.index.files": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.index.chunks": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.apply.full": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.apply.file": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.apply.chunk": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.apply.delta": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.state": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.handlers": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.type.godot.zip": CapabilityRow(status: "na", service: "release", na: [CapabilityNa(runtime: "macos", reason: "runtime"), CapabilityNa(runtime: "ios", reason: "runtime")]),
    "packs.type.l10n.table": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.type.data.json": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.type.audio.bank": CapabilityRow(status: "na", service: "release", na: [CapabilityNa(runtime: "macos", reason: "runtime"), CapabilityNa(runtime: "ios", reason: "runtime")]),
    "packs.type.ml.model": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.provides": CapabilityRow(status: "implemented", service: "release", na: []),
    "packs.transport.apple": CapabilityRow(status: "implemented", service: "distribution", na: []),
    "packs.transport.play": CapabilityRow(status: "na", service: "distribution", na: [CapabilityNa(runtime: "macos", reason: "runtime"), CapabilityNa(runtime: "ios", reason: "runtime")]),
    "packs.transport.steam": CapabilityRow(status: "planned", service: "distribution", na: [CapabilityNa(runtime: "ios", reason: "runtime")]),
    "packs.transport.msix": CapabilityRow(status: "na", service: "distribution", na: [CapabilityNa(runtime: "macos", reason: "runtime"), CapabilityNa(runtime: "ios", reason: "runtime")]),
    "packs.transport.flatpak": CapabilityRow(status: "na", service: "distribution", na: [CapabilityNa(runtime: "macos", reason: "runtime"), CapabilityNa(runtime: "ios", reason: "runtime")]),
    "ui.stages": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.boot": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.kit": CapabilityRow(status: "planned", service: "sdk", na: []),
    "ui.kit.manage": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.kit.keyentry": CapabilityRow(status: "planned", service: "sdk", na: []),
    "ui.kit.account": CapabilityRow(status: "planned", service: "sdk", na: []),
    "ui.cli": CapabilityRow(status: "na", service: "sdk", na: [CapabilityNa(runtime: "macos", reason: "runtime"), CapabilityNa(runtime: "ios", reason: "runtime")]),
    "ui.cli.mount": CapabilityRow(status: "na", service: "sdk", na: [CapabilityNa(runtime: "macos", reason: "runtime"), CapabilityNa(runtime: "ios", reason: "runtime")]),
    "ui.gate": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.activate": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.signin": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.devicelimit": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.devices": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.update": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.settings": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.paywall": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.theme": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "ui.i18n": CapabilityRow(status: "implemented", service: "sdk", na: []),
    "commerce.receipt": CapabilityRow(status: "implemented", service: "license", na: []),
    "server.license": CapabilityRow(status: "planned", service: "license", na: [CapabilityNa(runtime: "ios", reason: "runtime")]),
    "server.signin": CapabilityRow(status: "planned", service: "identity", na: [CapabilityNa(runtime: "ios", reason: "runtime")]),
    "server.config": CapabilityRow(status: "planned", service: "config", na: [CapabilityNa(runtime: "ios", reason: "runtime")]),
    "server.webhooks": CapabilityRow(status: "planned", service: "core", na: [CapabilityNa(runtime: "ios", reason: "runtime")]),
]

/// SHA-256 of the canonical table; `pnpm parity:check` recomputes it from the manifest.
public let CAPABILITY_DIGEST = "8797cce5893861efc9123babcaffa94ceca5b26d0210d457bcc424e28a50cfd6"
