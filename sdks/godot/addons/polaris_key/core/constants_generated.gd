# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm gen:constants` (tools/gen-sdk-constants.ts) from conformance/parity/
# errors.json, enums.json and features.json, tools/services.json, @polaris-key/protocol/core
# and the conformance corpus. `pnpm gen:constants -- --check` fails the green gate on any
# difference. To change a constant, edit its source and regenerate.
class_name PKeyConstants
extends RefCounted
## Polaris Key's shared constants: error codes, header names, enums, feature ids, versions.
## Read them as `PKeyConstants.ErrorCode.SERVICE_UNAVAILABLE`, `PKeyConstants.PROTOCOL_VERSION`.


## Every error code the Worker answers with or an SDK raises (conformance/parity/errors.json). Hosts match on these strings.
class ErrorCode:
	const UNAUTHORIZED := "unauthorized"
	const NOT_FOUND := "not_found"
	const BAD_REQUEST := "bad_request"
	const FORBIDDEN := "forbidden"
	const ATTESTATION_REQUIRED := "attestation_required"
	const ATTESTATION_REJECTED := "attestation_rejected"
	const ATTESTATION_UNAVAILABLE := "attestation_unavailable"
	const RATE_LIMITED := "rate_limited"
	const BODY_TOO_LARGE := "body_too_large"
	const METHOD_NOT_ALLOWED := "method_not_allowed"
	const MISCONFIGURED := "misconfigured"
	const REGISTRATION_CLOSED := "registration_closed"
	const VALUE_NOT_REPRESENTABLE := "value_not_representable"
	const DOCUMENT_NOT_REPRESENTABLE := "document_not_representable"
	const DEVICE_LIMIT := "device_limit"
	const LICENSE_DISABLED := "license_disabled"
	const LICENSE_EXPIRED := "license_expired"
	const NOT_ENTITLED := "not_entitled"
	const VERSION_BLOCKED := "version_blocked"
	const CHANNEL_NOT_ALLOWED := "channel_not_allowed"
	const HARDWARE_MISMATCH := "hardware_mismatch"
	const FINGERPRINT_REQUIRED := "fingerprint_required"
	const ENROLL_DISABLED := "enroll_disabled"
	const ENROLL_CLAIMED := "enroll_claimed"
	const ENROLL_FAILED := "enroll_failed"
	const MANAGED_BY_ADMIN := "managed_by_admin"
	const CATALOG_UNAVAILABLE := "catalog_unavailable"
	const LICENSE_UNUSABLE := "license_unusable"
	const DISABLED := "disabled"
	const OIDC_ERROR := "oidc_error"
	const UNAVAILABLE := "unavailable"
	const AUTH_METHOD_DISABLED := "auth_method_disabled"
	const EMAIL_NOT_CONFIGURED := "email_not_configured"
	const LICENSE_OWNED := "license_owned"
	const EMAIL_MISMATCH := "email_mismatch"
	const LINK_CONFLICT := "link_conflict"
	const LAST_LINK := "last_link"
	const STEP_UP_REQUIRED := "step_up_required"
	const NOT_ELIGIBLE := "not_eligible"
	const DOWNLOAD_AUTH_REQUIRED := "download_auth_required"
	const DELIVERY_GATE_MISSING := "delivery_gate_missing"
	const UPSTREAM_RATE_LIMITED := "upstream_rate_limited"
	const SERVER_MISCONFIGURED := "server_misconfigured"
	const INTERNAL_ERROR := "internal_error"
	const RELEASE_RECORD_REJECTED := "release_record_rejected"
	const RELEASE_TAG_IS_PACK_RELEASE := "release_tag_is_pack_release"
	const FEED_NOT_COMPOSABLE := "feed_not_composable"
	const SERVICE_UNAVAILABLE := "service-unavailable"
	const SERVICE_DISABLED := "service-disabled"
	const LOCAL_ONLY := "local-only"
	const INSECURE_BASE_URL := "insecure-base-url"
	const BUNDLE_JWS_REJECTED := "bundle-jws-rejected"
	const BUNDLE_CLAIMS_REJECTED := "bundle-claims-rejected"
	const BUNDLE_TRUST_REJECTED := "bundle-trust-rejected"
	const INNER_DOC_REJECTED := "inner-doc-rejected"
	const BUNDLE := "bundle"
	const TRANSPORT := "transport"
	const NETWORK := "network"
	const REFRESH_FAILED := "refresh-failed"
	const SYNC_FAILED := "sync-failed"
	const FETCH_FAILED := "fetch-failed"
	const BRIDGE_MISSING := "bridge-missing"
	const UNKNOWN := "unknown"
	const RELEASE_REFUSED := "release-refused"
	const BUNDLE_REJECTED := "bundle-rejected"
	const BUNDLE_IMPORT_UNSUPPORTED := "bundle-import-unsupported"
	const REPORT_UNSUPPORTED := "report-unsupported"
	const DEVICE_MANAGEMENT_UNSUPPORTED := "device-management-unsupported"
	const DEVICE_LIST_FAILED := "device_list_failed"
	const DEVICE_RENAME_FAILED := "device_rename_failed"
	const DEVICE_DEAUTHORIZE_FAILED := "device_deauthorize_failed"
	const KEY_ENTRY_UNSUPPORTED := "key-entry-unsupported"
	const SIGN_IN_FAILED := "sign-in-failed"
	const SIGN_OUT_FAILED := "sign-out-failed"
	const BAD_RESPONSE := "bad_response"
	const NETWORK_ERROR := "network-error"
	const SERVER_ERROR := "server-error"
	const CANCELLED := "cancelled"
	const SIGN_IN_EXPIRED := "sign-in-expired"
	const SIGN_IN_DENIED := "sign-in-denied"
	const SIGN_IN_UNAVAILABLE := "sign-in-unavailable"
	const INVALID_OPTIONS := "invalid-options"
	const NOT_CONFIGURED := "not-configured"
	const UNSUPPORTED := "unsupported"
	const TIMEOUT := "timeout"
	const RESPONSE_TOO_LARGE := "response-too-large"
	const TOO_MANY_REDIRECTS := "too-many-redirects"
	const INSECURE_REDIRECT := "insecure-redirect"
	const HTTP_ERROR := "http-error"
	const INVALID_RESPONSE := "invalid-response"
	const STORE_FAILED := "store-failed"
	const PLATFORM_ERROR := "platform-error"
	const NO_TOKEN := "no-token"
	const MINT_UNAVAILABLE := "mint-unavailable"
	const FEED_REJECTED := "feed-rejected"
	const FEED_ROLLBACK := "feed-rollback"
	const RECORD_REJECTED := "record-rejected"
	const RECORD_MISMATCH := "record-mismatch"
	const PAYLOAD_MISMATCH := "payload-mismatch"
	const SWAP_REFUSED := "swap-refused"
	const SWAP_FAILED := "swap-failed"
	const FILES_INDEX_INVALID := "files-index-invalid"
	const FILES_UNSAFE_PATH := "files-unsafe-path"
	const FILES_DUPLICATE_PATH := "files-duplicate-path"
	const FILES_CASE_COLLISION := "files-case-collision"
	const FILES_PATH_CONFLICT := "files-path-conflict"
	const FILES_LAYOUT_MISMATCH := "files-layout-mismatch"
	const CONTENT_STAMP_INVALID := "content-stamp-invalid"
	const FULL_CORRUPT := "full-corrupt"
	const DELTA_ARTIFACT_MISMATCH := "delta-artifact-mismatch"
	const DELTA_BASE_MISMATCH := "delta-base-mismatch"
	const DELTA_APPLY_FAILED := "delta-apply-failed"
	const FILE_CORRUPT := "file-corrupt"
	const FILE_SOURCE_MISSING := "file-source-missing"
	const PAYLOAD_HASH_MISMATCH := "payload-hash-mismatch"
	const CHUNKS_REF_MISMATCH := "chunks-ref-mismatch"
	const CHUNKS_BAD_LENGTH := "chunks-bad-length"
	const CHUNKS_BAD_MAGIC := "chunks-bad-magic"
	const CHUNKS_UNSUPPORTED_VERSION := "chunks-unsupported-version"
	const CHUNKS_BAD_RECORD_SIZE := "chunks-bad-record-size"
	const CHUNKS_BAD_FLAGS := "chunks-bad-flags"
	const CHUNKS_RESERVED_NONZERO := "chunks-reserved-nonzero"
	const CHUNKS_ZERO_LENGTH := "chunks-zero-length"
	const CHUNKS_BAD_CLEN := "chunks-bad-clen"
	const CHUNKS_BAD_BUNDLE_REF := "chunks-bad-bundle-ref"
	const CHUNKS_BAD_BUNDLE_RANGE := "chunks-bad-bundle-range"
	const CHUNKS_SIZE_MISMATCH := "chunks-size-mismatch"
	const CHUNKS_PAYLOAD_MISMATCH := "chunks-payload-mismatch"
	const CHUNK_BUNDLE_TRUNCATED := "chunk-bundle-truncated"
	const CHUNK_CORRUPT := "chunk-corrupt"
	const PLAN_TRANSPORT_UNSUPPORTED := "plan-transport-unsupported"
	const PLAN_INSUFFICIENT_DISK := "plan-insufficient-disk"
	const PLAN_NO_STRATEGY := "plan-no-strategy"
	const PACK_NO_VARIANT := "pack-no-variant"
	const PACK_TYPE_UNSUPPORTED := "pack-type-unsupported"
	const PACK_TYPE_CHECK_FAILED := "pack-type-check-failed"
	const PACK_NOT_PINNED := "pack-not-pinned"
	const PACK_NOT_ENTITLED := "pack-not-entitled"
	const PACK_STATE_UNREADABLE := "pack-state-unreadable"
	const PCK_DIRECTORY_REFUSED := "pck-directory-refused"
	const PCK_ENGINE_MISMATCH := "pck-engine-mismatch"
	const PACK_ROLLED_BACK := "pack-rolled-back"
	const PACK_REVOKED := "pack-revoked"
	const PACK_NOT_DATA_ONLY := "pack-not-data-only"
	const MARKER_REJECTED := "marker-rejected"


