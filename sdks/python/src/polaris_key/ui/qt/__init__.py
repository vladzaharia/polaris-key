"""``polaris_key.ui.qt``: the Qt Quick kit (UI-KITS §1.4 "Qt"), PySide6 primary and PyQt6 through qtpy.

``pip install "polaris-key[qt]"``, then ``run_gate(client, window)``, which also offers updates as a dialog
over the window and toasts a sign-in, and ``account_page(client)`` / ``settings_page(client)`` for the
host's own settings. The three layers of §1.3: (a) the drop-in flow (:func:`run_gate`), (b) the styled parts (``kit/*.qml`` over the generated
``Theme.qml`` and the QSS), (c) the headless models (:mod:`polaris_key.ui.core`, :mod:`.layout`).

Importing this package does not import Qt; the first call that needs it does, and says how to
install it when it is missing.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "AccountPage",
    "GateController",
    "GateFlow",
    "KitBridge",
    "KitView",
    "UpdateOffer",
    "account_page",
    "build_spec",
    "load_fonts",
    "render",
    "run_gate",
    "settings_page",
]

_LAZY = {
    "KitBridge": ".bridge",
    "KitView": ".kit",
    "load_fonts": ".kit",
    "render": ".kit",
    "run_gate": ".gate",
    "UpdateOffer": ".gate",
    "AccountPage": ".account",
    "account_page": ".account",
    "settings_page": ".account",
    "GateController": ".gate",
    "GateFlow": ".flow",
    "build_spec": ".layout",
}


def __getattr__(name: str) -> Any:
    if name in _LAZY:
        import importlib

        return getattr(importlib.import_module(_LAZY[name], __name__), name)
    raise AttributeError(name)
