"""Rendering the fixtures for the goldens: every variant of UI-KITS §7.1's Terminal row (truecolor,
ANSI-16, ``NO_COLOR``, ascii; 80 and 60 columns) plus the piped form (no terminal: what a log or a
screen reader gets, §4.4), in both terminal themes.

Record with ``PKEY_GOLDEN=record`` (``.venv/bin/python -m pytest -q tests/cli``); a changed
baseline fails until it is re-recorded, with the reason in the commit (§7.2).
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Dict, List, Tuple

from polaris_key.ui.terminal.env import TermEnv
from polaris_key.ui.terminal.text import Line, to_ansi

from .fixtures import Fixture, kit

GOLDEN = Path(__file__).resolve().parent / "golden"
THEMES = ("dark", "light")
#: (name, color, symbols)
MODES: Tuple[Tuple[str, str, str], ...] = (
    ("truecolor", "truecolor", "unicode"),
    ("ansi16", "ansi16", "unicode"),
    ("no-color", "none", "unicode"),
    ("ascii", "ansi16", "ascii"),
)
WIDTHS = (80, 60)

RECORD = os.environ.get("PKEY_GOLDEN") == "record"


def env(color: str, symbols: str, width: int, theme: str, *, tty: bool = True) -> TermEnv:
    return TermEnv(
        tty=tty,
        interactive=tty,
        color=color if tty else "none",
        symbols=symbols,
        width=width,
        # 30 rows, as the Node kit's goldens: tall enough for the offline QR, which shows only
        # where the whole screen fits with it (tests/cli/test_responsive.py covers 12 and 24).
        height=30,
        scheme=theme,
        hyperlinks=tty and color != "none",
        clipboard=tty,
        motion=tty,
    )


def variants(theme: str) -> List[Tuple[str, TermEnv]]:
    out = [(f"{name} · {w}", env(color, sym, w, theme)) for w in WIDTHS for name, color, sym in MODES]
    out.append(("pipe · 80", env("none", "unicode", 80, theme, tty=False)))
    return out


def render(fx: Fixture, e: TermEnv) -> Tuple[List[Line], str]:
    k = kit(e)
    lines = fx.draw(k)
    pal = k.palette()
    return lines, "\n".join(to_ansi(ln, pal) for ln in lines)


def document(fx: Fixture, theme: str) -> str:
    """The golden text for one fixture and theme: every variant under a ``── name ──`` line."""
    parts = []
    for label, e in variants(theme):
        _, text = render(fx, e)
        parts.append(f"── {label} ──\n{text}\n")
    return "".join(parts)


def sections(doc: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for m in re.finditer(r"^── (.+?) ──\n(.*?)(?=^── |\Z)", doc, re.S | re.M):
        out[m.group(1)] = m.group(2).rstrip("\n")
    return out


def check(path: Path, text: str) -> None:
    """Compare ``text`` with the committed baseline at ``path``, or write it when recording."""
    if RECORD:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        return
    assert path.exists(), f"missing baseline {path.relative_to(GOLDEN.parent)}: record with PKEY_GOLDEN=record"
    committed = path.read_text(encoding="utf-8")
    assert committed == text, f"{path.name} changed: re-record with PKEY_GOLDEN=record and give the reason in the commit"
