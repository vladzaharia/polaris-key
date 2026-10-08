// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen:constants` (tools/gen-sdk-constants.ts) from conformance/parity/
// errors.json, enums.json and features.json, tools/services.json, @polaris-key/protocol/core
// and the conformance corpus. `pnpm gen:constants -- --check` fails the green gate on any
// difference. To change a constant, edit its source and regenerate.

// `ServiceSlug` is not here: ServiceSlug.generated.kt (pnpm gen:services) declares it.

@file:Suppress("unused", "ObjectPropertyName")

package im.plrs.key.core

/** Every error code the Worker answers with or an SDK raises (conformance/parity/errors.json). Hosts match on these strings. */
public object ErrorCode {
    public const val unauthorized: String = "unauthorized"
    public const val notFound: String = "not_found"
    public const val badRequest: String = "bad_request"
    public const val forbidden: String = "forbidden"
    public const val attestationRequired: String = "attestation_required"
    public const val attestationRejected: String = "attestation_rejected"
    public const val attestationUnavailable: String = "attestation_unavailable"
    public const val rateLimited: String = "rate_limited"
    public const val bodyTooLarge: String = "body_too_large"
    public const val methodNotAllowed: String = "method_not_allowed"
    public const val misconfigured: String = "misconfigured"
    public const val registrationClosed: String = "registration_closed"
    public const val valueNotRepresentable: String = "value_not_representable"
    public const val documentNotRepresentable: String = "document_not_representable"
    public const val deviceLimit: String = "device_limit"
    public const val keyEntryLimit: String = "key_entry_limit"
    public const val licenseDisabled: String = "license_disabled"
    public const val licenseExpired: String = "license_expired"
    public const val notEntitled: String = "not_entitled"
    public const val versionBlocked: String = "version_blocked"
    public const val channelNotAllowed: String = "channel_not_allowed"
    public const val hardwareMismatch: String = "hardware_mismatch"
    public const val fingerprintRequired: String = "fingerprint_required"
    public const val enrollDisabled: String = "enroll_disabled"
    public const val enrollClaimed: String = "enroll_claimed"
    public const val enrollFailed: String = "enroll_failed"
    public const val managedByAdmin: String = "managed_by_admin"
    public const val catalogUnavailable: String = "catalog_unavailable"
    public const val licenseUnusable: String = "license_unusable"
    public const val disabled: String = "disabled"
    public const val oidcError: String = "oidc_error"
    public const val unavailable: String = "unavailable"
    public const val identityDisabled: String = "identity_disabled"
    public const val authMethodDisabled: String = "auth_method_disabled"
    public const val emailUnavailable: String = "email_unavailable"
    public const val turnstileFailed: String = "turnstile_failed"
    public const val signinExpired: String = "signin_expired"
    public const val invalidCode: String = "invalid_code"
    public const val emailInUse: String = "email_in_use"
    public const val termsRequired: String = "terms_required"
    public const val licenseOwned: String = "license_owned"
    public const val emailMismatch: String = "email_mismatch"
    public const val linkConflict: String = "link_conflict"
    public const val lastLink: String = "last_link"
    public const val stepUpRequired: String = "step_up_required"
    public const val notEligible: String = "not_eligible"
    public const val notRemovable: String = "not_removable"
    public const val downloadAuthRequired: String = "download_auth_required"
    public const val deliveryGateMissing: String = "delivery_gate_missing"
    public const val upstreamRateLimited: String = "upstream_rate_limited"
    public const val serverMisconfigured: String = "server_misconfigured"
    public const val internalError: String = "internal_error"
    public const val releaseRecordRejected: String = "release_record_rejected"
    public const val releaseTagIsPackRelease: String = "release_tag_is_pack_release"
    public const val assetUnreachable: String = "asset_unreachable"
    public const val feedNotComposable: String = "feed_not_composable"
    public const val serviceUnavailable: String = "service-unavailable"
    public const val serviceDisabled: String = "service-disabled"
    public const val localOnly: String = "local-only"
    public const val insecureBaseUrl: String = "insecure-base-url"
    public const val bundleJwsRejected: String = "bundle-jws-rejected"
    public const val bundleClaimsRejected: String = "bundle-claims-rejected"
    public const val bundleTrustRejected: String = "bundle-trust-rejected"
    public const val innerDocRejected: String = "inner-doc-rejected"
    public const val bundle: String = "bundle"
    public const val transport: String = "transport"
    public const val network: String = "network"
    public const val refreshFailed: String = "refresh-failed"
    public const val syncFailed: String = "sync-failed"
    public const val fetchFailed: String = "fetch-failed"
    public const val bridgeMissing: String = "bridge-missing"
    public const val unknown: String = "unknown"
    public const val releaseRefused: String = "release-refused"
    public const val bundleRejected: String = "bundle-rejected"
    public const val bundleImportUnsupported: String = "bundle-import-unsupported"
    public const val reportUnsupported: String = "report-unsupported"
    public const val deviceManagementUnsupported: String = "device-management-unsupported"
    public const val deviceListFailed: String = "device_list_failed"
    public const val deviceRenameFailed: String = "device_rename_failed"
    public const val deviceDeauthorizeFailed: String = "device_deauthorize_failed"
    public const val keyEntryUnsupported: String = "key-entry-unsupported"
    public const val signInFailed: String = "sign-in-failed"
    public const val signOutFailed: String = "sign-out-failed"
    public const val badResponse: String = "bad_response"
    public const val networkError: String = "network-error"
    public const val serverError: String = "server-error"
    public const val cancelled: String = "cancelled"
    public const val signInExpired: String = "sign-in-expired"
    public const val signInDenied: String = "sign-in-denied"
    public const val signInUnavailable: String = "sign-in-unavailable"
    public const val invalidOptions: String = "invalid-options"
    public const val notConfigured: String = "not-configured"
    public const val unsupported: String = "unsupported"
    public const val timeout: String = "timeout"
    public const val responseTooLarge: String = "response-too-large"
    public const val tooManyRedirects: String = "too-many-redirects"
    public const val insecureRedirect: String = "insecure-redirect"
    public const val httpError: String = "http-error"
    public const val invalidResponse: String = "invalid-response"
    public const val storeFailed: String = "store-failed"
    public const val platformError: String = "platform-error"
    public const val noToken: String = "no-token"
    public const val mintUnavailable: String = "mint-unavailable"
    public const val feedRejected: String = "feed-rejected"
    public const val feedRollback: String = "feed-rollback"
    public const val recordRejected: String = "record-rejected"
    public const val recordMismatch: String = "record-mismatch"
    public const val payloadMismatch: String = "payload-mismatch"
    public const val swapRefused: String = "swap-refused"
    public const val swapFailed: String = "swap-failed"
    public const val filesIndexInvalid: String = "files-index-invalid"
    public const val filesUnsafePath: String = "files-unsafe-path"
    public const val filesDuplicatePath: String = "files-duplicate-path"
    public const val filesCaseCollision: String = "files-case-collision"
    public const val filesPathConflict: String = "files-path-conflict"
    public const val filesLayoutMismatch: String = "files-layout-mismatch"
    public const val contentStampInvalid: String = "content-stamp-invalid"
    public const val fullCorrupt: String = "full-corrupt"
    public const val deltaArtifactMismatch: String = "delta-artifact-mismatch"
    public const val deltaBaseMismatch: String = "delta-base-mismatch"
    public const val deltaApplyFailed: String = "delta-apply-failed"
    public const val fileCorrupt: String = "file-corrupt"
    public const val fileSourceMissing: String = "file-source-missing"
    public const val payloadHashMismatch: String = "payload-hash-mismatch"
    public const val chunksRefMismatch: String = "chunks-ref-mismatch"
    public const val chunksBadLength: String = "chunks-bad-length"
    public const val chunksBadMagic: String = "chunks-bad-magic"
    public const val chunksUnsupportedVersion: String = "chunks-unsupported-version"
    public const val chunksBadRecordSize: String = "chunks-bad-record-size"
    public const val chunksBadFlags: String = "chunks-bad-flags"
    public const val chunksReservedNonzero: String = "chunks-reserved-nonzero"
    public const val chunksZeroLength: String = "chunks-zero-length"
    public const val chunksBadClen: String = "chunks-bad-clen"
    public const val chunksBadBundleRef: String = "chunks-bad-bundle-ref"
    public const val chunksBadBundleRange: String = "chunks-bad-bundle-range"
    public const val chunksSizeMismatch: String = "chunks-size-mismatch"
    public const val chunksPayloadMismatch: String = "chunks-payload-mismatch"
    public const val chunkBundleTruncated: String = "chunk-bundle-truncated"
    public const val chunkCorrupt: String = "chunk-corrupt"
    public const val planTransportUnsupported: String = "plan-transport-unsupported"
    public const val planInsufficientDisk: String = "plan-insufficient-disk"
    public const val planNoStrategy: String = "plan-no-strategy"
    public const val packNoVariant: String = "pack-no-variant"
    public const val packTypeUnsupported: String = "pack-type-unsupported"
    public const val packTypeCheckFailed: String = "pack-type-check-failed"
    public const val packNotPinned: String = "pack-not-pinned"
    public const val packNotEntitled: String = "pack-not-entitled"
    public const val packStateUnreadable: String = "pack-state-unreadable"
    public const val pckDirectoryRefused: String = "pck-directory-refused"
    public const val pckEngineMismatch: String = "pck-engine-mismatch"
    public const val packRolledBack: String = "pack-rolled-back"
    public const val packRevoked: String = "pack-revoked"
    public const val packNotDataOnly: String = "pack-not-data-only"
    public const val markerRejected: String = "marker-rejected"
}

