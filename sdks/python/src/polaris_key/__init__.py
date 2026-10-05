"""``polaris_key`` — the Polaris Key Python SDK (dist ``polaris-key``).

Core plus one sub-client per service, mirroring ``@polaris-key/node``::

    from polaris_key import PolarisKeyClient

    client = polaris_key.create(product_slug="djdl", version="1.2.0", trust=PINS)  # + discovery
    client.status()                      # the licence gate
    client.config.get_config("ui.theme") # layered settings
    client.devices.register()            # keyless device mint (§6)
    client.release.changelog()           # the truth store
    client.update.check()                # the feed over it
    client.update.decide()               # wire v4: the signed feed, the pinned record, the decision

Every subpackage is importable on its own, so a config-only daemon can
``from polaris_key.config import ConfigClient`` without pulling the licence module:

    ``polaris_key.core``     device principal, credential, trust, cache, clock floor, sync,
                         telemetry, offline bundles, the boot stage machine, and the
                         frozen wire crypto
    ``polaris_key.license``  activation + the gate
    ``polaris_key.config``   the signed config document + layered resolution
    ``polaris_key.devices``  registration, the roster, fingerprint/facts/device-id, the stores
    ``polaris_key.identity`` device-code sign-in (RFC 8628)
    ``polaris_key.release``  changelog / install script / artifact URLs
    ``polaris_key.update``   version check, the Sparkle appcast URL, and wire v4's signed
                         update decision (``decide()``, ``feed()``, ``release_record()``)
    ``polaris_key.local``    the transportless profile

This SDK verifies the SAME cross-language conformance corpus (``conformance/corpus/v2``)
byte-for-byte as the Node, React and Swift SDKs. The normative source is
``docs/security/WIRE-CONTRACT-V3.md``.
"""

from __future__ import annotations

from ._version import DIST_NAME, SDK_NAME, SDK_VERSION, __version__
from .client import DeviceInfo, PolarisKeyClient, SyncState
from .boot import ActivationOutcome, BootOutcome
from .aio import AsyncClient, AsyncPolarisKeyClient
from .update.bootguard import BootGuard, BootGuardOutcome

