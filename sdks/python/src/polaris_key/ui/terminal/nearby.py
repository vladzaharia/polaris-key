"""Nearby sign-in in the terminal kit (I-47.13; plans/I-47-slices.md D-5, D-6, D-10; WIRE-CONTRACT-V5
§12.11.5 and §15.6.1). Mirrors the Node kit's ``cli/nearby.ts`` (I-47.12). Two flows:

``login(client, t, verb)``
    ``login``, the new device (D). On an interactive terminal it looks for the person's other devices
    first. An approver that answers within 2 s is listed (a lone one is chosen after 3 s, several are
    picked by number), its code is shown as ``482 913`` with the a11y line, and the person taps it on the
    other device. ``c`` uses a code instead. Nothing answering in 2 s cancels nearby and the regular
    sign-in runs. After the poll signed in, the account is shown: Enter confirms it, ``n`` (or Esc) signs
    out again.

``approve(client, t)``
    ``devices approve``, the signed-in device (M). It listens for up to 300 s, shows the three codes as
    choices 1-3 with ``d`` = Deny, then the outcome and the license choice.

Neither starts under ``--json`` or without a terminal (D-10). Everything from the other device is display
data from an unverified peer: it goes through :func:`clean` here as well as where a line is written (SR-47:
terminal injection), and a secret (the handle, the proof, the token) is never drawn.
"""

from __future__ import annotations

import os
import queue
import sys
import threading
import time
from dataclasses import dataclass, replace
from typing import Any, List, Optional, Sequence, Tuple, Union

from ...constants_generated import ErrorCode
from ...core.errors import PolarisError
from ..core.models import SignInModel
from . import screens
from .device import run_in_thread
from .exit import EXIT
from .flows import Outcome, Terminal, _cancelled, _code_of, _error_outcome
from .parts import Kit
from .text import DROP, Line, Span, clean

__all__ = [
    "APPROVE_S",
    "Fall",
    "LISTEN_S",
    "LONE_S",
    "NearbyApprovalView",
    "NearbyLoginView",
    "approve",
    "login",
    "nearby_approval",
    "nearby_login",
]

#: An approver that answers within this long keeps the nearby sign-in going (D-5), seconds.
LISTEN_S = 2.0
#: A lone approver is chosen after this long (D-5).
LONE_S = 3.0
#: ``devices approve`` listens this long for a device to ask (D-6).
APPROVE_S = 300.0
#: The state-directory file that says a browse worked here (macOS: the Local Network prompt was seen).
BROWSED_FILE = "nearby-browsed"

#: Poll step of the key loops, seconds.
_TICK = 0.08


# ── The views (what the screens draw) ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class NearbyLoginView:
    """``login``'s nearby states. ``state``: ``prompt`` (SignIn nearby-prompt), ``looking``, ``pick`` (several
    devices answered) and ``wait`` (nearby-wait: the code to tap), ``done`` (nearby-done: the account), or
    ``signed-out`` ("Not you?" answered)."""

    state: str
    #: The cleaned labels of the approvers, in the order they are numbered.
    approvers: Tuple[str, ...] = ()
    code: Optional[str] = None
    name: Optional[str] = None
    email: Optional[str] = None


@dataclass(frozen=True)
class NearbyApprovalView:
    """``devices approve``'s states (NearbyApproval): ``entry`` (waiting for a device to ask), ``ask`` (the
    three codes), ``working``, ``approved``, ``not-nearby``, ``mismatch``, ``denied``, ``expired``,
    ``device-limit``, ``choose`` (the license), ``account-required``, ``rate-limited``, plus ``unsupported``
    and ``cancelled``."""

    state: str
    #: The other device's cleaned name; ``None``: it did not give one.
    device: Optional[str] = None
    codes: Tuple[str, ...] = ()
    #: ``choose``: the names of the licenses that can be given, and whether a new one can be made.
    choices: Tuple[str, ...] = ()
    create: bool = False


