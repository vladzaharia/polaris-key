"""``polaris_key.devices`` — the Device principal's surface.

Registration, the roster, telemetry, the two hashed-identity formulas, and the concrete
stores. ``device_id_from_raw`` and ``hash_components`` live together here because they are
the same kind of thing — hashed hardware identity computed ON the device so raw serials
never cross the wire — and because ``conformance/corpus/v2/fingerprint.json`` pins BOTH.

Mirrors ``@polaris-key/node/devices``.
"""

from __future__ import annotations

from .client import (
    DEVICES_PATH,
    REGISTER_PATH,
    AccountDevice,
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
    collect_fingerprint,
    hash_components,
    raw_components,
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
