"""The approving device's side of nearby sign-in in the Qt kit (I-47.14; plans/I-47-slices.md D-6; WIRE-CONTRACT-V5
§12.11.5 and §15.6.1): "Approve a nearby device".

:class:`NearbyApproval` is the state machine over the Python client: a device nearby asks to sign in, the person
sees three codes and taps the one the other device shows (number matching), or Deny, then the outcome and, when
the account holds several licenses, the license to give it. It draws nothing itself: every screen is a
``(view, data)`` from :func:`polaris_key.ui.core.ui_signin.nearby_approval_view` (the function the ui-matrix pins)
that :class:`~.kit.KitView` lays out; the three codes, the licenses and the other device's name are the host's data
(display data from an unverified peer, cleaned before they are drawn). The client calls that wait run on a worker
thread and come back on the GUI thread through ``bridge.post``.

:class:`Approver` owns the advert. The SDK core never advertises on its own (D-6): it stands only while an
approval screen is open (``prompt``), and, if the host asks for it (:class:`ForegroundApprover`), while the
application's window is active and the device is signed in, where a request raises a notice and nothing else
(``prompt=False``, ``background=True``) until the person opens "Approve a nearby device".

:func:`nearby_approval_page` is the screen as a page of its own; :class:`~.account.AccountPage` shows the entry in
its account pane and runs the same machine in place.
"""

from __future__ import annotations

import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

from ...constants_generated import ErrorCode
from ...core.peer_display import clean_label
from ..core import ui_signin
from ..core.identity import presentation_source
from ..core.theme import Theme
from ..core.ui_contract import SERVICES, context_of
from ..core.ui_view import View
from . import _binding as qt
from .flow import with_copy
from .kit import KitView

__all__ = ["Approver", "ForegroundApprover", "NearbyApproval", "NearbyApprovalPage", "nearby_approval_page"]


class Approver:
    """The advert, behind ``client.identity.nearby.on_request`` (D-6): ``start`` makes it, ``prompt`` and
    ``leave`` open and close the approval screen on it, ``stop`` ends it. A request is handed to the handler of
    the screen that is open; with none open it raises ``on_notice`` (when the advert is a background one)."""

    def __init__(self, client: Any, *, on_notice: Optional[Callable[[Any], None]] = None) -> None:
        self.client = client
        self._on_notice = on_notice
        self._handler: Optional[Callable[[Any], None]] = None
        self.handle: Any = None
        #: Why the advert is not up: an error code (``nearby-unsupported``, ``account_required``), or ``None``.
        self.error: Optional[str] = None
        self._background = False

    @property
    def active(self) -> bool:
        return self.handle is not None

    def start(self, *, background: bool = False, label: Optional[str] = None) -> bool:
        """Advertise. ``background=True`` keeps the advert up with the prompt closed (a request is a notice
        only); otherwise the prompt is open from the start. Answers whether the advert is up."""
        if self.handle is not None:
            return True
        self._background = background
        options: Dict[str, Any] = {"prompt": not background, "background": background, "on_notice": self._notice}
        if label is not None:
            options["label"] = label
        try:
            self.handle = self.client.identity.nearby.on_request(self._dispatch, **options)
        except Exception as e:  # noqa: BLE001 - every failure is a code for the screen to say
            self.error = str(getattr(e, "code", "") or "nearby-unsupported")
            self.handle = None
            return False
        self.error = None
        return True

    def _dispatch(self, ask: Any) -> None:
        handler = self._handler
        if handler is not None:
            handler(ask)

    def _notice(self, notice: Any) -> None:
        if self._on_notice is not None:
            self._on_notice(notice)

    def prompt(self, handler: Callable[[Any], None]) -> bool:
        """The approval screen opens: requests go to ``handler`` (on the SDK's thread). Starts the advert if
        it is not up; with a background one up, opens its prompt."""
        self._handler = handler
        if self.handle is None:
            return self.start()
        try:
            self.handle.set_prompt(True)
        except Exception:
            pass
        return True

    def leave(self) -> None:
        """The approval screen closes. A background advert stays up with its prompt closed; any other stops."""
        self._handler = None
        if self.handle is None:
            return
        if self._background:
            try:
                self.handle.set_prompt(False)
            except Exception:
                pass
        else:
            self.stop()

    def stop(self) -> None:
        self._handler = None
        handle, self.handle = self.handle, None
        if handle is not None:
            try:
                handle.stop()
            except Exception:
                pass