def _name(k: Kit, device: Optional[str], title: bool = False) -> str:
    """The other device's name in a sentence, else "the new device"."""
    clean_name = clean(device).strip() if device else ""
    return clean_name or k.s("part.newDeviceTitle" if title else "part.newDevice")


# ── The screens ────────────────────────────────────────────────────────────────────────────


def _row(k: Kit, n: int, spans: Sequence[Span]) -> List[Line]:
    """A numbered choice: the digit in strong, two cells, then the text."""
    return k.body([Span(str(n), ("strong",), None, "data:count"), Span("  ")] + list(spans))


def nearby_login(k: Kit, v: NearbyLoginView, verb: str = "login", *, frame: int = 0) -> List[Line]:
    """``login``'s nearby screens: the whole screen is one frame, header to key hints."""
    body: List[Line] = []
    end: List[Span] = []
    hints = False
    if v.state == "prompt":
        body += k.step("active", [k.t("signin.nearby.promptTitle", "strong")])
        body += k.body([k.t("signin.nearby.prePrompt", app=k.inline_product)])
        end, hints = k.hint_string("signin.cli.nearbyPromptKeys"), True
    elif v.state == "pick":
        body += k.step("active", [k.t("signin.nearby.title", "strong")])
        for i, label in enumerate(v.approvers[:9], 1):
            body += _row(k, i, [k.d(clean(label), "device")])
        body += screens._gap(k)
        end, hints = k.hint_string("signin.cli.nearbyPickKeys"), True
    elif v.state == "wait":
        code = v.code or ""
        body += k.step("active", [k.t("signin.nearby.title", "strong")])
        body += [replace(ln, keep=True) for ln in k.body([k.t("signin.nearby.body", app=k.inline_product)])]
        body += k.body([k.t("signin.nearby.match")])
        body += screens._code_rows(k, code)
        # The same line a screen reader hears (a11y.nearbyCode).
        body += k.body([k.t("a11y.nearbyCode", "muted", code=code)])
        body += screens._gap(k)
        body += screens._wait_line(k, "signin.approve.waiting", frame)
        end, hints = k.hint_string("signin.cli.nearbyKey"), True
    elif v.state == "done":
        who = (v.email or v.name or "").strip()
        if v.email:
            body += k.step("ok", k.units("signin.nearby.done", "strong", email=clean(v.email)))
        else:
            body += k.step("ok", [k.t("account.holder", name=clean(who) or k.product)])
        end, hints = k.hint_string("signin.cli.nearbyDoneKeys"), True
    elif v.state == "signed-out":
        body += k.step("done", [k.t("cli.logout.done", "strong", product=k.inline_product)])
        end = [k.t("signin.cli.signInAgain", "muted", command=f"{k.prog} {verb}")]
    else:  # looking
        body += k.step("active", [k.t("signin.nearby.title", "strong")])
        body += screens._wait_line(k, "signin.cli.nearbyLooking", frame)
        end, hints = k.hint_string("signin.cli.nearbyKey"), True
    return screens._frame(k, verb, body, end, hints)