## Every `ErrorCode` value, in source order.
const ERROR_CODE_VALUES := ["unauthorized", "not_found", "bad_request", "forbidden", "attestation_required", "attestation_rejected", "attestation_unavailable", "rate_limited", "body_too_large", "method_not_allowed", "misconfigured", "registration_closed", "value_not_representable", "document_not_representable", "device_limit", "license_disabled", "license_expired", "not_entitled", "version_blocked", "channel_not_allowed", "hardware_mismatch", "fingerprint_required", "enroll_disabled", "enroll_claimed", "enroll_failed", "managed_by_admin", "catalog_unavailable", "license_unusable", "disabled", "oidc_error", "unavailable", "auth_method_disabled", "email_not_configured", "license_owned", "email_mismatch", "link_conflict", "last_link", "step_up_required", "not_eligible", "download_auth_required", "delivery_gate_missing", "upstream_rate_limited", "server_misconfigured", "internal_error", "release_record_rejected", "release_tag_is_pack_release", "feed_not_composable", "service-unavailable", "service-disabled", "local-only", "insecure-base-url", "bundle-jws-rejected", "bundle-claims-rejected", "bundle-trust-rejected", "inner-doc-rejected", "bundle", "transport", "network", "refresh-failed", "sync-failed", "fetch-failed", "bridge-missing", "unknown", "release-refused", "bundle-rejected", "bundle-import-unsupported", "report-unsupported", "device-management-unsupported", "device_list_failed", "device_rename_failed", "device_deauthorize_failed", "key-entry-unsupported", "sign-in-failed", "sign-out-failed", "bad_response", "network-error", "server-error", "cancelled", "sign-in-expired", "sign-in-denied", "sign-in-unavailable", "invalid-options", "not-configured", "unsupported", "timeout", "response-too-large", "too-many-redirects", "insecure-redirect", "http-error", "invalid-response", "store-failed", "platform-error", "no-token", "mint-unavailable", "feed-rejected", "feed-rollback", "record-rejected", "record-mismatch", "payload-mismatch", "swap-refused", "swap-failed", "files-index-invalid", "files-unsafe-path", "files-duplicate-path", "files-case-collision", "files-path-conflict", "files-layout-mismatch", "content-stamp-invalid", "full-corrupt", "delta-artifact-mismatch", "delta-base-mismatch", "delta-apply-failed", "file-corrupt", "file-source-missing", "payload-hash-mismatch", "chunks-ref-mismatch", "chunks-bad-length", "chunks-bad-magic", "chunks-unsupported-version", "chunks-bad-record-size", "chunks-bad-flags", "chunks-reserved-nonzero", "chunks-zero-length", "chunks-bad-clen", "chunks-bad-bundle-ref", "chunks-bad-bundle-range", "chunks-size-mismatch", "chunks-payload-mismatch", "chunk-bundle-truncated", "chunk-corrupt", "plan-transport-unsupported", "plan-insufficient-disk", "plan-no-strategy", "pack-no-variant", "pack-type-unsupported", "pack-type-check-failed", "pack-not-pinned", "pack-not-entitled", "pack-state-unreadable", "pck-directory-refused", "pck-engine-mismatch", "pack-rolled-back", "pack-revoked", "pack-not-data-only", "marker-rejected"]

