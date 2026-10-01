# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm gen:constants` (tools/gen-sdk-constants.ts) from conformance/parity/
# errors.json, enums.json and features.json, tools/services.json, @polaris-key/protocol/core
# and the conformance corpus. `pnpm gen:constants -- --check` fails the green gate on any
# difference. To change a constant, edit its source and regenerate.
"""Polaris Key's shared constants: error codes, header names, enums, feature ids, versions."""

from __future__ import annotations

from types import MappingProxyType
from typing import Final, Mapping, Tuple

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
    "StoreBackend",
    "STORE_BACKEND_VALUES",
    "StoreDegradedReason",
    "STORE_DEGRADED_REASON_VALUES",
    "HeaderName",
    "HEADER_NAME_VALUES",
    "ServiceSlug",
    "SERVICE_SLUG_VALUES",
    "ERROR_CODE_KINDS",
    "PROTOCOL_VERSION",
    "CORPUS_VERSION",
    "GATE_MATRIX_VERSION",
    "FINGERPRINT_VERSION",
    "CHANNEL_ALIASES",
    "CHANNEL_BETA",
    "CHANNEL_DEV",
    "CHANNEL_NAME_PATTERN",
    "CHANNEL_PR",
    "CHANNEL_STABLE",
    "PR_CHANNEL_PATTERN",
    "PR_NUMBER_MAX_DIGITS",
]


class ErrorCode:
    """Every error code the Worker answers with or an SDK raises (conformance/parity/errors.json). Hosts match on these strings."""

    UNAUTHORIZED: Final = "unauthorized"
    NOT_FOUND: Final = "not_found"
    BAD_REQUEST: Final = "bad_request"
    FORBIDDEN: Final = "forbidden"
    RATE_LIMITED: Final = "rate_limited"
    BODY_TOO_LARGE: Final = "body_too_large"
    METHOD_NOT_ALLOWED: Final = "method_not_allowed"
    MISCONFIGURED: Final = "misconfigured"
    REGISTRATION_CLOSED: Final = "registration_closed"
    DEVICE_LIMIT: Final = "device_limit"
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
    DISABLED: Final = "disabled"
    OIDC_ERROR: Final = "oidc_error"
    UNAVAILABLE: Final = "unavailable"
    AUTH_METHOD_DISABLED: Final = "auth_method_disabled"
    EMAIL_NOT_CONFIGURED: Final = "email_not_configured"
    DOWNLOAD_AUTH_REQUIRED: Final = "download_auth_required"
    UPSTREAM_RATE_LIMITED: Final = "upstream_rate_limited"
    SERVER_MISCONFIGURED: Final = "server_misconfigured"
    INTERNAL_ERROR: Final = "internal_error"
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
    NO_TOKEN: Final = "no-token"
    MINT_UNAVAILABLE: Final = "mint-unavailable"


#: Every ``ErrorCode`` value, in source order.
ERROR_CODE_VALUES: Tuple[str, ...] = (
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
)


