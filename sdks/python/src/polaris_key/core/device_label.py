"""The device label (WIRE-CONTRACT-V5 §12.7.1, plans/PX-W13.md §2.1), pinned by
``device-label.json`` (``deviceLabelVersion`` 2).

The human name of this device the sign-in page shows ("Living room TV"), sent as ``deviceName``
on device-code sign-in, licence activation and registration. Display data only: no server
decision reads it. The Worker applies the same normalisation on receipt:

1. map every White_Space code point and U+2800 to a space;
2. delete the controls, format characters, default-ignorable code points and surrogates;
3. collapse runs of spaces to one, then trim;
4. keep at most ``DEVICE_LABEL_MAX_CODEPOINTS`` code points, and trim a space the cut exposes;
5. an empty result is no label (``None``).

``normalize_device_label`` is steps 1 to 5 with no Unicode normalisation. ``clean_display_label``
is the peer HELLO cleaner (§15.6): steps 1 and 2, NFC, then steps 3 to 5. Cleaning a cleaned
label changes nothing. Nothing is ever rejected.
"""

from __future__ import annotations

import platform
import re
import unicodedata
from typing import Callable, Optional

from ..constants_generated import DEVICE_LABEL_MAX_CODEPOINTS

__all__ = [
    "normalize_device_label",
    "clean_display_label",
    "default_device_name",
    "resolve_device_label",
]

# Frozen at Unicode 16.0; the corpus `ranges` section pins both tables (tests/test_device_label.py).
_SPACE = (
    (0x0009, 0x000D),
    (0x0085, 0x0085),
    (0x00A0, 0x00A0),
    (0x1680, 0x1680),
    (0x2000, 0x200A),
    (0x2028, 0x2029),
    (0x202F, 0x202F),
    (0x205F, 0x205F),
    (0x2800, 0x2800),
    (0x3000, 0x3000),
)
_STRIP = (
    (0x0000, 0x001F),
    (0x007F, 0x009F),
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x0890, 0x0891),
    (0x08E2, 0x08E2),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xD800, 0xDFFF),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)


def _in(cp: int, ranges: tuple) -> bool:
    return any(lo <= cp <= hi for lo, hi in ranges)


def _map_and_strip(raw: str) -> str:
    """Steps 1 and 2: a space for each blank, nothing for each invisible code point (lone
    surrogates included; a Python ``str`` can hold one)."""
    out: list = []
    for ch in raw:  # a Python str iterates code points, never UTF-16 units
        cp = ord(ch)
        if _in(cp, _SPACE):
            out.append(" ")
        elif not _in(cp, _STRIP):
            out.append(ch)
    return "".join(out)


def _collapse_and_cut(text: str) -> Optional[str]:
    """Steps 3 to 5."""
    kept: list = []
    for ch in text:
        if ch == " " and (not kept or kept[-1] == " "):
            continue
        kept.append(ch)
    while kept and kept[-1] == " ":
        kept.pop()
    cut = kept[:DEVICE_LABEL_MAX_CODEPOINTS]
    while cut and cut[-1] == " ":
        cut.pop()
    return "".join(cut) or None


def normalize_device_label(raw: object) -> Optional[str]:
    """§12.7.1: the label to send and store, or ``None`` when nothing is left of ``raw``."""
    if not isinstance(raw, str):
        return None
    return _collapse_and_cut(_map_and_strip(raw))


def clean_display_label(raw: object) -> Optional[str]:
    """§15.6: a peer's ``label`` or ``app`` as shown. Steps 1 and 2, NFC, then steps 3 to 5 (the
    cut counts code points after NFC). ``None`` when nothing is left."""
    if not isinstance(raw, str):
        return None
    return _collapse_and_cut(unicodedata.normalize("NFC", _map_and_strip(raw)))


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
