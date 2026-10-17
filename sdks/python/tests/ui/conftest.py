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
    from PySide6.QtGui import QGuiApplication

    app = QGuiApplication.instance() or QGuiApplication([])
    return app
