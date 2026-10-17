"""The Qt kit's modernity lint (UI-KITS §7.3) as source rules over the QML, plus the rules of
tests/ui_lint_qt.py on a live QWidget tree where the QSS layer is used. No physical left/right
(RTL-safe), no weight above 600, no all-caps, no text under 12 px, no system dialogs, theme tokens
only (no colour literal in the kit's QML)."""

from __future__ import annotations

import re
from pathlib import Path

from polaris_key.ui import QT_DIR

FILES = sorted((QT_DIR / "kit").glob("*.qml"))


def _lines():
    for f in FILES:
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            yield f.name, n, line.split("//")[0]


def test_the_kit_has_qml():
    assert {f.name for f in FILES} >= {"KitButton.qml", "KitScreen.qml"}


def test_no_physical_left_right():
    bad = re.compile(r"anchors\.(left|right|leftMargin|rightMargin)\b|\b(leftPadding|rightPadding|leftInset|rightInset)\b|Text\.Align(Left|Right)\b|Qt\.AlignAbsolute")
    assert [(f, n) for f, n, line in _lines() if bad.search(line)] == []


def test_type_rules():
    assert [(f, n) for f, n, line in _lines() if re.search(r"font\.(weight|bold)\s*:\s*(Font\.(Bold|Black|ExtraBold)|[7-9]\d\d)|font\.capitalization", line)] == []
    assert [(f, n) for f, n, line in _lines() if re.search(r"pixelSize\s*:\s*(\d|1[01])\b", line)] == []


def test_colours_come_from_the_theme():
    lit = re.compile(r'"#[0-9a-fA-F]{3,8}"|Qt\.rgba\(|\b(color|border\.color)\s*:\s*"(white|black|red|green|blue)"')
    assert [(f, n) for f, n, line in _lines() if lit.search(line)] == []


def test_no_system_dialogs():
    assert [(f, n) for f, n, line in _lines() if re.search(r"MessageDialog|FileDialog|Qt\.labs\.platform|QtQuick\.Dialogs", line)] == []
