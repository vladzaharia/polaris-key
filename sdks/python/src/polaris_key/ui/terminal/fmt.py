"""Locale-aware formatting of the values the copy takes as pre-formatted strings (UI-KITS §4.7:
dates, durations and byte counts are formatted by the platform and passed in)."""

from __future__ import annotations

import time
from typing import Optional

__all__ = ["countdown", "date", "duration", "size"]

#: Seconds and minutes, per launch locale.
_UNITS = {
    "en": ("s", "min"),
    "de": ("s", "Min."),
    "fr": ("s", "min"),
    "es": ("s", "min"),
    "pt-BR": ("s", "min"),
    "it": ("s", "min"),
    "ja": ("秒", "分"),
    "ko": ("초", "분"),
    "zh-Hans": ("秒", "分钟"),
}
_DECIMAL_COMMA = ("de", "fr", "es", "pt-BR", "it")


def countdown(seconds: int) -> str:
    """``4:12``: a code's remaining lifetime in tabular minutes and seconds."""
    s = max(0, int(seconds))
    return "%d:%02d" % (s // 60, s % 60)


def duration(seconds: float, locale: str = "en") -> str:
    """``20 s`` or ``2 min`` (rounded up to whole minutes past a minute)."""
    sec, minute = _UNITS.get(locale, _UNITS["en"])
    s = max(0, int(round(seconds)))
    if s < 60:
        return f"{s} {sec}" if locale not in ("ja", "ko", "zh-Hans") else f"{s}{sec}"
    m = (s + 59) // 60
    return f"{m} {minute}" if locale not in ("ja", "ko", "zh-Hans") else f"{m}{minute}"


def size(n: Optional[int], locale: str = "en") -> str:
    """``61 MB``, ``4.2 MB`` or ``820 KB`` (decimal units)."""
    if n is None:
        return ""
    value, unit = float(n), "B"
    for u in ("KB", "MB", "GB"):
        if value < 1000:
            break
        value /= 1000
        unit = u
    text = f"{value:.1f}" if value < 10 and unit != "B" else f"{value:.0f}"
    if locale in _DECIMAL_COMMA:
        text = text.replace(".", ",")
    return f"{text} {unit}"


def date(epoch: Optional[int]) -> str:
    """``2026-10-08``: an ISO date, the one format every launch locale reads."""
    if epoch is None:
        return ""
    return time.strftime("%Y-%m-%d", time.gmtime(int(epoch)))
