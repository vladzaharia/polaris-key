"""``polaris_key.core`` — the always-on substrate.

Device principal, credential, trust custody, the verified cache, the monotonic clock
floor, the sync loop, telemetry and offline bundles. A host that only wants Core (a
headless daemon that ships settings and reports facts, with no licence at all) imports
this and never pulls a service module.

Mirrors ``@polaris-key/node/core`` (``packages/sdk-node/src/core/``), with the pure verification
primitives that JS keeps in ``@polaris-key/client-core`` living here as native Python: this SDK
is a single distribution, so a second package would be a boundary with no consumer.
"""

from __future__ import annotations

from .b64url import B64URL_RE, b64url_decode, b64url_encode, b64url_encode_str
from .bundle import (
    BUNDLE_CLAIMS_REJECTED,
    BUNDLE_JWS_REJECTED,
    BUNDLE_REFUSAL_REASONS,
    BUNDLE_TRUST_REJECTED,
    INNER_DOC_REJECTED,
    MAX_BUNDLE_BYTES,
    BundleAccepted,
    BundleInspection,
    BundleRefused,
    ImportBundleResult,
    VerifiedBundle,
    VerifiedBundleDoc,
    import_bundle,
    inspect_bundle,
    verify_bundle,
)
from .cache import CachedDoc, CacheManager, LoadedCache
from .clock import effective_now, high_water_mark
from .context import (
    DEFAULT_BASE,
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    CoreContext,
    DocumentBlocked,
    DocumentDeviceCap,
    DocumentError,
    DocumentNotModified,
    DocumentOk,
    DocumentResult,
    DocumentUnauthorized,
    normalize_base_url,
    now_ms,
    now_sec,
)
from .errors import InsecureBaseUrlError, PolarisError
from .jws import TrustSet, VerifiedJws, sign_jws, verify_jws
from .models import (
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
    MAX_DOC_BYTES,
    MAX_GRACE_SECONDS,
    MAX_HEADER_BYTES,
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
from .semver import (
    ParsedSemver,
    channel_for_version,
    compare_semver,
    is_dev_build,
    parse_semver,
)
from .store import CACHE_FORMAT_VERSION, CacheRecord, ImportedBundle, Store
from .sync import DocOutcome, SyncDeps, SyncResult, sync
from .telemetry import build_snapshot, report_snapshot
from .token import TokenManager
from .trust import (
    SUPPORTED_TRUST_SCHEMA_VERSIONS,
    TrustManager,
    TrustManifestResult,
    merge_trust,
    verify_trust_manifest,
)
from .verify import verify_config_doc, verify_doc, verify_license_doc

__all__ = [
    # b64url
    "B64URL_RE",
    "b64url_decode",
    "b64url_encode",
    "b64url_encode_str",
    # jws
    "TrustSet",
    "VerifiedJws",
    "sign_jws",
    "verify_jws",
    # verify
    "verify_doc",
    "verify_license_doc",
    "verify_config_doc",
    # trust
    "SUPPORTED_TRUST_SCHEMA_VERSIONS",
    "TrustManager",
    "TrustManifestResult",
    "merge_trust",
    "verify_trust_manifest",
    # clock
    "effective_now",
    "high_water_mark",
    # context
    "CoreContext",
    "DEFAULT_BASE",
    "DEFAULT_REQUEST_TIMEOUT_SECONDS",
    "normalize_base_url",
    "now_ms",
    "now_sec",
    "DocumentResult",
    "DocumentOk",
    "DocumentNotModified",
    "DocumentUnauthorized",
    "DocumentDeviceCap",
    "DocumentBlocked",
    "DocumentError",
    # cache / store
    "CacheManager",
    "CachedDoc",
    "LoadedCache",
    "CacheRecord",
    "CACHE_FORMAT_VERSION",
    "ImportedBundle",
    "Store",
    # token / sync / telemetry
    "TokenManager",
    "sync",
    "SyncDeps",
    "SyncResult",
    "DocOutcome",
    "build_snapshot",
    "report_snapshot",
    # bundles
    "MAX_BUNDLE_BYTES",
    "BUNDLE_JWS_REJECTED",
    "BUNDLE_CLAIMS_REJECTED",
    "BUNDLE_TRUST_REJECTED",
    "INNER_DOC_REJECTED",
    "BUNDLE_REFUSAL_REASONS",
    "BundleAccepted",
    "BundleRefused",
    "BundleInspection",
    "VerifiedBundle",
    "VerifiedBundleDoc",
    "ImportBundleResult",
    "inspect_bundle",
    "verify_bundle",
    "import_bundle",
    # errors
    "PolarisError",
    "InsecureBaseUrlError",
    # semver
    "ParsedSemver",
    "parse_semver",
    "compare_semver",
    "channel_for_version",
    "is_dev_build",
    # models
    "PROTOCOL_VERSION",
    "ISSUER",
    "DOC_EXPIRY_SECONDS",
    "SECONDS_PER_DAY",
    "CLOCK_SKEW_SECONDS",
    "MAX_GRACE_SECONDS",
    "REFRESH_MARGIN_SECONDS",
    "MAX_HEADER_BYTES",
    "MAX_DOC_BYTES",
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
    "AllowedRange",
    "BlockedState",
    "ManagedEntry",
    "DocProfile",
    "DocClaims",
    "LicenseDoc",
    "ConfigDoc",
]