/** Every `ErrorCode` value, in source order. */
public val ERROR_CODE_VALUES: List<String> = listOf(
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
)

/** The registry: every error code and its kind (`wire` or `client`). */
public val ERROR_CODE_KINDS: Map<String, String> = mapOf(
    "unauthorized" to "wire",
    "not_found" to "wire",
    "bad_request" to "wire",
    "forbidden" to "wire",
    "attestation_required" to "wire",
    "attestation_rejected" to "wire",
    "attestation_unavailable" to "wire",
    "rate_limited" to "wire",
    "body_too_large" to "wire",
    "method_not_allowed" to "wire",
    "misconfigured" to "wire",
    "registration_closed" to "wire",
    "value_not_representable" to "wire",
    "document_not_representable" to "wire",
    "device_limit" to "wire",
    "key_entry_limit" to "wire",
    "license_disabled" to "wire",
    "license_expired" to "wire",
    "not_entitled" to "wire",
    "version_blocked" to "wire",
    "channel_not_allowed" to "wire",
    "hardware_mismatch" to "wire",
    "fingerprint_required" to "wire",
    "enroll_disabled" to "wire",
    "enroll_claimed" to "wire",
    "enroll_failed" to "wire",
    "managed_by_admin" to "wire",
    "catalog_unavailable" to "wire",
    "license_unusable" to "wire",
    "disabled" to "wire",
    "oidc_error" to "wire",
    "unavailable" to "wire",
    "identity_disabled" to "wire",
    "auth_method_disabled" to "wire",
    "email_unavailable" to "wire",
    "turnstile_failed" to "wire",
    "signin_expired" to "wire",
    "invalid_code" to "wire",
    "email_in_use" to "wire",
    "terms_required" to "wire",
    "license_owned" to "wire",
    "email_mismatch" to "wire",
    "link_conflict" to "wire",
    "last_link" to "wire",
    "step_up_required" to "wire",
    "not_eligible" to "wire",
    "not_removable" to "wire",
    "download_auth_required" to "wire",
    "delivery_gate_missing" to "wire",
    "upstream_rate_limited" to "wire",
    "server_misconfigured" to "wire",
    "internal_error" to "wire",
    "release_record_rejected" to "wire",
    "release_tag_is_pack_release" to "wire",
    "asset_unreachable" to "wire",
    "feed_not_composable" to "wire",
    "service-unavailable" to "client",
    "service-disabled" to "client",
    "local-only" to "client",
    "insecure-base-url" to "client",
    "bundle-jws-rejected" to "client",
    "bundle-claims-rejected" to "client",
    "bundle-trust-rejected" to "client",
    "inner-doc-rejected" to "client",
    "bundle" to "client",
    "transport" to "client",
    "network" to "client",
    "refresh-failed" to "client",
    "sync-failed" to "client",
    "fetch-failed" to "client",
    "bridge-missing" to "client",
    "unknown" to "client",
    "release-refused" to "client",
    "bundle-rejected" to "client",
    "bundle-import-unsupported" to "client",
    "report-unsupported" to "client",
    "device-management-unsupported" to "client",
    "device_list_failed" to "client",
    "device_rename_failed" to "client",
    "device_deauthorize_failed" to "client",
    "key-entry-unsupported" to "client",
    "sign-in-failed" to "client",
    "sign-out-failed" to "client",
    "bad_response" to "client",
    "network-error" to "client",
    "server-error" to "client",
    "cancelled" to "client",
    "sign-in-expired" to "client",
    "sign-in-denied" to "client",
    "sign-in-unavailable" to "client",
    "invalid-options" to "client",
    "not-configured" to "client",
    "unsupported" to "client",
    "timeout" to "client",
    "response-too-large" to "client",
    "too-many-redirects" to "client",
    "insecure-redirect" to "client",
    "http-error" to "client",
    "invalid-response" to "client",
    "store-failed" to "client",
    "platform-error" to "client",
    "no-token" to "client",
    "mint-unavailable" to "client",
    "feed-rejected" to "client",
    "feed-rollback" to "client",
    "record-rejected" to "client",
    "record-mismatch" to "client",
    "payload-mismatch" to "client",
    "swap-refused" to "client",
    "swap-failed" to "client",
    "files-index-invalid" to "client",
    "files-unsafe-path" to "client",
    "files-duplicate-path" to "client",
    "files-case-collision" to "client",
    "files-path-conflict" to "client",
    "files-layout-mismatch" to "client",
    "content-stamp-invalid" to "client",
    "full-corrupt" to "client",
    "delta-artifact-mismatch" to "client",
    "delta-base-mismatch" to "client",
    "delta-apply-failed" to "client",
    "file-corrupt" to "client",
    "file-source-missing" to "client",
    "payload-hash-mismatch" to "client",
    "chunks-ref-mismatch" to "client",
    "chunks-bad-length" to "client",
    "chunks-bad-magic" to "client",
    "chunks-unsupported-version" to "client",
    "chunks-bad-record-size" to "client",
    "chunks-bad-flags" to "client",
    "chunks-reserved-nonzero" to "client",
    "chunks-zero-length" to "client",
    "chunks-bad-clen" to "client",
    "chunks-bad-bundle-ref" to "client",
    "chunks-bad-bundle-range" to "client",
    "chunks-size-mismatch" to "client",
    "chunks-payload-mismatch" to "client",
    "chunk-bundle-truncated" to "client",
    "chunk-corrupt" to "client",
    "plan-transport-unsupported" to "client",
    "plan-insufficient-disk" to "client",
    "plan-no-strategy" to "client",
    "pack-no-variant" to "client",
    "pack-type-unsupported" to "client",
    "pack-type-check-failed" to "client",
    "pack-not-pinned" to "client",
    "pack-not-entitled" to "client",
    "pack-state-unreadable" to "client",
    "pck-directory-refused" to "client",
    "pck-engine-mismatch" to "client",
    "pack-rolled-back" to "client",
    "pack-revoked" to "client",
    "pack-not-data-only" to "client",
    "marker-rejected" to "client",
)

