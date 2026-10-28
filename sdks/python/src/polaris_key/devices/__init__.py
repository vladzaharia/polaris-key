"""``polaris_key.devices`` — the Device principal's surface.

Registration, the roster, telemetry, the two hashed-identity formulas, and the concrete
stores. ``device_id_from_raw`` and ``hash_components`` live together here because they are
the same kind of thing — hashed hardware identity computed ON the device so raw serials
never cross the wire — and because ``conformance/corpus/v2/fingerprint.json`` pins BOTH.

Mirrors ``@polaris-key/node/devices``.
"""

from __future__ import annotations

from ..core.device_keys import (
    DeviceKeyError,
    DeviceKeyPort,
    DeviceKeysRequest,
    DeviceKeyStoreError,
    DeviceKeysUnreadableError,
    DeviceKeyUnsupportedError,
    DeviceProofError,
    DevicePublicKeys,
    build_device_keys_request,
    sign_device_proof,
    sign_keys_proof,
)
from ..core.device_proof import DeviceProof, DeviceProofFields, verify_device_proof
from .client import (
    DEVICE_KEYS_PATH,
    DEVICES_PATH,
    REGISTER_PATH,
    AccountDevice,
    DeviceKeysResponse,
    DeviceManagementUnsupportedError,
    DevicesClient,
    RegisterClosed,
    RegisterError,
    RegisterNotConfigured,
    RegisterOk,
    RegisterRateLimited,
    RegisterResult,
)
from .deviceid import derive_device_id, device_id_from_raw, raw_os_device_id
from .facts import ProbeDeclaration, collect_facts, run_probes
from .fingerprint import (
    COMPONENT_ORDER,
    LINUX_ANCHOR_PATHS,
    WINDOWS_CIM_COMMAND,
    AnchorSource,
    FingerprintIO,
    WindowsCimCommand,
    collect_fingerprint,
    hash_components,
    linux_anchor_source,
    parse_windows_cim,
    ram_bucket,
    raw_components,
)
from .keys import (
    DEVICE_KEYS_FILE,
    DeviceKeyStorage,
    DeviceKeyStore,
    FileDeviceKeyStorage,
    InMemoryDeviceKeyStorage,
    create_device_key_store,
)
from .store import (
    CACHE_FORMAT_VERSION,
    KEYRING_SERVICE_PREFIX,
    SYMLINK_GUARD,
    CacheRecord,
    FileStore,
    InMemoryStore,
    KeyringStore,
    Store,
)

__all__ = [
    "DevicesClient",
    "DeviceKeysResponse",
    "DEVICE_KEYS_PATH",
    "DEVICE_KEYS_FILE",
    "DeviceKeyPort",
    "DevicePublicKeys",
    "DeviceKeyStore",
    "DeviceKeyStorage",
    "FileDeviceKeyStorage",
    "InMemoryDeviceKeyStorage",
    "create_device_key_store",
    "DeviceKeyError",
    "DeviceKeyUnsupportedError",
    "DeviceKeysUnreadableError",
    "DeviceKeyStoreError",
    "DeviceProofError",
    "DeviceProof",
    "DeviceProofFields",
    "DeviceKeysRequest",
    "verify_device_proof",
    "sign_device_proof",
    "sign_keys_proof",
    "build_device_keys_request",
    "AccountDevice",
    "RegisterResult",
    "RegisterOk",
    "RegisterClosed",
    "RegisterRateLimited",
    "RegisterNotConfigured",
    "RegisterError",
    "DeviceManagementUnsupportedError",
    "REGISTER_PATH",
    "DEVICES_PATH",
    "derive_device_id",
    "device_id_from_raw",
    "raw_os_device_id",
    "collect_facts",
    "run_probes",
    "ProbeDeclaration",
    "collect_fingerprint",
    "hash_components",
    "raw_components",
    "parse_windows_cim",
    "linux_anchor_source",
    "ram_bucket",
    "WINDOWS_CIM_COMMAND",
    "WindowsCimCommand",
    "LINUX_ANCHOR_PATHS",
    "AnchorSource",
    "FingerprintIO",
    "COMPONENT_ORDER",
    "Store",
    "InMemoryStore",
    "FileStore",
    "KeyringStore",
    "CacheRecord",
    "CACHE_FORMAT_VERSION",
    "SYMLINK_GUARD",
    "KEYRING_SERVICE_PREFIX",
]