class ForegroundApprover(Approver):
    """An :class:`Approver` that advertises while the application's window is active and the device is signed in
    (D-6; ``prompt=False``): a request raises ``on_notice`` (show a toast: "a device wants to sign in", with the
    account menu's entry), and opening "Approve a nearby device" gives the request its screen. The advert is
    paused while the application is in the background and resumed when it is active again."""

    def __init__(self, client: Any, *, on_notice: Optional[Callable[[Any], None]] = None, app: Any = None) -> None:
        super().__init__(client, on_notice=on_notice)
        qt.require()
        self._app = app or qt.QtGui.QGuiApplication.instance()
        if self._app is not None:
            self._app.applicationStateChanged.connect(self._state)

    def start(self, *, background: bool = True, label: Optional[str] = None) -> bool:
        active = self._active()
        if not active:
            return False  # started again when the window becomes active
        return super().start(background=True, label=label)

    def _active(self) -> bool:
        if self._app is None:
            return True
        return bool(self._app.applicationState() == qt.QtCore.Qt.ApplicationState.ApplicationActive)

    def _state(self, state: Any) -> None:
        if state == qt.QtCore.Qt.ApplicationState.ApplicationActive:
            if self.handle is None:
                self.start()
            else:
                try:
                    self.handle.resume()
                except Exception:
                    pass
        elif self.handle is not None:
            try:
                self.handle.pause()
            except Exception:
                pass

    def close(self) -> None:
        if self._app is not None:
            try:
                self._app.applicationStateChanged.disconnect(self._state)
            except (RuntimeError, TypeError):
                pass
            self._app = None
        self.stop()


#: ``NearbyApproval``'s steps for a Worker or SDK answer the SDK has no step for.
_STEPS = ("approved", "mismatch", "not-nearby", "denied", "expired", "device-limit", "account-required", "rate-limited")


