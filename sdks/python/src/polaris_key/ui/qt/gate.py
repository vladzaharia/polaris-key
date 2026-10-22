"""``run_gate(client, window)``: gate an app on its licence with the Qt Quick kit.

The kit never owns the event loop (UI-KITS §5.2). ``run_gate`` builds one :class:`~.kit.KitView`
from the SDK client's own state (``client.status()``, the SDK's presentation source), shows it as a
window transient for the host's ``window`` while the app may not proceed, and hides it when it may.
It returns a :class:`GateController` the host keeps; ``controller.refresh()`` re-reads the client,
and a Try again or Reconnect press does the same.

While the license is not usable the gate runs every screen that gets one (:class:`~.flow.GateFlow`):
Welcome, license-key entry with the client's refusals in their own words, sign-in in the browser
or by device code, Replace a device, and the blocked-status screens. The host calls nothing: the
gate calls ``client.license.activate_with_key`` and ``client.identity`` itself, off the GUI thread,
and re-reads the client when one succeeds.
"""

from __future__ import annotations

import math
import time
from typing import Any, Callable, Mapping, Optional, Tuple

from ..core.identity import presentation_source
from ..core.theme import Theme
from ..core.ui_gate import gate_view, grace_banner_view
from ..core.ui_contract import context_of
from ..core.ui_view import View
from . import _binding as qt
from .flow import GateFlow
from .kit import KitView

__all__ = ["GateController", "gate_input", "run_gate"]


def _mapping_of(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def gate_input(client: Any, *, now: Optional[int] = None) -> dict:
    """Map ``client.status()`` to the ``gate`` ui-matrix input shape."""
    try:
        st = client.status()
        status = st.status
    except Exception:
        return {"stage": {"outcome": "error"}}
    gate: dict = {"status": status}
    until = getattr(st, "graceUntil", None)
    if status == "grace" and isinstance(until, (int, float)) and not isinstance(until, bool):
        clock = time.time() if now is None else now
        gate["graceDaysLeft"] = max(0, math.ceil((until - clock) / 86400))
    return {"gate": gate}


class GateController:
    """The running gate: its view, the screen being drawn, and the open/close decision."""

    def __init__(
        self,
        client: Any,
        kit: KitView,
        window: Any = None,
        on_open: Optional[Callable[[], None]] = None,
        *,
        platform: Optional[Mapping[str, Any]] = None,
        capabilities: Optional[Mapping[str, bool]] = None,
        offers_free_tier: bool = False,
        open_url: Optional[Callable[[str], bool]] = None,
        renew_url: Optional[str] = None,
        clipboard: Any = None,
        device_name: Optional[str] = None,
    ) -> None:
        self.client = client
        self.kit = kit
        self.window = window
        self.on_open = on_open
        self._modal: Any = kit.view.modality() if hasattr(kit.view, "modality") else None
        #: The gate's own view (``needs-activation``, ``licensed``, ``grace`` …): what the client says.
        self.view: Optional[View] = None
        self.flow = GateFlow(
            client,
            kit,
            on_status=self.refresh,
            platform=platform,
            capabilities=capabilities,
            offers_free_tier=offers_free_tier,
            open_url=open_url,
            renew_url=renew_url,
            clipboard=clipboard,
            device_name=device_name,
        )
        kit.bridge.invoked.connect(self._invoked)
        kit.bridge.edited.connect(self.flow.edited)
        self.refresh()

    @property
    def screen(self) -> Optional[View]:
        """The screen the kit is drawing: Welcome, Activate, SignInHandoff … (the gate's own view while
        no screen of the flow applies)."""
        return self.kit.bridge.view

    @property
    def open(self) -> bool:
        """Whether the app may proceed: licensed, or in offline grace (a usable status)."""
        return self.view is not None and self.view.state in ("licensed", "grace")

    def refresh(self) -> View:
        ctx = context_of(gate_input(self.client))
        self.view = gate_view(ctx)
        if self.view.state == "grace":
            # The app renders in grace (ui-matrix PolarisKeyGate/grace). The notice is the grace
            # banner, shown as a non-modal window so it never blocks the app.
            self.flow.reset()
            self.kit.set_view(grace_banner_view(ctx))
            self.kit.view.setModality(qt.QtCore.Qt.WindowModality.NonModal)
            self.kit.view.show()
            if self.on_open:
                self.on_open()
            return self.view
        if self.open:
            self.flow.reset()
            self.kit.set_view(self.view)
            self.kit.view.hide()
            if self.on_open:
                self.on_open()
            return self.view
        if self.view.state in ("needs-activation", "blocked") and self.flow.available:
            self.flow.start(str(_mapping_of(ctx.input.get("gate")).get("status") or "needs-activation"))
            screen, data = self.flow.render()
            self.kit.set_view(screen, data)
        else:
            self.flow.reset()
            self.kit.set_view(self.view)
        if self._modal is not None:
            self.kit.view.setModality(self._modal)
        self.kit.view.show()
        return self.view

    def _invoked(self, key: str, action: str) -> None:
        if self.flow.handle(key, action):
            return
        if action == "retry":
            self.refresh()

    def close(self) -> None:
        self.flow.close()
        self.kit.close()


def run_gate(
    client: Any,
    window: Any = None,
    *,
    theme: Optional[Theme] = None,
    size: Tuple[int, int] = (520, 640),
    on_open: Optional[Callable[[], None]] = None,
    platform: Optional[Mapping[str, Any]] = None,
    capabilities: Optional[Mapping[str, bool]] = None,
    offers_free_tier: bool = False,
    open_url: Optional[Callable[[str], bool]] = None,
    renew_url: Optional[str] = None,
    device_name: Optional[str] = None,
) -> GateController:
    """Gate ``window`` (a ``QWidget``/``QWindow``, or ``None``) on ``client``'s licence.

    ``platform`` is ``{"os": …, "formFactor": …}`` when the app runs somewhere the desktop rules do
    not hold (a TV or a console opens on the device code and draws a QR, UI-KITS DL14). The paths the
    gate offers come from the client: sign-in when the product runs Identity, a license key when it
    runs License; ``capabilities`` overrides them, and ``offers_free_tier=True`` adds Continue free
    (``client.license.enroll``). ``open_url`` opens a link in the browser (``QDesktopServices`` by
    default); ``renew_url`` is the https page Renew opens on an expired license (without one, Use another
    license is the only control); ``device_name`` is the label a sign-in page shows."""
    kit = KitView(theme, source=presentation_source(client), size=size)
    handle = getattr(window, "windowHandle", None)
    parent = handle() if callable(handle) else window
    if parent is not None and hasattr(kit.view, "setTransientParent"):
        kit.view.setTransientParent(parent)
    kit.view.setModality(qt.QtCore.Qt.WindowModality.ApplicationModal if parent is not None else qt.QtCore.Qt.WindowModality.NonModal)
    return GateController(
        client,
        kit,
        window,
        on_open,
        platform=platform,
        capabilities=capabilities,
        offers_free_tier=offers_free_tier,
        open_url=open_url,
        renew_url=renew_url,
        device_name=device_name,
    )