def nearby_approval(k: Kit, v: NearbyApprovalView, verb: str = "devices approve", *, frame: int = 0) -> List[Line]:
    """``devices approve``'s screens."""
    body: List[Line] = []
    end: List[Span] = []
    hints = False
    device = _name(k, v.device)
    title_device = _name(k, v.device, title=True)
    if v.state == "entry":
        body += k.step("active", [k.t("signin.nearby.menu", "strong")])
        body += screens._wait_line(k, "signin.cli.approveWaiting", frame)
        end, hints = k.hint_string("signin.cli.approveWaitKeys"), True
    elif v.state in ("ask", "working"):
        body += k.step("active", [k.t("signin.nearby.ask", "strong", device=device)])
        if v.state == "working":
            body += screens._wait_line(k, "common.working", frame)
        else:
            body += k.body([k.t("signin.nearby.askBody")])
            body += k.body([k.t("signin.approve.warning", "muted")])
            body += screens._gap(k)
            for i, code in enumerate(v.codes, 1):
                body += _row(k, i, [k.d(code, "code", nobreak=True)])
            body += screens._gap(k)
            end, hints = k.hint_string("signin.cli.approveKeys"), True
    elif v.state == "choose":
        body += k.step("active", [k.t("signin.nearby.chooseTitle", "strong", device=device)])
        body += k.body([k.t("signin.nearby.chooseLede", product=k.inline_product)])
        for i, name in enumerate(v.choices, 1):
            body += _row(k, i, [k.d(clean(name), "tier")])
        if v.create:
            body += _row(k, len(v.choices) + 1, [k.t("signin.choice.create")])
        body += screens._gap(k)
        end, hints = k.hint_string("signin.cli.approveChooseKeys"), True
    elif v.state == "approved":
        body += k.step("ok", [k.t("signin.nearby.approved", "strong", device=title_device)])
        end = [k.t("common.done", "muted")]
    elif v.state == "mismatch":
        body += k.step("warn", [k.t("signin.nearby.mismatch", "strong", device=device)])
        end = [k.t("cli.nothingChanged", "muted")]
    elif v.state == "denied":
        # The person's own choice, like a cancel (DL7): no mark that reads as a failure.
        end = [k.t("signin.approve.deniedDone", "muted")]
    elif v.state == "not-nearby":
        body += k.step("warn", [k.t("signin.nearby.notNearby", "strong", device=title_device)])
        body += k.body([k.t("signin.nearby.notNearbyBody", device=device)])
    elif v.state == "expired":
        body += k.step("warn", [k.t("core.codes.sign-in-expired.title", "strong")])
        body += k.body([k.t("signin.nearby.expiredBody", device=device)])
    elif v.state == "device-limit":
        body += k.step("warn", [k.t("core.codes.device_limit.title", "strong")])
        body += k.body([k.t("signin.nearby.deviceLimitBody", device=device)])
        body += screens._fixes(k, [("devices list", "cli.verb.devicesList")])
    elif v.state == "rate-limited":
        body += k.step("warn", [k.t("core.codes.rate_limited.title", "strong")])
        body += k.body([k.t("signin.nearby.rateLimitedBody", device=device)])
    elif v.state == "account-required":
        body += k.step("warn", [k.t("core.codes.account_required.title", "strong")])
        body += k.body([k.t("core.codes.account_required.message")])
        body += screens._fixes(k, [("login", "cli.verb.login")])
    elif v.state == "unsupported":
        body += k.step("warn", [k.t("signin.cli.approveUnsupported", "strong")])
        end = [k.t("cli.nothingChanged", "muted")]
    else:  # cancelled, timeout
        end = [k.t("cli.nothingChanged", "muted")]
    return screens._frame(k, verb, body, end, hints)


# ── login ──────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Fall:
    """The nearby path did not sign in: the regular sign-in goes on (``device_code``: ``c`` asked for a code)."""

    device_code: bool = False


def _state_dir(client: Any) -> Optional[str]:
    try:
        return str(client.core.dirs.state)
    except Exception:
        return None


def _browsed(state: Optional[str]) -> bool:
    return state is not None and os.path.exists(os.path.join(state, BROWSED_FILE))


def _mark_browsed(state: Optional[str]) -> None:
    if state is None:
        return
    try:
        os.makedirs(state, exist_ok=True)
        with open(os.path.join(state, BROWSED_FILE), "w", encoding="utf-8") as f:
            f.write("1\n")
    except OSError:
        pass  # not remembered: the next run explains the prompt again


def _ask_local_network(t: Terminal, verb: str) -> str:
    """macOS asks for the Local Network on the first browse: say why before it does (D-A14). ``go``,
    ``later`` (Esc) or ``interrupt`` (Ctrl-C)."""
    k = t.kit
    view = NearbyLoginView("prompt")
    try:
        with t.device.keys() as keys, t.device.live() as live:
            while True:
                live.update(lambda: nearby_login(k, view, verb))
                key = keys.read(None)
                if key == "enter":
                    return "go"
                if key == "esc":
                    return "later"
    except KeyboardInterrupt:
        return "interrupt"