class NearbyApproval:
    """The approval's screens over one client, drawn into ``kit`` (see the module docstring). ``on_exit`` is
    called when the person is done (Done, Cancel, or an outcome that ends it); ``on_devices`` when "Manage
    devices" is chosen after a device limit; ``on_sign_in`` when "Sign in" is chosen after ``account-required``."""

    def __init__(
        self,
        client: Any,
        kit: KitView,
        *,
        approver: Optional[Approver] = None,
        platform: Optional[Dict[str, Any]] = None,
        on_exit: Optional[Callable[[], None]] = None,
        on_devices: Optional[Callable[[], None]] = None,
        on_sign_in: Optional[Callable[[], None]] = None,
    ) -> None:
        self.client = client
        self.kit = kit
        self.platform = platform
        self.approver = approver or Approver(client)
        self._on_exit = on_exit
        self._on_devices = on_devices
        self._on_sign_in = on_sign_in
        self.step = "entry"
        self.ask: Any = None
        self.choose_step: Any = None
        self.device: Optional[str] = None
        self.codes: Tuple[str, ...] = ()
        self._free: List[Dict[str, Any]] = []
        self._names: Tuple[str, ...] = ()
        self._create = False
        self._open = False
        self._closed = False

    # ── what the screen is ──────────────────────────────────────────────────────────────────
    def _services(self) -> List[str]:
        enabled = getattr(getattr(self.client, "core", None), "enabled", None)
        if callable(enabled):
            try:
                return [slug for slug, _requires in SERVICES if enabled(slug)]
            except Exception:
                pass
        return [slug for slug, _r in SERVICES if slug != "identity" or hasattr(self.client, "identity")]

    def render(self) -> Tuple[View, Any]:
        """The screen for the current step, as ``(view, data)``."""
        ident = self.kit.bridge.identity
        n: Dict[str, Any] = {"step": self.step}
        if self.device:
            n["device"] = self.device
        if self.step == "ask":
            n["codes"] = list(self.codes)
        if self.step == "choose":
            n["choices"] = list(self._names)
            n["create"] = self._create
        data: Dict[str, Any] = {
            "services": self._services(),
            "presentation": {"name": ident.name, "developerName": ident.developer},
            "nearbyApproval": n,
        }
        if self.platform is not None:
            data["platform"] = dict(self.platform)
        view = ui_signin.nearby_approval_view(context_of({k: v for k, v in data.items() if v is not None}))
        # Cancel leaves the screen that waits for a device to ask and answers nothing. At the codes and at the
        # license choice, leaving answers Deny (the view's own Deny: one rule for every kit, UXR-47 B1); an
        # outcome has Done. The waiting entry says what it waits for and shows the busy indicator (N5).
        if self.step == "entry":
            view = with_copy(view, "common.cancel", "signin.cli.approveWaiting")
        elif self.step == "working":
            view = with_copy(view, "common.working")
        elif self.step == "mismatch":
            view = with_copy(view, "signin.nearby.expiredBody")  # how to go on, as the terminal's closing line
        return view, None

    def redraw(self) -> None:
        if self._closed:
            return
        view, data = self.render()
        self.kit.set_view(view, data)

    # ── the flow ────────────────────────────────────────────────────────────────────────────
    def open(self) -> None:
        """"Approve a nearby device": show the waiting screen and start listening (the prompt is open)."""
        self._open = True
        self.step, self.ask, self.choose_step, self.device, self.codes = "entry", None, None, None, ()
        self.redraw()
        if not self.approver.prompt(self._on_ask):
            self._ended(self._error_step(self.approver.error))

    def _error_step(self, code: Optional[str]) -> str:
        if code in (ErrorCode.ACCOUNT_REQUIRED, ErrorCode.NO_TOKEN):
            return "account-required"
        return "expired"  # nothing nearby can ask: the screen says so and the person starts again

    def _on_ask(self, ask: Any) -> None:
        """A device asks (on the SDK's thread): show its three codes."""
        try:
            self.kit.bridge.post(lambda: self._asked(ask))
        except RuntimeError:
            pass  # the kit closed

    def _asked(self, ask: Any) -> None:
        if self._closed or not self._open or self.ask is not None:
            return
        self.ask = ask
        self.device = clean_label(str(getattr(ask, "device", None) or "")) or None
        self.codes = tuple(str(c) for c in ask.codes)
        self.step = "ask"
        self.redraw()

    def pick(self, number: int) -> None:
        """The person tapped the numbered code (1 to 3): the SDK approves only a code that matched."""
        if self.step != "ask" or self.ask is None or not 1 <= number <= len(self.codes):
            return
        code, ask = self.codes[number - 1], self.ask
        self.step = "working"
        self._work(lambda: ask.pick(code), self._stepped)

    def deny(self) -> None:
        """Deny: before a code was picked it is "none of these match" (no route is called); at the license
        choice it is the answer's own cancel."""
        if self.choose_step is not None:
            step, self.choose_step = self.choose_step, None
            self.step = "working"
            self._work(step.cancel, self._stepped)
            return
        ask = self.ask
        if ask is None:
            return
        self._work(ask.deny, lambda _r, _e: self._ended("denied"))

    def choose(self, key: str) -> None:
        """A license of the choice (``nearby.choice.N``) or a new one (``nearby.choice.create``)."""
        step = self.choose_step
        if step is None:
            return
        tail = key[len("nearby.choice.") :]
        if tail == "create":
            choice: Dict[str, Any] = {"kind": "create"}
        elif tail.isdigit() and 1 <= int(tail) <= len(self._free):
            choice = {"kind": "license", "licenseId": self._free[int(tail) - 1]["id"]}
        else:
            return
        self.choose_step = None
        self.step = "working"
        self._work(lambda: step.choose(choice), self._stepped)

    def _stepped(self, step: Any, error: Optional[BaseException]) -> None:
        if self._closed:
            return
        if error is not None:
            code = getattr(error, "code", None)
            self._ended("account-required" if code == ErrorCode.ACCOUNT_REQUIRED else "expired")
            return
        kind = str(getattr(step, "kind", "expired"))
        if kind == "choose":
            view = getattr(step, "choices", None) or {}
            self._free = [c for c in (view.get("choices") or []) if c.get("state") == "free"][:9]
            self._names = tuple(clean_label(str(c.get("name") or c.get("tierName") or "")) for c in self._free)
            self._create = view.get("create") is not None
            self.choose_step = step
            self.step = "choose"
            self.redraw()
            return
        self._ended(kind if kind in _STEPS else "expired")

    def _ended(self, step: str) -> None:
        """An outcome: it stops the advert's prompt and shows where it came to, with Done."""
        self.step, self.ask, self.choose_step = step, None, None
        self._open = False
        self.approver.leave()
        self.redraw()

    # ── controls ────────────────────────────────────────────────────────────────────────────
    def handle(self, key: str, action: str = "") -> bool:
        """A control of the screen was pressed: ``True`` when this machine ran it."""
        if key.startswith("nearby.code."):
            tail = key[len("nearby.code.") :]
            if tail.isdigit():
                self.pick(int(tail))
            return True
        if key.startswith("nearby.choice."):
            self.choose(key)
            return True
        if key == "signin.approve.deny":
            self.deny()
            return True
        if key == "common.cancel":
            self.leave()
            return True
        if key == "common.done":
            self.leave()
            return True
        if key == "devices.manage":
            self.leave(then=self._on_devices)
            return True
        if key == "signin.key.signIn":
            self.leave(then=self._on_sign_in)
            return True
        return False

    def leave(self, then: Optional[Callable[[], None]] = None) -> None:
        """Done or Cancel: the advert's prompt closes (nothing is left listening that the host did not ask
        for) and the host's ``on_exit`` runs (or ``then``, where the control leads elsewhere)."""
        self._deny_on_leave()
        self._open = False
        self.approver.leave()
        target = then or self._on_exit
        if target is not None:
            target()

    def _deny_on_leave(self) -> None:
        """Leaving the codes or the license choice any other way than a button (a closed window) is Deny too:
        before a code was picked it is local, at the license choice it is the answer's own cancel."""
        ask, step = self.ask, self.choose_step
        self.ask = self.choose_step = None
        if step is not None:
            threading.Thread(target=lambda: self._quiet(step.cancel), daemon=True, name="polaris-key-nearby").start()
        elif ask is not None and self.step == "ask":
            self._quiet(ask.deny)

    @staticmethod
    def _quiet(fn: Callable[[], Any]) -> None:
        try:
            fn()
        except Exception:
            pass

    def close(self) -> None:
        self._deny_on_leave()
        self._closed = True
        self._open = False
        self.approver.leave()

    # ── threads ─────────────────────────────────────────────────────────────────────────────
    def _work(self, fn: Callable[[], Any], done: Callable[[Any, Optional[BaseException]], None]) -> None:
        self.redraw()

        def run() -> None:
            try:
                result, error = fn(), None
            except BaseException as e:  # noqa: BLE001 - every failure is a result for the GUI thread
                result, error = None, e
            try:
                self.kit.bridge.post(lambda: None if self._closed else done(result, error))
            except RuntimeError:
                pass  # the kit closed while the call was out

        threading.Thread(target=run, daemon=True, name="polaris-key-nearby").start()


