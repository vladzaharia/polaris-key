"""``polaris_key.update`` — the Update service's client surface (version check + the Sparkle
appcast URL). Mirrors ``@polaris-key/node``'s ``update/client.ts``."""

from __future__ import annotations

from .client import UpdateClient, VersionCheck

__all__ = ["UpdateClient", "VersionCheck"]
