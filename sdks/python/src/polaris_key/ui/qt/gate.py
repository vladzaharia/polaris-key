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

import dataclasses
import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, List, Mapping, Optional, Sequence, Set, Tuple

from ..core.identity import presentation_source
from ..core.theme import Theme
from ..core.ui_gate import gate_view, grace_banner_view, toast_view
from ..core.ui_contract import context_of
from ..core.ui_update import update_progress_view, update_prompt_view
from ..core.ui_view import View, actions_for
from . import _binding as qt
from .flow import GateFlow, default_open_url
from .kit import KitView

__all__ = ["GateController", "UpdateOffer", "changelog_entry", "gate_input", "run_gate", "update_notes"]

#: How long a toast stays (a11y.toastTimer): it never holds the only record of anything.
TOAST_MS = 5000
#: The update dialog's and the toast's windows.
DIALOG_SIZE = (460, 560)
TOAST_SIZE = (440, 190)
#: The scrim's alpha over the host window, dark and light (a blurred scrim where the OS can: DL2).
_SCRIM = {"dark": (0, 0, 0, 140), "light": (16, 18, 24, 96)}


@dataclass(frozen=True)
class UpdateOffer:
    """An update offered to the person (UI-KITS decision 1): what the dialog says about it."""

    version: str
    #: The running version, from the app (the client's own).
    current: Optional[str] = None
    #: The download size in bytes, only when known: never guessed.
    size: Optional[int] = None
    #: At most three plain lines of the release summary, and the release page ("All changes").
    notes: Tuple[str, ...] = ()
    notes_url: Optional[str] = None
    mandatory: bool = False
    critical: bool = False


def update_notes(summary: Optional[str]) -> Tuple[str, ...]:
    """At most three plain lines of a release summary: list markers, headings and blank lines stripped."""
    if not isinstance(summary, str):
        return ()
    lines: List[str] = []
    for raw in summary.splitlines():
        line = raw.strip()
        while line and line[0] in "-*\u2022#>":
            line = line[1:].strip()
        if line:
            lines.append(line)
    return tuple(lines[:3])


def changelog_entry(entries: Sequence[Any], version: str) -> Optional[Any]:
    """The changelog entry for ``version`` (a leading ``v`` ignored on either side)."""

    def bare(v: Any) -> str:
        v = str(v or "")
        return v[1:] if v.startswith("v") else v

    return next((e for e in entries if bare(getattr(e, "version", "")) == bare(version) or bare(getattr(e, "tag", "")) == bare(version)), None)


def _client_version(client: Any) -> Optional[str]:
    """The running app's version as the client holds it (the SDK's own, never this kit's)."""
    version = getattr(getattr(client, "core", None), "version", None)
    return version if isinstance(version, str) and version else None


def presentation_source_of(kit: KitView) -> Any:
    """The presentation source the gate's own kit draws from: the overlays share it."""
    return getattr(kit.bridge, "_source", None)


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


def _host_rect(host: Any) -> Optional[Tuple[int, int, int, int]]:
    """The host window's frame in screen coordinates, or ``None`` when there is no host."""
    if host is None:
        return None
    try:
        g = host.geometry()
        return g.x(), g.y(), g.width(), g.height()
    except Exception:
        return None


