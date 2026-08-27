"""Runtime package metadata helpers."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version


def _installed_version() -> str:
    try:
        return version("polaris-key")
    except PackageNotFoundError:
        return "0.1.0"


__version__ = _installed_version()
SDK_NAME = "polaris-key"
SDK_VERSION = __version__