def login(client: Any, t: Terminal, verb: str = "login") -> Union[Outcome, Fall]:
    """The nearby start of ``login`` (see the module docstring). An :class:`Outcome` when the nearby path
    finished the sign-in, :class:`Fall` when the regular sign-in goes on."""
    k, env = t.kit, t.env
    if env.json or not env.interactive or env.headless or env.device_code:
        return Fall()
    nearby = getattr(getattr(client, "identity", None), "nearby", None)
    try:
        available = bool(nearby is not None and nearby.available(role="requester"))
    except Exception:
        available = False
    if not available:
        return Fall()
    state = _state_dir(client)
    if t.platform == "darwin" and not _browsed(state):
        asked = _ask_local_network(t, verb)
        if asked == "later":
            return Fall()
        if asked == "interrupt":
            t.interrupted = True
            return _left(t, verb)
    try:
        session = client.identity.sign_in.start(channel="nearby")
    except PolarisError as e:
        # The product serves no nearby approval, or this runtime cannot take part: the regular sign-in.
        if e.code in (ErrorCode.NEARBY_UNSUPPORTED, ErrorCode.SERVICE_UNAVAILABLE):
            return Fall()
        return _error_outcome(t, _code_of(client, e), verb)
    _mark_browsed(state)

    cancel = threading.Event()
    worker = run_in_thread(lambda: session.wait(cancel_token=cancel))
    ended: Optional[str] = None  # "code" | "cancel" | "handoff"
    frame = 0
    started = t.clock()
    lone_since: Optional[float] = None
    code: Optional[str] = None
    choosing = False

    def approvers() -> List[Any]:
        try:
            return list(session.approvers)
        except Exception:
            return []

    def label(a: Any) -> str:
        return clean(getattr(a, "label", None) or getattr(a, "platform", None) or "").strip() or k.s("part.newDevice")

    def choose(a: Any) -> None:
        nonlocal code, choosing
        if choosing or code is not None:
            return
        choosing = True
        try:
            code = str(session.choose(a.id))
        except Exception:
            choosing = False  # the device left: stay on the list

    def view() -> NearbyLoginView:
        found = approvers()
        if code is not None:
            return NearbyLoginView("wait", code=code)
        if len(found) >= 2:
            return NearbyLoginView("pick", approvers=tuple(label(a) for a in found))
        return NearbyLoginView("looking")

    try:
        with t.device.keys() as keys, t.device.live() as live:
            while worker.is_alive():
                now = t.clock()
                found = approvers()
                if code is None:
                    if not found and now - started >= LISTEN_S:
                        # Nobody nearby answered: leave nearby, the regular sign-in is next.
                        ended = "handoff"
                        break
                    if len(found) == 1:
                        lone_since = lone_since if lone_since is not None else now
                        if now - lone_since >= LONE_S:
                            choose(found[0])
                    else:
                        lone_since = None
                live.update(lambda v=view(), f=frame: nearby_login(k, v, verb, frame=f))
                frame += 1
                key = keys.read(_TICK)
                if key == "esc":
                    ended = "cancel"
                    break
                if key == "c":
                    ended = "code"
                    break
                if key and key.isdigit() and code is None:
                    n = int(key)
                    if 1 <= n <= min(len(found), 9):
                        choose(found[n - 1])
    except KeyboardInterrupt:
        ended = "cancel"
        t.interrupted = True
    if ended is not None:
        cancel.set()
        try:
            session.cancel()
        except Exception:
            pass
        worker.join(5)
        if ended in ("handoff", "code"):
            return Fall(device_code=ended == "code")
        return _left(t, verb)
    worker.join(5)

    model = SignInModel(headless=False)
    if worker.error is not None:
        c = getattr(worker.error, "code", "sign-in-failed")
        c = c if isinstance(c, str) else "sign-in-failed"
        model.errored(c)
        return Outcome(EXIT.failed, screens.sign_in(k, model.view, verb), {"state": "error", "error": model.view.code})
    result = worker.result
    final = model.finished(result)
    if final.state != "done":
        if final.state == "cancelled":
            return _cancelled(t, screens.sign_in(k, final, verb), {"state": "cancelled"})
        return Outcome(EXIT.failed, screens.sign_in(k, final, verb), {"state": final.state, "error": final.code})

    # Signed in by the poll. Until the person says the account is theirs, nothing from the other device
    # is acted on (V5 §15.6.1 rule 12): the account is shown, Enter confirms, n signs out.
    who = getattr(result, "identity", None)
    name, email = getattr(who, "name", None), getattr(who, "email", None)
    if not (name or email):
        try:
            current = client.identity.current()
        except Exception:
            current = None
        name, email = getattr(current, "name", None), getattr(current, "email", None)
    done_view = NearbyLoginView("done", name=name, email=email)
    answer = "decline"
    try:
        with t.device.keys() as keys, t.device.live() as live:
            while True:
                live.update(lambda: nearby_login(k, done_view, verb))
                key = keys.read(None)
                if key == "enter":
                    answer = "confirm"
                    break
                if key in ("n", "esc"):
                    break
    except KeyboardInterrupt:
        t.interrupted = True
    if answer == "confirm":
        try:
            session.confirm_account()
        except Exception:
            pass  # no channel copy: the device is still signed in and the normal unlock works later
        data = {"state": "signedIn", "name": name, "email": email, "attached": None}
        try:
            data["status"] = client.status().status
        except Exception:
            pass
        lines = screens._frame(k, verb, k.step("ok", _done_line(k, name, email)), [k.t("common.done", "muted")])
        return Outcome(EXIT.ok, lines, data)
    try:
        session.decline_account()
    except Exception:
        pass
    lines = nearby_login(k, NearbyLoginView("signed-out"), verb)
    return _cancelled(t, lines, {"state": "declined"})


