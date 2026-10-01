"""``polaris_key`` — the Polaris Key Python SDK (dist ``polaris-key``).

Core plus one sub-client per service, mirroring ``@polaris-key/node``::

    from polaris_key import PolarisKeyClient

    client = PolarisKeyClient.create(product_slug="djdl", version="1.2.0", trust=PINS)
    client.status()                      # the licence gate
    client.config.get_config("ui.theme") # layered settings
    client.devices.register()            # keyless device mint (§6)
    client.release.changelog()           # the truth store
    client.update.check()                # the feed over it

Every subpackage is importable on its own, so a config-only daemon can
``from polaris_key.config import ConfigClient`` without pulling the licence module:

    ``polaris_key.core``     device principal, credential, trust, cache, clock floor, sync,
                         telemetry, offline bundles, and the frozen wire crypto
    ``polaris_key.license``  activation + the gate
    ``polaris_key.config``   the signed config document + layered resolution
    ``polaris_key.devices``  registration, the roster, fingerprint/facts/device-id, the stores
    ``polaris_key.release``  changelog / install script / artifact URLs
    ``polaris_key.update``   version check + the Sparkle appcast URL
    ``polaris_key.local``    the transportless profile

This SDK verifies the SAME cross-language conformance corpus (``conformance/corpus/v2``)
byte-for-byte as the Node, React and Swift SDKs. The normative source is
``docs/security/WIRE-CONTRACT-V3.md``.
"""

from __future__ import annotations

from ._version import DIST_NAME, SDK_NAME, SDK_VERSION, __version__
from .client import DeviceInfo, PolarisKeyClient, SyncState
from .config.client import DEFAULT_ENV_PREFIX, ConfigClient
from .constants_generated import (
    ErrorCode,
    ERROR_CODE_VALUES,
    ERROR_CODE_KINDS,
    Feature,
    FEATURE_VALUES,
    UnsupportedReason,
    UNSUPPORTED_REASON_VALUES,
    Platform,
    PLATFORM_VALUES,
    Arch,
    ARCH_VALUES,
    HeaderName,
    HEADER_NAME_VALUES,
    ServiceSlug,
    SERVICE_SLUG_VALUES,
    PROTOCOL_VERSION,
    CORPUS_VERSION,
    GATE_MATRIX_VERSION,
    FINGERPRINT_VERSION,
)
from .core.bundle import (
    BUNDLE_CLAIMS_REJECTED,
    BUNDLE_JWS_REJECTED,
    BUNDLE_REFUSAL_REASONS,
    BUNDLE_TRUST_REJECTED,
    INNER_DOC_REJECTED,
    MAX_BUNDLE_BYTES,
    ImportBundleResult,
    VerifiedBundle,
    import_bundle,
    inspect_bundle,
    verify_bundle,
)
from .core.cache import CacheManager
from .core.clock import effective_now, high_water_mark
from .core.context import (
    DEFAULT_BASE,
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    CoreContext,
    normalize_base_url,
)
from .core.errors import InsecureBaseUrlError, PolarisError
from .core.jws import TrustSet, VerifiedJws, sign_jws, verify_jws
from .core.models import (
    CLOCK_SKEW_SECONDS,
    DOC_EXPIRY_SECONDS,
    HEADER_ARCH,
    HEADER_CHANNEL,
    HEADER_DEVICE,
    HEADER_PLATFORM,
    HEADER_SDK_NAME,
    HEADER_SDK_VERSION,
    HEADER_VERSION,
    ISSUER,
    MAX_GRACE_SECONDS,
    PROTOCOL_VERSION,
    REFRESH_MARGIN_SECONDS,
    SECONDS_PER_DAY,
    TOKEN_PREFIX,
    TYP_BUNDLE,
    TYP_CONFIG,
    TYP_LICENSE,
    TYP_TRUST,
    AllowedRange,
    BlockedState,
    ConfigDoc,
    DocClaims,
    DocProfile,
    LicenseDoc,
    ManagedEntry,
)
from .core.semver import (
    ParsedSemver,
    channel_for_version,
    compare_semver,
    is_dev_build,
    parse_semver,
)
from .core.store import CACHE_FORMAT_VERSION, CacheRecord, ImportedBundle, Store
from .core.sync import DocOutcome, SyncResult
from .core.token import TokenManager
from .core.trust import TrustManager, TrustManifestResult, merge_trust, verify_trust_manifest
from .core.verify import verify_config_doc, verify_doc, verify_license_doc
from .devices.client import (
    AccountDevice,
    DeviceManagementUnsupportedError,
    DevicesClient,
    RegisterResult,
)
from .devices.deviceid import derive_device_id, device_id_from_raw
from .devices.facts import ProbeDeclaration
from .devices.store import (
    SYMLINK_GUARD,
    FileStore,
    InMemoryStore,
    KeyringStore,
)
from .discovery import (
    DEFAULT_SERVICES,
    SERVICE_SLUGS,
    ServicesMap,
    discover_product,
    services_from_list,
)
from .license.client import LicenseClient
from .license.endpoints import (
    ActivationDeviceLimit,
    ActivationEnrollDisabled,
    ActivationError,
    ActivationFingerprintRequired,
    ActivationHardwareMismatch,
    ActivationOk,
    ActivationResult,
    ActivationUnauthorized,
)
from .license.gate import LicenseState, is_usable, license_state
from .release.client import ChangelogEntry, ReleaseClient
from .update.client import UpdateClient, VersionCheck

