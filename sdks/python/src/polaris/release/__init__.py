"""``polaris.release`` — the Release service's client surface (changelog, install script,
artifact URLs). Mirrors ``@plrs/node``'s ``release/client.ts``."""

from __future__ import annotations

from .client import ChangelogEntry, ReleaseClient

__all__ = ["ReleaseClient", "ChangelogEntry"]
