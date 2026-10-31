// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen constants` (tools/gen-sdk-constants.ts) from conformance/parity/
// errors.json, enums.json and features.json, tools/services.json, @polaris-key/protocol/core
// and the conformance corpus. `pnpm gen constants --check` fails the green gate on any
// difference. To change a constant, edit its source and regenerate.

// `ServiceSlug` is not here: ServiceSlug.generated.kt (pnpm gen services) declares it.

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
    public const val signingUnavailable: String = "signing_unavailable"
    public const val deviceKeysInvalid: String = "device_keys_invalid"
    public const val deviceKeysRequired: String = "device_keys_required"
    public const val ringTooLarge: String = "ring_too_large"
    public const val relayDisabled: String = "relay_disabled"
    public const val relayPaused: String = "relay_paused"
    public const val relayQuotaExceeded: String = "relay_quota_exceeded"
    public const val relayTicketInvalid: String = "relay_ticket_invalid"
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
    public const val erasureLedgerUnavailable: String = "erasure_ledger_unavailable"
    public const val identityDisabled: String = "identity_disabled"
    public const val unknownApp: String = "unknown_app"
    public const val invalidRequest: String = "invalid_request"
    public const val invalidClient: String = "invalid_client"
    public const val invalidGrant: String = "invalid_grant"
    public const val unsupportedGrantType: String = "unsupported_grant_type"
    public const val invalidScope: String = "invalid_scope"
    public const val redirectUriMismatch: String = "redirect_uri_mismatch"
    public const val licenseChoiceRequired: String = "license_choice_required"
    public const val interstitialRequired: String = "interstitial_required"
    public const val notNearby: String = "not_nearby"
    public const val authMethodDisabled: String = "auth_method_disabled"
    public const val emailUnavailable: String = "email_unavailable"
    public const val turnstileFailed: String = "turnstile_failed"
    public const val signinExpired: String = "signin_expired"
    public const val invalidCode: String = "invalid_code"
    public const val codeExpired: String = "code_expired"
    public const val emailInUse: String = "email_in_use"
    public const val termsRequired: String = "terms_required"
    public const val licenseOwned: String = "license_owned"
    public const val licenseEmailBound: String = "license_email_bound"
    public const val accountRequired: String = "account_required"
    public const val cursorExpired: String = "cursor_expired"
    public const val clientMismatch: String = "client_mismatch"
    public const val valueInvalid: String = "value_invalid"
    public const val opInvalidForPolicy: String = "op_invalid_for_policy"
    public const val settingNotSynced: String = "setting_not_synced"
    public const val collectionUnknown: String = "collection_unknown"
    public const val entitlementRequired: String = "entitlement_required"
    public const val quotaExceeded: String = "quota_exceeded"
    public const val writesPaused: String = "writes_paused"
    public const val encryptionMismatch: String = "encryption_mismatch"
    public const val revisionConflict: String = "revision_conflict"
    public const val uploadMismatch: String = "upload_mismatch"
    public const val uploadExpired: String = "upload_expired"
    public const val uploadIncomplete: String = "upload_incomplete"
    public const val fileTooLarge: String = "file_too_large"
    public const val keyringConflict: String = "keyring_conflict"
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
    public const val backendOriginNotAllowed: String = "backend-origin-not-allowed"
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
    public const val deviceKeysUnreadable: String = "device-keys-unreadable"
    public const val deviceKeyStoreError: String = "device-key-store-error"
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
    public const val platformIdentityUnavailable: String = "platform-identity-unavailable"
    public const val syncLocked: String = "sync-locked"
    public const val recoveryCodeInvalid: String = "recovery-code-invalid"
    public const val syncEncryptionPinned: String = "sync-encryption-pinned"
    public const val syncFileInvalid: String = "sync-file-invalid"
    public const val invalidOptions: String = "invalid-options"
    public const val invalidArgument: String = "invalid-argument"
    public const val invokeNotAllowed: String = "invoke-not-allowed"
    public const val senderRefused: String = "sender-refused"
    public const val notConfigured: String = "not-configured"
    public const val unsupported: String = "unsupported"
    public const val timeout: String = "timeout"
    public const val responseTooLarge: String = "response-too-large"
    public const val tooManyRedirects: String = "too-many-redirects"
    public const val insecureRedirect: String = "insecure-redirect"
    public const val httpError: String = "http-error"
    public const val invalidResponse: String = "invalid-response"
    public const val storeFailed: String = "store-failed"
    public const val connectUnavailable: String = "connect-unavailable"
    public const val peerCertInvalid: String = "peer-cert-invalid"
    public const val nearbyPermissionDenied: String = "nearby-permission-denied"
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
    public const val attachDeclined: String = "attach-declined"
    public const val licenseRequired: String = "license_required"
    public const val licenseInvalid: String = "license_invalid"
    public const val licenseStale: String = "license_stale"
    public const val signInRequired: String = "sign_in_required"
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
    "signing_unavailable",
    "device_keys_invalid",
    "device_keys_required",
    "ring_too_large",
    "relay_disabled",
    "relay_paused",
    "relay_quota_exceeded",
    "relay_ticket_invalid",
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
    "erasure_ledger_unavailable",
    "identity_disabled",
    "unknown_app",
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unsupported_grant_type",
    "invalid_scope",
    "redirect_uri_mismatch",
    "license_choice_required",
    "interstitial_required",
    "not_nearby",
    "auth_method_disabled",
    "email_unavailable",
    "turnstile_failed",
    "signin_expired",
    "invalid_code",
    "code_expired",
    "email_in_use",
    "terms_required",
    "license_owned",
    "license_email_bound",
    "account_required",
    "cursor_expired",
    "client_mismatch",
    "value_invalid",
    "op_invalid_for_policy",
    "setting_not_synced",
    "collection_unknown",
    "entitlement_required",
    "quota_exceeded",
    "writes_paused",
    "encryption_mismatch",
    "revision_conflict",
    "upload_mismatch",
    "upload_expired",
    "upload_incomplete",
    "file_too_large",
    "keyring_conflict",
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
    "backend-origin-not-allowed",
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
    "device-keys-unreadable",
    "device-key-store-error",
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
    "platform-identity-unavailable",
    "sync-locked",
    "recovery-code-invalid",
    "sync-encryption-pinned",
    "sync-file-invalid",
    "invalid-options",
    "invalid-argument",
    "invoke-not-allowed",
    "sender-refused",
    "not-configured",
    "unsupported",
    "timeout",
    "response-too-large",
    "too-many-redirects",
    "insecure-redirect",
    "http-error",
    "invalid-response",
    "store-failed",
    "connect-unavailable",
    "peer-cert-invalid",
    "nearby-permission-denied",
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
    "attach-declined",
    "license_required",
    "license_invalid",
    "license_stale",
    "sign_in_required",
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
    "signing_unavailable" to "wire",
    "device_keys_invalid" to "wire",
    "device_keys_required" to "wire",
    "ring_too_large" to "wire",
    "relay_disabled" to "wire",
    "relay_paused" to "wire",
    "relay_quota_exceeded" to "wire",
    "relay_ticket_invalid" to "wire",
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
    "erasure_ledger_unavailable" to "wire",
    "identity_disabled" to "wire",
    "unknown_app" to "wire",
    "invalid_request" to "wire",
    "invalid_client" to "wire",
    "invalid_grant" to "wire",
    "unsupported_grant_type" to "wire",
    "invalid_scope" to "wire",
    "redirect_uri_mismatch" to "wire",
    "license_choice_required" to "wire",
    "interstitial_required" to "wire",
    "not_nearby" to "wire",
    "auth_method_disabled" to "wire",
    "email_unavailable" to "wire",
    "turnstile_failed" to "wire",
    "signin_expired" to "wire",
    "invalid_code" to "wire",
    "code_expired" to "wire",
    "email_in_use" to "wire",
    "terms_required" to "wire",
    "license_owned" to "wire",
    "license_email_bound" to "wire",
    "account_required" to "wire",
    "cursor_expired" to "wire",
    "client_mismatch" to "wire",
    "value_invalid" to "wire",
    "op_invalid_for_policy" to "wire",
    "setting_not_synced" to "wire",
    "collection_unknown" to "wire",
    "entitlement_required" to "wire",
    "quota_exceeded" to "wire",
    "writes_paused" to "wire",
    "encryption_mismatch" to "wire",
    "revision_conflict" to "wire",
    "upload_mismatch" to "wire",
    "upload_expired" to "wire",
    "upload_incomplete" to "wire",
    "file_too_large" to "wire",
    "keyring_conflict" to "wire",
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
    "backend-origin-not-allowed" to "client",
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
    "device-keys-unreadable" to "client",
    "device-key-store-error" to "client",
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
    "platform-identity-unavailable" to "client",
    "sync-locked" to "client",
    "recovery-code-invalid" to "client",
    "sync-encryption-pinned" to "client",
    "sync-file-invalid" to "client",
    "invalid-options" to "client",
    "invalid-argument" to "client",
    "invoke-not-allowed" to "client",
    "sender-refused" to "client",
    "not-configured" to "client",
    "unsupported" to "client",
    "timeout" to "client",
    "response-too-large" to "client",
    "too-many-redirects" to "client",
    "insecure-redirect" to "client",
    "http-error" to "client",
    "invalid-response" to "client",
    "store-failed" to "client",
    "connect-unavailable" to "client",
    "peer-cert-invalid" to "client",
    "nearby-permission-denied" to "client",
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
    "attach-declined" to "client",
    "license_required" to "backend",
    "license_invalid" to "backend",
    "license_stale" to "backend",
    "sign_in_required" to "backend",
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
    public const val coreBackend: String = "core.backend"
    public const val coreDevicekeys: String = "core.devicekeys"
    public const val licenseGate: String = "license.gate"
    public const val licenseSignedinuser: String = "license.signedinuser"
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
    public const val configSync: String = "config.sync"
    public const val syncScenarios: String = "sync.scenarios"
    public const val syncSettings: String = "sync.settings"
    public const val syncConflict: String = "sync.conflict"
    public const val syncSaves: String = "sync.saves"
    public const val syncKeyring: String = "sync.keyring"
    public const val syncRecords: String = "sync.records"
    public const val syncFiles: String = "sync.files"
    public const val syncFilesDelta: String = "sync.files.delta"
    public const val syncE2eRecovery: String = "sync.e2e.recovery"
    public const val syncTransferBackground: String = "sync.transfer.background"
    public const val syncE2e: String = "sync.e2e"
    public const val connectIdentity: String = "connect.identity"
    public const val connectNoise: String = "connect.noise"
    public const val connectProtocol: String = "connect.protocol"
    public const val connectLan: String = "connect.lan"
    public const val connectRelay: String = "connect.relay"
    public const val connectLinks: String = "connect.links"
    public const val connectTransfer: String = "connect.transfer"
    public const val connectApp: String = "connect.app"
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
    public const val identityAttach: String = "identity.attach"
    public const val identityAccount: String = "identity.account"
    public const val identityRedirectWeb: String = "identity.redirect.web"
    public const val identityChoice: String = "identity.choice"
    public const val identitySigninHints: String = "identity.signin.hints"
    public const val identityExchange: String = "identity.exchange"
    public const val identityGamecenter: String = "identity.gamecenter"
    public const val identityPgs: String = "identity.pgs"
    public const val identityAutosignin: String = "identity.autosignin"
    public const val identityLink: String = "identity.link"
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
    public const val uiKitAccount: String = "ui.kit.account"
    public const val uiKitHolders: String = "ui.kit.holders"
    public const val uiCli: String = "ui.cli"
    public const val uiCliMount: String = "ui.cli.mount"
    public const val uiCliContract: String = "ui.cli.contract"
    public const val uiCliPortal: String = "ui.cli.portal"
    public const val uiGate: String = "ui.gate"
    public const val uiActivate: String = "ui.activate"
    public const val uiSignin: String = "ui.signin"
    public const val uiDevicelimit: String = "ui.devicelimit"
    public const val uiDevices: String = "ui.devices"
    public const val uiUpdate: String = "ui.update"
    public const val uiSettings: String = "ui.settings"
    public const val uiPaywall: String = "ui.paywall"
    public const val uiTheme: String = "ui.theme"
    public const val uiI18n: String = "ui.i18n"
    public const val commerceReceipt: String = "commerce.receipt"
    public const val serverLicense: String = "server.license"
    public const val serverSignin: String = "server.signin"
    public const val serverConfig: String = "server.config"
    public const val serverWebhooks: String = "server.webhooks"
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
    "core.backend",
    "core.devicekeys",
    "license.gate",
    "license.signedinuser",
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
    "sync.keyring",
    "sync.records",
    "sync.files",
    "sync.files.delta",
    "sync.e2e.recovery",
    "sync.transfer.background",
    "sync.e2e",
    "connect.identity",
    "connect.noise",
    "connect.protocol",
    "connect.lan",
    "connect.relay",
    "connect.links",
    "connect.transfer",
    "connect.app",
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
    "identity.redirect.web",
    "identity.choice",
    "identity.signin.hints",
    "identity.exchange",
    "identity.gamecenter",
    "identity.pgs",
    "identity.autosignin",
    "identity.link",
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
    "ui.kit.holders",
    "ui.cli",
    "ui.cli.mount",
    "ui.cli.contract",
    "ui.cli.portal",
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