class _Scrim:
    """The dim layer over the host window under a dialog (DL2): a frameless window the size of the host,
    transient for it, painted with the scheme's scrim colour. It takes the clicks the host must not get."""

    def __init__(self, host: Any) -> None:
        self.host = host
        self.alpha: Tuple[int, int, int, int] = _SCRIM["dark"]
        self.window: Any = None

    def show(self, scheme: str) -> None:
        rect = _host_rect(self.host)
        if rect is None:
            return
        self.alpha = _SCRIM["light" if scheme == "light" else "dark"]
        if self.window is None:
            colour = qt.QtGui.QColor(*self.alpha)
            owner = self

            class Scrim(qt.QtGui.QRasterWindow):  # type: ignore[misc]
                def paintEvent(self, _event: Any) -> None:
                    painter = qt.QtGui.QPainter(self)
                    painter.fillRect(self.rect(), qt.QtGui.QColor(*owner.alpha) if owner else colour)
                    painter.end()

            w = Scrim()
            flags = qt.QtCore.Qt.WindowType
            w.setFlags(flags.FramelessWindowHint | flags.Tool | flags.WindowDoesNotAcceptFocus)
            fmt = w.format()
            fmt.setAlphaBufferSize(8)
            w.setFormat(fmt)
            if hasattr(w, "setTransientParent"):
                w.setTransientParent(self.host)
            self.window = w
        x, y, width, height = rect
        self.window.setGeometry(x, y, width, height)
        self.window.show()

    def hide(self) -> None:
        if self.window is not None:
            self.window.hide()

    def close(self) -> None:
        if self.window is not None:
            self.window.close()
            self.window.destroy()
            self.window = None