/** Every feature id in the parity registry (conformance/parity/features.json). */
public object Feature {
    public const val coreVerify: String = "core.verify"
    public const val coreCache: String = "core.cache"
    public const val coreBundle: String = "core.bundle"
    public const val coreDiscover: String = "core.discover"
    public const val corePresentation: String = "core.presentation"
    public const val coreSync: String = "core.sync"
    public const val coreLocal: String = "core.local"
    public const val coreHeaders: String = "core.headers"
    public const val coreErrors: String = "core.errors"
    public const val coreCaps: String = "core.caps"
    public const val coreStore: String = "core.store"
    public const val coreCopy: String = "core.copy"
    public const val licenseGate: String = "license.gate"
    public const val licenseActivate: String = "license.activate"
    public const val licenseEnroll: String = "license.enroll"
    public const val licenseDeactivate: String = "license.deactivate"
    public const val licenseManage: String = "license.manage"
    public const val licenseEntitlements: String = "license.entitlements"
    public const val licenseChannels: String = "license.channels"
    public const val licenseReregister: String = "license.reregister"
    public const val licenseRefusals: String = "license.refusals"
    public const val configResolve: String = "config.resolve"
    public const val configList: String = "config.list"
    public const val configSecret: String = "config.secret"
    public const val configSchema: String = "config.schema"
    public const val configMint: String = "config.mint"
    public const val configMirror: String = "config.mirror"
    public const val configLocal: String = "config.local"
    public const val devicesFingerprint: String = "devices.fingerprint"
    public const val devicesFacts: String = "devices.facts"
    public const val devicesRegister: String = "devices.register"
    public const val devicesManage: String = "devices.manage"
    public const val devicesReport: String = "devices.report"
    public const val telemetryUpdates: String = "telemetry.updates"
    public const val devicesAttest: String = "devices.attest"
    public const val identityOidc: String = "identity.oidc"
    public const val identityDevicecode: String = "identity.devicecode"
    public const val identityDevicelabel: String = "identity.devicelabel"
    public const val identityToggle: String = "identity.toggle"
    public const val identityKeyentry: String = "identity.keyentry"
    public const val releaseChangelog: String = "release.changelog"
    public const val releaseDownload: String = "release.download"
    public const val releaseRecord: String = "release.record"
    public const val releaseFetch: String = "release.fetch"
    public const val releaseDistribution: String = "release.distribution"
    public const val updateCheck: String = "update.check"
    public const val updateFeed: String = "update.feed"
    public const val updateFeeds: String = "update.feeds"
    public const val updateDecide: String = "update.decide"
    public const val updateContent: String = "update.content"
    public const val updateDriver: String = "update.driver"
    public const val updateBootguard: String = "update.bootguard"
    public const val outletDetect: String = "outlet.detect"
    public const val crashTags: String = "crash.tags"
    public const val packsRecord: String = "packs.record"
    public const val packsRevoke: String = "packs.revoke"
    public const val packsDelegation: String = "packs.delegation"
    public const val packsDeltaFeed: String = "packs.delta.feed"
    public const val packsPlan: String = "packs.plan"
    public const val packsIndexFiles: String = "packs.index.files"
    public const val packsIndexChunks: String = "packs.index.chunks"
    public const val packsApplyFull: String = "packs.apply.full"
    public const val packsApplyFile: String = "packs.apply.file"
    public const val packsApplyChunk: String = "packs.apply.chunk"
    public const val packsApplyDelta: String = "packs.apply.delta"
    public const val packsState: String = "packs.state"
    public const val packsHandlers: String = "packs.handlers"
    public const val packsTypeGodotZip: String = "packs.type.godot.zip"
    public const val packsTypeL10nTable: String = "packs.type.l10n.table"
    public const val packsTypeDataJson: String = "packs.type.data.json"
    public const val packsTypeAudioBank: String = "packs.type.audio.bank"
    public const val packsTypeMlModel: String = "packs.type.ml.model"
    public const val packsProvides: String = "packs.provides"
    public const val packsTransportApple: String = "packs.transport.apple"
    public const val packsTransportPlay: String = "packs.transport.play"
    public const val packsTransportSteam: String = "packs.transport.steam"
    public const val packsTransportMsix: String = "packs.transport.msix"
    public const val packsTransportFlatpak: String = "packs.transport.flatpak"
    public const val uiStages: String = "ui.stages"
    public const val uiBoot: String = "ui.boot"
    public const val uiKit: String = "ui.kit"
    public const val uiKitManage: String = "ui.kit.manage"
    public const val uiKitKeyentry: String = "ui.kit.keyentry"
    public const val uiCli: String = "ui.cli"
    public const val commerceReceipt: String = "commerce.receipt"
}

/** Every `Feature` value, in source order. */
public val FEATURE_VALUES: List<String> = listOf(
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
    "ui.cli",
    "commerce.receipt",
)

/** Why a feature is unsupported here: the `supports()` reason enum (PARITY §2.2). */
public object UnsupportedReason {
    public const val runtime: String = "runtime"
    public const val outlet: String = "outlet"
    public const val product: String = "product"
    public const val dependency: String = "dependency"
    public const val version: String = "version"
}

/** Every `UnsupportedReason` value, in source order. */
public val UNSUPPORTED_REASON_VALUES: List<String> = listOf(
    "runtime",
    "outlet",
    "product",
    "dependency",
    "version",
)

/** OS family, the canonical `X-PKey-Platform` value (README §3.1). iPadOS is `ios`. `tvos`, `visionos` and `watchos` are header values only; build targets are `RELEASE_PLATFORMS` (WIRE-CONTRACT-V4 §5.2 rule 5). */
public object Platform {
    public const val macos: String = "macos"
    public const val ios: String = "ios"
    public const val android: String = "android"
    public const val windows: String = "windows"
    public const val linux: String = "linux"
    public const val web: String = "web"
    public const val tvos: String = "tvos"
    public const val visionos: String = "visionos"
    public const val watchos: String = "watchos"
}

