"""Outlet kinds and capabilities — plans/P3-01.md §2.9 (WIRE-CONTRACT-V4 §8, §11).

The compiled tables of ``@polaris-key/protocol/distribution``, restated: every SDK, the Worker
and ``outlet-matrix.json`` hold these same values, and ``tests/test_update_matrix.py`` asserts
them equal to the matrix. The kind and subkind vocabularies come from the generated constants
(``OUTLET_KIND_VALUES``, ``OUTLET_SUBKIND_VALUES``, ``OUTLET_CONFIDENCE_VALUES``).

Every table is read-only (``MappingProxyType`` over tuples), so a caller cannot widen a default
for every client in the process.
"""

from __future__ import annotations

import re
from types import MappingProxyType
from typing import Any, Dict, Mapping, Tuple

from ..constants_generated import (
    OUTLET_CONFIDENCE_VALUES,
    OUTLET_KIND_VALUES,
    OUTLET_SUBKIND_VALUES,
)

__all__ = [
    "OUTLET_KINDS",
    "OUTLET_SUBKINDS",
    "OUTLET_CONFIDENCES",
    "OUTLET_UNKNOWN",
    "OUTLET_ID_PATTERN",
    "BINARY_UPDATES_ORDER",
    "COMMERCE_VALUES",
    "CAPABILITY_BOOLEANS",
    "OUTLET_CAPABILITY_DEFAULTS",
    "OUTLET_PLATFORMS",
    "PLATFORM_NARROWING",
    "SUBKIND_NARROWING",
    "LISTING_URL_PREFIXES",
]

#: Every outlet kind (README §3.1), in ``OUTLET_KINDS`` order.
OUTLET_KINDS: Tuple[str, ...] = OUTLET_KIND_VALUES
#: How a ``direct`` install was put on the device, where that changes who updates it.
OUTLET_SUBKINDS: Tuple[str, ...] = OUTLET_SUBKIND_VALUES
#: How sure outlet detection is, strongest first.
OUTLET_CONFIDENCES: Tuple[str, ...] = OUTLET_CONFIDENCE_VALUES

#: A detection result, never a kind: nothing can declare it, and it never has a feed entry.
OUTLET_UNKNOWN = "unknown"

#: Outlet ids and kinds: lower-case, starting with a letter, at most 64 characters. Run it
#: through ``_full_match`` (the whole string, ASCII only).
OUTLET_ID_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,63}")

#: Who installs a new build, narrowest first: the platform, a store, or the SDK itself.
BINARY_UPDATES_ORDER: Tuple[str, ...] = ("none", "store", "self")
#: ``commerce``'s vocabulary.
COMMERCE_VALUES: Tuple[str, ...] = ("own", "store-iap", "steam", "none")
#: The four boolean capability fields.
CAPABILITY_BOOLEANS: Tuple[str, ...] = (
    "codeUpdates",
    "dataUpdates",
    "channelSwitch",
    "downloadedScripts",
)


def _caps(**fields: Any) -> Mapping[str, Any]:
    return MappingProxyType(dict(fields))


_STORE: Dict[str, Any] = {
    "binaryUpdates": "store",
    "codeUpdates": False,
    "dataUpdates": True,
    "channelSwitch": False,
    "commerce": "store-iap",
    "downloadedScripts": False,
}
_STORE_OWN: Dict[str, Any] = {**_STORE, "commerce": "own"}
_PLATFORM_OWN: Dict[str, Any] = {**_STORE_OWN, "binaryUpdates": "none"}