def _left(t: Terminal, verb: str) -> Outcome:
    """Esc or Ctrl-C: cancelling is not an error (DL7); the block closes on "Nothing changed."."""
    model = SignInModel(headless=False)
    model.cancelled()
    return _cancelled(t, screens.sign_in(t.kit, model.view, verb), {"state": "cancelled"})


def _done_line(k: Kit, name: Optional[str], email: Optional[str]) -> List[Span]:
    if email:
        return k.units("signin.nearby.done", "strong", email=clean(email))
    return [k.t("account.holder", name=clean(name or "") or k.product)]


# ── devices approve ────────────────────────────────────────────────────────────────────────


def _usage(t: Terminal) -> Outcome:
    """Both sides need a person (D-10): a usage error, before anything starts."""
    k = t.kit
    command = f"{k.prog} devices approve"
    message = k.s("cli.approve.needsPerson", command=command)
    lines = screens._frame(
        k, "devices approve", k.step("fail", [k.t("cli.help.usage", "strong")]) + k.body([Span(message, (), None, "key:cli.approve.needsPerson")])
    )
    return Outcome(EXIT.usage, lines, {"error": "usage", "usage": command, "message": message})


def approve(client: Any, t: Terminal) -> Outcome:
    """``devices approve`` (see the module docstring). The advert stands only while this runs (D-6) and is
    stopped on every way out."""
    k, env = t.kit, t.env
    verb = "devices approve"
    if env.json or not env.interactive:
        return _usage(t)

    def done(view: NearbyApprovalView, code: int, data: dict) -> Outcome:
        return Outcome(code, nearby_approval(k, view, verb), data)

    asks: "queue.Queue[Any]" = queue.Queue()
    try:
        handle = client.identity.nearby.on_request(asks.put, prompt=True)
    except PolarisError as e:
        if e.code == ErrorCode.NEARBY_UNSUPPORTED:
            return done(NearbyApprovalView("unsupported"), EXIT.failed, {"state": "unsupported"})
        if e.code in (ErrorCode.ACCOUNT_REQUIRED, ErrorCode.NO_TOKEN):
            return done(NearbyApprovalView("account-required"), EXIT.failed, {"state": "account-required"})
        return _error_outcome(t, _code_of(client, e), verb)
    try:
        return _run_approval(client, t, asks, verb)
    finally:
        try:
            handle.stop()
        except Exception:
            pass


