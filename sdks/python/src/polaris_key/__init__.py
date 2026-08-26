"""polaris-key — a product-agnostic Python client for the Polaris Key control plane.

Mirrors the Node SDK (``@polaris-key/node``) and verifies the SAME cross-language
conformance corpus byte-for-byte. The frozen wire crypto lives in :mod:`verify`; the
client facade in :mod:`client`.
"""

from __future__ import annotations

from .client import (
    DeviceInfo,
    DeviceManagementUnsupportedError,
    PolarisKeyClient,
    RefreshResult,
)
from .endpoints import (
    ActivationDeviceLimit,
    ActivationError,
    ActivationOk,
    ActivationResult,
    ActivationUnauthorized,
    deauthorize,
    activate_with_key,
    reacquire_token,
    report_snapshot,
)
from .fetch import (
    FetchBlocked,
    FetchDeviceCap,
    FetchError,
    FetchNotModified,
    FetchOk,
    FetchResult,
    FetchUnauthorized,
    fetch_managed_config,
)
from .license import (
    BlockedState,
    LicenseState,
    ParsedSemver,
    channel_for_version,
    compare_semver,
    is_dev_build,
    is_usable,
    license_state,
    parse_semver,
)
from .models import (
    DOC_EXPIRY_SECONDS,
    HEADER_CHANNEL,
    HEADER_DEVICE,
    HEADER_VERSION,
    ISSUER,
    PROTOCOL_VERSION,
    SECONDS_PER_DAY,
    AllowedRange,
    DocProfile,
    ManagedConfigDoc,
    ManagedEntry,
    ManagedPayload,
)
from .store import (
    CACHE_FORMAT_VERSION,
    SYMLINK_GUARD,
    CacheRecord,
    FileStore,
    InMemoryStore,
    KeyringStore,
    Store,
)
from .deviceid import derive_device_id
from .trust import (
    TrustManifestResult,
    merge_trust,
    verify_trust_manifest,
)
from .verify import (
    CLOCK_SKEW_SECONDS,
    MAX_GRACE_SECONDS,
    TYP_CONFIG,
    TYP_TRUST,
    TrustSet,
    VerifiedJws,
    sign_jws,
    verify_doc,
    verify_jws,
    verify_jws_doc,
)
from ._version import __version__

__all__ = [
    "__version__",
    # client
    "PolarisKeyClient",
    "RefreshResult",
    "DeviceInfo",
    "DeviceManagementUnsupportedError",
    # verify / crypto
    "verify_jws",
    "verify_jws_doc",
    "verify_doc",
    "sign_jws",
    "TrustSet",
    "VerifiedJws",
    "TYP_CONFIG",
    "TYP_TRUST",
    "CLOCK_SKEW_SECONDS",
    "MAX_GRACE_SECONDS",
    # trust set (§1)
    "merge_trust",
    "verify_trust_manifest",
    "TrustManifestResult",
    # license / gate
    "license_state",
    "is_usable",
    "LicenseState",
    "BlockedState",
    "parse_semver",
    "compare_semver",
    "channel_for_version",
    "is_dev_build",
    "ParsedSemver",
    # fetch
    "fetch_managed_config",
    "FetchResult",
    "FetchOk",
    "FetchNotModified",
    "FetchUnauthorized",
    "FetchDeviceCap",
    "FetchBlocked",
    "FetchError",
    # endpoints
    "activate_with_key",
    "reacquire_token",
    "deauthorize",
    "report_snapshot",
    "ActivationResult",
    "ActivationOk",
    "ActivationDeviceLimit",
    "ActivationUnauthorized",
    "ActivationError",
    # store
    "Store",
    "InMemoryStore",
    "FileStore",
    "KeyringStore",
    "CacheRecord",
    "CACHE_FORMAT_VERSION",
    "SYMLINK_GUARD",
    # device id
    "derive_device_id",
    # models
    "ManagedConfigDoc",
    "ManagedPayload",
    "ManagedEntry",
    "DocProfile",
    "AllowedRange",
    "PROTOCOL_VERSION",
    "ISSUER",
    "DOC_EXPIRY_SECONDS",
    "SECONDS_PER_DAY",
    "HEADER_DEVICE",
    "HEADER_VERSION",
    "HEADER_CHANNEL",
]
