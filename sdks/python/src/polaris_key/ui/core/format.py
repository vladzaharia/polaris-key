"""Locale words the kits share and no catalog key carries: a whole-day age ("3 days ago").

Dates, durations and byte sizes are formatted by the platform and passed to the catalog as strings
(UI-KITS 4.7); this is the one place the Python kits spell a relative day, as ``Intl.RelativeTimeFormat``
writes it. Pure data and no imports, so the Qt layout and the terminal read the same words.
"""

from __future__ import annotations

__all__ = ["RELATIVE", "relative_days"]

#: "today", "yesterday" and "N days ago", per launch locale (as ``Intl.RelativeTimeFormat`` writes them).
RELATIVE = {
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


def relative_days(days: int, locale: str = "en") -> str:
    """``today``, ``yesterday`` or ``3 days ago`` for a whole number of days (negative reads as today)."""
    today, yesterday, ago = RELATIVE.get(locale, RELATIVE["en"])
    return today if days < 1 else yesterday if days == 1 else ago.format(n=days)