## The registry: every error code and its kind (`wire` or `client`).
const ERROR_CODE_KINDS := {
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
	"auth_method_disabled": "wire",
	"email_not_configured": "wire",
	"license_owned": "wire",
	"email_mismatch": "wire",
	"link_conflict": "wire",
	"last_link": "wire",
	"step_up_required": "wire",
	"not_eligible": "wire",
	"download_auth_required": "wire",
	"delivery_gate_missing": "wire",
	"upstream_rate_limited": "wire",
	"server_misconfigured": "wire",
	"internal_error": "wire",
	"release_record_rejected": "wire",
	"release_tag_is_pack_release": "wire",
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


## Every feature id in the parity registry (conformance/parity/features.json).
class Feature:
	const CORE_VERIFY := "core.verify"
	const CORE_CACHE := "core.cache"
	const CORE_BUNDLE := "core.bundle"
	const CORE_DISCOVER := "core.discover"
	const CORE_SYNC := "core.sync"
	const CORE_LOCAL := "core.local"
	const CORE_HEADERS := "core.headers"
	const CORE_ERRORS := "core.errors"
	const CORE_CAPS := "core.caps"
	const CORE_STORE := "core.store"
	const CORE_COPY := "core.copy"
	const LICENSE_GATE := "license.gate"
	const LICENSE_ACTIVATE := "license.activate"
	const LICENSE_ENROLL := "license.enroll"
	const LICENSE_DEACTIVATE := "license.deactivate"
	const LICENSE_MANAGE := "license.manage"
	const LICENSE_ENTITLEMENTS := "license.entitlements"
	const LICENSE_CHANNELS := "license.channels"
	const LICENSE_REREGISTER := "license.reregister"
	const LICENSE_REFUSALS := "license.refusals"
	const CONFIG_RESOLVE := "config.resolve"
	const CONFIG_LIST := "config.list"
	const CONFIG_SECRET := "config.secret"
	const CONFIG_SCHEMA := "config.schema"
	const CONFIG_MINT := "config.mint"
	const CONFIG_MIRROR := "config.mirror"
	const CONFIG_LOCAL := "config.local"
	const DEVICES_FINGERPRINT := "devices.fingerprint"
	const DEVICES_FACTS := "devices.facts"
	const DEVICES_REGISTER := "devices.register"
	const DEVICES_MANAGE := "devices.manage"
	const DEVICES_REPORT := "devices.report"
	const TELEMETRY_UPDATES := "telemetry.updates"
	const DEVICES_ATTEST := "devices.attest"
	const IDENTITY_OIDC := "identity.oidc"
	const IDENTITY_DEVICECODE := "identity.devicecode"
	const RELEASE_CHANGELOG := "release.changelog"
	const RELEASE_DOWNLOAD := "release.download"
	const RELEASE_RECORD := "release.record"
	const RELEASE_FETCH := "release.fetch"
	const RELEASE_DISTRIBUTION := "release.distribution"
	const UPDATE_CHECK := "update.check"
	const UPDATE_FEED := "update.feed"
	const UPDATE_FEEDS := "update.feeds"
	const UPDATE_DECIDE := "update.decide"
	const UPDATE_CONTENT := "update.content"
	const UPDATE_DRIVER := "update.driver"
	const UPDATE_BOOTGUARD := "update.bootguard"
	const OUTLET_DETECT := "outlet.detect"
	const CRASH_TAGS := "crash.tags"
	const PACKS_RECORD := "packs.record"
	const PACKS_REVOKE := "packs.revoke"
	const PACKS_DELEGATION := "packs.delegation"
	const PACKS_DELTA_FEED := "packs.delta.feed"
	const PACKS_PLAN := "packs.plan"
	const PACKS_INDEX_FILES := "packs.index.files"
	const PACKS_INDEX_CHUNKS := "packs.index.chunks"
	const PACKS_APPLY_FULL := "packs.apply.full"
	const PACKS_APPLY_FILE := "packs.apply.file"
	const PACKS_APPLY_CHUNK := "packs.apply.chunk"
	const PACKS_APPLY_DELTA := "packs.apply.delta"
	const PACKS_STATE := "packs.state"
	const PACKS_HANDLERS := "packs.handlers"
	const PACKS_TYPE_GODOT_ZIP := "packs.type.godot.zip"
	const PACKS_TYPE_L10N_TABLE := "packs.type.l10n.table"
	const PACKS_TYPE_DATA_JSON := "packs.type.data.json"
	const PACKS_TYPE_AUDIO_BANK := "packs.type.audio.bank"
	const PACKS_TYPE_ML_MODEL := "packs.type.ml.model"
	const PACKS_PROVIDES := "packs.provides"
	const PACKS_TRANSPORT_APPLE := "packs.transport.apple"
	const PACKS_TRANSPORT_PLAY := "packs.transport.play"
	const PACKS_TRANSPORT_STEAM := "packs.transport.steam"
	const PACKS_TRANSPORT_MSIX := "packs.transport.msix"
	const PACKS_TRANSPORT_FLATPAK := "packs.transport.flatpak"
	const UI_STAGES := "ui.stages"
	const UI_BOOT := "ui.boot"
	const UI_KIT := "ui.kit"
	const UI_KIT_MANAGE := "ui.kit.manage"
	const UI_CLI := "ui.cli"
	const COMMERCE_RECEIPT := "commerce.receipt"


## Every `Feature` value, in source order.
const FEATURE_VALUES := ["core.verify", "core.cache", "core.bundle", "core.discover", "core.sync", "core.local", "core.headers", "core.errors", "core.caps", "core.store", "core.copy", "license.gate", "license.activate", "license.enroll", "license.deactivate", "license.manage", "license.entitlements", "license.channels", "license.reregister", "license.refusals", "config.resolve", "config.list", "config.secret", "config.schema", "config.mint", "config.mirror", "config.local", "devices.fingerprint", "devices.facts", "devices.register", "devices.manage", "devices.report", "telemetry.updates", "devices.attest", "identity.oidc", "identity.devicecode", "release.changelog", "release.download", "release.record", "release.fetch", "release.distribution", "update.check", "update.feed", "update.feeds", "update.decide", "update.content", "update.driver", "update.bootguard", "outlet.detect", "crash.tags", "packs.record", "packs.revoke", "packs.delegation", "packs.delta.feed", "packs.plan", "packs.index.files", "packs.index.chunks", "packs.apply.full", "packs.apply.file", "packs.apply.chunk", "packs.apply.delta", "packs.state", "packs.handlers", "packs.type.godot.zip", "packs.type.l10n.table", "packs.type.data.json", "packs.type.audio.bank", "packs.type.ml.model", "packs.provides", "packs.transport.apple", "packs.transport.play", "packs.transport.steam", "packs.transport.msix", "packs.transport.flatpak", "ui.stages", "ui.boot", "ui.kit", "ui.kit.manage", "ui.cli", "commerce.receipt"]


## Why a feature is unsupported here: the `supports()` reason enum (PARITY §2.2).
class UnsupportedReason:
	const RUNTIME := "runtime"
	const OUTLET := "outlet"
	const PRODUCT := "product"
	const DEPENDENCY := "dependency"
	const VERSION := "version"


## Every `UnsupportedReason` value, in source order.
const UNSUPPORTED_REASON_VALUES := ["runtime", "outlet", "product", "dependency", "version"]


## OS family, the canonical `X-PKey-Platform` value (README §3.1). iPadOS is `ios`.
class Platform:
	const MACOS := "macos"
	const IOS := "ios"
	const ANDROID := "android"
	const WINDOWS := "windows"
	const LINUX := "linux"
	const WEB := "web"


## Every `Platform` value, in source order.
const PLATFORM_VALUES := ["macos", "ios", "android", "windows", "linux", "web"]


## CPU architecture, the canonical `X-PKey-Arch` value (README §3.1). `universal` and `any` are artifact values, not header values, and are not listed.
class Arch:
	const ARM64 := "arm64"
	const X86_64 := "x86_64"
	const ARMV7 := "armv7"
	const WASM32 := "wasm32"


## Every `Arch` value, in source order.
const ARCH_VALUES := ["arm64", "x86_64", "armv7", "wasm32"]


## The canonical X-PKey-SDK value (WIRE-CONTRACT-V3 §5.2): which SDK made the request. The SDK's version is X-PKey-SDK-Version. An SDK adds its id when it lands.
class SdkId:
	const NODE := "node"
	const REACT := "react"
	const PYTHON := "python"
	const SWIFT := "swift"
	const GODOT := "godot"
	const KOTLIN := "kotlin"


## Every `SdkId` value, in source order.
const SDK_ID_VALUES := ["node", "react", "python", "swift", "godot", "kotlin"]


## Where a token store keeps the token, the `backend` of `Store.status()` (P1b-09). Mirrors `STORE_BACKENDS` in `@polaris-key/client-core/store`; a test keeps them equal.
class StoreBackend:
	const KEYRING := "keyring"
	const KEYCHAIN := "keychain"
	const KEYSTORE := "keystore"
	const FILE := "file"
	const MEMORY := "memory"
	const INDEXEDDB := "indexeddb"
	const CUSTOM := "custom"


## Every `StoreBackend` value, in source order.
const STORE_BACKEND_VALUES := ["keyring", "keychain", "keystore", "file", "memory", "indexeddb", "custom"]


## Why a token store is weaker than its platform's best option, the `degraded.reason` of `Store.status()` (P1b-09). Mirrors `STORE_DEGRADED_REASONS` in `@polaris-key/client-core/store`; a test keeps them equal.
class StoreDegradedReason:
	const KEYRING_UNAVAILABLE := "keyring-unavailable"
	const KEYRING_ERROR := "keyring-error"
	const LEGACY_KEYCHAIN := "legacy-keychain"
	const NOT_PERSISTENT := "not-persistent"


## Every `StoreDegradedReason` value, in source order.
const STORE_DEGRADED_REASON_VALUES := ["keyring-unavailable", "keyring-error", "legacy-keychain", "not-persistent"]


## The 17 outlet kinds, in `OUTLET_KINDS` order (README §3.1, plans/P3-01.md §2.9). `unknown` is a detection result, not a kind, and is not listed.
class OutletKind:
	const DIRECT := "direct"
	const APP_STORE := "app-store"
	const TESTFLIGHT := "testflight"
	const ALTSTORE := "altstore"
	const ALTSTORE_PAL := "altstore-pal"
	const PLAY := "play"
	const PLAY_TESTING := "play-testing"
	const OBTAINIUM := "obtainium"
	const FDROID_REPO := "fdroid-repo"
	const MS_STORE := "ms-store"
	const APP_INSTALLER := "app-installer"
	const STEAM := "steam"
	const ITCH := "itch"
	const FLATHUB := "flathub"
	const SNAP := "snap"
	const WINGET := "winget"
	const WEB := "web"


## Every `OutletKind` value, in source order.
const OUTLET_KIND_VALUES := ["direct", "app-store", "testflight", "altstore", "altstore-pal", "play", "play-testing", "obtainium", "fdroid-repo", "ms-store", "app-installer", "steam", "itch", "flathub", "snap", "winget", "web"]


## How sure outlet detection is, strongest first (`OUTLET_CONFIDENCES`, plans/P3-01.md §2.9).
class OutletConfidence:
	const ATTESTED := "attested"
	const DECLARED := "declared"
	const HEURISTIC := "heuristic"
	const STAMP := "stamp"


## Every `OutletConfidence` value, in source order.
const OUTLET_CONFIDENCE_VALUES := ["attested", "declared", "heuristic", "stamp"]


## How a `direct` install was put on the device, where that changes who updates it (`OUTLET_SUBKINDS`, plans/P3-01.md §2.9).
class OutletSubkind:
	const HOMEBREW := "homebrew"
	const NPM := "npm"
	const PNPM := "pnpm"
	const NPX := "npx"
	const SCOOP := "scoop"
	const CHOCOLATEY := "chocolatey"
	const FLATPAK := "flatpak"
	const APPIMAGE := "appimage"


## Every `OutletSubkind` value, in source order.
const OUTLET_SUBKIND_VALUES := ["homebrew", "npm", "pnpm", "npx", "scoop", "chocolatey", "flatpak", "appimage"]


## The update decision's action (`UPDATE_ACTIONS`, plans/P3-01.md §2.8; `packs` added by plans/P4-13.md §2.6).
class UpdateAction:
	const NONE := "none"
	const CODE_READY := "code-ready"
	const BINARY := "binary"
	const STORE := "store"
	const PLATFORM := "platform"
	const BLOCKED := "blocked"
	const PACKS := "packs"


## Every `UpdateAction` value, in source order.
const UPDATE_ACTION_VALUES := ["none", "code-ready", "binary", "store", "platform", "blocked", "packs"]


## Why the update decision is `none` (`NONE_REASONS`, plans/P3-01.md §2.8).
class UpdateNoneReason:
	const UP_TO_DATE := "up-to-date"
	const BEHIND := "behind"
	const NOT_AVAILABLE := "not-available"
	const HALTED := "halted"
	const OUT_OF_BUCKET := "out-of-bucket"
	const STALE := "stale"
	const SKIPPED := "skipped"
	const NO_METHOD := "no-method"
	const NO_BUILD := "no-build"
	const UNKNOWN_VERSION := "unknown-version"


## Every `UpdateNoneReason` value, in source order.
const UPDATE_NONE_REASON_VALUES := ["up-to-date", "behind", "not-available", "halted", "out-of-bucket", "stale", "skipped", "no-method", "no-build", "unknown-version"]


## Why the update decision is `blocked` (`BLOCKED_REASONS`, plans/P3-01.md §2.8; `content-floor` and `revoked-content` added by plans/P4-13.md §2.6).
class UpdateBlockedReason:
	const APP_FLOOR := "app-floor"
	const CONTENT_FLOOR := "content-floor"
	const REVOKED_CONTENT := "revoked-content"


## Every `UpdateBlockedReason` value, in source order.
const UPDATE_BLOCKED_REASON_VALUES := ["app-floor", "content-floor", "revoked-content"]


## How a `binary` decision installs the new build (`BINARY_METHODS`, plans/P3-01.md §2.8).
class BinaryMethod:
	const NATIVE := "native"
	const DOWNLOAD := "download"
	const SIDECAR_PCK := "sidecar-pck"


## Every `BinaryMethod` value, in source order.
const BINARY_METHOD_VALUES := ["native", "download", "sidecar-pck"]


## The update telemetry event names on the unsigned `devices/report` (plans/P3-01.md §2.10). The shapes and the Worker allowlist are P6-03's.
class UpdateEvent:
	const UPDATE_OFFERED := "update_offered"
	const UPDATE_DOWNLOADED := "update_downloaded"
	const UPDATE_APPLIED := "update_applied"
	const UPDATE_CONFIRMED := "update_confirmed"
	const UPDATE_REVERTED := "update_reverted"
	const PACK_FAILED := "pack_failed"
	const BOOT_ROLLED_BACK := "boot_rolled_back"


## Every `UpdateEvent` value, in source order.
const UPDATE_EVENT_VALUES := ["update_offered", "update_downloaded", "update_applied", "update_confirmed", "update_reverted", "pack_failed", "boot_rolled_back"]


## The pack types a v1 SDK can hold (`PACK_TYPES`, plans/P4-01.md §2.2): `files.tree` everywhere, `godot.pck` in Godot. A record may name any `PACK_TYPE_PATTERN` type; an unknown one makes the pack unusable (`pack-type-unsupported`).
class PackType:
	const GODOT_PCK := "godot.pck"
	const FILES_TREE := "files.tree"


## Every `PackType` value, in source order.
const PACK_TYPE_VALUES := ["godot.pck", "files.tree"]


## An app record's `content.expects[].delivery` (`PACK_DELIVERIES`, plans/P4-01.md §2.4). Any other `VOCAB_TOKEN_PATTERN` value is read as `on-demand`.
class PackDelivery:
	const ESSENTIAL := "essential"
	const PREFETCH := "prefetch"
	const ON_DEMAND := "on-demand"


## Every `PackDelivery` value, in source order.
const PACK_DELIVERY_VALUES := ["essential", "prefetch", "on-demand"]


## A pack record's `handler.activation` (`PACK_ACTIVATIONS`, plans/P4-01.md §2.3). An unknown value makes the pack unusable.
class PackActivation:
	const RESTART := "restart"
	const HOT := "hot"


## Every `PackActivation` value, in source order.
const PACK_ACTIVATION_VALUES := ["restart", "hot"]


## A pack variant's `files.layout` (`FILES_LAYOUTS`, plans/P4-01.md §2.3): a single-file payload with offsets and gaps, or a directory of files. An unknown layout makes the variant unusable.
class FilesLayout:
	const CONTAINER := "container"
	const TREE := "tree"


## Every `FilesLayout` value, in source order.
const FILES_LAYOUT_VALUES := ["container", "tree"]


## An object ref's `codec` (`CONTENT_CODECS`, plans/P4-01.md §2.3): one zstd frame with its content size, or stored raw (`bytes === size`). An unknown codec makes that object unusable.
class ContentCodec:
	const ZSTD := "zstd"
	const NONE := "none"


## Every `ContentCodec` value, in source order.
const CONTENT_CODEC_VALUES := ["zstd", "none"]


## A pack delta's `method` v1 applies (`PATCH_METHODS`, plans/P4-01.md §2.3). `godot-delta-pck`, `hdiffpatch` and `bsdiff` are reserved and not listed; an unknown method makes the delta infeasible.
class PatchMethod:
	const ZSTD_PATCH_FROM := "zstd-patch-from"


## Every `PatchMethod` value, in source order.
const PATCH_METHOD_VALUES := ["zstd-patch-from"]


## A pack delta's `scope` (`PATCH_SCOPES`, plans/P4-01.md §2.3): the whole payload, or the per-entry set. A delta of another scope is dropped.
class PatchScope:
	const PAYLOAD := "payload"
	const FILES := "files"


## Every `PatchScope` value, in source order.
const PATCH_SCOPE_VALUES := ["payload", "files"]


## The variant axis names a v1 manifest may declare (`VARIANT_AXES`, plans/P4-01.md §2.2). A record may name any `VARIANT_AXIS_PATTERN` axis; a variant on an axis the host has no preferences for is ineligible.
class VariantAxis:
	const TEXTURE := "texture"
	const LOCALE := "locale"
	const QUALITY := "quality"


## Every `VariantAxis` value, in source order.
const VARIANT_AXIS_VALUES := ["texture", "locale", "quality"]


## The install planner's strategies (plans/P4-01.md §2.9, A7 §4.2): a plan result's `strategy` and a host's `caps.strategies`. `plan-matrix.json` pins them.
class PatchStrategy:
	const NOOP := "noop"
	const PLATFORM := "platform"
	const DELTA := "delta"
	const CHUNK := "chunk"
	const FILE := "file"
	const FULL := "full"


## Every `PatchStrategy` value, in source order.
const PATCH_STRATEGY_VALUES := ["noop", "platform", "delta", "chunk", "file", "full"]


## How a deliverable's bytes arrive (`TRANSPORTS` in `@polaris-key/manifest`, P2b-02; README §3.1): the planner's `caps.transports` and a platform target's `transport` (plans/P4-01.md §2.9).
class Transport:
	const EMBEDDED := "embedded"
	const PKEY_CDN := "pkey-cdn"
	const APPLE_BA := "apple-ba"
	const PLAY_PAD := "play-pad"
	const STEAM_DEPOT := "steam-depot"
	const MSIX_OPTIONAL := "msix-optional"
	const FLATPAK_EXT := "flatpak-ext"
	const WEB := "web"


## Every `Transport` value, in source order.
const TRANSPORT_VALUES := ["embedded", "pkey-cdn", "apple-ba", "play-pad", "steam-depot", "msix-optional", "flatpak-ext", "web"]


## The pack types a delegated content key may sign (`DELEGABLE_PACK_TYPES`, plans/P4-19.md §2.5, decision 5). A delegation's `types` outside this list are ignored; `godot.pck`, `godot.zip`, `audio.bank`, `ml.model` and `custom.*` are never delegable. `delegationCases` pins them.
class DelegablePackType:
	const FILES_TREE := "files.tree"
	const DATA_JSON := "data.json"
	const L10N_TABLE := "l10n.table"


## Every `DelegablePackType` value, in source order.
const DELEGABLE_PACK_TYPE_VALUES := ["files.tree", "data.json", "l10n.table"]


## The file extensions a delegated install may hold (`DATA_ONLY_EXTENSIONS`, plans/P4-19.md §2.5 rule 2): the final segment's text after its last `.`, ASCII-lowercased. An allow-list: anything else is refused (`pack-not-data-only`, rule `extension`). `dataOnlyCases` pins them.
class DataOnlyExtension:
	const JSON_ := "json"
	const CSV := "csv"
	const TSV := "tsv"
	const PO := "po"
	const TXT := "txt"
	const PNG := "png"
	const JPG := "jpg"
	const JPEG := "jpeg"
	const WEBP := "webp"
	const OGG := "ogg"
	const WAV := "wav"
	const MP3 := "mp3"
	const TTF := "ttf"
	const OTF := "otf"


## Every `DataOnlyExtension` value, in source order.
const DATA_ONLY_EXTENSION_VALUES := ["json", "csv", "tsv", "po", "txt", "png", "jpg", "jpeg", "webp", "ogg", "wav", "mp3", "ttf", "otf"]


## Every gate status a licence evaluates to (`LicenseStatus` in `@polaris-key/protocol/license`, `client-core`'s gate). A tools/gen-sdk-constants.test.ts case keeps them equal; `copy.en.json`'s `gate` keys equal it (plans/SP-00.md §4). Every value, in source order.
const LICENSE_STATUS_VALUES := ["ok", "grace", "expired", "revoked", "needs-activation", "version-too-old", "version-too-new", "channel-not-entitled", "not-applicable"]


## The typed activation results of `license.activate` and `license.enroll` (SDK-PARITY-PASS §3.1), in the transcript (kebab) form; each SDK spells its own kinds in its casing. `copy.en.json`'s `activation` keys equal it (plans/SP-00.md §4). Every value, in source order.
const ACTIVATION_RESULT_VALUES := ["ok", "device-limit", "fingerprint-required", "hardware-mismatch", "enroll-claimed", "license-disabled", "license-expired", "attestation-required", "rate-limited", "unauthorized", "enroll-disabled", "refused", "error"]


## The `X-PKey-*` request header names (wire contract v3 §5).
class HeaderName:
	const ARCH := "X-PKey-Arch"
	const CHANNEL := "X-PKey-Channel"
	const DEVICE := "X-PKey-Device"
	const PLATFORM := "X-PKey-Platform"
	const SDK_NAME := "X-PKey-SDK"
	const SDK_VERSION := "X-PKey-SDK-Version"
	const VERSION := "X-PKey-Version"


## Every `HeaderName` value, in source order.
const HEADER_NAME_VALUES := ["X-PKey-Arch", "X-PKey-Channel", "X-PKey-Device", "X-PKey-Platform", "X-PKey-SDK", "X-PKey-SDK-Version", "X-PKey-Version"]


## The opt-in services (tools/services.json). Core is not a service — it is always on.
class ServiceSlug:
	const LICENSE := "license"
	const CONFIG := "config"
	const RELEASE := "release"
	const DISTRIBUTION := "distribution"
	const UPDATE := "update"
	const IDENTITY := "identity"


## Every `ServiceSlug` value, in source order.
const SERVICE_SLUG_VALUES := ["license", "config", "release", "distribution", "update", "identity"]

## The wire contract version (`@polaris-key/protocol/core`).
const PROTOCOL_VERSION := 4

## `corpusVersion` of conformance/corpus/v2/cases.json.
const CORPUS_VERSION := 2

## `gateMatrixVersion` of conformance/corpus/v2/gate-matrix.json.
const GATE_MATRIX_VERSION := 2

## `fingerprintVersion` of conformance/corpus/v2/fingerprint.json.
const FINGERPRINT_VERSION := 1

## `stageMatrixVersion` of conformance/corpus/v2/stage-matrix.json.
const STAGE_MATRIX_VERSION := 3

## `updateMatrixVersion` of conformance/corpus/v2/update-matrix.json.
const UPDATE_MATRIX_VERSION := 1

## `outletMatrixVersion` of conformance/corpus/v2/outlet-matrix.json.
const OUTLET_MATRIX_VERSION := 1

## `planMatrixVersion` of conformance/corpus/v2/plan-matrix.json.
const PLAN_MATRIX_VERSION := 2

## `contentCorpusVersion` of conformance/corpus/v2/content/cases.json.
const CONTENT_CORPUS_VERSION := 2

## Wire contract v4 limit `MAX_WIRE_INTEGER` (`@polaris-key/protocol/core`).
const MAX_WIRE_INTEGER := 9007199254740991

## Wire contract v4 limit `MAX_JSON_DEPTH` (`@polaris-key/protocol/core`).
const MAX_JSON_DEPTH := 64

## Wire contract v4 limit `MAX_RECORD_JWS_BYTES` (`@polaris-key/protocol/core`).
const MAX_RECORD_JWS_BYTES := 88844

## Wire contract v4 limit `MAX_FEED_REVOCATIONS` (`@polaris-key/protocol/core`).
const MAX_FEED_REVOCATIONS := 64

## Wire contract v4 limit `REVOCATION_REASON_MAX_BYTES` (`@polaris-key/protocol/core`).
const REVOCATION_REASON_MAX_BYTES := 512

## Wire contract v4 limit `MAX_FEED_DELTAS` (`@polaris-key/protocol/core`).
const MAX_FEED_DELTAS := 64

## Wire contract v4 limit `MAX_FEED_DELTAS_PER_TARGET` (`@polaris-key/protocol/core`).
const MAX_FEED_DELTAS_PER_TARGET := 4

## Wire contract v4 limit `MAX_DELEGATION_TTL_SECONDS` (`@polaris-key/protocol/core`).
const MAX_DELEGATION_TTL_SECONDS := 31622400

## Wire contract v4 limit `MAX_DELEGATION_TYPES` (`@polaris-key/protocol/core`).
const MAX_DELEGATION_TYPES := 8

## Wire contract v4 limit `DATA_ONLY_HEAD_BYTES` (`@polaris-key/protocol/core`).
const DATA_ONLY_HEAD_BYTES := 64

## Wire contract v4 limit `DATA_ONLY_TAIL_BYTES` (`@polaris-key/protocol/core`).
const DATA_ONLY_TAIL_BYTES := 65557

## Wire contract v4 limit `MAX_DELEGATIONS_PER_CHECK` (`@polaris-key/protocol/core`).
const MAX_DELEGATIONS_PER_CHECK := 16

## Packs on the wire: `MAX_PACK_VARIANTS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const MAX_PACK_VARIANTS := 32

## Packs on the wire: `MAX_VARIANT_DELTAS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const MAX_VARIANT_DELTAS := 16

## Packs on the wire: `MAX_CONTENT_PINS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const MAX_CONTENT_PINS := 256

## Packs on the wire: `MAX_BUILD_EMBEDS` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const MAX_BUILD_EMBEDS := 64

## Packs on the wire: `MAX_INDEX_FILES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const MAX_INDEX_FILES := 100000

## Packs on the wire: `MAX_FILES_INDEX_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const MAX_FILES_INDEX_BYTES := 33554432

## Packs on the wire: `MAX_PACK_PATH_BYTES` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const MAX_PACK_PATH_BYTES := 1024

## Packs on the wire: `FILES_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const FILES_FORMAT := "pkey-files/1"

## Packs on the wire: `PATCH_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const PATCH_FORMAT := "pkey-patch/1"

## Packs on the wire: `MARKER_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const MARKER_FORMAT := "pkey-marker/1"

## Packs on the wire: `CONTENT_STAMP_FORMAT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const CONTENT_STAMP_FORMAT := "pkey-content/1"

## Packs on the wire: `PLAN_REQUEST_WEIGHT` (plans/P4-01.md §2.13, `@polaris-key/protocol/core`).
const PLAN_REQUEST_WEIGHT := 16384

## Packs on the wire: `CHUNKS_FORMAT` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`).
const CHUNKS_FORMAT := "pkey-chunks/1"

## Packs on the wire: `MAX_CHUNK_INDEX_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`).
const MAX_CHUNK_INDEX_BYTES := 16777216

## Packs on the wire: `MAX_CHUNK_BYTES` (plans/P4-10.md §2.3, `@polaris-key/protocol/core`).
const MAX_CHUNK_BYTES := 4194304

## Channel constant `CHANNEL_ALIASES` (`@polaris-key/protocol/core`).
const CHANNEL_ALIASES := {
	"staging": "beta",
	"latest": "stable",
}

## Channel constant `CHANNEL_BETA` (`@polaris-key/protocol/core`).
const CHANNEL_BETA := "beta"

## Channel constant `CHANNEL_DEV` (`@polaris-key/protocol/core`).
const CHANNEL_DEV := "dev"

## Channel constant `CHANNEL_NAME_PATTERN` (`@polaris-key/protocol/core`).
const CHANNEL_NAME_PATTERN := "^[a-z0-9][a-z0-9-]{0,63}$"

## Channel constant `CHANNEL_PR` (`@polaris-key/protocol/core`).
const CHANNEL_PR := "pr"

## Channel constant `CHANNEL_STABLE` (`@polaris-key/protocol/core`).
const CHANNEL_STABLE := "stable"

## Channel constant `PR_CHANNEL_PATTERN` (`@polaris-key/protocol/core`).
const PR_CHANNEL_PATTERN := "^pr-?([0-9]+)$"

## Channel constant `PR_NUMBER_MAX_DIGITS` (`@polaris-key/protocol/core`).
const PR_NUMBER_MAX_DIGITS := 7

## Header-value table `ARCH_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`).
const ARCH_SPELLINGS := {
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

## Header-value table `PLATFORM_SPELLINGS`: a runtime's spelling, ASCII-lowercased, to its canonical value (WIRE-CONTRACT-V3 §5.2, `@polaris-key/protocol/core`).
const PLATFORM_SPELLINGS := {
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
}

## The parity-registry id of the SDK this module belongs to.
const CAPABILITY_SDK := "godot"

## The runtimes this SDK's manifest lists.
const CAPABILITY_RUNTIMES := ["linux", "macos", "windows", "android", "ios", "web"]

## This SDK's capability table, generated from its parity manifest (tools/capabilities.ts): per feature, the manifest's status, the owning service and every declared (runtime, reason) N/A. `supports()` reads it (P1b-10, PARITY §2.2).
## Each row is {status, service, na: [{runtime, reason}]}. A function, not a const, so every call
## builds a fresh Dictionary that any thread may read.
static func capabilities() -> Dictionary:
	return {
		"core.verify": {"status": "implemented", "service": "core", "na": []},
		"core.cache": {"status": "implemented", "service": "core", "na": []},
		"core.bundle": {"status": "implemented", "service": "core", "na": []},
		"core.discover": {"status": "implemented", "service": "core", "na": []},
		"core.sync": {"status": "implemented", "service": "core", "na": []},
		"core.local": {"status": "implemented", "service": "core", "na": []},
		"core.headers": {"status": "implemented", "service": "core", "na": []},
		"core.errors": {"status": "implemented", "service": "core", "na": []},
		"core.caps": {"status": "implemented", "service": "core", "na": []},
		"core.store": {"status": "planned", "service": "core", "na": []},
		"core.copy": {"status": "planned", "service": "sdk", "na": []},
		"license.gate": {"status": "implemented", "service": "license", "na": []},
		"license.activate": {"status": "implemented", "service": "license", "na": []},
		"license.enroll": {"status": "implemented", "service": "license", "na": [{"runtime": "web", "reason": "runtime"}]},
		"license.deactivate": {"status": "implemented", "service": "license", "na": []},
		"license.manage": {"status": "implemented", "service": "license", "na": []},
		"license.entitlements": {"status": "implemented", "service": "license", "na": []},
		"license.channels": {"status": "implemented", "service": "license", "na": []},
		"license.reregister": {"status": "implemented", "service": "license", "na": []},
		"license.refusals": {"status": "implemented", "service": "license", "na": []},
		"config.resolve": {"status": "implemented", "service": "config", "na": []},
		"config.list": {"status": "implemented", "service": "config", "na": []},
		"config.secret": {"status": "implemented", "service": "config", "na": []},
		"config.schema": {"status": "implemented", "service": "config", "na": []},
		"config.mint": {"status": "implemented", "service": "config", "na": []},
		"config.mirror": {"status": "implemented", "service": "config", "na": []},
		"config.local": {"status": "planned", "service": "sdk", "na": []},
		"devices.fingerprint": {"status": "implemented", "service": "core", "na": [{"runtime": "web", "reason": "runtime"}]},
		"devices.facts": {"status": "implemented", "service": "core", "na": []},
		"devices.register": {"status": "implemented", "service": "core", "na": []},
		"devices.manage": {"status": "implemented", "service": "core", "na": []},
		"devices.report": {"status": "implemented", "service": "core", "na": []},
		"telemetry.updates": {"status": "implemented", "service": "core", "na": []},
		"devices.attest": {"status": "implemented", "service": "core", "na": [{"runtime": "linux", "reason": "runtime"}, {"runtime": "macos", "reason": "runtime"}, {"runtime": "windows", "reason": "runtime"}, {"runtime": "web", "reason": "runtime"}, {"runtime": "ios", "reason": "outlet"}, {"runtime": "android", "reason": "outlet"}]},
		"identity.oidc": {"status": "planned", "service": "identity", "na": []},
		"identity.devicecode": {"status": "implemented", "service": "identity", "na": []},
		"release.changelog": {"status": "implemented", "service": "release", "na": []},
		"release.download": {"status": "implemented", "service": "release", "na": []},
		"release.record": {"status": "implemented", "service": "release", "na": []},
		"release.fetch": {"status": "planned", "service": "distribution", "na": []},
		"release.distribution": {"status": "implemented", "service": "distribution", "na": []},
		"update.check": {"status": "implemented", "service": "update", "na": []},
		"update.feed": {"status": "implemented", "service": "update", "na": []},
		"update.feeds": {"status": "planned", "service": "update", "na": []},
		"update.decide": {"status": "implemented", "service": "update", "na": []},
		"update.content": {"status": "implemented", "service": "update", "na": []},
		"update.driver": {"status": "implemented", "service": "update", "na": [{"runtime": "ios", "reason": "outlet"}]},
		"update.bootguard": {"status": "implemented", "service": "update", "na": []},
		"outlet.detect": {"status": "implemented", "service": "update", "na": []},
		"crash.tags": {"status": "implemented", "service": "sdk", "na": []},
		"packs.record": {"status": "implemented", "service": "release", "na": []},
		"packs.revoke": {"status": "implemented", "service": "release", "na": []},
		"packs.delegation": {"status": "implemented", "service": "release", "na": []},
		"packs.delta.feed": {"status": "implemented", "service": "release", "na": []},
		"packs.plan": {"status": "implemented", "service": "release", "na": []},
		"packs.index.files": {"status": "implemented", "service": "release", "na": []},
		"packs.index.chunks": {"status": "implemented", "service": "release", "na": []},
		"packs.apply.full": {"status": "implemented", "service": "release", "na": []},
		"packs.apply.file": {"status": "implemented", "service": "release", "na": []},
		"packs.apply.chunk": {"status": "implemented", "service": "release", "na": []},
		"packs.apply.delta": {"status": "implemented", "service": "release", "na": []},
		"packs.state": {"status": "implemented", "service": "release", "na": []},
		"packs.handlers": {"status": "implemented", "service": "release", "na": []},
		"packs.type.godot.zip": {"status": "implemented", "service": "release", "na": []},
		"packs.type.l10n.table": {"status": "implemented", "service": "release", "na": []},
		"packs.type.data.json": {"status": "implemented", "service": "release", "na": []},
		"packs.type.audio.bank": {"status": "implemented", "service": "release", "na": []},
		"packs.type.ml.model": {"status": "na", "service": "release", "na": [{"runtime": "linux", "reason": "runtime"}, {"runtime": "macos", "reason": "runtime"}, {"runtime": "windows", "reason": "runtime"}, {"runtime": "android", "reason": "runtime"}, {"runtime": "ios", "reason": "runtime"}, {"runtime": "web", "reason": "runtime"}]},
		"packs.provides": {"status": "implemented", "service": "release", "na": []},
		"packs.transport.apple": {"status": "implemented", "service": "distribution", "na": [{"runtime": "linux", "reason": "runtime"}, {"runtime": "windows", "reason": "runtime"}, {"runtime": "android", "reason": "runtime"}, {"runtime": "web", "reason": "runtime"}]},
		"packs.transport.play": {"status": "implemented", "service": "distribution", "na": [{"runtime": "linux", "reason": "runtime"}, {"runtime": "macos", "reason": "runtime"}, {"runtime": "windows", "reason": "runtime"}, {"runtime": "ios", "reason": "runtime"}, {"runtime": "web", "reason": "runtime"}]},
		"packs.transport.steam": {"status": "implemented", "service": "distribution", "na": [{"runtime": "android", "reason": "runtime"}, {"runtime": "ios", "reason": "runtime"}, {"runtime": "web", "reason": "runtime"}]},
		"packs.transport.msix": {"status": "planned", "service": "distribution", "na": [{"runtime": "linux", "reason": "runtime"}, {"runtime": "macos", "reason": "runtime"}, {"runtime": "android", "reason": "runtime"}, {"runtime": "ios", "reason": "runtime"}, {"runtime": "web", "reason": "runtime"}]},
		"packs.transport.flatpak": {"status": "planned", "service": "distribution", "na": [{"runtime": "macos", "reason": "runtime"}, {"runtime": "windows", "reason": "runtime"}, {"runtime": "android", "reason": "runtime"}, {"runtime": "ios", "reason": "runtime"}, {"runtime": "web", "reason": "runtime"}]},
		"ui.stages": {"status": "implemented", "service": "sdk", "na": []},
		"ui.boot": {"status": "implemented", "service": "sdk", "na": []},
		"ui.kit": {"status": "implemented", "service": "sdk", "na": []},
		"ui.kit.manage": {"status": "implemented", "service": "sdk", "na": []},
		"ui.cli": {"status": "na", "service": "sdk", "na": [{"runtime": "linux", "reason": "runtime"}, {"runtime": "macos", "reason": "runtime"}, {"runtime": "windows", "reason": "runtime"}, {"runtime": "android", "reason": "runtime"}, {"runtime": "ios", "reason": "runtime"}, {"runtime": "web", "reason": "runtime"}]},
		"commerce.receipt": {"status": "implemented", "service": "license", "na": []},
	}

## SHA-256 of the canonical table; `pnpm parity:check` recomputes it from the manifest.
const CAPABILITY_DIGEST := "01b87e660229fe5101850424937c1dc5e449ec2131127d865809b5e2ad1dc08f"