/** The canonical X-PKey-SDK value (WIRE-CONTRACT-V3 §5.2): which SDK made the request. The SDK's version is X-PKey-SDK-Version. An SDK adds its id when it lands. A server core (WIRE-CONTRACT-V4 §14) sends `<language>-server` on its trust-manifest fetch. */
public object SdkId {
    public const val node: String = "node"
    public const val react: String = "react"
    public const val python: String = "python"
    public const val swift: String = "swift"
    public const val godot: String = "godot"
    public const val kotlin: String = "kotlin"
    public const val nodeServer: String = "node-server"
    public const val pythonServer: String = "python-server"
    public const val swiftServer: String = "swift-server"
    public const val kotlinServer: String = "kotlin-server"
}

/** Every `SdkId` value, in source order. */
public val SDK_ID_VALUES: List<String> = listOf(
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
    "license-owned",
    "refused",
    "error",
)

/** How a managed setting appears to the app and its user (SP-35 D9): editable, readonly (set by the product or an operator) or hidden. Derived from the config document's `state`; `config.setting(key).visibility` reads it. */
public object SettingVisibility {
    public const val editable: String = "editable"
    public const val readonly: String = "readonly"
    public const val hidden: String = "hidden"
}

/** Every `SettingVisibility` value, in source order. */
public val SETTING_VISIBILITY_VALUES: List<String> = listOf(
    "editable",
    "readonly",
    "hidden",
)