/** Every `Platform` value, in source order. */
public val PLATFORM_VALUES: List<String> = listOf(
    "macos",
    "ios",
    "android",
    "windows",
    "linux",
    "web",
    "tvos",
    "visionos",
    "watchos",
)

/** CPU architecture, the canonical `X-PKey-Arch` value (README §3.1). `universal` and `any` are artifact values, not header values, and are not listed. */
public object Arch {
    public const val arm64: String = "arm64"
    public const val x86_64: String = "x86_64"
    public const val armv7: String = "armv7"
    public const val wasm32: String = "wasm32"
}

/** Every `Arch` value, in source order. */
public val ARCH_VALUES: List<String> = listOf(
    "arm64",
    "x86_64",
    "armv7",
    "wasm32",
)

/** The canonical X-PKey-SDK value (WIRE-CONTRACT-V3 §5.2): which SDK made the request. The SDK's version is X-PKey-SDK-Version. An SDK adds its id when it lands. */
public object SdkId {
    public const val node: String = "node"
    public const val react: String = "react"
    public const val python: String = "python"
    public const val swift: String = "swift"
    public const val godot: String = "godot"
    public const val kotlin: String = "kotlin"
}

/** Every `SdkId` value, in source order. */
public val SDK_ID_VALUES: List<String> = listOf(
    "node",
    "react",
    "python",
    "swift",
    "godot",
    "kotlin",
)

/** Where a token store keeps the token, the `backend` of `Store.status()` (P1b-09). Mirrors `STORE_BACKENDS` in `@polaris-key/client-core/store`; a test keeps them equal. */
public object StoreBackend {
    public const val keyring: String = "keyring"
    public const val keychain: String = "keychain"
    public const val keystore: String = "keystore"
    public const val file: String = "file"
    public const val memory: String = "memory"
    public const val indexeddb: String = "indexeddb"
    public const val custom: String = "custom"
}

/** Every `StoreBackend` value, in source order. */
public val STORE_BACKEND_VALUES: List<String> = listOf(
    "keyring",
    "keychain",
    "keystore",
    "file",
    "memory",
    "indexeddb",
    "custom",
)

/** Why a token store is weaker than its platform's best option, the `degraded.reason` of `Store.status()` (P1b-09). Mirrors `STORE_DEGRADED_REASONS` in `@polaris-key/client-core/store`; a test keeps them equal. */
public object StoreDegradedReason {
    public const val keyringUnavailable: String = "keyring-unavailable"
    public const val keyringError: String = "keyring-error"
    public const val legacyKeychain: String = "legacy-keychain"
    public const val notPersistent: String = "not-persistent"
}

/** Every `StoreDegradedReason` value, in source order. */
public val STORE_DEGRADED_REASON_VALUES: List<String> = listOf(
    "keyring-unavailable",
    "keyring-error",
    "legacy-keychain",
    "not-persistent",
)

/** The 17 outlet kinds, in `OUTLET_KINDS` order (README §3.1, plans/P3-01.md §2.9). `unknown` is a detection result, not a kind, and is not listed. */
public object OutletKind {
    public const val direct: String = "direct"
    public const val appStore: String = "app-store"
    public const val testflight: String = "testflight"
    public const val altstore: String = "altstore"
    public const val altstorePal: String = "altstore-pal"
    public const val play: String = "play"
    public const val playTesting: String = "play-testing"
    public const val obtainium: String = "obtainium"
    public const val fdroidRepo: String = "fdroid-repo"
    public const val msStore: String = "ms-store"
    public const val appInstaller: String = "app-installer"
    public const val steam: String = "steam"
    public const val itch: String = "itch"
    public const val flathub: String = "flathub"
    public const val snap: String = "snap"
    public const val winget: String = "winget"
    public const val web: String = "web"
}

/** Every `OutletKind` value, in source order. */
public val OUTLET_KIND_VALUES: List<String> = listOf(
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
)

/** How sure outlet detection is, strongest first (`OUTLET_CONFIDENCES`, plans/P3-01.md §2.9). */
public object OutletConfidence {
    public const val attested: String = "attested"
    public const val declared: String = "declared"
    public const val heuristic: String = "heuristic"
    public const val stamp: String = "stamp"
}

/** Every `OutletConfidence` value, in source order. */
public val OUTLET_CONFIDENCE_VALUES: List<String> = listOf(
    "attested",
    "declared",
    "heuristic",
    "stamp",
)

/** How a `direct` install was put on the device, where that changes who updates it (`OUTLET_SUBKINDS`, plans/P3-01.md §2.9). */
public object OutletSubkind {
    public const val homebrew: String = "homebrew"
    public const val npm: String = "npm"
    public const val pnpm: String = "pnpm"
    public const val npx: String = "npx"
    public const val scoop: String = "scoop"
    public const val chocolatey: String = "chocolatey"
    public const val flatpak: String = "flatpak"
    public const val appimage: String = "appimage"
}

/** Every `OutletSubkind` value, in source order. */
public val OUTLET_SUBKIND_VALUES: List<String> = listOf(
    "homebrew",
    "npm",
    "pnpm",
    "npx",
    "scoop",
    "chocolatey",
    "flatpak",
    "appimage",
)

/** The update decision's action (`UPDATE_ACTIONS`, plans/P3-01.md §2.8; `packs` added by plans/P4-13.md §2.6). */
public object UpdateAction {
    public const val none: String = "none"
    public const val codeReady: String = "code-ready"
    public const val binary: String = "binary"
    public const val store: String = "store"
    public const val platform: String = "platform"
    public const val blocked: String = "blocked"
    public const val packs: String = "packs"
}

/** Every `UpdateAction` value, in source order. */
public val UPDATE_ACTION_VALUES: List<String> = listOf(
    "none",
    "code-ready",
    "binary",
    "store",
    "platform",
    "blocked",
    "packs",
)

/** Why the update decision is `none` (`NONE_REASONS`, plans/P3-01.md §2.8). */
public object UpdateNoneReason {
    public const val upToDate: String = "up-to-date"
    public const val behind: String = "behind"
    public const val notAvailable: String = "not-available"
    public const val halted: String = "halted"
    public const val outOfBucket: String = "out-of-bucket"
    public const val stale: String = "stale"
    public const val skipped: String = "skipped"
    public const val noMethod: String = "no-method"
    public const val noBuild: String = "no-build"
    public const val unknownVersion: String = "unknown-version"
}

/** Every `UpdateNoneReason` value, in source order. */
public val UPDATE_NONE_REASON_VALUES: List<String> = listOf(
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
)

/** Why the update decision is `blocked` (`BLOCKED_REASONS`, plans/P3-01.md §2.8; `content-floor` and `revoked-content` added by plans/P4-13.md §2.6). */
public object UpdateBlockedReason {
    public const val appFloor: String = "app-floor"
    public const val contentFloor: String = "content-floor"
    public const val revokedContent: String = "revoked-content"
}