class NearbyApprovalPage:
    """"Approve a nearby device" as a page of its own: ``show()`` it, or put :meth:`container` in a widgets
    layout. Closing it stops the advert it started."""

    def __init__(
        self,
        client: Any,
        *,
        theme: Optional[Theme] = None,
        size: Tuple[int, int] = (480, 560),
        approver: Optional[Approver] = None,
        on_exit: Optional[Callable[[], None]] = None,
        on_devices: Optional[Callable[[], None]] = None,
        on_sign_in: Optional[Callable[[], None]] = None,
        platform: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.kit = KitView(theme, source=presentation_source(client), size=size)
        self.approval = NearbyApproval(
            client, self.kit, approver=approver, platform=platform, on_exit=on_exit or self.close, on_devices=on_devices, on_sign_in=on_sign_in
        )
        self.kit.bridge.invoked.connect(self.approval.handle)
        self._closed = False
        self.approval.open()

    @property
    def view(self) -> Any:
        return self.kit.view

    @property
    def screen(self) -> Optional[View]:
        return self.kit.bridge.view

    def container(self, parent: Any = None) -> Any:
        return self.kit.container(parent)

    def show(self) -> None:
        self.kit.view.show()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.approval.close()
        self.kit.close()


def nearby_approval_page(client: Any, **options: Any) -> NearbyApprovalPage:
    """The approval page for ``client``; ``options`` are those of :class:`NearbyApprovalPage`."""
    return NearbyApprovalPage(client, **options)
