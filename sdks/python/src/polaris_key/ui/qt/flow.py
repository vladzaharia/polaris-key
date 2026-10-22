"""The gate's screens while the license is not usable: Welcome, key entry, sign-in, device limit and
the blocked-status screens (UI-KITS §4.2, SIGN-IN.md §3.17).

:class:`GateFlow` is the state machine the other kits' gates run (``PolarisKeyGateModel`` in
SwiftUI, ``useGate`` in React), over the Python client: which screen the person is on, what they
typed, and the client calls that move them on. It draws nothing itself: every screen is a
``(view, data)`` from ``polaris_key.ui.core`` (the same functions the ui-matrix pins) that
:class:`~.kit.KitView` lays out. The client calls that wait (``activate_with_key``,
``begin_sign_in``, ``wait_for_sign_in``) run on a worker thread and hand their result back to the GUI
thread with ``bridge.post``; a result from a screen the person has since left is dropped.

The routes::

    welcome ── Sign in ──────────► signin (methods → browser wait | code → finishing)
       │  └── Use a license key ─► activate ── ok ──────────► the gate re-reads the client
       │                              └── device limit ─────► limit (Replace a device in the browser)
    status (revoked, expired, …) ── Sign in | Use a different key ─► signin | activate
"""

from __future__ import annotations

import dataclasses
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from ..core import ui_activate, ui_devices, ui_gate, ui_signin
from ..core.identity import ResolvedIdentity
from ..core.ui_activate import parse_key
from ..core.ui_contract import SERVICES, context_of, platform_class
from ..core.ui_view import View, actions_for, valid_link
from . import _binding as qt

__all__ = ["GateFlow", "default_open_url", "with_copy"]

#: A status whose screen is StatusScreen rather than the activation chooser.
_BLOCKED = frozenset(("revoked", "expired", "version-too-old", "version-too-new", "channel-not-entitled"))
#: How often the code's countdown is redrawn.
_TICK_MS = 1000


def with_copy(view: View, *add: str, primary: Optional[str] = None) -> View:
    """``view`` with more controls of the catalog on it (a Cancel the form adds to a step), and, when
    ``primary`` is given, that one as the filled control. The model's own actions stay."""
    copy = tuple(sorted(set(view.copy) | set(add)))
    decisions = view.decisions if primary is None else dataclasses.replace(view.decisions, primary=primary)
    return dataclasses.replace(view, copy=copy, actions=actions_for(copy, view.actions), decisions=decisions)


def without_renew(view: View) -> View:
    """``view`` without Renew, Use another license the one filled control: a host with no renewal
    page has nothing for Renew to open."""
    if "status.renew" not in view.copy:
        return view
    copy = tuple(k for k in view.copy if k != "status.renew")
    primary = view.decisions.primary
    decisions = dataclasses.replace(view.decisions, primary="status.useAnotherLicense") if primary == "status.renew" else view.decisions
    return dataclasses.replace(view, copy=copy, actions=view.actions, decisions=decisions)


def default_open_url(url: str) -> bool:
    """Open ``url`` in the system browser (``QDesktopServices``); ``False`` when there is none."""
    qt.require()
    return bool(qt.QtGui.QDesktopServices.openUrl(qt.QtCore.QUrl(url)))


class _Clipboard:
    """The system clipboard, behind the two calls the flow makes (a test hands in its own)."""

    def text(self) -> str:
        app = qt.QtGui.QGuiApplication.instance()
        return str(app.clipboard().text()) if app is not None else ""

    def set_text(self, text: str) -> None:
        app = qt.QtGui.QGuiApplication.instance()
        if app is not None:
            app.clipboard().setText(text)


class _Session:
    """One sign-in attempt."""

    def __init__(self, code_mode: bool) -> None:
        self.code_mode = code_mode
        self.prompt: Any = None
        self.cancel = threading.Event()
        #: ``starting`` → ``waiting`` → ``ok`` | ``denied`` | ``failed`` | ``expired``.
        self.phase = "starting"
        self.browser_opened: Optional[bool] = None
        self.copied = False
        self.error: Optional[str] = None


