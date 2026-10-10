# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm gen:constants` (tools/gen-sdk-constants.ts) from conformance/parity/
# errors.json, enums.json and features.json, tools/services.json, @polaris-key/protocol/core
# and the conformance corpus. `pnpm gen:constants -- --check` fails the green gate on any
# difference. To change a constant, edit its source and regenerate.
"""Polaris Key's shared constants: error codes, header names, enums, feature ids, versions."""

from __future__ import annotations

from types import MappingProxyType
from typing import Final, Mapping, NamedTuple, Tuple

__all__ = [
    "ErrorCode",
    "ERROR_CODE_VALUES",
    "Feature",
    "FEATURE_VALUES",
    "UnsupportedReason",
    "UNSUPPORTED_REASON_VALUES",
    "Platform",
    "PLATFORM_VALUES",
    "Arch",
    "ARCH_VALUES",
    "SdkId",
    "SDK_ID_VALUES",
    "StoreBackend",
    "STORE_BACKEND_VALUES",
    "StoreDegradedReason",
    "STORE_DEGRADED_REASON_VALUES",
    "OutletKind",
    "OUTLET_KIND_VALUES",
    "OutletConfidence",
    "OUTLET_CONFIDENCE_VALUES",
    "OutletSubkind",
    "OUTLET_SUBKIND_VALUES",
    "UpdateAction",
    "UPDATE_ACTION_VALUES",
    "UpdateNoneReason",
    "UPDATE_NONE_REASON_VALUES",
    "UpdateBlockedReason",
    "UPDATE_BLOCKED_REASON_VALUES",
    "BinaryMethod",
    "BINARY_METHOD_VALUES",
    "UpdateEvent",
    "UPDATE_EVENT_VALUES",
    "PackType",
    "PACK_TYPE_VALUES",
    "PackDelivery",
    "PACK_DELIVERY_VALUES",
    "PackActivation",
    "PACK_ACTIVATION_VALUES",
    "FilesLayout",
    "FILES_LAYOUT_VALUES",
    "ContentCodec",
    "CONTENT_CODEC_VALUES",
    "PatchMethod",
    "PATCH_METHOD_VALUES",
    "PatchScope",
    "PATCH_SCOPE_VALUES",
    "VariantAxis",
    "VARIANT_AXIS_VALUES",
    "PatchStrategy",
    "PATCH_STRATEGY_VALUES",
    "Transport",
    "TRANSPORT_VALUES",
    "DelegablePackType",
    "DELEGABLE_PACK_TYPE_VALUES",
    "DataOnlyExtension",
    "DATA_ONLY_EXTENSION_VALUES",
    "LICENSE_STATUS_VALUES",
    "ACTIVATION_RESULT_VALUES",
    "HeaderName",
    "HEADER_NAME_VALUES",
    "ServiceSlug",
    "SERVICE_SLUG_VALUES",
    "ERROR_CODE_KINDS",
    "PROTOCOL_VERSION",
    "CORPUS_VERSION",
    "GATE_MATRIX_VERSION",
    "FINGERPRINT_VERSION",
    "STAGE_MATRIX_VERSION",
    "UPDATE_MATRIX_VERSION",
    "OUTLET_MATRIX_VERSION",
    "PLAN_MATRIX_VERSION",
    "SYNC_SCENARIOS_VERSION",
    "DEVICE_LABEL_VERSION",
    "PRESENTATION_MATRIX_VERSION",
    "UI_MATRIX_VERSION",
    "CONTENT_CORPUS_VERSION",
    "MAX_WIRE_INTEGER",
    "MAX_JSON_DEPTH",
    "MAX_RECORD_JWS_BYTES",
    "MAX_FEED_REVOCATIONS",
    "REVOCATION_REASON_MAX_BYTES",
    "MAX_FEED_DELTAS",
    "MAX_FEED_DELTAS_PER_TARGET",
    "MAX_DELEGATION_TTL_SECONDS",
    "MAX_DELEGATION_TYPES",
    "DATA_ONLY_HEAD_BYTES",
    "DATA_ONLY_TAIL_BYTES",
    "MAX_DELEGATIONS_PER_CHECK",
    "MAX_TRUST_SIGNER_ATTEMPTS",
    "MAX_PACK_VARIANTS",
    "MAX_VARIANT_DELTAS",
    "MAX_CONTENT_PINS",
    "MAX_BUILD_EMBEDS",
    "MAX_INDEX_FILES",
    "MAX_FILES_INDEX_BYTES",
    "MAX_PACK_PATH_BYTES",
    "FILES_FORMAT",
    "PATCH_FORMAT",
    "MARKER_FORMAT",
    "CONTENT_STAMP_FORMAT",
    "PLAN_REQUEST_WEIGHT",
    "CHUNKS_FORMAT",
    "MAX_CHUNK_INDEX_BYTES",
    "MAX_CHUNK_BYTES",
    "DEVICE_LABEL_MAX_CODEPOINTS",
    "REQUEST_HANDLE_PATTERN",
    "REQUEST_HANDLE_TTL_SECONDS",
    "PRESENTATION_TEXT_MAX_BYTES",
    "PRESENTATION_URL_MAX_BYTES",
    "PRESENTATION_MAX_ICON_SIZES",
    "PRESENTATION_MAX_ICON_WIDTH",
    "PRESENTATION_ICON_MAX_DIMENSION",
    "PRESENTATION_ICON_MAX_BYTES",
    "PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS",
    "PRESENTATION_CACHE_MAX_FILES",
    "PRESENTATION_ICON_TYPES",
    "CHANNEL_ALIASES",
    "CHANNEL_BETA",
    "CHANNEL_DEV",
    "CHANNEL_NAME_PATTERN",
    "CHANNEL_PR",
    "CHANNEL_STABLE",
    "PR_CHANNEL_PATTERN",
    "PR_NUMBER_MAX_DIGITS",
    "ARCH_SPELLINGS",
    "PLATFORM_SPELLINGS",
    "CapabilityNa",
    "CapabilityRow",
    "CAPABILITY_SDK",
    "CAPABILITY_RUNTIMES",
    "CAPABILITIES",
    "CAPABILITY_DIGEST",
]