#: The capability defaults per outlet kind (in ``OUTLET_KINDS`` order), and for ``unknown``. The feed and a platform or
#: subkind can narrow them; nothing widens them.
OUTLET_CAPABILITY_DEFAULTS: Mapping[str, Mapping[str, Any]] = MappingProxyType(
    {
        "direct": _caps(
            binaryUpdates="self",
            codeUpdates=True,
            dataUpdates=True,
            channelSwitch=True,
            commerce="own",
            downloadedScripts=True,
        ),
        "app-store": _caps(**_STORE),
        "testflight": _caps(**_STORE),
        "altstore": _caps(**_STORE_OWN),
        "altstore-pal": _caps(**_STORE_OWN),
        "play": _caps(**_STORE),
        "play-testing": _caps(**_STORE),
        "obtainium": _caps(**_STORE_OWN),
        "fdroid-repo": _caps(**_STORE_OWN),
        "ms-store": _caps(**_STORE),
        "app-installer": _caps(**_PLATFORM_OWN),
        "steam": _caps(**{**_PLATFORM_OWN, "commerce": "steam"}),
        "itch": _caps(**_PLATFORM_OWN),
        "flathub": _caps(**_PLATFORM_OWN),
        "snap": _caps(**_PLATFORM_OWN),
        "winget": _caps(**_PLATFORM_OWN),
        "web": _caps(**{**_PLATFORM_OWN, "downloadedScripts": True}),
        OUTLET_UNKNOWN: _caps(
            binaryUpdates="none",
            codeUpdates=False,
            dataUpdates=False,
            channelSwitch=False,
            commerce="none",
            downloadedScripts=False,
        ),
    }
)

#: The platforms each kind serves. ``unknown`` lists every platform (it can be anywhere).
OUTLET_PLATFORMS: Mapping[str, Tuple[str, ...]] = MappingProxyType(
    {
        "direct": ("macos", "windows", "linux", "android", "ios"),
        "app-store": ("ios", "macos"),
        "testflight": ("ios", "macos"),
        "altstore": ("ios",),
        "altstore-pal": ("ios",),
        "play": ("android",),
        "play-testing": ("android",),
        "obtainium": ("android",),
        "fdroid-repo": ("android",),
        "ms-store": ("windows",),
        "app-installer": ("windows",),
        "steam": ("windows", "macos", "linux"),
        "itch": ("windows", "macos", "linux"),
        "flathub": ("linux",),
        "snap": ("linux",),
        "winget": ("windows",),
        "web": ("web",),
        OUTLET_UNKNOWN: ("macos", "ios", "android", "windows", "linux", "web"),
    }
)

#: Per platform, per kind. On iOS a ``direct`` install is Web Distribution: it opens its page
#: (``store``) and never loads code.
PLATFORM_NARROWING: Mapping[str, Mapping[str, Mapping[str, Any]]] = MappingProxyType(
    {
        "ios": MappingProxyType(
            {
                "direct": _caps(
                    binaryUpdates="store", codeUpdates=False, downloadedScripts=False
                )
            }
        )
    }
)

_PACKAGE_MANAGED = _caps(binaryUpdates="none", codeUpdates=False)

#: A package manager or Flatpak updates the install; AppImageUpdate is a native method, so
#: ``appimage`` narrows nothing.
SUBKIND_NARROWING: Mapping[str, Mapping[str, Any]] = MappingProxyType(
    {
        "homebrew": _PACKAGE_MANAGED,
        "npm": _PACKAGE_MANAGED,
        "pnpm": _PACKAGE_MANAGED,
        "npx": _PACKAGE_MANAGED,
        "scoop": _PACKAGE_MANAGED,
        "chocolatey": _PACKAGE_MANAGED,
        "flatpak": _PACKAGE_MANAGED,
        "appimage": _caps(),
    }
)

#: The only prefixes a feed's ``listingUrl`` may start with, byte for byte, per kind. Every
#: other kind carries no ``listingUrl``.
LISTING_URL_PREFIXES: Mapping[str, Tuple[str, ...]] = MappingProxyType(
    {
        "app-store": ("https://apps.apple.com/", "itms-apps://apps.apple.com/"),
        "testflight": ("https://testflight.apple.com/join/",),
        "play": (
            "https://play.google.com/store/apps/details?id=",
            "market://details?id=",
        ),
        "play-testing": (
            "https://play.google.com/apps/testing/",
            "https://play.google.com/store/apps/details?id=",
            "market://details?id=",
        ),
        "ms-store": (
            "https://apps.microsoft.com/detail/",
            "ms-windows-store://pdp/?productid=",
        ),
    }
)