/** Every `UpdateBlockedReason` value, in source order. */
public val UPDATE_BLOCKED_REASON_VALUES: List<String> = listOf(
    "app-floor",
    "content-floor",
    "revoked-content",
)

/** How a `binary` decision installs the new build (`BINARY_METHODS`, plans/P3-01.md §2.8). */
public object BinaryMethod {
    public const val native: String = "native"
    public const val download: String = "download"
    public const val sidecarPck: String = "sidecar-pck"
}

/** Every `BinaryMethod` value, in source order. */
public val BINARY_METHOD_VALUES: List<String> = listOf(
    "native",
    "download",
    "sidecar-pck",
)

/** The update telemetry event names on the unsigned `devices/report` (plans/P3-01.md §2.10). The shapes and the Worker allowlist are P6-03's. */
public object UpdateEvent {
    public const val updateOffered: String = "update_offered"
    public const val updateDownloaded: String = "update_downloaded"
    public const val updateApplied: String = "update_applied"
    public const val updateConfirmed: String = "update_confirmed"
    public const val updateReverted: String = "update_reverted"
    public const val packFailed: String = "pack_failed"
    public const val bootRolledBack: String = "boot_rolled_back"
}

/** Every `UpdateEvent` value, in source order. */
public val UPDATE_EVENT_VALUES: List<String> = listOf(
    "update_offered",
    "update_downloaded",
    "update_applied",
    "update_confirmed",
    "update_reverted",
    "pack_failed",
    "boot_rolled_back",
)

/** The pack types a v1 SDK can hold (`PACK_TYPES`, plans/P4-01.md §2.2): `files.tree` everywhere, `godot.pck` in Godot. A record may name any `PACK_TYPE_PATTERN` type; an unknown one makes the pack unusable (`pack-type-unsupported`). */
public object PackType {
    public const val godotPck: String = "godot.pck"
    public const val filesTree: String = "files.tree"
}

/** Every `PackType` value, in source order. */
public val PACK_TYPE_VALUES: List<String> = listOf(
    "godot.pck",
    "files.tree",
)

/** An app record's `content.expects[].delivery` (`PACK_DELIVERIES`, plans/P4-01.md §2.4). Any other `VOCAB_TOKEN_PATTERN` value is read as `on-demand`. */
public object PackDelivery {
    public const val essential: String = "essential"
    public const val prefetch: String = "prefetch"
    public const val onDemand: String = "on-demand"
}

/** Every `PackDelivery` value, in source order. */
public val PACK_DELIVERY_VALUES: List<String> = listOf(
    "essential",
    "prefetch",
    "on-demand",
)

/** A pack record's `handler.activation` (`PACK_ACTIVATIONS`, plans/P4-01.md §2.3). An unknown value makes the pack unusable. */
public object PackActivation {
    public const val restart: String = "restart"
    public const val hot: String = "hot"
}

/** Every `PackActivation` value, in source order. */
public val PACK_ACTIVATION_VALUES: List<String> = listOf(
    "restart",
    "hot",
)

/** A pack variant's `files.layout` (`FILES_LAYOUTS`, plans/P4-01.md §2.3): a single-file payload with offsets and gaps, or a directory of files. An unknown layout makes the variant unusable. */
public object FilesLayout {
    public const val container: String = "container"
    public const val tree: String = "tree"
}

/** Every `FilesLayout` value, in source order. */
public val FILES_LAYOUT_VALUES: List<String> = listOf(
    "container",
    "tree",
)

/** An object ref's `codec` (`CONTENT_CODECS`, plans/P4-01.md §2.3): one zstd frame with its content size, or stored raw (`bytes === size`). An unknown codec makes that object unusable. */
public object ContentCodec {
    public const val zstd: String = "zstd"
    public const val none: String = "none"
}

/** Every `ContentCodec` value, in source order. */
public val CONTENT_CODEC_VALUES: List<String> = listOf(
    "zstd",
    "none",
)

/** A pack delta's `method` v1 applies (`PATCH_METHODS`, plans/P4-01.md §2.3). `godot-delta-pck`, `hdiffpatch` and `bsdiff` are reserved and not listed; an unknown method makes the delta infeasible. */
public object PatchMethod {
    public const val zstdPatchFrom: String = "zstd-patch-from"
}

/** Every `PatchMethod` value, in source order. */
public val PATCH_METHOD_VALUES: List<String> = listOf(
    "zstd-patch-from",
)

/** A pack delta's `scope` (`PATCH_SCOPES`, plans/P4-01.md §2.3): the whole payload, or the per-entry set. A delta of another scope is dropped. */
public object PatchScope {
    public const val payload: String = "payload"
    public const val files: String = "files"
}

/** Every `PatchScope` value, in source order. */
public val PATCH_SCOPE_VALUES: List<String> = listOf(
    "payload",
    "files",
)

/** The variant axis names a v1 manifest may declare (`VARIANT_AXES`, plans/P4-01.md §2.2). A record may name any `VARIANT_AXIS_PATTERN` axis; a variant on an axis the host has no preferences for is ineligible. */
public object VariantAxis {
    public const val texture: String = "texture"
    public const val locale: String = "locale"
    public const val quality: String = "quality"
}

/** Every `VariantAxis` value, in source order. */
public val VARIANT_AXIS_VALUES: List<String> = listOf(
    "texture",
    "locale",
    "quality",
)

/** The install planner's strategies (plans/P4-01.md §2.9, A7 §4.2): a plan result's `strategy` and a host's `caps.strategies`. `plan-matrix.json` pins them. */
public object PatchStrategy {
    public const val noop: String = "noop"
    public const val platform: String = "platform"
    public const val delta: String = "delta"
    public const val chunk: String = "chunk"
    public const val file: String = "file"
    public const val full: String = "full"
}

/** Every `PatchStrategy` value, in source order. */
public val PATCH_STRATEGY_VALUES: List<String> = listOf(
    "noop",
    "platform",
    "delta",
    "chunk",
    "file",
    "full",
)

/** How a deliverable's bytes arrive (`TRANSPORTS` in `@polaris-key/manifest`, P2b-02; README §3.1): the planner's `caps.transports` and a platform target's `transport` (plans/P4-01.md §2.9). */
public object Transport {
    public const val embedded: String = "embedded"
    public const val pkeyCdn: String = "pkey-cdn"
    public const val appleBa: String = "apple-ba"
    public const val playPad: String = "play-pad"
    public const val steamDepot: String = "steam-depot"
    public const val msixOptional: String = "msix-optional"
    public const val flatpakExt: String = "flatpak-ext"
    public const val web: String = "web"
}

/** Every `Transport` value, in source order. */
public val TRANSPORT_VALUES: List<String> = listOf(
    "embedded",
    "pkey-cdn",
    "apple-ba",
    "play-pad",
    "steam-depot",
    "msix-optional",
    "flatpak-ext",
    "web",
)