__all__ = [
    "__version__",
    "DIST_NAME",
    "SDK_NAME",
    "SDK_VERSION",
    # facade
    "PolarisKeyClient",
    "SyncState",
    "DeviceInfo",
    # sub-clients
    "LicenseClient",
    "ConfigClient",
    "DevicesClient",
    "ReleaseClient",
    "UpdateClient",
    "CoreContext",
    "CacheManager",
    "TokenManager",
    "TrustManager",
    # wire crypto
    "verify_jws",
    "sign_jws",
    "TrustSet",
    "VerifiedJws",
    "verify_doc",
    "verify_license_doc",
    "verify_config_doc",
    "merge_trust",
    "verify_trust_manifest",
    "TrustManifestResult",
    # bundles (§7)
    "inspect_bundle",
    "verify_bundle",
    "import_bundle",
    "ImportBundleResult",
    "VerifiedBundle",
    "MAX_BUNDLE_BYTES",
    "BUNDLE_JWS_REJECTED",
    "BUNDLE_CLAIMS_REJECTED",
    "BUNDLE_TRUST_REJECTED",
    "INNER_DOC_REJECTED",
    "BUNDLE_REFUSAL_REASONS",
    # gate
    "license_state",
    "is_usable",
    "LicenseState",
    "BlockedState",
    "AllowedRange",
    "effective_now",
    "high_water_mark",
    # semver
    "parse_semver",
    "compare_semver",
    "channel_for_version",
    "is_dev_build",
    "ParsedSemver",
    # activation
    "ActivationResult",
    "ActivationOk",
    "ActivationDeviceLimit",
    "ActivationUnauthorized",
    "ActivationFingerprintRequired",
    "ActivationHardwareMismatch",
    "ActivationEnrollDisabled",
    "ActivationError",
    # devices
    "AccountDevice",
    "RegisterResult",
    "DeviceManagementUnsupportedError",
    "derive_device_id",
    "device_id_from_raw",
    "ProbeDeclaration",
    # release / update
    "ChangelogEntry",
    "VersionCheck",
    # discovery
    "discover_product",
    "services_from_list",
    "SERVICE_SLUGS",
    "DEFAULT_SERVICES",
    "ServicesMap",
    # store
    "Store",
    "InMemoryStore",
    "FileStore",
    "KeyringStore",
    "CacheRecord",
    "ImportedBundle",
    "CACHE_FORMAT_VERSION",
    "SYMLINK_GUARD",
    # sync
    "SyncResult",
    "DocOutcome",
    # config
    "DEFAULT_ENV_PREFIX",
    # errors
    "PolarisError",
    "InsecureBaseUrlError",
    # models + constants
    "ManagedEntry",
    "DocProfile",
    "DocClaims",
    "LicenseDoc",
    "ConfigDoc",
    "PROTOCOL_VERSION",
    "ISSUER",
    "DOC_EXPIRY_SECONDS",
    "SECONDS_PER_DAY",
    "CLOCK_SKEW_SECONDS",
    "MAX_GRACE_SECONDS",
    "REFRESH_MARGIN_SECONDS",
    "TOKEN_PREFIX",
    "TYP_LICENSE",
    "TYP_CONFIG",
    "TYP_TRUST",
    "TYP_BUNDLE",
    "HEADER_DEVICE",
    "HEADER_VERSION",
    "HEADER_CHANNEL",
    "HEADER_PLATFORM",
    "HEADER_ARCH",
    "HEADER_SDK_NAME",
    "HEADER_SDK_VERSION",
    "DEFAULT_BASE",
    "DEFAULT_REQUEST_TIMEOUT_SECONDS",
    "normalize_base_url",
    # generated constants (`pnpm gen:constants`, tools/gen-sdk-constants.ts)
    "ErrorCode",
    "ERROR_CODE_VALUES",
    "ERROR_CODE_KINDS",
    "Feature",
    "FEATURE_VALUES",
    "UnsupportedReason",
    "UNSUPPORTED_REASON_VALUES",
    "Platform",
    "PLATFORM_VALUES",
    "Arch",
    "ARCH_VALUES",
    "HeaderName",
    "HEADER_NAME_VALUES",
    "ServiceSlug",
    "SERVICE_SLUG_VALUES",
    "PROTOCOL_VERSION",
    "CORPUS_VERSION",
    "GATE_MATRIX_VERSION",
    "FINGERPRINT_VERSION",
]