class ErrorCode:
    """Every error code the Worker answers with or an SDK raises (conformance/parity/errors.json). Hosts match on these strings."""

    UNAUTHORIZED: Final = "unauthorized"
    NOT_FOUND: Final = "not_found"
    BAD_REQUEST: Final = "bad_request"
    FORBIDDEN: Final = "forbidden"
    ATTESTATION_REQUIRED: Final = "attestation_required"
    ATTESTATION_REJECTED: Final = "attestation_rejected"
    ATTESTATION_UNAVAILABLE: Final = "attestation_unavailable"
    RATE_LIMITED: Final = "rate_limited"
    BODY_TOO_LARGE: Final = "body_too_large"
    METHOD_NOT_ALLOWED: Final = "method_not_allowed"
    MISCONFIGURED: Final = "misconfigured"
    REGISTRATION_CLOSED: Final = "registration_closed"
    VALUE_NOT_REPRESENTABLE: Final = "value_not_representable"
    DOCUMENT_NOT_REPRESENTABLE: Final = "document_not_representable"
    DEVICE_LIMIT: Final = "device_limit"
    KEY_ENTRY_LIMIT: Final = "key_entry_limit"
    LICENSE_DISABLED: Final = "license_disabled"
    LICENSE_EXPIRED: Final = "license_expired"
    NOT_ENTITLED: Final = "not_entitled"
    VERSION_BLOCKED: Final = "version_blocked"
    CHANNEL_NOT_ALLOWED: Final = "channel_not_allowed"
    HARDWARE_MISMATCH: Final = "hardware_mismatch"
    FINGERPRINT_REQUIRED: Final = "fingerprint_required"
    ENROLL_DISABLED: Final = "enroll_disabled"
    ENROLL_CLAIMED: Final = "enroll_claimed"
    ENROLL_FAILED: Final = "enroll_failed"
    MANAGED_BY_ADMIN: Final = "managed_by_admin"
    CATALOG_UNAVAILABLE: Final = "catalog_unavailable"
    LICENSE_UNUSABLE: Final = "license_unusable"
    DISABLED: Final = "disabled"
    OIDC_ERROR: Final = "oidc_error"
    UNAVAILABLE: Final = "unavailable"
    IDENTITY_DISABLED: Final = "identity_disabled"
    AUTH_METHOD_DISABLED: Final = "auth_method_disabled"
    EMAIL_UNAVAILABLE: Final = "email_unavailable"
    TURNSTILE_FAILED: Final = "turnstile_failed"
    SIGNIN_EXPIRED: Final = "signin_expired"
    INVALID_CODE: Final = "invalid_code"
    EMAIL_IN_USE: Final = "email_in_use"
    TERMS_REQUIRED: Final = "terms_required"
    LICENSE_OWNED: Final = "license_owned"
    EMAIL_MISMATCH: Final = "email_mismatch"
    LINK_CONFLICT: Final = "link_conflict"
    LAST_LINK: Final = "last_link"
    STEP_UP_REQUIRED: Final = "step_up_required"
    NOT_ELIGIBLE: Final = "not_eligible"
    NOT_REMOVABLE: Final = "not_removable"
    DOWNLOAD_AUTH_REQUIRED: Final = "download_auth_required"
    DELIVERY_GATE_MISSING: Final = "delivery_gate_missing"
    UPSTREAM_RATE_LIMITED: Final = "upstream_rate_limited"
    SERVER_MISCONFIGURED: Final = "server_misconfigured"
    INTERNAL_ERROR: Final = "internal_error"
    RELEASE_RECORD_REJECTED: Final = "release_record_rejected"
    RELEASE_TAG_IS_PACK_RELEASE: Final = "release_tag_is_pack_release"
    ASSET_UNREACHABLE: Final = "asset_unreachable"
    FEED_NOT_COMPOSABLE: Final = "feed_not_composable"
    SERVICE_UNAVAILABLE: Final = "service-unavailable"
    SERVICE_DISABLED: Final = "service-disabled"
    LOCAL_ONLY: Final = "local-only"
    INSECURE_BASE_URL: Final = "insecure-base-url"
    BUNDLE_JWS_REJECTED: Final = "bundle-jws-rejected"
    BUNDLE_CLAIMS_REJECTED: Final = "bundle-claims-rejected"
    BUNDLE_TRUST_REJECTED: Final = "bundle-trust-rejected"
    INNER_DOC_REJECTED: Final = "inner-doc-rejected"
    BUNDLE: Final = "bundle"
    TRANSPORT: Final = "transport"
    NETWORK: Final = "network"
    REFRESH_FAILED: Final = "refresh-failed"
    SYNC_FAILED: Final = "sync-failed"
    FETCH_FAILED: Final = "fetch-failed"
    BRIDGE_MISSING: Final = "bridge-missing"
    UNKNOWN: Final = "unknown"
    RELEASE_REFUSED: Final = "release-refused"
    BUNDLE_REJECTED: Final = "bundle-rejected"
    BUNDLE_IMPORT_UNSUPPORTED: Final = "bundle-import-unsupported"
    REPORT_UNSUPPORTED: Final = "report-unsupported"
    DEVICE_MANAGEMENT_UNSUPPORTED: Final = "device-management-unsupported"
    DEVICE_LIST_FAILED: Final = "device_list_failed"
    DEVICE_RENAME_FAILED: Final = "device_rename_failed"
    DEVICE_DEAUTHORIZE_FAILED: Final = "device_deauthorize_failed"
    KEY_ENTRY_UNSUPPORTED: Final = "key-entry-unsupported"
    SIGN_IN_FAILED: Final = "sign-in-failed"
    SIGN_OUT_FAILED: Final = "sign-out-failed"
    BAD_RESPONSE: Final = "bad_response"
    NETWORK_ERROR: Final = "network-error"
    SERVER_ERROR: Final = "server-error"
    CANCELLED: Final = "cancelled"
    SIGN_IN_EXPIRED: Final = "sign-in-expired"
    SIGN_IN_DENIED: Final = "sign-in-denied"
    SIGN_IN_UNAVAILABLE: Final = "sign-in-unavailable"
    INVALID_OPTIONS: Final = "invalid-options"
    NOT_CONFIGURED: Final = "not-configured"
    UNSUPPORTED: Final = "unsupported"
    TIMEOUT: Final = "timeout"
    RESPONSE_TOO_LARGE: Final = "response-too-large"
    TOO_MANY_REDIRECTS: Final = "too-many-redirects"
    INSECURE_REDIRECT: Final = "insecure-redirect"
    HTTP_ERROR: Final = "http-error"
    INVALID_RESPONSE: Final = "invalid-response"
    STORE_FAILED: Final = "store-failed"
    PLATFORM_ERROR: Final = "platform-error"
    NO_TOKEN: Final = "no-token"
    MINT_UNAVAILABLE: Final = "mint-unavailable"
    FEED_REJECTED: Final = "feed-rejected"
    FEED_ROLLBACK: Final = "feed-rollback"
    RECORD_REJECTED: Final = "record-rejected"
    RECORD_MISMATCH: Final = "record-mismatch"
    PAYLOAD_MISMATCH: Final = "payload-mismatch"
    SWAP_REFUSED: Final = "swap-refused"
    SWAP_FAILED: Final = "swap-failed"
    FILES_INDEX_INVALID: Final = "files-index-invalid"
    FILES_UNSAFE_PATH: Final = "files-unsafe-path"
    FILES_DUPLICATE_PATH: Final = "files-duplicate-path"
    FILES_CASE_COLLISION: Final = "files-case-collision"
    FILES_PATH_CONFLICT: Final = "files-path-conflict"
    FILES_LAYOUT_MISMATCH: Final = "files-layout-mismatch"
    CONTENT_STAMP_INVALID: Final = "content-stamp-invalid"
    FULL_CORRUPT: Final = "full-corrupt"
    DELTA_ARTIFACT_MISMATCH: Final = "delta-artifact-mismatch"
    DELTA_BASE_MISMATCH: Final = "delta-base-mismatch"
    DELTA_APPLY_FAILED: Final = "delta-apply-failed"
    FILE_CORRUPT: Final = "file-corrupt"
    FILE_SOURCE_MISSING: Final = "file-source-missing"
    PAYLOAD_HASH_MISMATCH: Final = "payload-hash-mismatch"
    CHUNKS_REF_MISMATCH: Final = "chunks-ref-mismatch"
    CHUNKS_BAD_LENGTH: Final = "chunks-bad-length"
    CHUNKS_BAD_MAGIC: Final = "chunks-bad-magic"
    CHUNKS_UNSUPPORTED_VERSION: Final = "chunks-unsupported-version"
    CHUNKS_BAD_RECORD_SIZE: Final = "chunks-bad-record-size"
    CHUNKS_BAD_FLAGS: Final = "chunks-bad-flags"
    CHUNKS_RESERVED_NONZERO: Final = "chunks-reserved-nonzero"
    CHUNKS_ZERO_LENGTH: Final = "chunks-zero-length"
    CHUNKS_BAD_CLEN: Final = "chunks-bad-clen"
    CHUNKS_BAD_BUNDLE_REF: Final = "chunks-bad-bundle-ref"
    CHUNKS_BAD_BUNDLE_RANGE: Final = "chunks-bad-bundle-range"
    CHUNKS_SIZE_MISMATCH: Final = "chunks-size-mismatch"
    CHUNKS_PAYLOAD_MISMATCH: Final = "chunks-payload-mismatch"
    CHUNK_BUNDLE_TRUNCATED: Final = "chunk-bundle-truncated"
    CHUNK_CORRUPT: Final = "chunk-corrupt"
    PLAN_TRANSPORT_UNSUPPORTED: Final = "plan-transport-unsupported"
    PLAN_INSUFFICIENT_DISK: Final = "plan-insufficient-disk"
    PLAN_NO_STRATEGY: Final = "plan-no-strategy"
    PACK_NO_VARIANT: Final = "pack-no-variant"
    PACK_TYPE_UNSUPPORTED: Final = "pack-type-unsupported"
    PACK_TYPE_CHECK_FAILED: Final = "pack-type-check-failed"
    PACK_NOT_PINNED: Final = "pack-not-pinned"
    PACK_NOT_ENTITLED: Final = "pack-not-entitled"
    PACK_STATE_UNREADABLE: Final = "pack-state-unreadable"
    PCK_DIRECTORY_REFUSED: Final = "pck-directory-refused"
    PCK_ENGINE_MISMATCH: Final = "pck-engine-mismatch"
    PACK_ROLLED_BACK: Final = "pack-rolled-back"
    PACK_REVOKED: Final = "pack-revoked"
    PACK_NOT_DATA_ONLY: Final = "pack-not-data-only"
    MARKER_REJECTED: Final = "marker-rejected"


