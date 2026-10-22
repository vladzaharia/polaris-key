"""Qt kit test setup: Qt renders offscreen with the software scene graph, so a baseline is the same
pixels on a machine with no display (UI-KITS §7.1)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
sys.path.insert(0, str(Path(__file__).resolve().parent))


@pytest.fixture(scope="session")
def kit_app():
    pytest.importorskip("PySide6.QtQuick")
    from PySide6.QtWidgets import QApplication

    # A QApplication is a QGuiApplication: the kit needs the second, KitView.container() the first.
    return QApplication.instance() or QApplication([])


#: Qt messages that are the machine's, not the kit's (no QML file behind them).
_QML_ERROR = ("TypeError", "ReferenceError", "SyntaxError", "Unable to assign", "is not defined", "Binding loop", "Cannot read property", "Cannot assign")


@pytest.fixture(autouse=True)
def qml_console():
    """Every Qt UI test fails on a QML console error: a binding that throws (``Cannot read property
    'role' of undefined``), a type mismatch on assignment or a binding loop. Such a message used to
    print and pass; it is a bug in a delegate that only shows when a screen is drawn from another
    one. ``qml_console`` is the list collected so far, for a test that wants to look."""
    try:
        from PySide6 import QtCore
    except ImportError:  # pragma: no cover
        yield []
        return
    seen: list = []

    def handler(kind, context, message):
        file = getattr(context, "file", None) or ""
        if file.endswith(".qml") or ".qml:" in message or any(m in message for m in _QML_ERROR):
            if kind in (QtCore.QtMsgType.QtWarningMsg, QtCore.QtMsgType.QtCriticalMsg, QtCore.QtMsgType.QtFatalMsg):
                seen.append(message)

    previous = QtCore.qInstallMessageHandler(handler)
    try:
        yield seen
    finally:
        QtCore.qInstallMessageHandler(previous)
    assert seen == [], "QML console errors:\n" + "\n".join(seen)
