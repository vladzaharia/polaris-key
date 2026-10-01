"""The one pattern helper every claim and version check goes through (WIRE-CONTRACT-V4 §3).

A pattern matches the WHOLE string, with nothing after the match — a line terminator
included. ``re.match`` with ``^…$`` lets ``1.2.3\\n`` through (``$`` matches before a final
``\\n``), and ``\\d`` matches every Unicode decimal digit (``١.٢.٣``), so every pattern here
is written with ASCII classes and run through ``re.fullmatch``. JavaScript, Swift
(``wholeMatches``) and GDScript (``PKeyClaims.matches_whole``) apply the same rule.
"""

from __future__ import annotations

import re
from typing import Any, Optional, Pattern

__all__ = ["_full_match"]


def _full_match(pattern: "Pattern[str]", value: Any) -> Optional["re.Match[str]"]:
    """The match when ``value`` is a string the pattern matches whole; otherwise ``None``."""
    if not isinstance(value, str):
        return None
    return pattern.fullmatch(value)