class GateFlow:
    """The screens of a gate that is not open, and what pressing their controls does."""

    def __init__(
        self,
        client: Any,
        kit: Any,
        *,
        on_status: Callable[[], None],
        platform: Optional[Mapping[str, Any]] = None,
        capabilities: Optional[Mapping[str, bool]] = None,
        offers_free_tier: bool = False,
        open_url: Optional[Callable[[str], bool]] = None,
        renew_url: Optional[str] = None,
        clipboard: Any = None,
        device_name: Optional[str] = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.client = client
        self.kit = kit
        self._on_status = on_status
        self.platform = platform
        self._open_url = open_url or default_open_url
        #: The https page Renew opens; without one an expired license offers Use another license alone.
        self.renew_url = valid_link(renew_url)
        self._clipboard = clipboard or _Clipboard()
        self._device_name = device_name
        self._now = now
        self._given = dict(capabilities or {})
        self._free_tier = bool(offers_free_tier)
        self.caps = self._capabilities(self._given, self._free_tier)
        self.route = ""
        self.status = "needs-activation"
        self.key_text = ""
        self.key_submitted = False
        self.activation: Optional[Dict[str, Any]] = None
        self.pending: Optional[str] = None
        self.manage_opened = False
        #: Called with the sign-in result once the person is signed in (the gate shows its toast).
        self.on_signed_in: Optional[Callable[[Any], None]] = None
        self.session: Optional[_Session] = None
        self.error_code: Optional[str] = None
        self._generation = 0
        self._closed = False
        #: What is drawn now: ``(component, state)``, for the typing shortcut in :meth:`edited`.
        self.shown: Tuple[str, str] = ("", "")
        self._ticker = qt.QtCore.QTimer(kit.bridge)
        self._ticker.setInterval(_TICK_MS)
        self._ticker.timeout.connect(self._tick)
        # Back from Replace a device in the browser: try the key once more (DL6).
        app = qt.QtGui.QGuiApplication.instance()
        self._app = app
        if app is not None:
            app.applicationStateChanged.connect(self._app_state)

    # ── what the client offers ──────────────────────────────────────────────────────────────
    def _enabled(self) -> Optional[List[str]]:
        """The services the product runs, from the client's own capability map; ``None`` when the
        client does not say (every service is then taken as on)."""
        core = getattr(self.client, "core", None)
        enabled = getattr(core, "enabled", None)
        if callable(enabled):
            try:
                return [slug for slug, _requires in SERVICES if enabled(slug)]
            except Exception:
                return None
        return None

    def _capabilities(self, given: Optional[Mapping[str, bool]], offers_free_tier: bool) -> Dict[str, bool]:
        enabled = self._enabled()
        identity_on = (enabled is None or "identity" in enabled) and hasattr(self.client, "identity")
        license_on = enabled is None or "license" in enabled
        caps = {
            "signIn": identity_on,
            "keyEntry": license_on,
            "deviceCode": identity_on,
            "offlineActivation": False,
            "trial": False,
            "restore": False,
            "purchase": False,
            "enroll": bool(offers_free_tier) and hasattr(getattr(self.client, "license", None), "enroll"),
        }
        for key, value in (given or {}).items():
            if key in caps:
                caps[key] = value is True
        return caps

    def _services(self) -> Optional[List[str]]:
        enabled = self._enabled()
        if enabled is not None:
            return enabled
        # a client that does not say: everything but what it plainly lacks
        return [slug for slug, _r in SERVICES if slug != "identity" or hasattr(self.client, "identity")]

    @property
    def can_sign_in(self) -> bool:
        return bool(self.caps["signIn"])

    @property
    def can_key(self) -> bool:
        return bool(self.caps["keyEntry"])

    @property
    def has_welcome(self) -> bool:
        """Whether the person has a choice to come back to."""
        return self.can_sign_in and self.can_key

    # ── drawing ─────────────────────────────────────────────────────────────────────────────
    def _input(self, **extra: Any) -> Dict[str, Any]:
        ident: ResolvedIdentity = self.kit.bridge.identity
        data: Dict[str, Any] = {
            "capabilities": dict(self.caps),
            "services": self._services(),
            "presentation": {"name": ident.name, "developerName": ident.developer},
        }
        if ident.device_code_url:
            data["integrator"] = {"deviceCodeUrl": ident.device_code_url}
        if self.platform is not None:
            data["platform"] = dict(self.platform)
        data.update(extra)
        return {k: v for k, v in data.items() if v is not None}

    def start(self, status: str) -> None:
        """The gate shows this status: pick the first screen for it. The person keeps their place while
        the status stays the same (a Try again that finds nothing new does not close the key form)."""
        if status != self.status or not self.route:
            self.status = status
            self._reset_screen()
            self.caps = self._capabilities(self._given, self._free_tier)  # discovery may have changed them
            self.route = "status" if status in _BLOCKED else self._first_route()

    def reset(self) -> None:
        """The license is usable: the next time the gate shows, it starts over."""
        self._reset_screen()
        self.status, self.route, self.key_text = "", "", ""

    @property
    def available(self) -> bool:
        """Whether there is any way to get a license from here (sign-in, or a key)."""
        return self.can_sign_in or self.can_key

    def _first_route(self) -> str:
        if self.can_sign_in and self.can_key:
            return "welcome"
        if self.can_sign_in:
            return "welcome"  # Sign in, alone
        return "activate"

    def _reset_screen(self) -> None:
        self._stop_session()
        self.activation = None
        self.pending = None
        self.manage_opened = False
        self.error_code = None
        self.key_submitted = False

    def render(self) -> Tuple[View, Any]:
        """The screen for the current route, as ``(view, data)`` for ``KitView.set_view``."""
        route = self.route
        if route == "status":
            view = ui_gate.status_screen_view(context_of(self._input(gate={"status": self.status})))
            return self._show(view if self.renew_url else without_renew(view), None)
        if route == "activate":
            return self._render_activate()
        if route == "signin":
            return self._render_signin()
        if route == "limit":
            return self._render_limit()
        view = ui_activate.welcome_view(context_of(self._input(**({"pending": "signin"} if self.pending == "signin" else {}))))
        return self._show(view, None)

    def _show(self, view: View, data: Any) -> Tuple[View, Any]:
        self.shown = (view.component, view.state)
        return view, data

    # activate
    def _render_activate(self) -> Tuple[View, Any]:
        field = {"text": self.key_text, "submitted": self.key_submitted}
        extra: Dict[str, Any] = {"keyField": field}
        if self.pending in ("activate", "enroll"):
            extra["pending"] = "activate"
        elif self.activation is not None:
            extra["activation"] = self.activation
        view = ui_activate.activate_view(context_of(self._input(**extra)))
        # Back to the chooser, when there is one to go back to (the key-only product has none).
        if self.has_welcome and view.state not in ("busy", "done"):
            view = with_copy(view, "common.cancel")
        return self._show(view, {"keyField": field})

    # sign-in
    def _device_code(self, session: _Session) -> Dict[str, Any]:
        out: Dict[str, Any] = {"phase": session.phase}
        prompt = session.prompt
        if prompt is not None:
            out["userCode"] = prompt.userCode
            out["verificationUri"] = prompt.verificationUri
            out["expiresIn"] = prompt.expiresIn
            out["secondsLeft"] = max(0, int(prompt.expiresAt - self._now()))
        if session.copied:
            out["copied"] = True
        return out

    def _render_signin(self) -> Tuple[View, Any]:
        s = self.session
        sign: Dict[str, Any] = {"presentation": "inline", "replace": "browser", "channel": "browser"}
        if s is None:  # step 1: the methods
            extra = {"error": {"code": self.error_code}} if self.error_code else {}
            return self._show(ui_signin.sign_in_view(context_of(self._input(signIn=sign, **extra))), None)
        add: List[str] = [] if s.phase == "ok" else ["common.cancel"]  # Cancel returns to the chooser
        data: Any = None
        if s.code_mode or s.phase in ("denied", "failed"):
            sign["channel"] = "device-code"
            data = {"deviceCode": self._device_code(s)}
            view = ui_signin.sign_in_handoff_view(context_of(self._input(signIn=sign, **data)))
        elif s.error:
            view = ui_signin.sign_in_view(context_of(self._input(signIn=sign, error={"code": s.error})))
        elif s.phase == "starting":
            view = ui_signin.sign_in_handoff_view(context_of(self._input(signIn=sign)))
        elif s.phase == "waiting":
            sign["outcome"] = "pending"
            if s.browser_opened is False:  # the opener failed: the screen stays, with Copy link (DL14)
                sign["browserOpened"] = False
                if s.copied:
                    sign["event"] = "copy-link"
                view = ui_signin.sign_in_handoff_view(context_of(self._input(signIn=sign)))
                if view.state == "no-browser" and self.caps["deviceCode"]:
                    add.append("signin.handoff.useCode")
            else:
                view = ui_signin.sign_in_view(context_of(self._input(signIn=sign)))
        elif s.phase == "ok":
            sign["redeeming"] = True
            view = ui_signin.sign_in_view(context_of(self._input(signIn=sign)))
        else:
            sign["outcome"] = "expired"
            view = ui_signin.sign_in_view(context_of(self._input(signIn=sign)))
        return self._show(with_copy(view, *add) if add else view, data)

    # device limit
    def _render_limit(self) -> Tuple[View, Any]:
        a = self.activation or {}
        ctx = context_of(self._input(activation=a))
        if a.get("manageUrl") and ui_devices.device_limit_view(ctx).state == "browser-mode":
            view = ui_devices.device_limit_view(ctx)
            add = ["common.back"]
            primary = None
            if self.manage_opened:
                # Back from the browser: try the key again (DL6), and it is the filled control now.
                add.append("common.tryAgain")
                primary = "common.tryAgain"
            return self._show(with_copy(view, *add, primary=primary), None)
        view = ui_activate.activate_view(context_of(self._input(activation=a, keyField={"text": self.key_text})))
        return self._show(with_copy(view, "common.tryAgain", "common.back", primary="common.tryAgain"), None)

    # ── controls ────────────────────────────────────────────────────────────────────────────
    def handle(self, key: str, action: str) -> bool:
        """A control of the kit was pressed: ``True`` when the flow ran it, ``False`` when it is the
        gate's (Try again and Reconnect re-read the client)."""
        handler = {
            "welcome.signIn": self.sign_in,
            "welcome.useKey": self.use_key,
            "welcome.continueFree": self.enroll,
            "status.useAnotherLicense": self.use_key,
            "signin.key.differentKey": self.use_key,
            "signin.choice.keyInstead": self.use_key,
            "signin.desktop.continue": self.begin_sign_in,
            "signin.provider.continue": self.begin_sign_in,
            "signin.handoff.again": self.open_browser,
            "signin.handoff.openBrowser": self.open_browser,
            "signin.handoff.useCode": self.use_code,
            "signin.link.deviceCode": self.use_code,
            "signin.handoff.copyLink": self.copy_link,
            "a11y.copyCode": self.copy_code,
            "a11y.copyAddress": self.copy_link,
            "signin.again": self.begin_sign_in,
            "signInHandoff.newCode": self.new_code,
            "activate.submit": self.submit_key,
            "common.paste": self.paste,
            "common.cancel": self.back,
            "common.back": self.back,
            "deviceLimit.openBrowser": self.open_manage,
            "status.renew": self.open_renew,
        }.get(key)
        if key == "common.tryAgain" and self.route == "limit":
            self.submit_key()
            return True
        if handler is None:
            if self.route == "status" and key.startswith("status."):
                self._on_status()  # Renew, Update, Switch channel: the fix is outside the app; re-read when back
                return True
            return False
        handler()
        return True

    def edited(self, key: str, text: str) -> None:
        """The key field changed. The screen is drawn again only when its state moves (typing, a key
        that is whole, a refusal cleared), never per keystroke: a field that is rebuilt under the
        cursor loses its place."""
        if key != "part.keyField.label" or self.route != "activate":
            return
        before = self.shown
        cleared = self.activation is not None or self.key_submitted
        self.key_text = text
        self.activation, self.key_submitted = None, False
        view, data = self._render_activate()
        if cleared or (view.component, view.state) != before:
            self._draw(view, data)

    def _draw(self, view: View, data: Any) -> None:
        self.kit.set_view(view, data)

    def redraw(self) -> None:
        view, data = self.render()
        self._draw(view, data)

    def back(self) -> None:
        """Cancel or Back. From the device limit it is the key form again, with the key still in it;
        from the form or from sign-in it is the chooser (the blocked screen, when that is where the
        person came from)."""
        if self.route == "limit":
            self.activation, self.manage_opened = None, False
            self.route = "activate"
        else:
            self._reset_screen()
            self.route = "status" if self.status in _BLOCKED else self._first_route()
        self.redraw()

    def use_key(self) -> None:
        self._stop_session()
        self.route = "activate"
        self.activation = None
        self.key_submitted = False
        self.redraw()

    # key entry
    def paste(self) -> None:
        text = "".join(str(self._clipboard.text() or "").split())
        if not text:
            return
        self.key_text = text
        self.activation, self.key_submitted = None, False
        self.redraw()

    def submit_key(self) -> None:
        if self.pending:
            return
        self.route = "activate"
        verdict = parse_key(self.key_text, submitted=True)
        if verdict.kind != "parsed":
            # Caught here: an empty, cut-short or malformed key never costs a request.
            self.key_submitted, self.activation = True, None
            self.redraw()
            return
        self.key_submitted, self.activation, self.manage_opened = False, None, False
        self.pending = "activate"
        key = self.key_text.strip()
        self.redraw()
        self._run(lambda: self.client.license.activate_with_key(key), self._activated)

    def enroll(self) -> None:
        if self.pending:
            return
        self.route, self.pending, self.activation = "activate", "enroll", None
        self.redraw()
        self._run(self.client.license.enroll, self._activated)

    def _activated(self, result: Any, error: Optional[BaseException]) -> None:
        self.pending = None
        if error is not None:
            code = getattr(error, "code", "network-error")
            self.activation = {"result": "error", "code": str(code)}
            self.redraw()
            return
        kind = str(getattr(result, "kind", "error"))
        if kind == "ok":
            self.key_text = ""
            self._on_status()
            return
        self.activation = {
            "result": kind,
            "code": getattr(result, "code", None),
            "deviceCount": getattr(result, "deviceCount", None),
            "limit": getattr(result, "limit", None),
            "manageUrl": getattr(result, "manage_url", None),
        }
        self.route = "limit" if kind == "device-limit" else "activate"
        self.redraw()

    def open_manage(self) -> None:
        url = (self.activation or {}).get("manageUrl")
        if url and self._open_url(url) is not False:
            self.manage_opened = True
        self.redraw()

    def open_renew(self) -> None:
        """Renew: open the host's renewal page, then re-read the license when the person is back."""
        if self.renew_url:
            self._open_url(self.renew_url)
            self._on_status()

    # sign-in
    def sign_in(self) -> None:
        """Sign in: the methods step first (step 1 of the form); a TV or a console has no choice to
        make and opens on the code."""
        if platform_class(self.platform) in ("tv", "console"):
            self.begin_sign_in()
            return
        self._stop_session()
        self.route, self.error_code = "signin", None
        self.redraw()

    def begin_sign_in(self) -> None:
        """Step 2: ask for a code, open the browser and wait. A TV or a console has no browser to
        open and goes straight to the code (SIGN-IN.md §4.3)."""
        self._start_session(code_mode=platform_class(self.platform) in ("tv", "console"))

    def use_code(self) -> None:
        self._start_session(code_mode=True)

    def new_code(self) -> None:
        old = self.session
        self._start_session(code_mode=bool(old and old.code_mode))

    def _start_session(self, code_mode: bool) -> None:
        self._stop_session()
        self.route = "signin"
        self.error_code = None
        session = self.session = _Session(code_mode)
        self.redraw()
        name = self._device_name
        self._run(
            lambda: self.client.identity.begin_sign_in(name, confirm_identity=False),
            lambda prompt, error: self._prompted(session, prompt, error),
        )

    def _prompted(self, session: _Session, prompt: Any, error: Optional[BaseException]) -> None:
        if session is not self.session:
            return
        if error is not None:
            code = getattr(error, "code", "sign-in-unavailable")
            session.error = "sign-in-unavailable" if code == "sign-in-unavailable" else str(code)
            self.redraw()
            return
        session.prompt = prompt
        session.phase = "waiting"
        if session.code_mode:
            self._ticker.start()
        else:
            session.browser_opened = bool(self._open_url(prompt.verificationUriComplete))
        self.redraw()
        self._run(
            lambda: self.client.identity.wait_for_sign_in(prompt, cancel=session.cancel),
            lambda result, err: self._signed_in(session, result, err),
        )

    def _signed_in(self, session: _Session, result: Any, error: Optional[BaseException]) -> None:
        if session is not self.session:
            return
        if error is not None:
            if getattr(error, "code", None) == "cancelled":
                return
            session.phase = "failed"
        else:
            status = getattr(result, "status", "error")
            code = getattr(result, "code", None)
            session.phase = (
                "ok" if status == "ready" else "expired" if status == "expired" else "denied" if code == "sign-in-denied" else "failed"
            )
        self._ticker.stop()
        if session.phase == "ok":
            self.session = None
            self.route = "welcome" if self.has_welcome else "activate"
            self.redraw()
            self._on_status()
            if self.on_signed_in is not None:
                self.on_signed_in(result)
            return
        self.redraw()

    def open_browser(self) -> None:
        """Open browser again: the request in flight is reused, never a second one."""
        session = self.session
        if session is None or session.prompt is None:
            return
        url = session.prompt.verificationUriComplete
        view = getattr(self.kit.bridge, "_view", None)
        link = view.decisions.link if view is not None else None
        if session.code_mode and link is not None and link.url:
            url = link.url  # the page the code view names, the QR and the address all carry
        session.browser_opened = bool(self._open_url(url))
        self.redraw()

    def copy_code(self) -> None:
        session = self.session
        if session is None or session.prompt is None:
            return
        self._clipboard.set_text(session.prompt.userCode)
        session.copied = True
        self.redraw()
        qt.QtCore.QTimer.singleShot(2000, lambda: self._uncopy(session))

    def copy_link(self) -> None:
        session = self.session
        if session is None or session.prompt is None:
            return
        self._clipboard.set_text(session.prompt.verificationUriComplete)
        session.copied = True
        self.redraw()
        qt.QtCore.QTimer.singleShot(2000, lambda: self._uncopy(session))

    def _uncopy(self, session: _Session) -> None:
        if self._closed or session is not self.session or not session.copied:
            return
        session.copied = False
        self.redraw()

    def _tick(self) -> None:
        """Once a second: the code's countdown, and its end. A lapsed code is never polled again."""
        session = self.session
        if session is None or session.prompt is None or session.phase != "waiting":
            self._ticker.stop()
            return
        if self._now() >= session.prompt.expiresAt:
            session.cancel.set()
            session.phase = "expired"
            self._ticker.stop()
        self.redraw()

    def _stop_session(self) -> None:
        session, self.session = self.session, None
        self._generation += 1
        self._ticker.stop()
        if session is not None:
            session.cancel.set()

    # ── threads ─────────────────────────────────────────────────────────────────────────────
    def _run(self, fn: Callable[[], Any], done: Callable[[Any, Optional[BaseException]], None]) -> None:
        """Run ``fn`` (a client call that waits) off the GUI thread and hand its result to ``done``
        on it, unless the person has left the screen since."""
        generation = self._generation

        def deliver(result: Any, error: Optional[BaseException]) -> None:
            if self._closed or generation != self._generation:
                return
            done(result, error)

        def work() -> None:
            try:
                result, error = fn(), None
            except BaseException as e:  # noqa: BLE001 - every failure is a result for the GUI thread
                result, error = None, e
            try:
                self.kit.bridge.post(lambda: deliver(result, error))
            except RuntimeError:
                pass  # the kit closed while the call was out

        threading.Thread(target=work, daemon=True, name="polaris-key-gate").start()

    def _app_state(self, state: Any) -> None:
        if state == qt.QtCore.Qt.ApplicationState.ApplicationActive and self.manage_opened and self.route == "limit":
            self.manage_opened = False
            self.submit_key()

    def close(self) -> None:
        self._closed = True
        self._stop_session()
        if self._app is not None:
            try:
                self._app.applicationStateChanged.disconnect(self._app_state)
            except (RuntimeError, TypeError):
                pass
