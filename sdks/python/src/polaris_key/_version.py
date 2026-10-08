"""Runtime package metadata helpers.

``__version__`` and ``SDK_VERSION`` are read from the installed distribution's metadata on first
use (PEP 562): ``importlib.metadata`` costs tens of milliseconds to import, and a host CLI that
mounts the verbs should not pay it for a command that is not ours.
"""

from __future__ import annotations

from typing import Any, Optional

from .constants_generated import SdkId

#: The PyPI distribution name. The IMPORT package is ``polaris_key``.
DIST_NAME = "polaris-key"

#: Sent as ``X-PKey-SDK``: the short SDK id ``python`` (WIRE-CONTRACT-V3 §5.2, the generated
#: ``SdkId``). The header names the SDK, not the distribution, so the SDKs are distinguishable
#: in the Worker's device roster; the version travels in ``X-PKey-SDK-Version``.
SDK_NAME = SdkId.PYTHON

_installed: Optional[str] = None


def _installed_version() -> str:
    global _installed
    if _installed is None:
        from importlib.metadata import PackageNotFoundError, version

        try:
            _installed = version(DIST_NAME)
        except PackageNotFoundError:
            _installed = "0.1.0"
    return _installed


def __getattr__(name: str) -> Any:
    # ``__version__`` and ``SDK_VERSION`` (sent as ``X-PKey-SDK-Version``): the installed version.
    if name in ("__version__", "SDK_VERSION"):
        return _installed_version()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
