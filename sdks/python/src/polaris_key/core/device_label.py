"""The device label (WIRE-CONTRACT-V4 §12.7.1, plans/PX-W13.md §2.1), pinned by
``device-label.json``.

The human name of this device the sign-in page shows ("Living room TV"), sent as ``deviceName``
on device-code sign-in, licence activation and registration. Display data only: no server
decision reads it. The Worker applies the same normalisation on receipt:

1. map the whitespace controls (U+0009-000D, U+0085, U+00A0, U+2028, U+2029, U+3000) to a space;
2. delete the controls, zero-width and bidi code points;
3. collapse runs of spaces to one, then trim;
4. keep at most ``DEVICE_LABEL_MAX_CODEPOINTS`` code points, and trim a space the cut exposes;
5. an empty result is no label (``None``).

No Unicode normalisation; nothing is ever rejected.
"""

from __future__ import annotations

import platform
import re
from typing import Callable, Optional

from ..constants_generated import DEVICE_LABEL_MAX_CODEPOINTS

__all__ = ["normalize_device_label", "default_device_name", "resolve_device_label"]

_SPACE = (
    (0x0009, 0x000D),
    (0x0085, 0x0085),
    (0x00A0, 0x00A0),
    (0x2028, 0x2029),
    (0x3000, 0x3000),
)
_STRIP = (
    (0x0000, 0x001F),
    (0x007F, 0x009F),
    (0x061C, 0x061C),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x2069),
    (0xFEFF, 0xFEFF),
)


def _in(cp: int, ranges: tuple) -> bool:
    return any(lo <= cp <= hi for lo, hi in ranges)


def normalize_device_label(raw: object) -> Optional[str]:
    """§12.7.1: the label to send and store, or ``None`` when nothing is left of ``raw``."""
    if not isinstance(raw, str):
        return None
    kept: list = []
    for ch in raw:  # a Python str iterates code points, never UTF-16 units
        cp = ord(ch)
        if _in(cp, _SPACE):
            cp = 0x20
        elif _in(cp, _STRIP):
            continue
        if cp == 0x20 and (not kept or kept[-1] == 0x20):
            continue
        kept.append(cp)
    while kept and kept[-1] == 0x20:
        kept.pop()
    cut = kept[:DEVICE_LABEL_MAX_CODEPOINTS]
    while cut and cut[-1] == 0x20:
        cut.pop()
    return "".join(chr(c) for c in cut) or None


_HOST_SUFFIX = re.compile(r"\.(local|lan|home)$", re.IGNORECASE)


def default_device_name() -> Optional[str]:
    """``platform.node()`` with a trailing ``.local``, ``.lan`` or ``.home`` removed."""
    try:
        return _HOST_SUFFIX.sub("", platform.node()) or None
    except Exception:
        return None


def resolve_device_label(
    override: Optional[str],
    configured: Optional[str],
    platform_default: Callable[[], Optional[str]] = default_device_name,
) -> Optional[str]:
    """``override`` (per call) wins, then ``configured`` (the client option), then the platform
    default. ``""`` at either level sends none."""
    if override is not None:
        return normalize_device_label(override)
    if configured is not None:
        return normalize_device_label(configured)
    return normalize_device_label(platform_default())
