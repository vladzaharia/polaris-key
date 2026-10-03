"""``polaris_key.update`` — the Update service's client surface: the version check, the Sparkle
appcast URL, and wire v4's signed update decision (``decide()``, ``feed()``,
``release_record()``, ``build_url()``) and the pack facet (``client.update.packs``,
:mod:`polaris_key.update.packs`). Mirrors ``@polaris-key/node``'s ``update/client.ts``."""

from __future__ import annotations

from .client import (
    FeedCheck,
    ReleaseRecordCheck,
    UpdateClient,
    UpdateClientOptions,
    UpdateError,
    VersionCheck,
)
from ..core.detection import detect_outlet, detection_stamp
from .packs import DataJsonHandler, L10nTableHandler, MlModelHandler, PackError, PackHandler
from .packs.client import EmbeddedPack, PacksClient, PacksOptions
from .outlet import (
    OutletFs,
    OutletReaderEnvironment,
    process_outlet_environment,
    read_outlet_signals,
)

__all__ = [
    "UpdateClient",
    "UpdateClientOptions",
    "UpdateError",
    "VersionCheck",
    "FeedCheck",
    "ReleaseRecordCheck",
    "OutletFs",
    "OutletReaderEnvironment",
    "detect_outlet",
    "detection_stamp",
    "process_outlet_environment",
    "read_outlet_signals",
    "PackError",
    "PackHandler",
    "DataJsonHandler",
    "L10nTableHandler",
    "MlModelHandler",
    "EmbeddedPack",
    "PacksClient",
    "PacksOptions",
]