class _Overlay:
    """A kit window that sits over the host window (the update dialog, a toast): its own
    :class:`KitView`, centred (dialog) or at the foot (toast) on the host, never owning the event loop."""

    def __init__(self, theme: Optional[Theme], source: Any, size: Tuple[int, int], host: Any, *, dialog: bool) -> None:
        self.kit = KitView(theme, source=source, size=size)
        self.host = host
        self.dialog = dialog
        self.size = size
        flags = qt.QtCore.Qt.WindowType
        window = self.kit.view
        if dialog:
            window.setFlags(flags.Dialog | flags.FramelessWindowHint | flags.WindowStaysOnTopHint)
        else:
            window.setFlags(flags.Tool | flags.FramelessWindowHint | flags.WindowStaysOnTopHint | flags.WindowDoesNotAcceptFocus)
        if host is not None and hasattr(window, "setTransientParent"):
            window.setTransientParent(host)
        window.setModality(
            qt.QtCore.Qt.WindowModality.ApplicationModal if dialog and host is not None else qt.QtCore.Qt.WindowModality.NonModal
        )
        self.scrim = _Scrim(host) if dialog else None

    def place(self) -> None:
        rect = _host_rect(self.host)
        width, height = self.size
        if rect is None:
            return
        x, y, w, h = rect
        if self.dialog:
            self.kit.view.setPosition(x + max(0, (w - width) // 2), y + max(0, (h - height) // 2))
        else:
            self.kit.view.setPosition(x + max(0, (w - width) // 2), y + max(0, h - height - 24))

    def show(self) -> None:
        if self.scrim is not None:
            self.scrim.show(self.kit.bridge.look.scheme)
        self.place()
        self.kit.view.show()

    def hide(self) -> None:
        self.kit.view.hide()
        if self.scrim is not None:
            self.scrim.hide()

    def close(self) -> None:
        if self.scrim is not None:
            self.scrim.close()
        self.kit.close()


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
        theme: Optional[Theme] = None,
        on_update: Optional[Callable[[UpdateOffer], None]] = None,
        current_version: Optional[str] = None,
        toasts: bool = True,
    ) -> None:
        self.client = client
        self.kit = kit
        self.window = window
        self.on_open = on_open
        self._theme = theme
        self._open_url = open_url or default_open_url
        #: What the host does for "Update now" (decision 7: the button draws only with one).
        self.on_update = on_update
        self.current_version = current_version if current_version is not None else _client_version(client)
        self._toasts = toasts
        #: The update on offer (``None`` when none), what it says about the download, and the versions
        #: the person chose Later for (a repeat offer of one is a toast, never the dialog again).
        self.update: Optional[UpdateOffer] = None
        self.update_progress_state: Optional[Mapping[str, Any]] = None
        self._later: Set[str] = set()
        self._dialog: Optional[_Overlay] = None
        self._toast: Optional[_Overlay] = None
        self._toast_token = 0
        self._closing = False
        self._handle = getattr(window, "windowHandle", None)
        self._host: Any = self._handle() if callable(self._handle) else window
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
        self.flow.on_signed_in = self._signed_in
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

    # ── update dialog ───────────────────────────────────────────────────────────────────────
    def _context(self, **extra: Any) -> Any:
        ident = self.kit.bridge.identity
        data = {
            "services": self.flow._services(),
            "presentation": {"name": ident.name, "developerName": ident.developer},
            **extra,
        }
        return context_of({k: v for k, v in data.items() if v is not None})

    @property
    def update_open(self) -> bool:
        """Whether the update dialog is on screen."""
        return self._dialog is not None and self._dialog.kit.view.isVisible()

    @property
    def toast(self) -> Optional[View]:
        """The toast being shown, or ``None``."""
        t = self._toast
        return t.kit.bridge.view if t is not None and t.kit.view.isVisible() else None

    def offer_update(self, offer: "UpdateOffer | str", **fields: Any) -> None:
        """Offer an update as a dialog over the host window: a scrim, Later and Update now, the facts and,
        once the host reports it, the progress. ``offer`` is an :class:`UpdateOffer` or a version (the
        rest of the :class:`UpdateOffer` fields as keywords).

        The release notes come from the product's changelog (decision 1): when ``offer`` carries none, the
        entry for its version is fetched off the GUI thread and the dialog gains up to three summary
        lines and "All changes". A mandatory update has no Later. A version the person chose Later for
        is a toast the next time it is offered, never the dialog again."""
        if not isinstance(offer, UpdateOffer):
            offer = UpdateOffer(version=str(offer), **fields)
        if offer.current is None and self.current_version:
            offer = dataclasses.replace(offer, current=self.current_version)
        if self.update is not None and self.update.version == offer.version:  # the same offer again keeps what it learned
            offer = dataclasses.replace(
                offer,
                size=offer.size if offer.size is not None else self.update.size,
                notes=offer.notes or self.update.notes,
                notes_url=offer.notes_url or self.update.notes_url,
            )
        else:
            self.update_progress_state = None
        self.update = offer
        if offer.version in self._later and not offer.mandatory:
            self._show_toast(toast_view(self._context(toast={"kind": "update"}, update={"action": "binary", "version": offer.version})))
            return
        self._later.discard(offer.version)
        self._draw_update()
        if not offer.notes and not offer.notes_url:
            self._fetch_notes(offer.version)

    def _fetch_notes(self, version: str) -> None:
        release = getattr(self.client, "release", None)
        changelog = getattr(release, "changelog", None)
        if not callable(changelog):
            return

        def done(entries: Any, error: Optional[BaseException]) -> None:
            if error is not None or self.update is None or self.update.version != version:
                return
            entry = changelog_entry(entries or (), version)
            if entry is None:
                return
            self.update = dataclasses.replace(
                self.update, notes=update_notes(getattr(entry, "summary", None)), notes_url=getattr(entry, "url", None) or None
            )
            if self.update_open:
                self._draw_update()

        self._work(changelog, done)

    def _work(self, fn: Callable[[], Any], done: Callable[[Any, Optional[BaseException]], None]) -> None:
        """Run a client call that waits off the GUI thread and deliver its result on it."""

        def run() -> None:
            try:
                result, error = fn(), None
            except BaseException as e:  # noqa: BLE001 - every failure is a result for the GUI thread
                result, error = None, e
            try:
                self.kit.bridge.post(lambda: None if self._closing else done(result, error))
            except RuntimeError:
                pass  # the kit closed while the call was out

        threading.Thread(target=run, daemon=True, name="polaris-key-gate").start()

    def update_view(self) -> Optional[Tuple[View, Mapping[str, Any]]]:
        """The update dialog's screen and the facts it draws, or ``None`` with nothing on offer."""
        offer = self.update
        if offer is None:
            return None
        update: dict = {"action": "binary", "version": offer.version}
        if offer.mandatory:
            update["mandatory"] = True
        if offer.critical:
            update["critical"] = True
        progress = self.update_progress_state
        if progress:
            update["progress"] = dict(progress)
        ctx = self._context(update=update)
        view = update_prompt_view(ctx)
        if progress and progress.get("phase") not in ("download", "verify"):
            view = update_progress_view(ctx)
        drop = {"update.restartWhenReady", "update.skipVersion", "update.timeLeft"}
        if self.on_update is None:
            drop.update(("update.install", "common.tryAgain"))  # nothing in the host to run it (decision 7)
        if not offer.notes_url:
            drop.add("update.allChanges")
        if not offer.notes:
            drop.add("update.whatsNew")
        if offer.mandatory:
            drop.add("update.later")
        copy = tuple(k for k in view.copy if k not in drop)
        args = dict(view.args)
        if progress and "update.title" not in copy:
            copy = ("update.title",) + copy  # a download keeps the name of the version it fetches
            args.update(product=self.kit.bridge.identity.name, version=offer.version)
        decisions = view.decisions
        if decisions.primary in drop:
            decisions = dataclasses.replace(decisions, primary=None)
        if progress and decisions.tone == "danger":
            decisions = dataclasses.replace(decisions, tone="neutral")  # the name is not the failure: the sentence under it is
        view = dataclasses.replace(view, copy=copy, actions=actions_for(copy), decisions=decisions, args=args)
        return view, {"current": offer.current, "size": offer.size, "notes": offer.notes}

    def _draw_update(self) -> None:
        shown = self.update_view()
        if shown is None or shown[0].state == "hidden":
            return
        view, facts = shown
        if self._dialog is None:
            self._dialog = _Overlay(self._theme, presentation_source_of(self.kit), DIALOG_SIZE, self._host, dialog=True)
            self._dialog.kit.bridge.invoked.connect(self._dialog_invoked)
        self._dialog.kit.set_view(view, None, facts)
        self._dialog.show()

    def update_progress(self, fraction: Optional[float] = None, *, phase: str = "download") -> None:
        """The host's updater reports a download (``phase`` ``download``, ``verify``, ``install``,
        ``paused``, ``failed`` or ``done``) and how far it is (``fraction`` 0..1, left out when the
        host does not know: the bar then shows no number)."""
        if self.update is None:
            return
        state: dict = {"phase": phase}
        if isinstance(fraction, (int, float)) and not isinstance(fraction, bool):
            state["fraction"] = max(0.0, min(1.0, float(fraction)))
        self.update_progress_state = state
        if phase == "done":
            self.dismiss_update()
            return
        self._draw_update()

    def update_later(self) -> None:
        """Later: the dialog goes and the version is remembered (a mandatory update has no Later)."""
        if self.update is None or self.update.mandatory:
            return
        self._later.add(self.update.version)
        self._hide_update()

    def dismiss_update(self) -> None:
        """The update is done or withdrawn: the dialog goes and nothing is remembered."""
        self.update = None
        self.update_progress_state = None
        self._hide_update()

    def _hide_update(self) -> None:
        if self._dialog is not None:
            self._dialog.hide()

    def _dialog_invoked(self, key: str, action: str) -> None:
        offer = self.update
        if key == "update.later":
            self.update_later()
        elif key == "update.install" and offer is not None and self.on_update is not None:
            self.on_update(offer)
        elif key == "update.allChanges" and offer is not None and offer.notes_url:
            self._open_url(offer.notes_url)
        elif key == "common.tryAgain" and offer is not None and self.on_update is not None:
            self.update_progress_state = None
            self._draw_update()
            self.on_update(offer)

    def check_for_update(self, channel: Optional[str] = None) -> None:
        """Ask the product for the signed update decision (``client.update.decide``, off the GUI thread)
        and offer a newer build of the app: a binary update, mandatory or critical when the decision says
        so. Anything else the decision answers (a store listing, a platform install, nothing) is the
        host's own affair and draws nothing here."""
        update = getattr(self.client, "update", None)
        decide = getattr(update, "decide", None)
        if not callable(decide):
            return

        def done(check: Any, error: Optional[BaseException]) -> None:
            decision = getattr(check, "decision", None)
            release = getattr(decision, "release", None)
            if error is not None or getattr(decision, "action", None) != "binary" or release is None:
                return
            self.offer_update(
                UpdateOffer(
                    version=str(release.version),
                    mandatory=getattr(decision, "mandatory", None) is True,
                    critical=getattr(decision, "critical", None) is True,
                )
            )

        self._work(lambda: decide(channel=channel) if channel else decide(), done)

    # ── toasts ──────────────────────────────────────────────────────────────────────────────
    def _signed_in(self, result: Any) -> None:
        """A sign-in the gate ran finished: "Signed in as <name> · <Tier> license"."""
        identity = getattr(result, "identity", None)
        name = getattr(identity, "name", None)
        if not name:
            current = getattr(getattr(self.client, "identity", None), "current", None)
            try:
                name = (current() or {}).get("name") if callable(current) else None
            except Exception:
                name = None
        info = getattr(getattr(self.client, "license", None), "license_info", None)
        try:
            lic = info() if callable(info) else None
        except Exception:
            lic = None
        tier = getattr(lic, "tierLabel", None) or getattr(lic, "tier", None)
        toast: dict = {"kind": "signedIn", "name": name}
        if tier:
            toast["tier"] = tier
        self._show_toast(toast_view(self._context(toast=toast)))

    def _show_toast(self, view: View) -> None:
        if not self._toasts or view.state == "hidden":
            return
        if self._toast is None:
            self._toast = _Overlay(self._theme, presentation_source_of(self.kit), TOAST_SIZE, self._host, dialog=False)
            self._toast.kit.bridge.invoked.connect(lambda key, _a: self.dismiss_toast() if key == "common.dismiss" else None)
        self._toast.kit.set_view(view)
        self._toast.show()
        self._toast_token += 1
        token = self._toast_token
        # An older toast's timer never clears a newer one.
        qt.QtCore.QTimer.singleShot(TOAST_MS, lambda: self.dismiss_toast(token))

    def dismiss_toast(self, token: Optional[int] = None) -> None:
        """The toast timed out or was dismissed."""
        if self._toast is None or (token is not None and token != self._toast_token):
            return
        self._toast.hide()

    def close(self) -> None:
        self._closing = True
        self.flow.close()
        for overlay in (self._dialog, self._toast):
            if overlay is not None:
                overlay.close()
        self._dialog = self._toast = None
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
    on_update: Optional[Callable[[UpdateOffer], None]] = None,
    current_version: Optional[str] = None,
    toasts: bool = True,
) -> GateController:
    """Gate ``window`` (a ``QWidget``/``QWindow``, or ``None``) on ``client``'s licence.

    ``platform`` is ``{"os": …, "formFactor": …}`` when the app runs somewhere the desktop rules do
    not hold (a TV or a console opens on the device code and draws a QR, UI-KITS DL14). The paths the
    gate offers come from the client: sign-in when the product runs Identity, a license key when it
    runs License; ``capabilities`` overrides them, and ``offers_free_tier=True`` adds Continue free
    (``client.license.enroll``). ``open_url`` opens a link in the browser (``QDesktopServices`` by
    default); ``renew_url`` is the https page Renew opens on an expired license (without one, Use another
    license is the only control); ``device_name`` is the label a sign-in page shows.

    Updates are offered as a dialog over ``window`` (:meth:`GateController.offer_update`,
    :meth:`~GateController.check_for_update`): ``on_update`` is what the host does for Update now, and the
    button draws only when there is one (UI-KITS decision 7); ``current_version`` is the running app's
    version when the client does not know it. ``toasts=False`` turns off the "Signed in as ..." toast."""
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
        theme=theme,
        on_update=on_update,
        current_version=current_version,
        toasts=toasts,
    )
