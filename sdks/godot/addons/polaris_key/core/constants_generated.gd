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
	const RATE_LIMITED := "rate_limited"
	const BODY_TOO_LARGE := "body_too_large"
	const METHOD_NOT_ALLOWED := "method_not_allowed"
	const MISCONFIGURED := "misconfigured"
	const REGISTRATION_CLOSED := "registration_closed"
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
	const DISABLED := "disabled"
	const OIDC_ERROR := "oidc_error"
	const UNAVAILABLE := "unavailable"
	const AUTH_METHOD_DISABLED := "auth_method_disabled"
	const EMAIL_NOT_CONFIGURED := "email_not_configured"
	const DOWNLOAD_AUTH_REQUIRED := "download_auth_required"
	const UPSTREAM_RATE_LIMITED := "upstream_rate_limited"
	const SERVER_MISCONFIGURED := "server_misconfigured"
	const INTERNAL_ERROR := "internal_error"
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
	const NO_TOKEN := "no-token"
	const MINT_UNAVAILABLE := "mint-unavailable"


## Every `ErrorCode` value, in source order.
const ERROR_CODE_VALUES := ["unauthorized", "not_found", "bad_request", "forbidden", "rate_limited", "body_too_large", "method_not_allowed", "misconfigured", "registration_closed", "device_limit", "license_disabled", "license_expired", "not_entitled", "version_blocked", "channel_not_allowed", "hardware_mismatch", "fingerprint_required", "enroll_disabled", "enroll_claimed", "enroll_failed", "managed_by_admin", "catalog_unavailable", "disabled", "oidc_error", "unavailable", "auth_method_disabled", "email_not_configured", "download_auth_required", "upstream_rate_limited", "server_misconfigured", "internal_error", "service-unavailable", "service-disabled", "local-only", "insecure-base-url", "bundle-jws-rejected", "bundle-claims-rejected", "bundle-trust-rejected", "inner-doc-rejected", "bundle", "transport", "network", "refresh-failed", "sync-failed", "fetch-failed", "bridge-missing", "unknown", "release-refused", "bundle-rejected", "bundle-import-unsupported", "report-unsupported", "device-management-unsupported", "device_list_failed", "device_rename_failed", "device_deauthorize_failed", "key-entry-unsupported", "sign-in-failed", "sign-out-failed", "bad_response", "network-error", "server-error", "cancelled", "sign-in-expired", "sign-in-denied", "sign-in-unavailable", "invalid-options", "not-configured", "unsupported", "timeout", "response-too-large", "too-many-redirects", "insecure-redirect", "http-error", "invalid-response", "store-failed", "no-token", "mint-unavailable"]

## The registry: every error code and its kind (`wire` or `client`).
const ERROR_CODE_KINDS := {
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
	"no-token": "client",
	"mint-unavailable": "client",
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
	const LICENSE_GATE := "license.gate"
	const LICENSE_ACTIVATE := "license.activate"
	const LICENSE_ENROLL := "license.enroll"
	const LICENSE_DEACTIVATE := "license.deactivate"
	const LICENSE_ENTITLEMENTS := "license.entitlements"
	const LICENSE_CHANNELS := "license.channels"
	const LICENSE_REREGISTER := "license.reregister"
	const CONFIG_RESOLVE := "config.resolve"
	const CONFIG_LIST := "config.list"
	const CONFIG_SECRET := "config.secret"
	const CONFIG_SCHEMA := "config.schema"
	const CONFIG_MINT := "config.mint"
	const CONFIG_MIRROR := "config.mirror"
	const DEVICES_FINGERPRINT := "devices.fingerprint"
	const DEVICES_FACTS := "devices.facts"
	const DEVICES_REGISTER := "devices.register"
	const DEVICES_MANAGE := "devices.manage"
	const DEVICES_REPORT := "devices.report"
	const IDENTITY_OIDC := "identity.oidc"
	const IDENTITY_DEVICECODE := "identity.devicecode"
	const RELEASE_CHANGELOG := "release.changelog"
	const RELEASE_DOWNLOAD := "release.download"
	const RELEASE_RECORD := "release.record"
	const UPDATE_CHECK := "update.check"
	const UPDATE_FEED := "update.feed"
	const UPDATE_DECIDE := "update.decide"
	const UPDATE_DRIVER := "update.driver"
	const UPDATE_BOOTGUARD := "update.bootguard"
	const OUTLET_DETECT := "outlet.detect"
	const PACKS_PLAN := "packs.plan"
	const PACKS_INDEX := "packs.index"
	const PACKS_APPLY_FULL := "packs.apply.full"
	const PACKS_APPLY_FILE := "packs.apply.file"
	const PACKS_APPLY_CHUNK := "packs.apply.chunk"
	const PACKS_APPLY_DELTA := "packs.apply.delta"
	const PACKS_STATE := "packs.state"
	const PACKS_HANDLERS := "packs.handlers"
	const PACKS_PROVIDES := "packs.provides"
	const PACKS_TRANSPORT_APPLE := "packs.transport.apple"
	const PACKS_TRANSPORT_PLAY := "packs.transport.play"
	const PACKS_TRANSPORT_STEAM := "packs.transport.steam"
	const PACKS_TRANSPORT_MSIX := "packs.transport.msix"
	const PACKS_TRANSPORT_FLATPAK := "packs.transport.flatpak"
	const UI_STAGES := "ui.stages"
	const UI_KIT := "ui.kit"
	const COMMERCE_RECEIPT := "commerce.receipt"


## Every `Feature` value, in source order.
const FEATURE_VALUES := ["core.verify", "core.cache", "core.bundle", "core.discover", "core.sync", "core.local", "core.headers", "core.errors", "core.caps", "core.store", "license.gate", "license.activate", "license.enroll", "license.deactivate", "license.entitlements", "license.channels", "license.reregister", "config.resolve", "config.list", "config.secret", "config.schema", "config.mint", "config.mirror", "devices.fingerprint", "devices.facts", "devices.register", "devices.manage", "devices.report", "identity.oidc", "identity.devicecode", "release.changelog", "release.download", "release.record", "update.check", "update.feed", "update.decide", "update.driver", "update.bootguard", "outlet.detect", "packs.plan", "packs.index", "packs.apply.full", "packs.apply.file", "packs.apply.chunk", "packs.apply.delta", "packs.state", "packs.handlers", "packs.provides", "packs.transport.apple", "packs.transport.play", "packs.transport.steam", "packs.transport.msix", "packs.transport.flatpak", "ui.stages", "ui.kit", "commerce.receipt"]


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
const PROTOCOL_VERSION := 3

## `corpusVersion` of conformance/corpus/v2/cases.json.
const CORPUS_VERSION := 2

## `gateMatrixVersion` of conformance/corpus/v2/gate-matrix.json.
const GATE_MATRIX_VERSION := 2

## `fingerprintVersion` of conformance/corpus/v2/fingerprint.json.
const FINGERPRINT_VERSION := 1

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