def _run_approval(client: Any, t: Terminal, asks: "queue.Queue[Any]", verb: str) -> Outcome:
    k = t.kit

    def done(view: NearbyApprovalView, code: int, data: dict) -> Outcome:
        return Outcome(code, nearby_approval(k, view, verb), data)

    frame = 0
    ask: Any = None
    try:
        with t.device.keys() as keys, t.device.live() as live:
            started = t.clock()
            while ask is None:
                try:
                    ask = asks.get_nowait()
                    break
                except queue.Empty:
                    pass
                if t.clock() - started >= APPROVE_S:
                    return done(NearbyApprovalView("timeout"), EXIT.failed, {"state": "timeout"})
                live.update(lambda f=frame: nearby_approval(k, NearbyApprovalView("entry"), verb, frame=f))
                frame += 1
                if keys.read(_TICK) == "esc":
                    return done(NearbyApprovalView("cancelled"), EXIT.failed, {"state": "cancelled"})
            device = clean(getattr(ask, "device", None) or "").strip() or None
            codes = tuple(str(c) for c in ask.codes)
            ask_view = NearbyApprovalView("ask", device=device, codes=codes)

            def press(valid: int) -> Optional[str]:
                """The next key that means something: a digit up to ``valid``, ``d`` or Esc."""
                while True:
                    key = keys.read(None)
                    if key == "esc" or key == "d":
                        return key
                    if key and key.isdigit() and 1 <= int(key) <= valid:
                        return key

            live.update(lambda: nearby_approval(k, ask_view, verb))
            key = press(len(codes))
            if key in ("d", "esc"):
                ask.deny()
                return done(NearbyApprovalView("denied", device=device), EXIT.failed, {"state": "denied"})
            live.update(lambda: nearby_approval(k, replace(ask_view, state="working"), verb))
            step = ask.pick(codes[int(key) - 1])  # type: ignore[arg-type]
            # The license choice, as many rounds as the Worker asks for (at most three).
            while step.kind == "choose":
                free = [c for c in (step.choices or {}).get("choices", []) if c.get("state") == "free"][:9]
                names = tuple((c.get("name") or c.get("tierName") or "") for c in free)
                create = (step.choices or {}).get("create") is not None
                choose_view = NearbyApprovalView("choose", device=device, choices=names, create=create)
                live.update(lambda v=choose_view: nearby_approval(k, v, verb))
                total = len(names) + (1 if create else 0)
                choice = press(total)
                if choice in ("esc", "d") or total == 0:
                    step = step.cancel()
                elif int(choice) <= len(free):  # type: ignore[arg-type]
                    step = step.choose({"kind": "license", "licenseId": free[int(choice) - 1]["id"]})  # type: ignore[arg-type]
                else:
                    step = step.choose({"kind": "create"})
    except KeyboardInterrupt:
        t.interrupted = True
        try:
            if ask is not None:
                ask.deny()
        except Exception:
            pass
        return _cancelled(t, nearby_approval(k, NearbyApprovalView("denied" if ask is not None else "cancelled"), verb), {"state": "cancelled"})
    except PolarisError as e:
        return _error_outcome(t, _code_of(client, e), verb)
    kind = step.kind
    data = {"state": kind}
    if kind == "approved":
        data["device"] = device
        return done(NearbyApprovalView("approved", device=device), EXIT.ok, data)
    return done(NearbyApprovalView(kind, device=device), EXIT.failed, data)
