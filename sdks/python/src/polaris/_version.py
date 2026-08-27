"""Runtime package metadata helpers."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

#: The PyPI distribution name (§9 external gates). The IMPORT package is ``polaris``.
DIST_NAME = "polaris-suite"


def _installed_version() -> str:
    try:
        return version(DIST_NAME)
    except PackageNotFoundError:
        return "0.1.0"


__version__ = _installed_version()
#: Sent as ``X-Polaris-SDK``. The suite's Python SDK identifies as ``polaris-python`` —
#: the header names the SDK, not the distribution, and the four SDKs must be
#: distinguishable in the Worker's device roster.
SDK_NAME = "polaris-python"
SDK_VERSION = __version__
