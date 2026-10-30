"""WIRE-CONTRACT-V5 §15.6 and §15.6.1: display data from a peer that is not yet verified (a mode v or p
HELLO, a ``VOUCH_REQ``) is cleaned the same way wherever it is read. One module, so the session and the
vouch codecs cannot drift apart. Mirrors ``packages/client-core/src/peer/display.ts``."""

from __future__ import annotations

import re
from typing import Optional

from .device_label import clean_display_label

__all__ = ["UNKNOWN_DISPLAY", "clean_app", "clean_label", "clean_platform"]

#: ``platform`` is shown as sent only when it is up to 32 of these characters.
_PLATFORM_DISPLAY = re.compile(r"[A-Za-z0-9 ._+-]{1,32}")
UNKNOWN_DISPLAY = "Unknown"


def clean_label(raw: str) -> Optional[str]:
    """The device-label cleaning, NFC after the strip (§12.7.1, §15.6): ``None`` when nothing is left."""
    return clean_display_label(raw)


def clean_platform(raw: str) -> str:
    """The platform as sent when it is up to 32 plain characters, else "Unknown"."""
    return raw if _PLATFORM_DISPLAY.fullmatch(raw) else UNKNOWN_DISPLAY


def clean_app(raw: str) -> str:
    """The app name, cleaned like a label; "Unknown" when nothing is left."""
    return clean_label(raw) or UNKNOWN_DISPLAY