#: Every ``ErrorCode`` value, in source order.
ERROR_CODE_VALUES: Tuple[str, ...] = (
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


#: The registry: every error code and its kind (``wire`` or ``client``).
ERROR_CODE_KINDS: Mapping[str, str] = MappingProxyType(
    {
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
    }
)


class Feature:
    """Every feature id in the parity registry (conformance/parity/features.json)."""

    CORE_VERIFY: Final = "core.verify"
    CORE_CACHE: Final = "core.cache"
    CORE_BUNDLE: Final = "core.bundle"
    CORE_DISCOVER: Final = "core.discover"
    CORE_PRESENTATION: Final = "core.presentation"
    CORE_SYNC: Final = "core.sync"
    CORE_LOCAL: Final = "core.local"
    CORE_HEADERS: Final = "core.headers"
    CORE_ERRORS: Final = "core.errors"
    CORE_CAPS: Final = "core.caps"
    CORE_STORE: Final = "core.store"
    CORE_COPY: Final = "core.copy"
    LICENSE_GATE: Final = "license.gate"
    LICENSE_ACTIVATE: Final = "license.activate"
    LICENSE_ENROLL: Final = "license.enroll"
    LICENSE_DEACTIVATE: Final = "license.deactivate"
    LICENSE_MANAGE: Final = "license.manage"
    LICENSE_ENTITLEMENTS: Final = "license.entitlements"
    LICENSE_CHANNELS: Final = "license.channels"
    LICENSE_REREGISTER: Final = "license.reregister"
    LICENSE_REFUSALS: Final = "license.refusals"
    CONFIG_RESOLVE: Final = "config.resolve"
    CONFIG_LIST: Final = "config.list"
    CONFIG_SECRET: Final = "config.secret"
    CONFIG_SCHEMA: Final = "config.schema"
    CONFIG_MINT: Final = "config.mint"
    CONFIG_MIRROR: Final = "config.mirror"
    CONFIG_LOCAL: Final = "config.local"
    DEVICES_FINGERPRINT: Final = "devices.fingerprint"
    DEVICES_FACTS: Final = "devices.facts"
    DEVICES_REGISTER: Final = "devices.register"
    DEVICES_MANAGE: Final = "devices.manage"
    DEVICES_REPORT: Final = "devices.report"
    TELEMETRY_UPDATES: Final = "telemetry.updates"
    DEVICES_ATTEST: Final = "devices.attest"
    IDENTITY_OIDC: Final = "identity.oidc"
    IDENTITY_DEVICECODE: Final = "identity.devicecode"
    IDENTITY_DEVICELABEL: Final = "identity.devicelabel"
    IDENTITY_TOGGLE: Final = "identity.toggle"
    IDENTITY_KEYENTRY: Final = "identity.keyentry"
    RELEASE_CHANGELOG: Final = "release.changelog"
    RELEASE_DOWNLOAD: Final = "release.download"
    RELEASE_RECORD: Final = "release.record"
    RELEASE_FETCH: Final = "release.fetch"
    RELEASE_DISTRIBUTION: Final = "release.distribution"
    UPDATE_CHECK: Final = "update.check"
    UPDATE_FEED: Final = "update.feed"
    UPDATE_FEEDS: Final = "update.feeds"
    UPDATE_DECIDE: Final = "update.decide"
    UPDATE_CONTENT: Final = "update.content"
    UPDATE_DRIVER: Final = "update.driver"
    UPDATE_BOOTGUARD: Final = "update.bootguard"
    OUTLET_DETECT: Final = "outlet.detect"
    CRASH_TAGS: Final = "crash.tags"
    PACKS_RECORD: Final = "packs.record"
    PACKS_REVOKE: Final = "packs.revoke"
    PACKS_DELEGATION: Final = "packs.delegation"
    PACKS_DELTA_FEED: Final = "packs.delta.feed"
    PACKS_PLAN: Final = "packs.plan"
    PACKS_INDEX_FILES: Final = "packs.index.files"
    PACKS_INDEX_CHUNKS: Final = "packs.index.chunks"
    PACKS_APPLY_FULL: Final = "packs.apply.full"
    PACKS_APPLY_FILE: Final = "packs.apply.file"
    PACKS_APPLY_CHUNK: Final = "packs.apply.chunk"
    PACKS_APPLY_DELTA: Final = "packs.apply.delta"
    PACKS_STATE: Final = "packs.state"
    PACKS_HANDLERS: Final = "packs.handlers"
    PACKS_TYPE_GODOT_ZIP: Final = "packs.type.godot.zip"
    PACKS_TYPE_L10N_TABLE: Final = "packs.type.l10n.table"
    PACKS_TYPE_DATA_JSON: Final = "packs.type.data.json"
    PACKS_TYPE_AUDIO_BANK: Final = "packs.type.audio.bank"
    PACKS_TYPE_ML_MODEL: Final = "packs.type.ml.model"
    PACKS_PROVIDES: Final = "packs.provides"
    PACKS_TRANSPORT_APPLE: Final = "packs.transport.apple"
    PACKS_TRANSPORT_PLAY: Final = "packs.transport.play"
    PACKS_TRANSPORT_STEAM: Final = "packs.transport.steam"
    PACKS_TRANSPORT_MSIX: Final = "packs.transport.msix"
    PACKS_TRANSPORT_FLATPAK: Final = "packs.transport.flatpak"
    UI_STAGES: Final = "ui.stages"
    UI_BOOT: Final = "ui.boot"
    UI_KIT: Final = "ui.kit"
    UI_KIT_MANAGE: Final = "ui.kit.manage"
    UI_KIT_KEYENTRY: Final = "ui.kit.keyentry"
    UI_CLI: Final = "ui.cli"
    UI_GATE: Final = "ui.gate"
    UI_ACTIVATE: Final = "ui.activate"
    UI_SIGNIN: Final = "ui.signin"
    UI_DEVICELIMIT: Final = "ui.devicelimit"
    UI_DEVICES: Final = "ui.devices"
    UI_UPDATE: Final = "ui.update"
    UI_SETTINGS: Final = "ui.settings"
    UI_PAYWALL: Final = "ui.paywall"
    UI_THEME: Final = "ui.theme"
    UI_I18N: Final = "ui.i18n"
    COMMERCE_RECEIPT: Final = "commerce.receipt"


#: Every ``Feature`` value, in source order.
FEATURE_VALUES: Tuple[str, ...] = (
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
)


class UnsupportedReason:
    """Why a feature is unsupported here: the `supports()` reason enum (PARITY §2.2)."""

    RUNTIME: Final = "runtime"
    OUTLET: Final = "outlet"
    PRODUCT: Final = "product"
    DEPENDENCY: Final = "dependency"
    VERSION: Final = "version"


#: Every ``UnsupportedReason`` value, in source order.
UNSUPPORTED_REASON_VALUES: Tuple[str, ...] = (
    "runtime",
    "outlet",
    "product",
    "dependency",
    "version",
)


class Platform:
    """OS family, the canonical `X-PKey-Platform` value (README §3.1). iPadOS is `ios`. `tvos`, `visionos` and `watchos` are header values only; build targets are `RELEASE_PLATFORMS` (WIRE-CONTRACT-V4 §5.2 rule 5)."""

    MACOS: Final = "macos"
    IOS: Final = "ios"
    ANDROID: Final = "android"
    WINDOWS: Final = "windows"
    LINUX: Final = "linux"
    WEB: Final = "web"
    TVOS: Final = "tvos"
    VISIONOS: Final = "visionos"
    WATCHOS: Final = "watchos"


#: Every ``Platform`` value, in source order.
PLATFORM_VALUES: Tuple[str, ...] = (
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


class Arch:
    """CPU architecture, the canonical `X-PKey-Arch` value (README §3.1). `universal` and `any` are artifact values, not header values, and are not listed."""

    ARM64: Final = "arm64"
    X86_64: Final = "x86_64"
    ARMV7: Final = "armv7"
    WASM32: Final = "wasm32"


#: Every ``Arch`` value, in source order.
ARCH_VALUES: Tuple[str, ...] = (
    "arm64",
    "x86_64",
    "armv7",
    "wasm32",
)


class SdkId:
    """The canonical X-PKey-SDK value (WIRE-CONTRACT-V3 §5.2): which SDK made the request. The SDK's version is X-PKey-SDK-Version. An SDK adds its id when it lands."""

    NODE: Final = "node"
    REACT: Final = "react"
    PYTHON: Final = "python"
    SWIFT: Final = "swift"
    GODOT: Final = "godot"
    KOTLIN: Final = "kotlin"


#: Every ``SdkId`` value, in source order.
SDK_ID_VALUES: Tuple[str, ...] = (
    "node",
    "react",
    "python",
    "swift",
    "godot",
    "kotlin",
)


class StoreBackend:
    """Where a token store keeps the token, the `backend` of `Store.status()` (P1b-09). Mirrors `STORE_BACKENDS` in `@polaris-key/client-core/store`; a test keeps them equal."""

    KEYRING: Final = "keyring"
    KEYCHAIN: Final = "keychain"
    KEYSTORE: Final = "keystore"
    FILE: Final = "file"
    MEMORY: Final = "memory"
    INDEXEDDB: Final = "indexeddb"
    CUSTOM: Final = "custom"


#: Every ``StoreBackend`` value, in source order.
STORE_BACKEND_VALUES: Tuple[str, ...] = (
    "keyring",
    "keychain",
    "keystore",
    "file",
    "memory",
    "indexeddb",
    "custom",
)


class StoreDegradedReason:
    """Why a token store is weaker than its platform's best option, the `degraded.reason` of `Store.status()` (P1b-09). Mirrors `STORE_DEGRADED_REASONS` in `@polaris-key/client-core/store`; a test keeps them equal."""

    KEYRING_UNAVAILABLE: Final = "keyring-unavailable"
    KEYRING_ERROR: Final = "keyring-error"
    LEGACY_KEYCHAIN: Final = "legacy-keychain"
    NOT_PERSISTENT: Final = "not-persistent"


#: Every ``StoreDegradedReason`` value, in source order.
STORE_DEGRADED_REASON_VALUES: Tuple[str, ...] = (
    "keyring-unavailable",
    "keyring-error",
    "legacy-keychain",
    "not-persistent",
)


class OutletKind:
    """The 17 outlet kinds, in `OUTLET_KINDS` order (README §3.1, plans/P3-01.md §2.9). `unknown` is a detection result, not a kind, and is not listed."""

    DIRECT: Final = "direct"
    APP_STORE: Final = "app-store"
    TESTFLIGHT: Final = "testflight"
    ALTSTORE: Final = "altstore"
    ALTSTORE_PAL: Final = "altstore-pal"
    PLAY: Final = "play"
    PLAY_TESTING: Final = "play-testing"
    OBTAINIUM: Final = "obtainium"
    FDROID_REPO: Final = "fdroid-repo"
    MS_STORE: Final = "ms-store"
    APP_INSTALLER: Final = "app-installer"
    STEAM: Final = "steam"
    ITCH: Final = "itch"
    FLATHUB: Final = "flathub"
    SNAP: Final = "snap"
    WINGET: Final = "winget"
    WEB: Final = "web"


#: Every ``OutletKind`` value, in source order.
OUTLET_KIND_VALUES: Tuple[str, ...] = (
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


class OutletConfidence:
    """How sure outlet detection is, strongest first (`OUTLET_CONFIDENCES`, plans/P3-01.md §2.9)."""

    ATTESTED: Final = "attested"
    DECLARED: Final = "declared"
    HEURISTIC: Final = "heuristic"
    STAMP: Final = "stamp"


#: Every ``OutletConfidence`` value, in source order.
OUTLET_CONFIDENCE_VALUES: Tuple[str, ...] = (
    "attested",
    "declared",
    "heuristic",
    "stamp",
)


class OutletSubkind:
    """How a `direct` install was put on the device, where that changes who updates it (`OUTLET_SUBKINDS`, plans/P3-01.md §2.9)."""

    HOMEBREW: Final = "homebrew"
    NPM: Final = "npm"
    PNPM: Final = "pnpm"
    NPX: Final = "npx"
    SCOOP: Final = "scoop"
    CHOCOLATEY: Final = "chocolatey"
    FLATPAK: Final = "flatpak"
    APPIMAGE: Final = "appimage"


#: Every ``OutletSubkind`` value, in source order.
OUTLET_SUBKIND_VALUES: Tuple[str, ...] = (
    "homebrew",
    "npm",
    "pnpm",
    "npx",
    "scoop",
    "chocolatey",
    "flatpak",
    "appimage",
)


class UpdateAction:
    """The update decision's action (`UPDATE_ACTIONS`, plans/P3-01.md §2.8; `packs` added by plans/P4-13.md §2.6)."""

    NONE: Final = "none"
    CODE_READY: Final = "code-ready"
    BINARY: Final = "binary"
    STORE: Final = "store"
    PLATFORM: Final = "platform"
    BLOCKED: Final = "blocked"
    PACKS: Final = "packs"


#: Every ``UpdateAction`` value, in source order.
UPDATE_ACTION_VALUES: Tuple[str, ...] = (
    "none",
    "code-ready",
    "binary",
    "store",
    "platform",
    "blocked",
    "packs",
)


class UpdateNoneReason:
    """Why the update decision is `none` (`NONE_REASONS`, plans/P3-01.md §2.8)."""

    UP_TO_DATE: Final = "up-to-date"
    BEHIND: Final = "behind"
    NOT_AVAILABLE: Final = "not-available"
    HALTED: Final = "halted"
    OUT_OF_BUCKET: Final = "out-of-bucket"
    STALE: Final = "stale"
    SKIPPED: Final = "skipped"
    NO_METHOD: Final = "no-method"
    NO_BUILD: Final = "no-build"
    UNKNOWN_VERSION: Final = "unknown-version"


#: Every ``UpdateNoneReason`` value, in source order.
UPDATE_NONE_REASON_VALUES: Tuple[str, ...] = (
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


class UpdateBlockedReason:
    """Why the update decision is `blocked` (`BLOCKED_REASONS`, plans/P3-01.md §2.8; `content-floor` and `revoked-content` added by plans/P4-13.md §2.6)."""

    APP_FLOOR: Final = "app-floor"
    CONTENT_FLOOR: Final = "content-floor"
    REVOKED_CONTENT: Final = "revoked-content"


#: Every ``UpdateBlockedReason`` value, in source order.
UPDATE_BLOCKED_REASON_VALUES: Tuple[str, ...] = (
    "app-floor",
    "content-floor",
    "revoked-content",
)


class BinaryMethod:
    """How a `binary` decision installs the new build (`BINARY_METHODS`, plans/P3-01.md §2.8)."""

    NATIVE: Final = "native"
    DOWNLOAD: Final = "download"
    SIDECAR_PCK: Final = "sidecar-pck"


#: Every ``BinaryMethod`` value, in source order.
BINARY_METHOD_VALUES: Tuple[str, ...] = (
    "native",
    "download",
    "sidecar-pck",
)


class UpdateEvent:
    """The update telemetry event names on the unsigned `devices/report` (plans/P3-01.md §2.10). The shapes and the Worker allowlist are P6-03's."""

    UPDATE_OFFERED: Final = "update_offered"
    UPDATE_DOWNLOADED: Final = "update_downloaded"
    UPDATE_APPLIED: Final = "update_applied"
    UPDATE_CONFIRMED: Final = "update_confirmed"
    UPDATE_REVERTED: Final = "update_reverted"
    PACK_FAILED: Final = "pack_failed"
    BOOT_ROLLED_BACK: Final = "boot_rolled_back"


#: Every ``UpdateEvent`` value, in source order.
UPDATE_EVENT_VALUES: Tuple[str, ...] = (
    "update_offered",
    "update_downloaded",
    "update_applied",
    "update_confirmed",
    "update_reverted",
    "pack_failed",
    "boot_rolled_back",
)


class PackType:
    """The pack types a v1 SDK can hold (`PACK_TYPES`, plans/P4-01.md §2.2): `files.tree` everywhere, `godot.pck` in Godot. A record may name any `PACK_TYPE_PATTERN` type; an unknown one makes the pack unusable (`pack-type-unsupported`)."""

    GODOT_PCK: Final = "godot.pck"
    FILES_TREE: Final = "files.tree"


#: Every ``PackType`` value, in source order.
PACK_TYPE_VALUES: Tuple[str, ...] = (
    "godot.pck",
    "files.tree",
)


class PackDelivery:
    """An app record's `content.expects[].delivery` (`PACK_DELIVERIES`, plans/P4-01.md §2.4). Any other `VOCAB_TOKEN_PATTERN` value is read as `on-demand`."""

    ESSENTIAL: Final = "essential"
    PREFETCH: Final = "prefetch"
    ON_DEMAND: Final = "on-demand"


#: Every ``PackDelivery`` value, in source order.
PACK_DELIVERY_VALUES: Tuple[str, ...] = (
    "essential",
    "prefetch",
    "on-demand",
)


class PackActivation:
    """A pack record's `handler.activation` (`PACK_ACTIVATIONS`, plans/P4-01.md §2.3). An unknown value makes the pack unusable."""

    RESTART: Final = "restart"
    HOT: Final = "hot"


#: Every ``PackActivation`` value, in source order.
PACK_ACTIVATION_VALUES: Tuple[str, ...] = (
    "restart",
    "hot",
)


class FilesLayout:
    """A pack variant's `files.layout` (`FILES_LAYOUTS`, plans/P4-01.md §2.3): a single-file payload with offsets and gaps, or a directory of files. An unknown layout makes the variant unusable."""

    CONTAINER: Final = "container"
    TREE: Final = "tree"


#: Every ``FilesLayout`` value, in source order.
FILES_LAYOUT_VALUES: Tuple[str, ...] = (
    "container",
    "tree",
)


class ContentCodec:
    """An object ref's `codec` (`CONTENT_CODECS`, plans/P4-01.md §2.3): one zstd frame with its content size, or stored raw (`bytes === size`). An unknown codec makes that object unusable."""

    ZSTD: Final = "zstd"
    NONE: Final = "none"


#: Every ``ContentCodec`` value, in source order.
CONTENT_CODEC_VALUES: Tuple[str, ...] = (
    "zstd",
    "none",
)


class PatchMethod:
    """A pack delta's `method` v1 applies (`PATCH_METHODS`, plans/P4-01.md §2.3). `godot-delta-pck`, `hdiffpatch` and `bsdiff` are reserved and not listed; an unknown method makes the delta infeasible."""

    ZSTD_PATCH_FROM: Final = "zstd-patch-from"


#: Every ``PatchMethod`` value, in source order.
PATCH_METHOD_VALUES: Tuple[str, ...] = (
    "zstd-patch-from",
)


class PatchScope:
    """A pack delta's `scope` (`PATCH_SCOPES`, plans/P4-01.md §2.3): the whole payload, or the per-entry set. A delta of another scope is dropped."""

    PAYLOAD: Final = "payload"
    FILES: Final = "files"


#: Every ``PatchScope`` value, in source order.
PATCH_SCOPE_VALUES: Tuple[str, ...] = (
    "payload",
    "files",
)


class VariantAxis:
    """The variant axis names a v1 manifest may declare (`VARIANT_AXES`, plans/P4-01.md §2.2). A record may name any `VARIANT_AXIS_PATTERN` axis; a variant on an axis the host has no preferences for is ineligible."""

    TEXTURE: Final = "texture"
    LOCALE: Final = "locale"
    QUALITY: Final = "quality"


#: Every ``VariantAxis`` value, in source order.
VARIANT_AXIS_VALUES: Tuple[str, ...] = (
    "texture",
    "locale",
    "quality",
)


class PatchStrategy:
    """The install planner's strategies (plans/P4-01.md §2.9, A7 §4.2): a plan result's `strategy` and a host's `caps.strategies`. `plan-matrix.json` pins them."""

    NOOP: Final = "noop"
    PLATFORM: Final = "platform"
    DELTA: Final = "delta"
    CHUNK: Final = "chunk"
    FILE: Final = "file"
    FULL: Final = "full"


#: Every ``PatchStrategy`` value, in source order.
PATCH_STRATEGY_VALUES: Tuple[str, ...] = (
    "noop",
    "platform",
    "delta",
    "chunk",
    "file",
    "full",
)


class Transport:
    """How a deliverable's bytes arrive (`TRANSPORTS` in `@polaris-key/manifest`, P2b-02; README §3.1): the planner's `caps.transports` and a platform target's `transport` (plans/P4-01.md §2.9)."""

    EMBEDDED: Final = "embedded"
    PKEY_CDN: Final = "pkey-cdn"
    APPLE_BA: Final = "apple-ba"
    PLAY_PAD: Final = "play-pad"
    STEAM_DEPOT: Final = "steam-depot"
    MSIX_OPTIONAL: Final = "msix-optional"
    FLATPAK_EXT: Final = "flatpak-ext"
    WEB: Final = "web"


#: Every ``Transport`` value, in source order.
TRANSPORT_VALUES: Tuple[str, ...] = (
    "embedded",
    "pkey-cdn",
    "apple-ba",
    "play-pad",
    "steam-depot",
    "msix-optional",
    "flatpak-ext",
    "web",
)


class DelegablePackType:
    """The pack types a delegated content key may sign (`DELEGABLE_PACK_TYPES`, plans/P4-19.md §2.5, decision 5). A delegation's `types` outside this list are ignored; `godot.pck`, `godot.zip`, `audio.bank`, `ml.model` and `custom.*` are never delegable. `delegationCases` pins them."""

    FILES_TREE: Final = "files.tree"
    DATA_JSON: Final = "data.json"
    L10N_TABLE: Final = "l10n.table"


#: Every ``DelegablePackType`` value, in source order.
DELEGABLE_PACK_TYPE_VALUES: Tuple[str, ...] = (
    "files.tree",
    "data.json",
    "l10n.table",
)


class DataOnlyExtension:
    """The file extensions a delegated install may hold (`DATA_ONLY_EXTENSIONS`, plans/P4-19.md §2.5 rule 2): the final segment's text after its last `.`, ASCII-lowercased. An allow-list: anything else is refused (`pack-not-data-only`, rule `extension`). `dataOnlyCases` pins them."""

    JSON: Final = "json"
    CSV: Final = "csv"
    TSV: Final = "tsv"
    PO: Final = "po"
    TXT: Final = "txt"
    PNG: Final = "png"
    JPG: Final = "jpg"
    JPEG: Final = "jpeg"
    WEBP: Final = "webp"
    OGG: Final = "ogg"
    WAV: Final = "wav"
    MP3: Final = "mp3"
    TTF: Final = "ttf"
    OTF: Final = "otf"


#: Every ``DataOnlyExtension`` value, in source order.
DATA_ONLY_EXTENSION_VALUES: Tuple[str, ...] = (
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


#: Every gate status a licence evaluates to (`LicenseStatus` in `@polaris-key/protocol/license`, `client-core`'s gate). A tools/gen-sdk-constants.test.ts case keeps them equal; `copy.en.json`'s `gate` keys equal it (plans/SP-00.md §4). Every value, in source order.
LICENSE_STATUS_VALUES: Tuple[str, ...] = (
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


#: The typed activation results of `license.activate` and `license.enroll` (SDK-PARITY-PASS §3.1), in the transcript (kebab) form; each SDK spells its own kinds in its casing. `copy.en.json`'s `activation` keys equal it (plans/SP-00.md §4). Every value, in source order.
ACTIVATION_RESULT_VALUES: Tuple[str, ...] = (
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


class HeaderName:
    """The `X-PKey-*` request header names (wire contract v3 §5)."""

    ARCH: Final = "X-PKey-Arch"
    CHANNEL: Final = "X-PKey-Channel"
    DEVICE: Final = "X-PKey-Device"
    PLATFORM: Final = "X-PKey-Platform"
    SDK_NAME: Final = "X-PKey-SDK"
    SDK_VERSION: Final = "X-PKey-SDK-Version"
    VERSION: Final = "X-PKey-Version"


#: Every ``HeaderName`` value, in source order.
HEADER_NAME_VALUES: Tuple[str, ...] = (
    "X-PKey-Arch",
    "X-PKey-Channel",
    "X-PKey-Device",
    "X-PKey-Platform",
    "X-PKey-SDK",
    "X-PKey-SDK-Version",
    "X-PKey-Version",
)


class ServiceSlug:
    """The opt-in services (tools/services.json). Core is not a service — it is always on."""

    LICENSE: Final = "license"
    CONFIG: Final = "config"
    RELEASE: Final = "release"
    DISTRIBUTION: Final = "distribution"
    UPDATE: Final = "update"
    IDENTITY: Final = "identity"
    SYNC: Final = "sync"


#: Every ``ServiceSlug`` value, in source order.
SERVICE_SLUG_VALUES: Tuple[str, ...] = (
    "license",
    "config",
    "release",
    "distribution",
    "update",
    "identity",
    "sync",
)


#: The wire contract version (`@polaris-key/protocol/core`).
PROTOCOL_VERSION: Final[int] = 4


#: `corpusVersion` of conformance/corpus/v2/cases.json.
CORPUS_VERSION: Final[int] = 2


#: `gateMatrixVersion` of conformance/corpus/v2/gate-matrix.json.
GATE_MATRIX_VERSION: Final[int] = 2


#: `fingerprintVersion` of conformance/corpus/v2/fingerprint.json.
FINGERPRINT_VERSION: Final[int] = 1


#: `stageMatrixVersion` of conformance/corpus/v2/stage-matrix.json.
STAGE_MATRIX_VERSION: Final[int] = 3


#: `updateMatrixVersion` of conformance/corpus/v2/update-matrix.json.
UPDATE_MATRIX_VERSION: Final[int] = 1


#: `outletMatrixVersion` of conformance/corpus/v2/outlet-matrix.json.
OUTLET_MATRIX_VERSION: Final[int] = 1


#: `planMatrixVersion` of conformance/corpus/v2/plan-matrix.json.
PLAN_MATRIX_VERSION: Final[int] = 2


#: `syncScenariosVersion` of conformance/corpus/v2/sync-scenarios.json.
SYNC_SCENARIOS_VERSION: Final[int] = 1


#: `deviceLabelVersion` of conformance/corpus/v2/device-label.json.
DEVICE_LABEL_VERSION: Final[int] = 1


#: `presentationMatrixVersion` of conformance/corpus/v2/presentation-matrix.json.
PRESENTATION_MATRIX_VERSION: Final[int] = 1


#: `uiMatrixVersion` of conformance/corpus/v2/ui-matrix.json.
UI_MATRIX_VERSION: Final[int] = 2


#: `contentCorpusVersion` of conformance/corpus/v2/content/cases.json.
CONTENT_CORPUS_VERSION: Final[int] = 2


#: Wire contract v4 limit `MAX_WIRE_INTEGER` (`@polaris-key/protocol/core`).
MAX_WIRE_INTEGER: Final[int] = 9007199254740991


#: Wire contract v4 limit `MAX_JSON_DEPTH` (`@polaris-key/protocol/core`).
MAX_JSON_DEPTH: Final[int] = 64


#: Wire contract v4 limit `MAX_RECORD_JWS_BYTES` (`@polaris-key/protocol/core`).
MAX_RECORD_JWS_BYTES: Final[int] = 88844


#: Wire contract v4 limit `MAX_FEED_REVOCATIONS` (`@polaris-key/protocol/core`).
MAX_FEED_REVOCATIONS: Final[int] = 64


#: Wire contract v4 limit `REVOCATION_REASON_MAX_BYTES` (`@polaris-key/protocol/core`).
REVOCATION_REASON_MAX_BYTES: Final[int] = 512


#: Wire contract v4 limit `MAX_FEED_DELTAS` (`@polaris-key/protocol/core`).
MAX_FEED_DELTAS: Final[int] = 64


#: Wire contract v4 limit `MAX_FEED_DELTAS_PER_TARGET` (`@polaris-key/protocol/core`).
MAX_FEED_DELTAS_PER_TARGET: Final[int] = 4


#: Wire contract v4 limit `MAX_DELEGATION_TTL_SECONDS` (`@polaris-key/protocol/core`).
MAX_DELEGATION_TTL_SECONDS: Final[int] = 31622400


#: Wire contract v4 limit `MAX_DELEGATION_TYPES` (`@polaris-key/protocol/core`).
MAX_DELEGATION_TYPES: Final[int] = 8


#: Wire contract v4 limit `DATA_ONLY_HEAD_BYTES` (`@polaris-key/protocol/core`).
DATA_ONLY_HEAD_BYTES: Final[int] = 64


#: Wire contract v4 limit `DATA_ONLY_TAIL_BYTES` (`@polaris-key/protocol/core`).
DATA_ONLY_TAIL_BYTES: Final[int] = 65557


#: Wire contract v4 limit `MAX_DELEGATIONS_PER_CHECK` (`@polaris-key/protocol/core`).
MAX_DELEGATIONS_PER_CHECK: Final[int] = 16


#: Wire contract v4 limit `MAX_TRUST_SIGNER_ATTEMPTS` (`@polaris-key/protocol/core`).
MAX_TRUST_SIGNER_ATTEMPTS: Final[int] = 4


#: Packs on the wire: `MAX_PACK_VARIANTS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
MAX_PACK_VARIANTS: Final[int] = 32


#: Packs on the wire: `MAX_VARIANT_DELTAS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
MAX_VARIANT_DELTAS: Final[int] = 16


#: Packs on the wire: `MAX_CONTENT_PINS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
MAX_CONTENT_PINS: Final[int] = 256


#: Packs on the wire: `MAX_BUILD_EMBEDS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
MAX_BUILD_EMBEDS: Final[int] = 64


#: Packs on the wire: `MAX_INDEX_FILES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
MAX_INDEX_FILES: Final[int] = 100000


#: Packs on the wire: `MAX_FILES_INDEX_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
MAX_FILES_INDEX_BYTES: Final[int] = 33554432


#: Packs on the wire: `MAX_PACK_PATH_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
MAX_PACK_PATH_BYTES: Final[int] = 1024


#: Packs on the wire: `FILES_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
FILES_FORMAT: Final[str] = "pkey-files/1"


#: Packs on the wire: `PATCH_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
PATCH_FORMAT: Final[str] = "pkey-patch/1"


#: Packs on the wire: `MARKER_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
MARKER_FORMAT: Final[str] = "pkey-marker/1"


#: Packs on the wire: `CONTENT_STAMP_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
CONTENT_STAMP_FORMAT: Final[str] = "pkey-content/1"


#: Packs on the wire: `PLAN_REQUEST_WEIGHT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
PLAN_REQUEST_WEIGHT: Final[int] = 16384


#: Packs on the wire: `CHUNKS_FORMAT` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`).
CHUNKS_FORMAT: Final[str] = "pkey-chunks/1"


#: Packs on the wire: `MAX_CHUNK_INDEX_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`).
MAX_CHUNK_INDEX_BYTES: Final[int] = 16777216


#: Packs on the wire: `MAX_CHUNK_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`).
MAX_CHUNK_BYTES: Final[int] = 4194304


#: Identity passthrough: `DEVICE_LABEL_MAX_CODEPOINTS` (WIRE-CONTRACT-V4 §12.7, `@polaris-key/protocol/identity`).
DEVICE_LABEL_MAX_CODEPOINTS: Final[int] = 64


#: Identity passthrough: `REQUEST_HANDLE_PATTERN` (WIRE-CONTRACT-V4 §12.7, `@polaris-key/protocol/identity`).
REQUEST_HANDLE_PATTERN: Final[str] = "^rq_[A-Za-z0-9_-]{22}$"


#: Identity passthrough: `REQUEST_HANDLE_TTL_SECONDS` (WIRE-CONTRACT-V4 §12.7, `@polaris-key/protocol/identity`).
REQUEST_HANDLE_TTL_SECONDS: Final[int] = 600


#: Product presentation: `PRESENTATION_TEXT_MAX_BYTES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
PRESENTATION_TEXT_MAX_BYTES: Final[int] = 1024


#: Product presentation: `PRESENTATION_URL_MAX_BYTES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
PRESENTATION_URL_MAX_BYTES: Final[int] = 2048


#: Product presentation: `PRESENTATION_MAX_ICON_SIZES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
PRESENTATION_MAX_ICON_SIZES: Final[int] = 8


#: Product presentation: `PRESENTATION_MAX_ICON_WIDTH` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
PRESENTATION_MAX_ICON_WIDTH: Final[int] = 4096


#: Product presentation: `PRESENTATION_ICON_MAX_DIMENSION` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
PRESENTATION_ICON_MAX_DIMENSION: Final[int] = 16384


#: Product presentation: `PRESENTATION_ICON_MAX_BYTES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
PRESENTATION_ICON_MAX_BYTES: Final[int] = 10485760


#: Product presentation: `PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS: Final[int] = 10


#: Product presentation: `PRESENTATION_CACHE_MAX_FILES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
PRESENTATION_CACHE_MAX_FILES: Final[int] = 4


#: Product presentation: `PRESENTATION_ICON_TYPES` (WIRE-CONTRACT-V4 §5.5, `@polaris-key/protocol/core`).
PRESENTATION_ICON_TYPES: Tuple[str, ...] = (
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
)


#: Channel constant `CHANNEL_ALIASES` (`@polaris-key/protocol/core`).
CHANNEL_ALIASES: Mapping[str, str] = MappingProxyType(
    {
        "staging": "beta",
        "latest": "stable",
    }
)


#: Channel constant `CHANNEL_BETA` (`@polaris-key/protocol/core`).
CHANNEL_BETA: Final[str] = "beta"


#: Channel constant `CHANNEL_DEV` (`@polaris-key/protocol/core`).
CHANNEL_DEV: Final[str] = "dev"


#: Channel constant `CHANNEL_NAME_PATTERN` (`@polaris-key/protocol/core`).
CHANNEL_NAME_PATTERN: Final[str] = "^[a-z0-9][a-z0-9-]{0,63}$"


#: Channel constant `CHANNEL_PR` (`@polaris-key/protocol/core`).
CHANNEL_PR: Final[str] = "pr"


#: Channel constant `CHANNEL_STABLE` (`@polaris-key/protocol/core`).
CHANNEL_STABLE: Final[str] = "stable"


#: Channel constant `PR_CHANNEL_PATTERN` (`@polaris-key/protocol/core`).
PR_CHANNEL_PATTERN: Final[str] = "^pr-?([0-9]+)$"


#: Channel constant `PR_NUMBER_MAX_DIGITS` (`@polaris-key/protocol/core`).
PR_NUMBER_MAX_DIGITS: Final[int] = 7


#: Header-value table `ARCH_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`).
ARCH_SPELLINGS: Mapping[str, str] = MappingProxyType(
    {
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
    }
)


#: Header-value table `PLATFORM_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`).
PLATFORM_SPELLINGS: Mapping[str, str] = MappingProxyType(
    {
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
    }
)


class CapabilityNa(NamedTuple):
    """One declared N/A: on ``runtime``, the feature is unsupported for ``reason``."""

    runtime: str
    reason: str


class CapabilityRow(NamedTuple):
    """One feature's row in ``CAPABILITIES``."""

    status: str
    service: str
    na: Tuple[CapabilityNa, ...]


#: The parity-registry id of the SDK this module belongs to.
CAPABILITY_SDK: Final[str] = "python"

#: The runtimes this SDK's manifest lists.
CAPABILITY_RUNTIMES: Tuple[str, ...] = (
    "python",
)

#: This SDK's capability table, generated from its parity manifest (tools/capabilities.ts): per feature, the manifest's status, the owning service and every declared (runtime, reason) N/A. `supports()` reads it (P1b-10, PARITY §2.2).
CAPABILITIES: Mapping[str, CapabilityRow] = MappingProxyType(
    {
        "core.verify": CapabilityRow("implemented", "core", ()),
        "core.cache": CapabilityRow("implemented", "core", ()),
        "core.bundle": CapabilityRow("implemented", "core", ()),
        "core.discover": CapabilityRow("implemented", "core", ()),
        "core.presentation": CapabilityRow("planned", "core", ()),
        "core.sync": CapabilityRow("implemented", "core", ()),
        "core.local": CapabilityRow("implemented", "core", ()),
        "core.headers": CapabilityRow("implemented", "core", ()),
        "core.errors": CapabilityRow("implemented", "core", ()),
        "core.caps": CapabilityRow("implemented", "core", ()),
        "core.store": CapabilityRow("implemented", "core", (CapabilityNa("python", "dependency"),)),
        "core.copy": CapabilityRow("implemented", "sdk", ()),
        "license.gate": CapabilityRow("implemented", "license", ()),
        "license.activate": CapabilityRow("implemented", "license", ()),
        "license.enroll": CapabilityRow("implemented", "license", ()),
        "license.deactivate": CapabilityRow("implemented", "license", ()),
        "license.manage": CapabilityRow("implemented", "license", ()),
        "license.entitlements": CapabilityRow("implemented", "license", ()),
        "license.channels": CapabilityRow("implemented", "license", ()),
        "license.reregister": CapabilityRow("implemented", "license", ()),
        "license.refusals": CapabilityRow("implemented", "license", ()),
        "config.resolve": CapabilityRow("implemented", "config", ()),
        "config.list": CapabilityRow("implemented", "config", ()),
        "config.secret": CapabilityRow("implemented", "config", ()),
        "config.schema": CapabilityRow("implemented", "config", ()),
        "config.mint": CapabilityRow("implemented", "config", ()),
        "config.mirror": CapabilityRow("implemented", "config", ()),
        "config.local": CapabilityRow("implemented", "sdk", ()),
        "devices.fingerprint": CapabilityRow("implemented", "core", ()),
        "devices.facts": CapabilityRow("implemented", "core", ()),
        "devices.register": CapabilityRow("implemented", "core", ()),
        "devices.manage": CapabilityRow("implemented", "core", ()),
        "devices.report": CapabilityRow("implemented", "core", ()),
        "telemetry.updates": CapabilityRow("implemented", "core", ()),
        "devices.attest": CapabilityRow("na", "core", (CapabilityNa("python", "runtime"),)),
        "identity.oidc": CapabilityRow("planned", "identity", ()),
        "identity.devicecode": CapabilityRow("implemented", "identity", ()),
        "identity.devicelabel": CapabilityRow("implemented", "identity", ()),
        "identity.toggle": CapabilityRow("planned", "identity", ()),
        "identity.keyentry": CapabilityRow("planned", "identity", ()),
        "release.changelog": CapabilityRow("implemented", "release", ()),
        "release.download": CapabilityRow("implemented", "release", ()),
        "release.record": CapabilityRow("implemented", "release", ()),
        "release.fetch": CapabilityRow("implemented", "distribution", ()),
        "release.distribution": CapabilityRow("implemented", "distribution", ()),
        "update.check": CapabilityRow("implemented", "update", ()),
        "update.feed": CapabilityRow("implemented", "update", ()),
        "update.feeds": CapabilityRow("implemented", "update", ()),
        "update.decide": CapabilityRow("implemented", "update", ()),
        "update.content": CapabilityRow("implemented", "update", ()),
        "update.driver": CapabilityRow("implemented", "update", ()),
        "update.bootguard": CapabilityRow("implemented", "update", ()),
        "outlet.detect": CapabilityRow("implemented", "update", ()),
        "crash.tags": CapabilityRow("implemented", "sdk", ()),
        "packs.record": CapabilityRow("implemented", "release", ()),
        "packs.revoke": CapabilityRow("implemented", "release", ()),
        "packs.delegation": CapabilityRow("implemented", "release", ()),
        "packs.delta.feed": CapabilityRow("implemented", "release", ()),
        "packs.plan": CapabilityRow("implemented", "release", ()),
        "packs.index.files": CapabilityRow("implemented", "release", ()),
        "packs.index.chunks": CapabilityRow("implemented", "release", ()),
        "packs.apply.full": CapabilityRow("implemented", "release", ()),
        "packs.apply.file": CapabilityRow("implemented", "release", ()),
        "packs.apply.chunk": CapabilityRow("implemented", "release", ()),
        "packs.apply.delta": CapabilityRow("implemented", "release", ()),
        "packs.state": CapabilityRow("implemented", "release", ()),
        "packs.handlers": CapabilityRow("implemented", "release", ()),
        "packs.type.godot.zip": CapabilityRow("na", "release", (CapabilityNa("python", "runtime"),)),
        "packs.type.l10n.table": CapabilityRow("implemented", "release", ()),
        "packs.type.data.json": CapabilityRow("implemented", "release", ()),
        "packs.type.audio.bank": CapabilityRow("na", "release", (CapabilityNa("python", "runtime"),)),
        "packs.type.ml.model": CapabilityRow("implemented", "release", ()),
        "packs.provides": CapabilityRow("implemented", "release", ()),
        "packs.transport.apple": CapabilityRow("na", "distribution", (CapabilityNa("python", "runtime"),)),
        "packs.transport.play": CapabilityRow("na", "distribution", (CapabilityNa("python", "runtime"),)),
        "packs.transport.steam": CapabilityRow("planned", "distribution", ()),
        "packs.transport.msix": CapabilityRow("planned", "distribution", ()),
        "packs.transport.flatpak": CapabilityRow("planned", "distribution", ()),
        "ui.stages": CapabilityRow("implemented", "sdk", ()),
        "ui.boot": CapabilityRow("implemented", "sdk", ()),
        "ui.kit": CapabilityRow("na", "sdk", (CapabilityNa("python", "runtime"),)),
        "ui.kit.manage": CapabilityRow("na", "sdk", (CapabilityNa("python", "runtime"),)),
        "ui.kit.keyentry": CapabilityRow("na", "sdk", (CapabilityNa("python", "runtime"),)),
        "ui.cli": CapabilityRow("implemented", "sdk", ()),
        "ui.gate": CapabilityRow("planned", "sdk", ()),
        "ui.activate": CapabilityRow("planned", "sdk", ()),
        "ui.signin": CapabilityRow("planned", "sdk", ()),
        "ui.devicelimit": CapabilityRow("planned", "sdk", ()),
        "ui.devices": CapabilityRow("planned", "sdk", ()),
        "ui.update": CapabilityRow("planned", "sdk", ()),
        "ui.settings": CapabilityRow("planned", "sdk", ()),
        "ui.paywall": CapabilityRow("planned", "sdk", ()),
        "ui.theme": CapabilityRow("planned", "sdk", ()),
        "ui.i18n": CapabilityRow("planned", "sdk", ()),
        "commerce.receipt": CapabilityRow("implemented", "license", ()),
    }
)

#: SHA-256 of the canonical table; ``pnpm parity:check`` recomputes it from the manifest.
CAPABILITY_DIGEST: Final[str] = "23d6ce503bec7fcf42597404c388ec4a92a1ba619924b3db5d00cfeeb9b21402"