/** The pack types a delegated content key may sign (`DELEGABLE_PACK_TYPES`, plans/P4-19.md §2.5, decision 5). A delegation's `types` outside this list are ignored; `godot.pck`, `godot.zip`, `audio.bank`, `ml.model` and `custom.*` are never delegable. `delegationCases` pins them. */
public object DelegablePackType {
    public const val filesTree: String = "files.tree"
    public const val dataJson: String = "data.json"
    public const val l10nTable: String = "l10n.table"
}

/** Every `DelegablePackType` value, in source order. */
public val DELEGABLE_PACK_TYPE_VALUES: List<String> = listOf(
    "files.tree",
    "data.json",
    "l10n.table",
)

/** The file extensions a delegated install may hold (`DATA_ONLY_EXTENSIONS`, plans/P4-19.md §2.5 rule 2): the final segment's text after its last `.`, ASCII-lowercased. An allow-list: anything else is refused (`pack-not-data-only`, rule `extension`). `dataOnlyCases` pins them. */
public object DataOnlyExtension {
    public const val json: String = "json"
    public const val csv: String = "csv"
    public const val tsv: String = "tsv"
    public const val po: String = "po"
    public const val txt: String = "txt"
    public const val png: String = "png"
    public const val jpg: String = "jpg"
    public const val jpeg: String = "jpeg"
    public const val webp: String = "webp"
    public const val ogg: String = "ogg"
    public const val wav: String = "wav"
    public const val mp3: String = "mp3"
    public const val ttf: String = "ttf"
    public const val otf: String = "otf"
}

/** Every `DataOnlyExtension` value, in source order. */
public val DATA_ONLY_EXTENSION_VALUES: List<String> = listOf(
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
)

/** Every gate status a licence evaluates to (`LicenseStatus` in `@polaris-key/protocol/license`, `client-core`'s gate). A tools/gen-sdk-constants.test.ts case keeps them equal; `copy.en.json`'s `gate` keys equal it (plans/SP-00.md §4). Every value, in source order. */
public val LICENSE_STATUS_VALUES: List<String> = listOf(
    "ok",
    "grace",
    "expired",
    "revoked",
    "needs-activation",
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
    "not-applicable",
)

/** The typed activation results of `license.activate` and `license.enroll` (SDK-PARITY-PASS §3.1), in the transcript (kebab) form; each SDK spells its own kinds in its casing. `copy.en.json`'s `activation` keys equal it (plans/SP-00.md §4). Every value, in source order. */
public val ACTIVATION_RESULT_VALUES: List<String> = listOf(
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
)

/** The `X-PKey-*` request header names (wire contract v3 §5). */
public object HeaderName {
    public const val arch: String = "X-PKey-Arch"
    public const val channel: String = "X-PKey-Channel"
    public const val device: String = "X-PKey-Device"
    public const val platform: String = "X-PKey-Platform"
    public const val sdkName: String = "X-PKey-SDK"
    public const val sdkVersion: String = "X-PKey-SDK-Version"
    public const val version: String = "X-PKey-Version"
}

/** Every `HeaderName` value, in source order. */
public val HEADER_NAME_VALUES: List<String> = listOf(
    "X-PKey-Arch",
    "X-PKey-Channel",
    "X-PKey-Device",
    "X-PKey-Platform",
    "X-PKey-SDK",
    "X-PKey-SDK-Version",
    "X-PKey-Version",
)

/** The wire contract version (`@polaris-key/protocol/core`). */
public const val PROTOCOL_VERSION: Int = 4

/** `corpusVersion` of conformance/corpus/v2/cases.json. */
public const val CORPUS_VERSION: Int = 2

/** `gateMatrixVersion` of conformance/corpus/v2/gate-matrix.json. */
public const val GATE_MATRIX_VERSION: Int = 2

/** `fingerprintVersion` of conformance/corpus/v2/fingerprint.json. */
public const val FINGERPRINT_VERSION: Int = 1

/** `stageMatrixVersion` of conformance/corpus/v2/stage-matrix.json. */
public const val STAGE_MATRIX_VERSION: Int = 3

/** `updateMatrixVersion` of conformance/corpus/v2/update-matrix.json. */
public const val UPDATE_MATRIX_VERSION: Int = 1

/** `outletMatrixVersion` of conformance/corpus/v2/outlet-matrix.json. */
public const val OUTLET_MATRIX_VERSION: Int = 1

/** `planMatrixVersion` of conformance/corpus/v2/plan-matrix.json. */
public const val PLAN_MATRIX_VERSION: Int = 2

/** `syncScenariosVersion` of conformance/corpus/v2/sync-scenarios.json. */
public const val SYNC_SCENARIOS_VERSION: Int = 1

/** `deviceLabelVersion` of conformance/corpus/v2/device-label.json. */
public const val DEVICE_LABEL_VERSION: Int = 1

/** `presentationMatrixVersion` of conformance/corpus/v2/presentation-matrix.json. */
public const val PRESENTATION_MATRIX_VERSION: Int = 1

/** `contentCorpusVersion` of conformance/corpus/v2/content/cases.json. */
public const val CONTENT_CORPUS_VERSION: Int = 2

/** Wire contract v4 limit `MAX_WIRE_INTEGER` (`@polaris-key/protocol/core`). */
public const val MAX_WIRE_INTEGER: Long = 9007199254740991L

/** Wire contract v4 limit `MAX_JSON_DEPTH` (`@polaris-key/protocol/core`). */
public const val MAX_JSON_DEPTH: Int = 64

/** Wire contract v4 limit `MAX_RECORD_JWS_BYTES` (`@polaris-key/protocol/core`). */
public const val MAX_RECORD_JWS_BYTES: Int = 88844

/** Wire contract v4 limit `MAX_FEED_REVOCATIONS` (`@polaris-key/protocol/core`). */
public const val MAX_FEED_REVOCATIONS: Int = 64

/** Wire contract v4 limit `REVOCATION_REASON_MAX_BYTES` (`@polaris-key/protocol/core`). */
public const val REVOCATION_REASON_MAX_BYTES: Int = 512

/** Wire contract v4 limit `MAX_FEED_DELTAS` (`@polaris-key/protocol/core`). */
public const val MAX_FEED_DELTAS: Int = 64

/** Wire contract v4 limit `MAX_FEED_DELTAS_PER_TARGET` (`@polaris-key/protocol/core`). */
public const val MAX_FEED_DELTAS_PER_TARGET: Int = 4

/** Wire contract v4 limit `MAX_DELEGATION_TTL_SECONDS` (`@polaris-key/protocol/core`). */
public const val MAX_DELEGATION_TTL_SECONDS: Int = 31622400

/** Wire contract v4 limit `MAX_DELEGATION_TYPES` (`@polaris-key/protocol/core`). */
public const val MAX_DELEGATION_TYPES: Int = 8

/** Wire contract v4 limit `DATA_ONLY_HEAD_BYTES` (`@polaris-key/protocol/core`). */
public const val DATA_ONLY_HEAD_BYTES: Int = 64

/** Wire contract v4 limit `DATA_ONLY_TAIL_BYTES` (`@polaris-key/protocol/core`). */
public const val DATA_ONLY_TAIL_BYTES: Int = 65557

/** Wire contract v4 limit `MAX_DELEGATIONS_PER_CHECK` (`@polaris-key/protocol/core`). */
public const val MAX_DELEGATIONS_PER_CHECK: Int = 16

