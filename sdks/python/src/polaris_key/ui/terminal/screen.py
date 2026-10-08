"""Fitting a live screen to the terminal (docs/design/UI-KITS.md §1.4 Terminal), as the Node kit's
``term/screen.ts`` does it.

A live flow draws its whole screen (header to key hints). It is laid out spaced first. When it is
taller than the terminal, less one row for the cursor, it compacts in a fixed order and stops as
soon as it fits:

1. the key hints join the spinner line, when the joined line fits the width;
2. the blank lines between prose blocks go (tier ``DROP["blank_prose"]``);
3. the "Check the code there matches" line goes;
4. the blank lines around the code chip go;
5. the "Code expires in" line goes;
6. whatever is still too tall loses its top lines (the header and the lead-in) from view.

The URL line, the code and the key hints are never dropped. Printed output (status, devices,
offline) is never compacted: it scrolls.
"""

from __future__ import annotations

from dataclasses import replace
from typing import List, NamedTuple, Sequence

from .text import Line, Span, cell_len

__all__ = ["Fitted", "fit_screen", "inline_hints"]


class Fitted(NamedTuple):
    #: The lines that fit.
    lines: List[Line]
    #: How many of the leading lines are the flow's header (0 once the top lines were cut).
    head: int


def _width(spans: Sequence[Span]) -> int:
    return cell_len("".join(s.text for s in spans).rstrip())


def inline_hints(lines: Sequence[Line], columns: int, separator: str) -> List[Line]:
    """Merge the hints line onto the spinner line when the joined line fits ``columns``."""
    h = next((i for i, ln in enumerate(lines) if ln.role == "hints"), -1)
    s = next((i for i, ln in enumerate(lines) if ln.role == "spinner"), -1)
    if h < 0 or s < 0 or not lines[h].hint_spans:
        return list(lines)
    joined = lines[s].spans + [Span(" " + separator + " ", ("muted",), None, "symbol")] + list(lines[h].hint_spans or [])
    if _width(joined) > columns:
        return list(lines)
    return [replace(ln, spans=joined) if i == s else ln for i, ln in enumerate(lines) if i != h]


def fit_screen(lines: Sequence[Line], max_rows: int, columns: int, separator: str) -> Fitted:
    """The lines that fit ``max_rows``: spaced if they fit, else compacted in the tier order, else
    with the top lines cut."""
    max_rows = max(1, max_rows)

    def head_of(ls: Sequence[Line], cut: int = 0) -> int:
        n = 0
        while n < len(ls) and ls[n].role == "header":
            n += 1
        return max(0, n - cut)

    if len(lines) <= max_rows:
        return Fitted(list(lines), head_of(lines))
    cur = inline_hints(lines, columns, separator)
    for tier in sorted({ln.drop for ln in cur if ln.drop is not None}):
        if len(cur) <= max_rows:
            break
        cur = [ln for ln in cur if ln.drop != tier]
    cut = max(0, len(cur) - max_rows)
    return Fitted(cur[cut:] if cut else cur, head_of(cur, cut))
