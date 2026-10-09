"""Locale-aware formatting of the values the copy takes as pre-formatted strings (UI-KITS §4.7:
dates, durations and byte counts are formatted by the platform and passed in)."""

from __future__ import annotations

import time
from typing import Optional

__all__ = ["countdown", "date", "duration", "relative", "size", "size_pair"]

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


#: Short month names where the locale spells them (the others use numbers: 10月8日, 10월 8일).
_MONTHS = {
    "en": "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(),
    "de": "Jan. Feb. März Apr. Mai Juni Juli Aug. Sept. Okt. Nov. Dez.".split(),
    "fr": "janv. févr. mars avr. mai juin juil. août sept. oct. nov. déc.".split(),
    "es": "ene feb mar abr may jun jul ago sept oct nov dic".split(),
    "pt-BR": "jan. fev. mar. abr. mai. jun. jul. ago. set. out. nov. dez.".split(),
    "it": "gen feb mar apr mag giu lug ago set ott nov dic".split(),
}


def date(epoch: Optional[int], locale: str = "en") -> str:
    """``Oct 8``: the locale's short month and day (never an ISO date in prose), as the Node kit's
    ``Intl.DateTimeFormat`` writes it."""
    if epoch is None:
        return ""
    t = time.gmtime(int(epoch))
    if locale in ("ja", "zh-Hans"):
        return f"{t.tm_mon}月{t.tm_mday}日"
    if locale == "ko":
        return f"{t.tm_mon}월 {t.tm_mday}일"
    month = _MONTHS.get(locale, _MONTHS["en"])[t.tm_mon - 1]
    if locale == "en":
        return f"{month} {t.tm_mday}"
    if locale == "de":
        return f"{t.tm_mday}. {month}"
    if locale == "pt-BR":
        return f"{t.tm_mday} de {month}"
    return f"{t.tm_mday} {month}"


#: "today", "yesterday" and "N days ago", per launch locale (as ``Intl.RelativeTimeFormat`` writes them).
_RELATIVE = {
    "en": ("today", "yesterday", "{n} days ago"),
    "de": ("heute", "gestern", "vor {n} Tagen"),
    "fr": ("aujourd’hui", "hier", "il y a {n} jours"),
    "es": ("hoy", "ayer", "hace {n} días"),
    "pt-BR": ("hoje", "ontem", "há {n} dias"),
    "it": ("oggi", "ieri", "{n} giorni fa"),
    "ja": ("今日", "昨日", "{n}日前"),
    "ko": ("오늘", "어제", "{n}일 전"),
    "zh-Hans": ("今天", "昨天", "{n}天前"),
}


def relative(epoch: Optional[float], now: float, locale: str = "en") -> str:
    """When something last happened, in whole days: ``today``, ``yesterday``, ``3 days ago``.
    ``epoch`` is epoch seconds; a value too large to be seconds is read as the milliseconds it is
    (the cache's ``lastVerifiedAt``), never ``20,713,526 days ago``."""
    if epoch is None:
        return ""
    seconds = epoch / 1000 if epoch > 1e11 else epoch
    days = max(0, int(round((now - seconds) / 86_400)))
    today, yesterday, ago = _RELATIVE.get(locale, _RELATIVE["en"])
    return today if days < 1 else yesterday if days == 1 else ago.format(n=days)


def size_pair(done: int, total: int, locale: str = "en") -> "tuple[str, str]":
    """``("38", "61 MB")``: the finished part as a bare number and the whole with its unit, so
    "38 of 61 MB" reads once and each number keeps its unit."""
    unit, div = ("MB", 1_000_000) if total >= 1_000_000 else ("KB", 1000)
    digits = 0 if total / div >= 10 or total / div < 1 else 1

    def num(n: float) -> str:
        text = f"{n:.{digits}f}"
        return text.replace(".", ",") if locale in _DECIMAL_COMMA else text

    return num(done / div), f"{num(total / div)} {unit}"
