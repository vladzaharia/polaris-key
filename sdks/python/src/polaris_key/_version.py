"""Runtime package metadata helpers."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

from .constants_generated import SdkId

#: The PyPI distribution name. The IMPORT package is ``polaris_key``.
DIST_NAME = "polaris-key"


def _installed_version() -> str:
    try:
        return version(DIST_NAME)
    except PackageNotFoundError:
        return "0.1.0"


__version__ = _installed_version()
#: Sent as ``X-PKey-SDK``: the short SDK id ``python`` (WIRE-CONTRACT-V3 §5.2, the generated
#: ``SdkId``). The header names the SDK, not the distribution, so the SDKs are distinguishable
#: in the Worker's device roster; the version travels in ``X-PKey-SDK-Version``.
SDK_NAME = SdkId.PYTHON
SDK_VERSION = __version__
