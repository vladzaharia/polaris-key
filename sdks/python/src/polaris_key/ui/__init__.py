"""Polaris Key UI foundations for Python: tokens, the accent resolver and the terminal tables.

The design system every Python UI kit reads (docs/design/UI-KITS.md §2, §3.3): the generated
tokens (``polaris_key.ui._tokens``), the ANSI tables for the terminal kit (``polaris_key.ui.ansi``),
the Qt Quick theme and QWidget stylesheets (``polaris_key/ui/qt/``), the bundled variable Rubik and
JetBrains Mono (``polaris_key/ui/fonts/``) and the product accent resolver
(``polaris_key.ui.accent``). Pure Python, no GUI dependency: the Qt and terminal kits build on it.
"""

from __future__ import annotations

from pathlib import Path

from . import _tokens as tokens
from . import ansi
from .accent import ResolvedAccent, derive_accent, resolve_accent

#: The bundled fonts (TTF) and their licences.
FONTS_DIR = Path(__file__).resolve().parent / "fonts"
#: The Qt Quick theme (Theme.qml + qmldir) and the QWidget stylesheets.
QT_DIR = Path(__file__).resolve().parent / "qt"

__all__ = [
    "FONTS_DIR",
    "QT_DIR",
    "ResolvedAccent",
    "ansi",
    "derive_accent",
    "resolve_accent",
    "tokens",
]
