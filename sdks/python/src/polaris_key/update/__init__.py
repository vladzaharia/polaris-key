"""``polaris_key.update`` — the Update service's client surface: the version check, the Sparkle
appcast URL, and wire v4's signed update decision (``decide()``, ``feed()``,
``release_record()``, ``build_url()``). Mirrors ``@polaris-key/node``'s ``update/client.ts``."""

from __future__ import annotations

from .client import (
    FeedCheck,
    ReleaseRecordCheck,
    UpdateClient,
    UpdateClientOptions,
    UpdateError,
    VersionCheck,
)

__all__ = [
    "UpdateClient",
    "UpdateClientOptions",
    "UpdateError",
    "VersionCheck",
    "FeedCheck",
    "ReleaseRecordCheck",
]