/** The kinds of event on the client's `events` stream (SP-35 Appendix A), in camelCase in every SDK. `entitlement` ships with LX-19 and `cloudSync` with U-06/07/20/21. */
public object EventKind {
    public const val license: String = "license"
    public const val entitlement: String = "entitlement"
    public const val config: String = "config"
    public const val updateavailable: String = "updateAvailable"
    public const val packs: String = "packs"
    public const val store: String = "store"
    public const val cloudsync: String = "cloudSync"
}

/** Every `EventKind` value, in source order. */
public val EVENT_KIND_VALUES: List<String> = listOf(
    "license",
    "entitlement",
    "config",
    "updateAvailable",
    "packs",
    "store",
    "cloudSync",
)

/** The variants of a Cloud Sync file transfer event, on the client's `events` stream under the `cloudSync` kind (U-22, U-23), in camelCase in every SDK: `transferProgress` (bytes done and total), `transferDone`, `transferFailed` (a code; a cancelled transfer is a state, not a failure). */
public object TransferEvent {
    public const val transferprogress: String = "transferProgress"
    public const val transferdone: String = "transferDone"
    public const val transferfailed: String = "transferFailed"
}

/** Every `TransferEvent` value, in source order. */
public val TRANSFER_EVENT_VALUES: List<String> = listOf(
    "transferProgress",
    "transferDone",
    "transferFailed",
)