/** Packs on the wire: `MAX_PACK_VARIANTS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val MAX_PACK_VARIANTS: Int = 32

/** Packs on the wire: `MAX_VARIANT_DELTAS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val MAX_VARIANT_DELTAS: Int = 16

/** Packs on the wire: `MAX_CONTENT_PINS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val MAX_CONTENT_PINS: Int = 256

/** Packs on the wire: `MAX_BUILD_EMBEDS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val MAX_BUILD_EMBEDS: Int = 64

/** Packs on the wire: `MAX_INDEX_FILES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val MAX_INDEX_FILES: Int = 100000

/** Packs on the wire: `MAX_FILES_INDEX_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val MAX_FILES_INDEX_BYTES: Int = 33554432

/** Packs on the wire: `MAX_PACK_PATH_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val MAX_PACK_PATH_BYTES: Int = 1024

/** Packs on the wire: `FILES_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val FILES_FORMAT: String = "pkey-files/1"

/** Packs on the wire: `PATCH_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val PATCH_FORMAT: String = "pkey-patch/1"

/** Packs on the wire: `MARKER_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val MARKER_FORMAT: String = "pkey-marker/1"

/** Packs on the wire: `CONTENT_STAMP_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val CONTENT_STAMP_FORMAT: String = "pkey-content/1"

/** Packs on the wire: `PLAN_REQUEST_WEIGHT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`). */
public const val PLAN_REQUEST_WEIGHT: Int = 16384

/** Packs on the wire: `CHUNKS_FORMAT` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`). */
public const val CHUNKS_FORMAT: String = "pkey-chunks/1"

/** Packs on the wire: `MAX_CHUNK_INDEX_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`). */
public const val MAX_CHUNK_INDEX_BYTES: Int = 16777216

/** Packs on the wire: `MAX_CHUNK_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`). */
public const val MAX_CHUNK_BYTES: Int = 4194304

/** Identity passthrough: `DEVICE_LABEL_MAX_CODEPOINTS` (WIRE-CONTRACT-V4 §12.7, `@polaris-key/protocol/identity`). */
public const val DEVICE_LABEL_MAX_CODEPOINTS: Int = 64

/** Identity passthrough: `REQUEST_HANDLE_PATTERN` (WIRE-CONTRACT-V4 §12.7, `@polaris-key/protocol/identity`). */
public const val REQUEST_HANDLE_PATTERN: String = "^rq_[A-Za-z0-9_-]{22}\$"

/** Identity passthrough: `REQUEST_HANDLE_TTL_SECONDS` (WIRE-CONTRACT-V4 §12.7, `@polaris-key/protocol/identity`). */
public const val REQUEST_HANDLE_TTL_SECONDS: Int = 600

/** Product presentation: `PRESENTATION_TEXT_MAX_BYTES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`). */
public const val PRESENTATION_TEXT_MAX_BYTES: Int = 1024

/** Product presentation: `PRESENTATION_URL_MAX_BYTES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`). */
public const val PRESENTATION_URL_MAX_BYTES: Int = 2048

/** Product presentation: `PRESENTATION_MAX_ICON_SIZES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`). */
public const val PRESENTATION_MAX_ICON_SIZES: Int = 8

/** Product presentation: `PRESENTATION_MAX_ICON_WIDTH` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`). */
public const val PRESENTATION_MAX_ICON_WIDTH: Int = 4096

/** Product presentation: `PRESENTATION_ICON_MAX_DIMENSION` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`). */
public const val PRESENTATION_ICON_MAX_DIMENSION: Int = 16384

/** Product presentation: `PRESENTATION_ICON_MAX_BYTES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`). */
public const val PRESENTATION_ICON_MAX_BYTES: Int = 10485760

/** Product presentation: `PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`). */
public const val PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS: Int = 10

/** Product presentation: `PRESENTATION_CACHE_MAX_FILES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`). */
public const val PRESENTATION_CACHE_MAX_FILES: Int = 4

/** Product presentation: `PRESENTATION_ICON_TYPES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`). */
public val PRESENTATION_ICON_TYPES: List<String> = listOf("image/avif", "image/gif", "image/jpeg", "image/png", "image/webp")

/** Channel constant `CHANNEL_ALIASES` (`@polaris-key/protocol/core`). */
public val CHANNEL_ALIASES: Map<String, String> = mapOf(
    "staging" to "beta",
    "latest" to "stable",
)

/** Channel constant `CHANNEL_BETA` (`@polaris-key/protocol/core`). */
public const val CHANNEL_BETA: String = "beta"

/** Channel constant `CHANNEL_DEV` (`@polaris-key/protocol/core`). */
public const val CHANNEL_DEV: String = "dev"

/** Channel constant `CHANNEL_NAME_PATTERN` (`@polaris-key/protocol/core`). */
public const val CHANNEL_NAME_PATTERN: String = "^[a-z0-9][a-z0-9-]{0,63}\$"

/** Channel constant `CHANNEL_PR` (`@polaris-key/protocol/core`). */
public const val CHANNEL_PR: String = "pr"

/** Channel constant `CHANNEL_STABLE` (`@polaris-key/protocol/core`). */
public const val CHANNEL_STABLE: String = "stable"

/** Channel constant `PR_CHANNEL_PATTERN` (`@polaris-key/protocol/core`). */
public const val PR_CHANNEL_PATTERN: String = "^pr-?([0-9]+)\$"

/** Channel constant `PR_NUMBER_MAX_DIGITS` (`@polaris-key/protocol/core`). */
public const val PR_NUMBER_MAX_DIGITS: Int = 7

/** Header-value table `ARCH_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`). */
public val ARCH_SPELLINGS: Map<String, String> = mapOf(
    "arm64" to "arm64",
    "aarch64" to "arm64",
    "arm64-v8a" to "arm64",
    "x86_64" to "x86_64",
    "x64" to "x86_64",
    "amd64" to "x86_64",
    "armv7" to "armv7",
    "armv7l" to "armv7",
    "armv8l" to "armv7",
    "arm" to "armv7",
    "arm32" to "armv7",
    "armeabi-v7a" to "armv7",
    "wasm32" to "wasm32",
)

/** Header-value table `PLATFORM_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`). */
public val PLATFORM_SPELLINGS: Map<String, String> = mapOf(
    "macos" to "macos",
    "darwin" to "macos",
    "maccatalyst" to "macos",
    "ios" to "ios",
    "ipados" to "ios",
    "android" to "android",
    "windows" to "windows",
    "win32" to "windows",
    "linux" to "linux",
    "web" to "web",
    "browser" to "web",
    "tvos" to "tvos",
    "visionos" to "visionos",
    "watchos" to "watchos",
)

/** One declared N/A: on `runtime`, the feature is unsupported for `reason`. */
public data class CapabilityNa(val runtime: String, val reason: String)

/** One feature's row in `CAPABILITIES`. */
public data class CapabilityRow(val status: String, val service: String, val na: List<CapabilityNa>)

/** The parity-registry id of the SDK this module belongs to. */
public const val CAPABILITY_SDK: String = "kotlin"

