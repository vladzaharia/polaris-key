"""The gate's screens while the license is not usable: Welcome, key entry, sign-in, device limit and
the blocked-status screens (UI-KITS §4.2, SIGN-IN.md §3.17).

:class:`GateFlow` is the state machine the other kits' gates run (``PolarisKeyGateModel`` in
SwiftUI, ``useGate`` in React), over the Python client: which screen the person is on, what they
typed, and the client calls that move them on. It draws nothing itself: every screen is a
``(view, data)`` from ``polaris_key.ui.core`` (the same functions the ui-matrix pins) that
:class:`~.kit.KitView` lays out. The client calls that wait (``activate_with_key``,
``sign_in.start``, ``wait``) run on a worker thread and hand their result back to the GUI
thread with ``bridge.post``; a result from a screen the person has since left is dropped.

The routes::

    welcome ── Sign in ──────────► signin (methods → browser wait | code → finishing)
       │  └── Use a license key ─► activate ── ok ──────────► the gate re-reads the client
       │                              └── device limit ─────► limit (Replace a device in the browser)
    status (revoked, expired, …) ── Sign in | Use a different key ─► signin | activate
"""

from __future__ import annotations

import dataclasses
import os
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from ...core.peer_display import clean_label
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
#: Nearby sign-in (I-47.14; plans/I-47-slices.md D-5): an approver that answers within 2 s keeps it going, a
#: lone one is chosen after 3 s, else nearby is cancelled and the regular sign-in is shown. How often the
#: approvers are looked at, and the file in the state directory that says a browse worked here (macOS: the
#: Local Network prompt has been seen).
NEARBY_LISTEN_S = 2.0
NEARBY_LONE_S = 3.0
_NEARBY_TICK_MS = 200
_NEARBY_BROWSED = "nearby-browsed"


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
        #: ``browser`` (device code or browser) or ``nearby`` (I-47.14). A nearby attempt's phase is
        #: ``prompt`` (macOS names the Local Network prompt first), ``looking``, ``pick`` (several
        #: approvers answered), ``waiting`` (the code is shown), ``done`` (the poll signed in and the
        #: person confirms the account), ``denied``, ``failed`` or ``expired``.
        self.kind = "browser"
        self.nearby: Any = None
        self.started = 0.0
        self.lone_since: Optional[float] = None
        self.choosing = False
        self.code: Optional[str] = None
        self.labels: Tuple[str, ...] = ()
        #: The cleaned name of the approver that was chosen (the code screen names it).
        self.device: Optional[str] = None
        self.result: Any = None


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
        clock: Callable[[], float] = time.monotonic,
        os_name: Optional[str] = None,
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
        #: The clock the nearby windows count on, and the operating system (macOS names the Local Network
        #: prompt before the first browse); tests set both.
        self._clock = clock
        self._os = os_name or sys.platform
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
        self._nearby_timer = qt.QtCore.QTimer(kit.bridge)
        self._nearby_timer.setInterval(_NEARBY_TICK_MS)
        self._nearby_timer.timeout.connect(self._nearby_tick)
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
            out["userCode"] = prompt.user_code
            out["verificationUri"] = prompt.verification_uri
            out["expiresIn"] = prompt.expires_in
            out["secondsLeft"] = max(0, int(prompt.expires_at - self._now()))
        if session.copied:
            out["copied"] = True
        return out

    def _render_signin(self) -> Tuple[View, Any]:
        s = self.session
        sign: Dict[str, Any] = {"presentation": "inline", "replace": "browser", "channel": "browser"}
        if s is not None and s.kind == "nearby" and s.phase not in ("denied", "failed", "expired"):
            return self._render_nearby(s, sign)
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

    def _render_nearby(self, s: _Session, sign: Dict[str, Any]) -> Tuple[View, Any]:
        """Nearby sign-in's screens: the prompt (macOS), the first seconds, the approvers to pick from, the
        code to tap, and the account to confirm."""
        add: List[str] = ["common.cancel"]  # Cancel returns to the chooser
        if s.phase == "prompt":
            view = ui_signin.sign_in_view(context_of(self._input(signIn=sign, autoSignIn={"step": "nearby-prompt"})))
            return self._show(view, None)
        if s.phase == "done":
            who = getattr(s.result, "identity", None)
            email = getattr(who, "email", None) or getattr(who, "name", None) or ""
            view = ui_signin.sign_in_view(context_of(self._input(signIn=sign, autoSignIn={"step": "nearby-done", "email": email})))
            return self._show(view, None)
        if s.phase in ("looking",):
            view = ui_signin.sign_in_handoff_view(context_of(self._input(signIn=sign)))
            return self._show(with_copy(view, *add), None)
        auto: Dict[str, Any] = {"step": "nearby-wait"}
        if s.code:
            auto["code"] = s.code
            if s.device:
                auto["device"] = s.device
        else:
            auto["approvers"] = list(s.labels)
        view = ui_signin.sign_in_view(context_of(self._input(signIn=sign, autoSignIn=auto)))
        return self._show(with_copy(view, *add), None)

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
            "common.continue": self.nearby_continue,
            "common.notNow": self.nearby_not_now,
            "signin.nearby.code": self.use_code,
            "signin.nearby.notYou": self.nearby_not_you,
            "activate.submit": self.submit_key,
            "common.paste": self.paste,
            "common.cancel": self.back,
            "common.back": self.back,
            "deviceLimit.openBrowser": self.open_manage,
            "status.renew": self.open_renew,
        }.get(key)
        if key.startswith("nearby.pick.") and key[len("nearby.pick."):].isdigit():
            self.nearby_pick(int(key[len("nearby.pick."):]))
            return True
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
        if self._offers_nearby():
            # Nearby first (D-5, D-10): the person's other devices, then the regular sign-in. Whether
            # this product and runtime take part is asked off the GUI thread; the button waits meanwhile.
            self.pending = "signin"
            self.redraw()
            self._run(self._nearby_probe, self._nearby_probed)
            return
        self.route, self.error_code = "signin", None
        self.redraw()

    # nearby sign-in (I-47.14)
    def _offers_nearby(self) -> bool:
        return self.can_sign_in and hasattr(getattr(self.client, "identity", None), "nearby")

    def _nearby_probe(self) -> bool:
        try:
            return bool(self.client.identity.nearby.available(role="requester"))
        except Exception:
            return False

    def _state_dir(self) -> Optional[str]:
        try:
            return str(self.client.core.dirs.state)
        except Exception:
            return None

    def _browsed(self) -> bool:
        state = self._state_dir()
        return state is not None and os.path.exists(os.path.join(state, _NEARBY_BROWSED))

    def _mark_browsed(self) -> None:
        state = self._state_dir()
        if state is None:
            return
        try:
            os.makedirs(state, exist_ok=True)
            with open(os.path.join(state, _NEARBY_BROWSED), "w", encoding="utf-8") as f:
                f.write("1\n")
        except OSError:
            pass  # not remembered: the next sign-in explains the prompt again

    def _nearby_probed(self, ok: Any, error: Optional[BaseException]) -> None:
        self.pending = None
        if error is not None or not ok:
            self.route, self.error_code = "signin", None  # not on offer here: the regular sign-in
            self.redraw()
            return
        if self._os == "darwin" and not self._browsed():
            # macOS asks for the Local Network on the first browse: say why before it does (D-A14).
            session = self.session = _Session(False)
            session.kind, session.phase = "nearby", "prompt"
            self.route, self.error_code = "signin", None
            self.redraw()
            return
        self._start_nearby()

    def _start_nearby(self) -> None:
        self._stop_session()
        self.route, self.error_code = "signin", None
        session = self.session = _Session(False)
        session.kind, session.phase, session.started = "nearby", "looking", self._clock()
        self.redraw()
        name = self._device_name
        self._run(
            lambda: self.client.identity.sign_in.start(channel="nearby", device_name=name),
            lambda nearby, error: self._nearby_started(session, nearby, error),
        )

    def _nearby_started(self, session: _Session, nearby: Any, error: Optional[BaseException]) -> None:
        if session is not self.session:
            return
        if error is not None:
            self._nearby_handoff()  # the product serves none or this runtime cannot take part
            return
        session.nearby = nearby
        self._mark_browsed()
        self._nearby_timer.start()
        self._run(
            lambda: nearby.wait(cancel_token=session.cancel),
            lambda result, err: self._nearby_signed_in(session, result, err),
        )

    def _approvers(self, session: _Session) -> List[Any]:
        try:
            return list(session.nearby.approvers)
        except Exception:
            return []

    def _nearby_tick(self) -> None:
        """Every 200 ms: what the approvers do. None within 2 s hands over to the regular sign-in; one is
        chosen after 3 s; several are listed to pick from."""
        session = self.session
        if session is not None and session.kind == "nearby" and session.phase == "done":
            # The confirm screen leaves when the session ends (a deadline, a decline from elsewhere).
            if session.nearby is None or getattr(session.nearby, "ended", False):
                self._nearby_timer.stop()
                session.phase = "expired"
                self.redraw()
            return
        if session is None or session.kind != "nearby" or session.nearby is None or session.phase not in ("looking", "pick"):
            self._nearby_timer.stop()
            return
        found = self._approvers(session)
        now = self._clock()
        if not found and now - session.started >= NEARBY_LISTEN_S:
            self._nearby_handoff()
            return
        if len(found) == 1:
            session.lone_since = session.lone_since if session.lone_since is not None else now
            if now - session.lone_since >= NEARBY_LONE_S:
                self._nearby_choose(session, found[0])
        else:
            session.lone_since = None
        labels = tuple(clean_label(str(getattr(a, "label", None) or getattr(a, "platform", None) or "")) for a in found)
        if labels != session.labels:
            session.labels = labels
            session.phase = "pick" if labels else "looking"
            self.redraw()

    def nearby_pick(self, number: int) -> None:
        """The person tapped the numbered approver (the list is 1-based)."""
        session = self.session
        if session is None or session.kind != "nearby" or session.nearby is None:
            return
        found = self._approvers(session)
        if 1 <= number <= len(found):
            self._nearby_choose(session, found[number - 1])

    def _nearby_choose(self, session: _Session, approver: Any) -> None:
        if session.choosing or session.code is not None:
            return
        session.choosing = True
        session.device = clean_label(str(getattr(approver, "label", None) or getattr(approver, "platform", None) or "")) or None

        def done(code: Any, error: Optional[BaseException]) -> None:
            if session is not self.session:
                return
            session.choosing = False
            if error is not None:
                session.device = None
                return  # the device left: stay on the list
            session.code, session.phase = str(code), "waiting"
            self._nearby_timer.stop()
            self.redraw()

        self._run(lambda: session.nearby.choose(approver.id), done)

    def _nearby_handoff(self) -> None:
        """Nobody nearby answered (or nearby cannot start): cancel it and show the regular sign-in."""
        self._stop_session()
        self.route, self.error_code = "signin", None
        self.redraw()

    def _nearby_signed_in(self, session: _Session, result: Any, error: Optional[BaseException]) -> None:
        if session is not self.session:
            return
        self._nearby_timer.stop()
        if error is None and getattr(result, "kind", None) == "signed_in":
            self._nearby_timer.start()  # watch for the end of the session while the account is shown
        if error is not None:
            session.phase = "denied" if getattr(error, "code", None) == "sign-in-denied" else "failed"
        else:
            kind = getattr(result, "kind", "error")
            if kind == "cancelled":
                return
            if kind == "signed_in":
                # The account is shown and the person says it is theirs before anything from the other
                # device is acted on (V5 §15.6.1 rule 12).
                session.phase, session.result = "done", result
            else:
                session.phase = "expired" if kind == "expired" else "failed"
        self.redraw()

    def nearby_continue(self) -> None:
        """Continue: past the Local Network explanation, or "this is my account"."""
        session = self.session
        if session is None or session.kind != "nearby":
            return
        if session.phase == "prompt":
            self._start_nearby()
        elif session.phase == "done":
            nearby, result = session.nearby, session.result
            self._run(
                lambda: nearby.confirm_account() if nearby is not None else None,
                lambda _r, e: self._nearby_confirmed(session, result, e),
            )

    def _nearby_confirmed(self, session: _Session, result: Any, error: Optional[BaseException] = None) -> None:
        if session is not self.session:
            return
        if error is not None:
            # The sign-in ended before the confirmation took (the deadline): never "signed in", and the
            # host's callback is not called.
            self._nearby_timer.stop()
            session.phase = "expired"
            try:
                session.nearby.close()
            except Exception:
                pass
            self.redraw()
            return
        self._stop_session()
        try:
            session.nearby.close()  # the LAN side stayed open for the wrap until the account was confirmed
        except Exception:
            pass
        self.route = "welcome" if self.has_welcome else "activate"
        self.redraw()
        self._on_status()
        if self.on_signed_in is not None:
            self.on_signed_in(result)

    def nearby_not_now(self) -> None:
        """Not now: the regular sign-in, and nothing is browsed."""
        session = self.session
        if session is not None and session.kind == "nearby" and session.phase == "prompt":
            self._nearby_handoff()

    def nearby_not_you(self) -> None:
        """Not you?: the held records are dropped and the device signs out (V5 §15.6.1 rule 12)."""
        session = self.session
        if session is None or session.kind != "nearby" or session.phase != "done":
            return
        nearby = session.nearby

        def after(_r: Any, _e: Optional[BaseException]) -> None:
            if session is not self.session:
                return
            self._stop_session()
            self.route = "status" if self.status in _BLOCKED else self._first_route()
            self.redraw()

        self._run(lambda: nearby.decline_account() if nearby is not None else None, after)

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
            lambda: self.client.identity.sign_in.start(device_name=name),
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
            session.browser_opened = bool(self._open_url(prompt.verification_uri_complete))
        self.redraw()
        self._run(
            lambda: prompt.wait(cancel_token=session.cancel),
            lambda result, err: self._signed_in(session, result, err),
        )

    def _signed_in(self, session: _Session, result: Any, error: Optional[BaseException]) -> None:
        if session is not self.session:
            return
        if error is not None:
            session.phase = "denied" if getattr(error, "code", None) == "sign-in-denied" else "failed"
        else:
            kind = getattr(result, "kind", "error")
            if kind == "cancelled":
                return
            session.phase = "ok" if kind == "signed_in" else "expired" if kind == "expired" else "failed"
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
        url = session.prompt.verification_uri_complete
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
        self._clipboard.set_text(session.prompt.user_code)
        session.copied = True
        self.redraw()
        qt.QtCore.QTimer.singleShot(2000, lambda: self._uncopy(session))

    def copy_link(self) -> None:
        session = self.session
        if session is None or session.prompt is None:
            return
        self._clipboard.set_text(session.prompt.verification_uri_complete)
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
        if self._now() >= session.prompt.expires_at:
            session.cancel.set()
            session.phase = "expired"
            self._ticker.stop()
        self.redraw()

    @staticmethod
    def _cancel_quietly(nearby: Any) -> None:
        try:
            nearby.cancel()
        except Exception:
            pass

    def _stop_session(self) -> None:
        session, self.session = self.session, None
        self._generation += 1
        self._ticker.stop()
        self._nearby_timer.stop()
        if session is not None:
            session.cancel.set()
            # A nearby attempt that is left closes its LAN side (a request nobody collects just lapses).
            if session.kind == "nearby" and session.nearby is not None:
                # Leaving the confirm screen by any route is a cancel (after a confirmation it does
                # nothing). The sign-out it may make is a network call, so it is off the GUI thread there.
                if session.phase == "done":
                    threading.Thread(target=self._cancel_quietly, args=(session.nearby,), daemon=True).start()
                else:
                    self._cancel_quietly(session.nearby)

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