#: ``polaris_key.create(**opts)`` — the one-call constructor: build, ``init()`` and (unless
#: ``expected_services`` is pinned) discover. See :meth:`PolarisKeyClient.create`.
create = PolarisKeyClient.create
from .commerce import (
    ClaimAttestationRequired,
    ClaimNotOwned,
    ClaimOk,
    ClaimRefused,
    ClaimResult,
    CommerceBinding,
    CommerceClient,
    CommerceProduct,
)
from .config.client import DEFAULT_ENV_PREFIX, ConfigClient, ConfigSetting
from .core.events import EVENT_KINDS, Event, EventBus
from .config.mint import MintedToken
from .identity.client import (
    IdentityClient,
    SignedInIdentity,
    SignInPoll,
    SignInPrompt,
    SignInResult,
)
from . import copy, qr
from .portal import PORTAL_FLOWS, PortalClient
# Generated constants (`pnpm gen:constants`, tools/gen-sdk-constants.ts), imported wholesale through
# the generated ``__all__`` so a constant the generator gains reaches the package root unedited.
from . import constants_generated as _constants_generated
from .constants_generated import *  # noqa: F401,F403
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
from .core.caps import Support, Supported, Unsupported, UnsupportedError
from .core.headers import canonical_arch, canonical_platform
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
from .core.decide import (
    OutletCapabilities,
    ResolvedOutlet,
    boot_decision,
    decide_update,
    effective_capabilities,
    is_undismissable,
    is_valid_host_outlet,
    resolve_update_outlet,
    rollout_bucket,
    select_pack_rows,
)
from .core.feed import (
    FeedContent,
    FeedFloor,
    VerifyFeedResult,
    feed_claims,
    feed_content,
    feed_floor,
    verify_feed,
    with_feed_content,
)
from .core.pack_claims import holds_of
from .core.models import (
    ChannelFeedDoc,
    DecisionRelease,
    InstalledBuild,
    ReleaseRecordDoc,
    StagedUpdate,
    TYP_FEED,
    TYP_RELEASE,
    UpdateCheck,
    UpdateCheckError,
    UpdateDecision,
    UpdateDecisionInput,
    UpdateOutlet,
    UpdateContentInput,
    ContentRevocationInput,
    PackTarget,
)
from .core.release_record import (
    DelegationBody,
    RecordDelegation,
    ReleaseRecordPin,
    RevocationBody,
    VerifiedDelegation,
    VerifiedRevocation,
    VerifyDelegationResult,
    VerifyReleaseRecordResult,
    VerifyRevocationResult,
    covers_pack,
    delegated_kid,
    delegation_hash_of,
    delegation_of,
    newer_revocation,
    record_hash,
    record_revoked,
    release_record_claims,
    revocation_of,
    verify_delegation,
    verify_release_record,
    verify_revocation,
)
from .update.packs.dataonly import data_only_file_refusal, data_only_refusal
from .core.version import VERSION_SCHEMES, compare_versions, parse_version
from .core.semver import (
    ParsedSemver,
    channel_for_version,
    compare_semver,
    is_dev_build,
    parse_semver,
)
from .core.stages import (
    BOOT_EMIT_TYPES,
    BOOT_EVENT_TYPES,
    BOOT_GUARD_ACTIONS,
    BOOT_OUTCOMES,
    BOOT_STAGES,
    MAX_FAILED_BOOTS,
    BootEmit,
    BootEvent,
    BootOptions,
    BootState,
    BootTransition,
    boot_guard_action,
    boot_transition,
    initial_boot_state,
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
from .license.client import LicenseClient, LicenseInfo
from .license.endpoints import (
    ActivationDeviceLimit,
    ActivationEnrollDisabled,
    ActivationError,
    ActivationEnrollClaimed,
    ActivationLicenseDisabled,
    ActivationLicenseExpired,
    ActivationAttestationRequired,
    ActivationRateLimited,
    ActivationRefused,
    ActivationFingerprintRequired,
    ActivationHardwareMismatch,
    ActivationOk,
    ActivationResult,
    ActivationUnauthorized,
)
from .license.gate import LicenseState, is_usable, license_state
from .release.client import ChangelogEntry, FetchedFile, ReleaseClient
from .distribution import DistributionClient, DownloadModel, DownloadPlatform
from .update.client import (
    FeedCheck,
    ReleaseRecordCheck,
    UpdateClient,
    UpdateClientOptions,
    UpdateError,
    VersionCheck,
)
from .update.packs import DataJsonHandler, L10nTableHandler, MlModelHandler, PackError, PackHandler
from .update.packs.client import EmbeddedPack, PacksClient, PacksOptions

__all__ = [
    "__version__",
    "DIST_NAME",
    "SDK_NAME",
    "SDK_VERSION",
    # client metadata header values (WIRE-CONTRACT-V3 §5.2)
    "canonical_platform",
    "canonical_arch",
    # facade
    "PolarisKeyClient",
    "BootOutcome",
    "ActivationOutcome",
    "BootGuard",
    "BootGuardOutcome",
    "create",
    "AsyncPolarisKeyClient",
    "AsyncClient",
    # supports() and typed "unsupported here" (P1b-10)
    "Support",
    "Supported",
    "Unsupported",
    "UnsupportedError",
    "SyncState",
    "DeviceInfo",
    # sub-clients
    "LicenseClient",
    "LicenseInfo",
    "ConfigClient",
    "ConfigSetting",
    "Event",
    "EventBus",
    "EVENT_KINDS",
    "DevicesClient",
    "IdentityClient",
    "SignInPrompt",
    "SignInPoll",
    "SignInResult",
    "SignedInIdentity",
    "qr",
    "copy",
    "PortalClient",
    "PORTAL_FLOWS",
    "MintedToken",
    "ReleaseClient",
    "FetchedFile",
    "DistributionClient",
    "DownloadModel",
    "DownloadPlatform",
    "CommerceClient",
    "CommerceBinding",
    "CommerceProduct",
    "ClaimResult",
    "ClaimOk",
    "ClaimNotOwned",
    "ClaimAttestationRequired",
    "ClaimRefused",
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
    # boot stage machine
    "BOOT_STAGES",
    "BOOT_OUTCOMES",
    "BOOT_EVENT_TYPES",
    "BOOT_EMIT_TYPES",
    "BOOT_GUARD_ACTIONS",
    "MAX_FAILED_BOOTS",
    "BootEvent",
    "BootEmit",
    "BootOptions",
    "BootState",
    "BootTransition",
    "initial_boot_state",
    "boot_transition",
    "boot_guard_action",
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
    "ActivationEnrollClaimed",
    "ActivationLicenseDisabled",
    "ActivationLicenseExpired",
    "ActivationAttestationRequired",
    "ActivationRateLimited",
    "ActivationRefused",
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
    # wire v4: the signed feed, the release record and the update decision
    "UpdateClientOptions",
    "PackError",
    "PackHandler",
    "DataJsonHandler",
    "L10nTableHandler",
    "MlModelHandler",
    "EmbeddedPack",
    "PacksClient",
    "PacksOptions",
    "UpdateError",
    "FeedCheck",
    "ReleaseRecordCheck",
    "TYP_FEED",
    "TYP_RELEASE",
    "VERSION_SCHEMES",
    "parse_version",
    "compare_versions",
    "feed_claims",
    "verify_feed",
    "feed_floor",
    "FeedFloor",
    "VerifyFeedResult",
    "record_hash",
    "release_record_claims",
    "verify_release_record",
    "ReleaseRecordPin",
    "VerifyReleaseRecordResult",
    "rollout_bucket",
    "effective_capabilities",
    "OutletCapabilities",
    "is_valid_host_outlet",
    "resolve_update_outlet",
    "ResolvedOutlet",
    "decide_update",
    "boot_decision",
    "is_undismissable",
    "select_pack_rows",
    "feed_content",
    "with_feed_content",
    "FeedContent",
    "holds_of",
    "revocation_of",
    "verify_revocation",
    "newer_revocation",
    "RevocationBody",
    "VerifiedRevocation",
    "VerifyRevocationResult",
    "delegation_hash_of",
    "delegated_kid",
    "delegation_of",
    "verify_delegation",
    "covers_pack",
    "record_revoked",
    "DelegationBody",
    "RecordDelegation",
    "VerifiedDelegation",
    "VerifyDelegationResult",
    "data_only_refusal",
    "data_only_file_refusal",
    "UpdateContentInput",
    "ContentRevocationInput",
    "PackTarget",
    "ChannelFeedDoc",
    "ReleaseRecordDoc",
    "InstalledBuild",
    "UpdateOutlet",
    "StagedUpdate",
    "UpdateDecisionInput",
    "UpdateDecision",
    "DecisionRelease",
    "UpdateCheck",
    "UpdateCheckError",
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
    *_constants_generated.__all__,
]
