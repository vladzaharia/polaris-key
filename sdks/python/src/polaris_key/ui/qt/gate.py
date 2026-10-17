"""``run_gate(client, window)``: gate an app on its licence with the Qt Quick kit.

The kit never owns the event loop (UI-KITS §5.2). ``run_gate`` builds one :class:`~.kit.KitView`
from the SDK client's own state (``client.status()``, the SDK's presentation source), shows it as a
window transient for the host's ``window`` while the app may not proceed, and hides it when it may.
It returns a :class:`GateController` the host keeps; ``controller.refresh()`` re-reads the client,
and a Try again or Reconnect press does the same. Activation and sign-in screens follow with the
rest of the drop-in flow; until then the host calls its own ``client.license.activate`` and
``refresh()``.
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Tuple

from ..core.identity import presentation_source
from ..core.theme import Theme
from ..core.ui_gate import gate_view
from ..core.ui_contract import context_of
from ..core.ui_view import View
from . import _binding as qt
from .kit import KitView

__all__ = ["GateController", "gate_input", "run_gate"]


def gate_input(client: Any, *, now: Optional[int] = None) -> dict:
    """Map ``client.status()`` to the ``gate`` ui-matrix input shape."""
    try:
        status = client.status().status
    except Exception:
        return {"stage": {"outcome": "error"}}
    return {"gate": {"status": status}}


class GateController:
    """The running gate: its view, the last model view and the open/close decision."""

    def __init__(self, client: Any, kit: KitView, window: Any = None, on_open: Optional[Callable[[], None]] = None) -> None:
        self.client = client
        self.kit = kit
        self.window = window
        self.on_open = on_open
        self.view: Optional[View] = None
        kit.bridge.invoked.connect(self._invoked)
        self.refresh()

    @property
    def open(self) -> bool:
        """Whether the app may proceed (the gate shows nothing)."""
        return self.view is not None and self.view.state == "licensed"

    def refresh(self) -> View:
        self.view = gate_view(context_of(gate_input(self.client)))
        self.kit.set_view(self.view)
        if self.open:
            self.kit.view.hide()
            if self.on_open:
                self.on_open()
        else:
            self.kit.view.show()
        return self.view

    def _invoked(self, _key: str, action: str) -> None:
        if action == "retry":
            self.refresh()

    def close(self) -> None:
        self.kit.close()


def run_gate(
    client: Any,
    window: Any = None,
    *,
    theme: Optional[Theme] = None,
    size: Tuple[int, int] = (520, 640),
    on_open: Optional[Callable[[], None]] = None,
) -> GateController:
    """Gate ``window`` (a ``QWidget``/``QWindow``, or ``None``) on ``client``'s licence."""
    kit = KitView(theme, source=presentation_source(client), size=size)
    handle = getattr(window, "windowHandle", None)
    parent = handle() if callable(handle) else window
    if parent is not None and hasattr(kit.view, "setTransientParent"):
        kit.view.setTransientParent(parent)
    kit.view.setModality(qt.QtCore.Qt.WindowModality.ApplicationModal if parent is not None else qt.QtCore.Qt.WindowModality.NonModal)
    return GateController(client, kit, window, on_open)