/** The `X-PKey-*` request header names (wire contract v3 §5). */
public object HeaderName {
    public const val arch: String = "X-PKey-Arch"
    public const val channel: String = "X-PKey-Channel"
    public const val device: String = "X-PKey-Device"
    public const val license: String = "X-PKey-License"
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
    "X-PKey-License",
    "X-PKey-Platform",
    "X-PKey-SDK",
    "X-PKey-SDK-Version",
    "X-PKey-Version",
)

/** The wire contract version (`@polaris-key/protocol/core`). */
public const val PROTOCOL_VERSION: Int = 5

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
public const val SYNC_SCENARIOS_VERSION: Int = 4

/** `deviceLabelVersion` of conformance/corpus/v2/device-label.json. */
public const val DEVICE_LABEL_VERSION: Int = 1

/** `presentationMatrixVersion` of conformance/corpus/v2/presentation-matrix.json. */
public const val PRESENTATION_MATRIX_VERSION: Int = 1

/** `portalMatrixVersion` of conformance/corpus/v2/portal-matrix.json (WIRE-CONTRACT-V4 §5.7). */
public const val PORTAL_MATRIX_VERSION: Int = 1

/** `uiMatrixVersion` of conformance/corpus/v2/ui-matrix.json. */
public const val UI_MATRIX_VERSION: Int = 7

/** `backendMatrixVersion` of conformance/corpus/v2/backend-matrix.json (WIRE-CONTRACT-V4 §14). */
public const val BACKEND_MATRIX_VERSION: Int = 1

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

/** Wire contract v4 limit `MAX_TRUST_SIGNER_ATTEMPTS` (`@polaris-key/protocol/core`). */
public const val MAX_TRUST_SIGNER_ATTEMPTS: Int = 4

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

/** Cloud Sync: `SYNC_BLINDED_NAME_PATTERN` (WIRE-CONTRACT-V4 §8, §13.10.3, `@polaris-key/protocol/sync`). */
public const val SYNC_BLINDED_NAME_PATTERN: String = "^x:[A-Za-z0-9_-]{43}\$"

/** Cloud Sync: `SYNC_BLINDED_PREFIX` (WIRE-CONTRACT-V4 §8, §13.10.3, `@polaris-key/protocol/sync`). */
public const val SYNC_BLINDED_PREFIX: String = "x:"

/** Cloud Sync: `SYNC_CDC_AVG_BYTES` (WIRE-CONTRACT-V4 §13.8.3, `@polaris-key/protocol/sync`). */
public const val SYNC_CDC_AVG_BYTES: Int = 262144

/** Cloud Sync: `SYNC_CDC_FORMAT` (WIRE-CONTRACT-V4 §13.8.3, `@polaris-key/protocol/sync`). */
public const val SYNC_CDC_FORMAT: String = "pkey-sync-cdc/1"

/** Cloud Sync: `SYNC_CDC_GEAR_SEED` (WIRE-CONTRACT-V4 §13.8.3, `@polaris-key/protocol/sync`). */
public const val SYNC_CDC_GEAR_SEED: Long = 2654435769L

