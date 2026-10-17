"""The Qt binding: PySide6 first, else PyQt6 through qtpy (UI-KITS §1.4 "Qt"). Nothing here runs at
``import polaris_key``; the kit imports it on first use and raises one clear error without a binding."""

from __future__ import annotations

from typing import Any

__all__ = ["BINDING", "QtCore", "QtGui", "QtQml", "QtQuick", "Signal", "Slot", "Property", "require"]

BINDING: str = ""
try:  # pragma: no cover - which branch runs depends on the environment
    from PySide6 import QtCore, QtGui, QtQml, QtQuick  # type: ignore[import-not-found]
    from PySide6.QtCore import Property, Signal, Slot  # type: ignore[import-not-found]

    BINDING = "PySide6"
except ImportError:  # pragma: no cover
    try:
        from qtpy import QtCore, QtGui, QtQml, QtQuick  # type: ignore[import-not-found,no-redef]
        from qtpy.QtCore import Property, Signal, Slot  # type: ignore[import-not-found,no-redef]

        BINDING = "qtpy"
    except ImportError:
        QtCore = QtGui = QtQml = QtQuick = None  # type: ignore[assignment]
        Property = Signal = Slot = None  # type: ignore[assignment,misc]


def require() -> Any:
    """Raise the one install hint when no binding is present."""
    if not BINDING:
        raise ImportError('The Qt kit needs a Qt binding: pip install "polaris-key[qt]" (PySide6) or PyQt6 with qtpy.')
    return QtCore