/** The runtimes this SDK's manifest lists. */
public val CAPABILITY_RUNTIMES: List<String> = listOf("android", "jvm")

/** This SDK's capability table, generated from its parity manifest (tools/capabilities.ts): per feature, the manifest's status, the owning service and every declared (runtime, reason) N/A. `supports()` reads it (P1b-10, PARITY §2.2). */
public val CAPABILITIES: Map<String, CapabilityRow> = mapOf(
    "core.verify" to CapabilityRow("implemented", "core", listOf()),
    "core.cache" to CapabilityRow("implemented", "core", listOf()),
    "core.bundle" to CapabilityRow("implemented", "core", listOf()),
    "core.discover" to CapabilityRow("implemented", "core", listOf()),
    "core.presentation" to CapabilityRow("planned", "core", listOf()),
    "core.sync" to CapabilityRow("implemented", "core", listOf()),
    "core.local" to CapabilityRow("implemented", "core", listOf()),
    "core.headers" to CapabilityRow("implemented", "core", listOf()),
    "core.errors" to CapabilityRow("implemented", "core", listOf()),
    "core.caps" to CapabilityRow("implemented", "core", listOf()),
    "core.store" to CapabilityRow("implemented", "core", listOf(CapabilityNa("jvm", "dependency"))),
    "core.copy" to CapabilityRow("implemented", "sdk", listOf()),
    "license.gate" to CapabilityRow("implemented", "license", listOf()),
    "license.activate" to CapabilityRow("implemented", "license", listOf()),
    "license.enroll" to CapabilityRow("implemented", "license", listOf()),
    "license.deactivate" to CapabilityRow("implemented", "license", listOf()),
    "license.manage" to CapabilityRow("implemented", "license", listOf()),
    "license.entitlements" to CapabilityRow("implemented", "license", listOf()),
    "license.channels" to CapabilityRow("implemented", "license", listOf()),
    "license.reregister" to CapabilityRow("implemented", "license", listOf()),
    "license.refusals" to CapabilityRow("implemented", "license", listOf()),
    "config.resolve" to CapabilityRow("implemented", "config", listOf()),
    "config.list" to CapabilityRow("implemented", "config", listOf()),
    "config.secret" to CapabilityRow("implemented", "config", listOf()),
    "config.schema" to CapabilityRow("implemented", "config", listOf()),
    "config.mint" to CapabilityRow("implemented", "config", listOf()),
    "config.mirror" to CapabilityRow("implemented", "config", listOf()),
    "config.local" to CapabilityRow("implemented", "sdk", listOf()),
    "devices.fingerprint" to CapabilityRow("implemented", "core", listOf()),
    "devices.facts" to CapabilityRow("implemented", "core", listOf()),
    "devices.register" to CapabilityRow("implemented", "core", listOf()),
    "devices.manage" to CapabilityRow("implemented", "core", listOf()),
    "devices.report" to CapabilityRow("implemented", "core", listOf()),
    "telemetry.updates" to CapabilityRow("implemented", "core", listOf()),
    "devices.attest" to CapabilityRow("implemented", "core", listOf(CapabilityNa("jvm", "runtime"), CapabilityNa("android", "outlet"))),
    "identity.oidc" to CapabilityRow("planned", "identity", listOf()),
    "identity.devicecode" to CapabilityRow("implemented", "identity", listOf()),
    "identity.devicelabel" to CapabilityRow("implemented", "identity", listOf()),
    "identity.toggle" to CapabilityRow("planned", "identity", listOf()),
    "identity.keyentry" to CapabilityRow("planned", "identity", listOf()),
    "release.changelog" to CapabilityRow("implemented", "release", listOf()),
    "release.download" to CapabilityRow("implemented", "release", listOf()),
    "release.record" to CapabilityRow("implemented", "release", listOf()),
    "release.fetch" to CapabilityRow("implemented", "distribution", listOf()),
    "release.distribution" to CapabilityRow("implemented", "distribution", listOf()),
    "update.check" to CapabilityRow("implemented", "update", listOf()),
    "update.feed" to CapabilityRow("implemented", "update", listOf()),
    "update.feeds" to CapabilityRow("implemented", "update", listOf()),
    "update.decide" to CapabilityRow("implemented", "update", listOf()),
    "update.content" to CapabilityRow("implemented", "update", listOf()),
    "update.driver" to CapabilityRow("implemented", "update", listOf()),
    "update.bootguard" to CapabilityRow("implemented", "update", listOf()),
    "outlet.detect" to CapabilityRow("implemented", "update", listOf()),
    "crash.tags" to CapabilityRow("implemented", "sdk", listOf()),
    "packs.record" to CapabilityRow("implemented", "release", listOf()),
    "packs.revoke" to CapabilityRow("implemented", "release", listOf()),
    "packs.delegation" to CapabilityRow("implemented", "release", listOf()),
    "packs.delta.feed" to CapabilityRow("implemented", "release", listOf()),
    "packs.plan" to CapabilityRow("implemented", "release", listOf()),
    "packs.index.files" to CapabilityRow("implemented", "release", listOf()),
    "packs.index.chunks" to CapabilityRow("implemented", "release", listOf()),
    "packs.apply.full" to CapabilityRow("implemented", "release", listOf()),
    "packs.apply.file" to CapabilityRow("implemented", "release", listOf()),
    "packs.apply.chunk" to CapabilityRow("implemented", "release", listOf()),
    "packs.apply.delta" to CapabilityRow("implemented", "release", listOf(CapabilityNa("android", "dependency"), CapabilityNa("jvm", "dependency"))),
    "packs.state" to CapabilityRow("implemented", "release", listOf()),
    "packs.handlers" to CapabilityRow("implemented", "release", listOf()),
    "packs.type.godot.zip" to CapabilityRow("na", "release", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "packs.type.l10n.table" to CapabilityRow("implemented", "release", listOf()),
    "packs.type.data.json" to CapabilityRow("implemented", "release", listOf()),
    "packs.type.audio.bank" to CapabilityRow("na", "release", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "packs.type.ml.model" to CapabilityRow("implemented", "release", listOf()),
    "packs.provides" to CapabilityRow("implemented", "release", listOf()),
    "packs.transport.apple" to CapabilityRow("na", "distribution", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "packs.transport.play" to CapabilityRow("implemented", "distribution", listOf(CapabilityNa("jvm", "runtime"))),
    "packs.transport.steam" to CapabilityRow("planned", "distribution", listOf(CapabilityNa("android", "runtime"))),
    "packs.transport.msix" to CapabilityRow("na", "distribution", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "packs.transport.flatpak" to CapabilityRow("na", "distribution", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "ui.stages" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.boot" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.kit" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.kit.manage" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.kit.keyentry" to CapabilityRow("planned", "sdk", listOf()),
    "ui.cli" to CapabilityRow("na", "sdk", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "commerce.receipt" to CapabilityRow("implemented", "license", listOf()),
)

/** SHA-256 of the canonical table; `pnpm parity:check` recomputes it from the manifest. */
public const val CAPABILITY_DIGEST: String = "30a1e43428f178b2bf1be5153343056578f0cf823b6fcfa5559265c0f0874e21"