/** Cloud Sync: `SYNC_CDC_MAX_BYTES` (WIRE-CONTRACT-V4 §13.8.3, `@polaris-key/protocol/sync`). */
public const val SYNC_CDC_MAX_BYTES: Int = 1048576

/** Cloud Sync: `SYNC_CDC_MIN_BYTES` (WIRE-CONTRACT-V4 §13.8.3, `@polaris-key/protocol/sync`). */
public const val SYNC_CDC_MIN_BYTES: Int = 65536

/** Cloud Sync: `SYNC_CHUNK_FORMAT` (WIRE-CONTRACT-V4 §13.8.3, `@polaris-key/protocol/sync`). */
public const val SYNC_CHUNK_FORMAT: String = "pkey-sync-chunk/1"

/** Cloud Sync: `SYNC_CHUNK_ID_PATTERN` (WIRE-CONTRACT-V4 §8, §13.8.3, `@polaris-key/protocol/sync`). */
public const val SYNC_CHUNK_ID_PATTERN: String = "^[0-9a-f]{64}\$"

/** Cloud Sync: `SYNC_CHUNK_PLAN_MAX_IDS` (WIRE-CONTRACT-V4 §13.8.2, `@polaris-key/protocol/sync`). */
public const val SYNC_CHUNK_PLAN_MAX_IDS: Int = 1024

/** Cloud Sync: `SYNC_CHUNK_REQUESTS_PER_MINUTE` (WIRE-CONTRACT-V4 §13.8.2, `@polaris-key/protocol/sync`). */
public const val SYNC_CHUNK_REQUESTS_PER_MINUTE: Int = 600

/** Cloud Sync: `SYNC_CLIENT_ID_PATTERN` (WIRE-CONTRACT-V4 §8, §13.3 rule 4, `@polaris-key/protocol/sync`). */
public const val SYNC_CLIENT_ID_PATTERN: String = "^c_[A-Za-z0-9_-]{22}\$"

/** Cloud Sync: `SYNC_DEBOUNCE_MS` (WIRE-CONTRACT-V4 §11.5, `@polaris-key/protocol/sync`). */
public const val SYNC_DEBOUNCE_MS: Int = 2000

/** Cloud Sync: `SYNC_DELTA_MIN_FILE_BYTES` (WIRE-CONTRACT-V4 §13.8.1, `@polaris-key/protocol/sync`). */
public const val SYNC_DELTA_MIN_FILE_BYTES: Int = 1048576

/** Cloud Sync: `SYNC_E2E_OVERHEAD_BYTES` (WIRE-CONTRACT-V4 §13.10.4, `@polaris-key/protocol/sync`). */
public const val SYNC_E2E_OVERHEAD_BYTES: Int = 113

/** Cloud Sync: `SYNC_ENVELOPE_FIXED_BYTES` (WIRE-CONTRACT-V4 §13.10.4, `@polaris-key/protocol/sync`). */
public const val SYNC_ENVELOPE_FIXED_BYTES: Int = 49

/** Cloud Sync: `SYNC_ENVELOPE_PAD_BLOCK` (WIRE-CONTRACT-V4 §13.10.4, `@polaris-key/protocol/sync`). */
public const val SYNC_ENVELOPE_PAD_BLOCK: Int = 64

/** Cloud Sync: `SYNC_FILE_FORMAT` (WIRE-CONTRACT-V4 §13.10.4, `@polaris-key/protocol/sync`). */
public const val SYNC_FILE_FORMAT: String = "pkey-sync-file/1"

/** Cloud Sync: `SYNC_FILE_MAX_BYTES` (WIRE-CONTRACT-V4 §13.8.1, `@polaris-key/protocol/sync`). */
public const val SYNC_FILE_MAX_BYTES: Int = 1073741824

/** Cloud Sync: `SYNC_FILE_SEGMENT_BYTES` (WIRE-CONTRACT-V4 §13.10.4, `@polaris-key/protocol/sync`). */
public const val SYNC_FILE_SEGMENT_BYTES: Int = 1048576

/** Cloud Sync: `SYNC_FILE_TRANSFERS_PER_HOUR` (WIRE-CONTRACT-V4 §13.8.2, `@polaris-key/protocol/sync`). */
public const val SYNC_FILE_TRANSFERS_PER_HOUR: Int = 30

/** Cloud Sync: `SYNC_HLC_PATTERN` (WIRE-CONTRACT-V4 §8, `@polaris-key/protocol/sync`). */
public const val SYNC_HLC_PATTERN: String = "^[0-9a-f]{12}:[0-9a-f]{4}\$"

/** Cloud Sync: `SYNC_IMPORT_HLC` (WIRE-CONTRACT-V4 §11.5, §13.3, `@polaris-key/protocol/sync`). */
public const val SYNC_IMPORT_HLC: String = "000000000000:0000"

