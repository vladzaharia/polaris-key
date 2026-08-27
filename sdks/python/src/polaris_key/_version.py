"""Runtime package metadata helpers."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

#: The PyPI distribution name. The IMPORT package is ``polaris_key``.
DIST_NAME = "polaris-key"


def _installed_version() -> str:
    try:
        return version(DIST_NAME)
    except PackageNotFoundError:
        return "0.1.0"


__version__ = _installed_version()
#: Sent as ``X-PKey-SDK``. The Python SDK identifies as ``polaris-key-python`` — the header
#: names the SDK, not the distribution, and the four SDKs must be distinguishable in the
#: Worker's device roster.
SDK_NAME = "polaris-key-python"
SDK_VERSION = __version__