#: The registry: every error code and its kind (``wire`` or ``client``).
ERROR_CODE_KINDS: Mapping[str, str] = MappingProxyType(
    {
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
)


class Feature:
    """Every feature id in the parity registry (conformance/parity/features.json)."""

    CORE_VERIFY: Final = "core.verify"
    CORE_CACHE: Final = "core.cache"
    CORE_BUNDLE: Final = "core.bundle"
    CORE_DISCOVER: Final = "core.discover"
    CORE_SYNC: Final = "core.sync"
    CORE_LOCAL: Final = "core.local"
    CORE_HEADERS: Final = "core.headers"
    CORE_ERRORS: Final = "core.errors"
    CORE_CAPS: Final = "core.caps"
    CORE_STORE: Final = "core.store"
    LICENSE_GATE: Final = "license.gate"
    LICENSE_ACTIVATE: Final = "license.activate"
    LICENSE_ENROLL: Final = "license.enroll"
    LICENSE_DEACTIVATE: Final = "license.deactivate"
    LICENSE_ENTITLEMENTS: Final = "license.entitlements"
    LICENSE_CHANNELS: Final = "license.channels"
    LICENSE_REREGISTER: Final = "license.reregister"
    CONFIG_RESOLVE: Final = "config.resolve"
    CONFIG_LIST: Final = "config.list"
    CONFIG_SECRET: Final = "config.secret"
    CONFIG_SCHEMA: Final = "config.schema"
    CONFIG_MINT: Final = "config.mint"
    CONFIG_MIRROR: Final = "config.mirror"
    DEVICES_FINGERPRINT: Final = "devices.fingerprint"
    DEVICES_FACTS: Final = "devices.facts"
    DEVICES_REGISTER: Final = "devices.register"
    DEVICES_MANAGE: Final = "devices.manage"
    DEVICES_REPORT: Final = "devices.report"
    IDENTITY_OIDC: Final = "identity.oidc"
    IDENTITY_DEVICECODE: Final = "identity.devicecode"
    RELEASE_CHANGELOG: Final = "release.changelog"
    RELEASE_DOWNLOAD: Final = "release.download"
    RELEASE_RECORD: Final = "release.record"
    UPDATE_CHECK: Final = "update.check"
    UPDATE_FEED: Final = "update.feed"
    UPDATE_DECIDE: Final = "update.decide"
    UPDATE_DRIVER: Final = "update.driver"
    UPDATE_BOOTGUARD: Final = "update.bootguard"
    OUTLET_DETECT: Final = "outlet.detect"
    PACKS_PLAN: Final = "packs.plan"
    PACKS_INDEX: Final = "packs.index"
    PACKS_APPLY_FULL: Final = "packs.apply.full"
    PACKS_APPLY_FILE: Final = "packs.apply.file"
    PACKS_APPLY_CHUNK: Final = "packs.apply.chunk"
    PACKS_APPLY_DELTA: Final = "packs.apply.delta"
    PACKS_STATE: Final = "packs.state"
    PACKS_HANDLERS: Final = "packs.handlers"
    PACKS_PROVIDES: Final = "packs.provides"
    PACKS_TRANSPORT_APPLE: Final = "packs.transport.apple"
    PACKS_TRANSPORT_PLAY: Final = "packs.transport.play"
    PACKS_TRANSPORT_STEAM: Final = "packs.transport.steam"
    PACKS_TRANSPORT_MSIX: Final = "packs.transport.msix"
    PACKS_TRANSPORT_FLATPAK: Final = "packs.transport.flatpak"
    UI_STAGES: Final = "ui.stages"
    UI_KIT: Final = "ui.kit"
    COMMERCE_RECEIPT: Final = "commerce.receipt"


#: Every ``Feature`` value, in source order.
FEATURE_VALUES: Tuple[str, ...] = (
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
    """OS family, the canonical `X-PKey-Platform` value (README §3.1). iPadOS is `ios`."""

    MACOS: Final = "macos"
    IOS: Final = "ios"
    ANDROID: Final = "android"
    WINDOWS: Final = "windows"
    LINUX: Final = "linux"
    WEB: Final = "web"


#: Every ``Platform`` value, in source order.
PLATFORM_VALUES: Tuple[str, ...] = (
    "macos",
    "ios",
    "android",
    "windows",
    "linux",
    "web",
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


#: Every ``ServiceSlug`` value, in source order.
SERVICE_SLUG_VALUES: Tuple[str, ...] = (
    "license",
    "config",
    "release",
    "distribution",
    "update",
    "identity",
)


#: The wire contract version (`@polaris-key/protocol/core`).
PROTOCOL_VERSION: Final[int] = 3


#: `corpusVersion` of conformance/corpus/v2/cases.json.
CORPUS_VERSION: Final[int] = 2


#: `gateMatrixVersion` of conformance/corpus/v2/gate-matrix.json.
GATE_MATRIX_VERSION: Final[int] = 2


#: `fingerprintVersion` of conformance/corpus/v2/fingerprint.json.
FINGERPRINT_VERSION: Final[int] = 1


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