/** Cloud Sync: `SYNC_KEYCHAIN_SERVICE_PREFIX` (WIRE-CONTRACT-V4 §8, §13.11.5, `@polaris-key/protocol/sync`). */
public const val SYNC_KEYCHAIN_SERVICE_PREFIX: String = "pkey-sync:"

/** Cloud Sync: `SYNC_KEY_PATTERN` (WIRE-CONTRACT-V4 §8, §13.2, `@polaris-key/protocol/sync`). */
public const val SYNC_KEY_PATTERN: String = "^[A-Za-z0-9._:-]{1,128}\$"

/** Cloud Sync: `SYNC_KID_PATTERN` (WIRE-CONTRACT-V4 §8, §13.10.2, `@polaris-key/protocol/sync`). */
public const val SYNC_KID_PATTERN: String = "^[0-9a-f]{32}\$"

/** Cloud Sync: `SYNC_MANIFEST_FORMAT` (WIRE-CONTRACT-V4 §13.8.3, `@polaris-key/protocol/sync`). */
public const val SYNC_MANIFEST_FORMAT: String = "pkey-sync-chunks/1"

/** Cloud Sync: `SYNC_MAX_CHUNKS_PER_FILE` (WIRE-CONTRACT-V4 §13.8.2, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_CHUNKS_PER_FILE: Int = 16384

/** Cloud Sync: `SYNC_MAX_CLOCK_SKEW_MS` (WIRE-CONTRACT-V4 §13.3, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_CLOCK_SKEW_MS: Int = 300000

/** Cloud Sync: `SYNC_MAX_MERGE_MEMBERS` (WIRE-CONTRACT-V4 §13.7, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_MERGE_MEMBERS: Int = 256

/** Cloud Sync: `SYNC_MAX_MUTATIONS` (WIRE-CONTRACT-V4 §13.3, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_MUTATIONS: Int = 100

/** Cloud Sync: `SYNC_MAX_OPEN_UPLOADS` (WIRE-CONTRACT-V4 §13.8.2, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_OPEN_UPLOADS: Int = 4

/** Cloud Sync: `SYNC_MAX_PARTS` (WIRE-CONTRACT-V4 §13.8.1, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_PARTS: Int = 9999

/** Cloud Sync: `SYNC_MAX_PUSH_BYTES` (WIRE-CONTRACT-V4 §13.3, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_PUSH_BYTES: Int = 262144

/** Cloud Sync: `SYNC_MAX_RECORD_BYTES` (WIRE-CONTRACT-V4 §13.1, §13.7, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_RECORD_BYTES: Int = 65536

/** Cloud Sync: `SYNC_MAX_SETTINGS` (WIRE-CONTRACT-V4 §13.1, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_SETTINGS: Int = 256

/** Cloud Sync: `SYNC_MAX_SETTINGS_BYTES` (WIRE-CONTRACT-V4 §13.1, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_SETTINGS_BYTES: Int = 65536

/** Cloud Sync: `SYNC_MAX_UNION_ELEMENT_BYTES` (WIRE-CONTRACT-V4 §13.7, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_UNION_ELEMENT_BYTES: Int = 1024

/** Cloud Sync: `SYNC_MAX_VALUE_BYTES` (WIRE-CONTRACT-V4 §13.1, `@polaris-key/protocol/sync`). */
public const val SYNC_MAX_VALUE_BYTES: Int = 8192

/** Cloud Sync: `SYNC_PART_MAX_BYTES` (WIRE-CONTRACT-V4 §13.8.1, `@polaris-key/protocol/sync`). */
public const val SYNC_PART_MAX_BYTES: Int = 67108864

/** Cloud Sync: `SYNC_PART_MIN_BYTES` (WIRE-CONTRACT-V4 §13.8.1, `@polaris-key/protocol/sync`). */
public const val SYNC_PART_MIN_BYTES: Int = 8388608

/** Cloud Sync: `SYNC_PART_ROUND_BYTES` (WIRE-CONTRACT-V4 §13.8.1, `@polaris-key/protocol/sync`). */
public const val SYNC_PART_ROUND_BYTES: Int = 1048576

/** Cloud Sync: `SYNC_PENDING_DAYS` (WIRE-CONTRACT-V4 §11.5, `@polaris-key/protocol/sync`). */
public const val SYNC_PENDING_DAYS: Int = 30

/** Cloud Sync: `SYNC_PULL_PAGE_CHANGES` (WIRE-CONTRACT-V4 §13.4, `@polaris-key/protocol/sync`). */
public const val SYNC_PULL_PAGE_CHANGES: Int = 500

/** Cloud Sync: `SYNC_QUOTA_BYTES` (WIRE-CONTRACT-V4 §13.1, `@polaris-key/protocol/sync`). */
public const val SYNC_QUOTA_BYTES: Int = 268435456

/** Cloud Sync: `SYNC_RECOVERY_READS_PER_DAY` (WIRE-CONTRACT-V4 §13.11.2, `@polaris-key/protocol/sync`). */
public const val SYNC_RECOVERY_READS_PER_DAY: Int = 5

/** Cloud Sync: `SYNC_RESET_KEEP_DAYS` (WIRE-CONTRACT-V4 §13.11.4, `@polaris-key/protocol/sync`). */
public const val SYNC_RESET_KEEP_DAYS: Int = 30

/** Cloud Sync: `SYNC_RING_ID_PATTERN` (WIRE-CONTRACT-V4 §8, §13.11, `@polaris-key/protocol/sync`). */
public const val SYNC_RING_ID_PATTERN: String = "^rg_[A-Za-z0-9_-]{22}\$"

/** Cloud Sync: `SYNC_SAVE_SLOTS` (WIRE-CONTRACT-V4 §13.1, §13.7, `@polaris-key/protocol/sync`). */
public const val SYNC_SAVE_SLOTS: Int = 16

/** Cloud Sync: `SYNC_SIGNOUT_FLUSH_MS` (WIRE-CONTRACT-V4 §11.5, `@polaris-key/protocol/sync`). */
public const val SYNC_SIGNOUT_FLUSH_MS: Int = 5000

/** Cloud Sync: `SYNC_SINGLE_PUT_MAX_BYTES` (WIRE-CONTRACT-V4 §13.8.1, `@polaris-key/protocol/sync`). */
public const val SYNC_SINGLE_PUT_MAX_BYTES: Int = 16777216

/** Cloud Sync: `SYNC_TOMBSTONE_DAYS` (WIRE-CONTRACT-V4 §13.4, §13.6, `@polaris-key/protocol/sync`). */
public const val SYNC_TOMBSTONE_DAYS: Int = 90

/** Cloud Sync: `SYNC_UNLICENSED_QUOTA_BYTES` (WIRE-CONTRACT-V4 §13.1, `@polaris-key/protocol/sync`). */
public const val SYNC_UNLICENSED_QUOTA_BYTES: Int = 1048576

/** Cloud Sync: `SYNC_UPLOAD_PARALLELISM` (WIRE-CONTRACT-V4 §13.8.2, `@polaris-key/protocol/sync`). */
public const val SYNC_UPLOAD_PARALLELISM: Int = 4

/** Cloud Sync: `SYNC_UPLOAD_TTL_SECONDS` (WIRE-CONTRACT-V4 §13.8.2, `@polaris-key/protocol/sync`). */
public const val SYNC_UPLOAD_TTL_SECONDS: Int = 86400

/** Cloud Sync: `SYNC_VALUE_FORMAT` (WIRE-CONTRACT-V4 §13.10.4, `@polaris-key/protocol/sync`). */
public const val SYNC_VALUE_FORMAT: String = "pkey-sync-value/1"

/** Cloud Sync: `SYNC_WRAP_FORMAT` (WIRE-CONTRACT-V4 §13.11.1, `@polaris-key/protocol/sync`). */
public const val SYNC_WRAP_FORMAT: String = "pkey-sync-wrap/1"

/** Cloud Sync: `SYNC_WRITES_PAUSED_RETRY_AFTER_SECONDS` (WIRE-CONTRACT-V4 §13.9, `@polaris-key/protocol/sync`). */
public const val SYNC_WRITES_PAUSED_RETRY_AFTER_SECONDS: Int = 300

/** Signed-in subject: `PAIRWISE_SUBJECT_PATTERN` (WIRE-CONTRACT-V4 §3.2, `@polaris-key/protocol/core`). */
public const val PAIRWISE_SUBJECT_PATTERN: String = "^ps_[A-Za-z0-9_-]{22}\$"

/** Customer site display fallback: `CUSTOMER_ORIGIN_DEFAULT` (LK-00 §3, `@polaris-key/protocol/core`). */
public const val CUSTOMER_ORIGIN_DEFAULT: String = "https://polaris.locker"

/** Customer site display fallback: `DEVICE_CODE_PAGE` (LK-00 §3, `@polaris-key/protocol/core`). */
public const val DEVICE_CODE_PAGE: String = "https://polaris.locker/device"

/** Customer site display fallback: `TV_CODE_PAGE` (LK-00 §3, `@polaris-key/protocol/core`). */
public const val TV_CODE_PAGE: String = "https://polaris.locker/tv"

/** Customer site display fallback: `SIGN_IN_PROVIDER_NAME` (LK-00 §3, `@polaris-key/protocol/core`). */
public const val SIGN_IN_PROVIDER_NAME: String = "Polaris Locker"

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
    "core.presentation" to CapabilityRow("implemented", "core", listOf()),
    "core.sync" to CapabilityRow("implemented", "core", listOf()),
    "core.local" to CapabilityRow("implemented", "core", listOf()),
    "core.headers" to CapabilityRow("implemented", "core", listOf()),
    "core.errors" to CapabilityRow("implemented", "core", listOf()),
    "core.caps" to CapabilityRow("implemented", "core", listOf()),
    "core.store" to CapabilityRow("implemented", "core", listOf(CapabilityNa("jvm", "dependency"))),
    "core.copy" to CapabilityRow("implemented", "sdk", listOf()),
    "core.backend" to CapabilityRow("implemented", "license", listOf()),
    "core.devicekeys" to CapabilityRow("implemented", "core", listOf()),
    "license.gate" to CapabilityRow("implemented", "license", listOf()),
    "license.signedinuser" to CapabilityRow("implemented", "license", listOf()),
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
    "config.sync" to CapabilityRow("implemented", "sync", listOf()),
    "sync.scenarios" to CapabilityRow("implemented", "sync", listOf()),
    "sync.settings" to CapabilityRow("implemented", "sync", listOf()),
    "sync.conflict" to CapabilityRow("planned", "sync", listOf()),
    "sync.saves" to CapabilityRow("planned", "sync", listOf()),
    "sync.keyring" to CapabilityRow("implemented", "sync", listOf()),
    "sync.records" to CapabilityRow("planned", "sync", listOf()),
    "sync.files" to CapabilityRow("planned", "sync", listOf()),
    "sync.files.delta" to CapabilityRow("planned", "sync", listOf()),
    "sync.e2e.recovery" to CapabilityRow("planned", "sync", listOf()),
    "sync.transfer.background" to CapabilityRow("planned", "sync", listOf(CapabilityNa("jvm", "runtime"))),
    "sync.e2e" to CapabilityRow("planned", "sync", listOf()),
    "connect.identity" to CapabilityRow("implemented", "connect", listOf()),
    "connect.noise" to CapabilityRow("implemented", "connect", listOf()),
    "connect.protocol" to CapabilityRow("implemented", "connect", listOf()),
    "connect.lan" to CapabilityRow("planned", "connect", listOf()),
    "connect.relay" to CapabilityRow("implemented", "connect", listOf()),
    "connect.links" to CapabilityRow("planned", "connect", listOf()),
    "connect.transfer" to CapabilityRow("planned", "connect", listOf()),
    "connect.app" to CapabilityRow("implemented", "connect", listOf()),
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
    "identity.toggle" to CapabilityRow("implemented", "identity", listOf()),
    "identity.keyentry" to CapabilityRow("implemented", "identity", listOf()),
    "identity.attach" to CapabilityRow("implemented", "identity", listOf()),
    "identity.account" to CapabilityRow("implemented", "identity", listOf()),
    "identity.redirect.web" to CapabilityRow("implemented", "identity", listOf()),
    "identity.choice" to CapabilityRow("implemented", "identity", listOf()),
    "identity.signin.hints" to CapabilityRow("implemented", "identity", listOf()),
    "identity.exchange" to CapabilityRow("implemented", "identity", listOf(CapabilityNa("jvm", "runtime"))),
    "identity.gamecenter" to CapabilityRow("na", "identity", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "identity.pgs" to CapabilityRow("planned", "identity", listOf(CapabilityNa("jvm", "runtime"))),
    "identity.autosignin" to CapabilityRow("implemented", "identity", listOf()),
    "identity.link" to CapabilityRow("planned", "identity", listOf(CapabilityNa("jvm", "runtime"))),
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
    "ui.kit.keyentry" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.kit.account" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.kit.holders" to CapabilityRow("planned", "sdk", listOf()),
    "ui.cli" to CapabilityRow("na", "sdk", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "ui.cli.mount" to CapabilityRow("planned", "sdk", listOf(CapabilityNa("android", "runtime"))),
    "ui.cli.contract" to CapabilityRow("na", "sdk", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "ui.cli.portal" to CapabilityRow("na", "core", listOf(CapabilityNa("android", "runtime"), CapabilityNa("jvm", "runtime"))),
    "ui.gate" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.activate" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.signin" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.devicelimit" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.devices" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.update" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.settings" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.paywall" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.theme" to CapabilityRow("implemented", "sdk", listOf()),
    "ui.i18n" to CapabilityRow("implemented", "sdk", listOf()),
    "commerce.receipt" to CapabilityRow("implemented", "commerce", listOf()),
    "server.license" to CapabilityRow("implemented", "license", listOf(CapabilityNa("android", "runtime"))),
    "server.signin" to CapabilityRow("implemented", "identity", listOf(CapabilityNa("android", "runtime"))),
    "server.config" to CapabilityRow("planned", "config", listOf(CapabilityNa("android", "runtime"))),
    "server.webhooks" to CapabilityRow("planned", "core", listOf(CapabilityNa("android", "runtime"))),
)

/** SHA-256 of the canonical table; `pnpm parity:check` recomputes it from the manifest. */
public const val CAPABILITY_DIGEST: String = "4fe2f5106c311417b3733e8aef030e26bf23c8888c9cb37ea276ddcc6b1ff758"
