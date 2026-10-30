"""A stand-in for ``identity.sign_in.start()``'s :class:`SignInSession`, shared by the CLI tests.

``start`` answers a session with the shown fields (``user_code``, ``verification_uri``,
``verification_uri_complete``, ``expires_at``) and a ``wait``; the poll credential is never an
attribute. ``wait`` returns a :class:`SignInOutcome` (``signed_in``, ``expired``, ``cancelled``)
or raises, as the real one does.
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace
from typing import Any, Callable, Optional

from polaris_key.core.errors import PolarisError
from polaris_key.identity.sign_in import SignInOutcome


class FakeSession:
    def __init__(
        self,
        *,
        user_code: str = "WDJB-MJHT",
        verification_uri: str = "https://polaris.locker/device",
        verification_uri_complete: Optional[str] = None,
        expires_at: Optional[int] = None,
        behave: Optional[Callable[[Optional[threading.Event]], SignInOutcome]] = None,
    ) -> None:
        self.user_code = user_code
        self.verification_uri = verification_uri
        self.verification_uri_complete = verification_uri_complete or f"{verification_uri}?user_code={user_code}"
        self.expires_in = 600
        self.interval = 1
        self.expires_at = expires_at if expires_at is not None else int(time.time()) + 600
        self.channel = "device-code"
        self._behave = behave
        self.cancelled = False

    def reopen(self) -> bool:
        return True

    def cancel(self) -> None:
        self.cancelled = True

    def wait(self, timeout: Any = None, *, once: bool = False, confirm: Any = None, cancel_token: Optional[threading.Event] = None) -> SignInOutcome:
        if self._behave is None:
            if cancel_token is not None:
                cancel_token.wait(10)
            return SignInOutcome(kind="cancelled")
        return self._behave(cancel_token)


def signed_in(name: str = "Mara Fennick", email: str = "mara@fennick.studio", after: float = 0.3) -> Callable[[Optional[threading.Event]], SignInOutcome]:
    """Finishes after ``after`` seconds; cancelled at once if the token is set first."""

    def behave(token: Optional[threading.Event]) -> SignInOutcome:
        if token is not None and token.wait(after):
            return SignInOutcome(kind="cancelled")
        return SignInOutcome(kind="signed_in", identity=SimpleNamespace(name=name, email=email), activation=None)

    return behave


def ends(kind: str, after: float = 0.4) -> Callable[[Optional[threading.Event]], SignInOutcome]:
    """Settles as ``kind`` (``expired`` ...) after ``after`` seconds."""

    def behave(token: Optional[threading.Event]) -> SignInOutcome:
        if token is not None and token.wait(after):
            return SignInOutcome(kind="cancelled")
        return SignInOutcome(kind=kind)

    return behave


def raises(error: BaseException) -> Callable[[Optional[threading.Event]], SignInOutcome]:
    def behave(token: Optional[threading.Event]) -> SignInOutcome:
        raise error

    return behave


def sign_in_of(session: FakeSession) -> SimpleNamespace:
    """The ``client.identity.sign_in`` namespace: ``start(device_name=...)`` answers ``session``."""
    return SimpleNamespace(start=lambda device_name=None, **kw: session)


# ── Nearby sign-in and approval (I-47.13) ───────────────────────────────────────────────────


class FakeNearbySession:
    """A stand-in for ``identity.sign_in.start(channel="nearby")``'s session. ``choose(id)`` shows the code
    and, as if the person tapped it on the other device, lets the poll answer ``signed_in``; ``cancel()``
    ends ``wait`` as ``cancelled``. ``approvers`` is what the LAN half has listed so far."""

    channel = "nearby"

    def __init__(
        self,
        approvers: Any = (),
        *,
        outcome: Any = None,
        sign_in_after_choose: bool = True,
        identity: Any = None,
    ) -> None:
        self.approvers = list(approvers)
        self.code: Optional[str] = None
        self.chosen: list = []
        self.confirmed = 0
        self.declined = 0
        self.cancelled = False
        self._outcome = outcome
        self._after_choose = sign_in_after_choose
        self._identity = identity or SimpleNamespace(name="Mara Fennick", email="mara@fennick.studio")
        self._gate = threading.Event()
        self._stop = threading.Event()

    def choose(self, approver_id: str) -> str:
        self.chosen.append(approver_id)
        self.code = "482 913"
        if self._after_choose:
            self._gate.set()
        return self.code

    def cancel(self) -> None:
        self.cancelled = True
        self._stop.set()

    def wait(self, timeout: Any = None, *, once: bool = False, cancel_token: Optional[threading.Event] = None) -> SignInOutcome:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self._stop.is_set() or (cancel_token is not None and cancel_token.is_set()):
                return SignInOutcome(kind="cancelled")
            if self._gate.wait(0.005):
                break
        else:
            return SignInOutcome(kind="cancelled")
        if isinstance(self._outcome, BaseException):
            raise self._outcome
        if self._outcome is not None:
            return SignInOutcome(kind=self._outcome)
        return SignInOutcome(kind="signed_in", identity=self._identity, activation=None)

    def confirm_account(self) -> None:
        self.confirmed += 1

    def decline_account(self) -> None:
        self.declined += 1


def approver(id_: str = "a1", label: Optional[str] = "Ana's laptop", platform: str = "macos") -> SimpleNamespace:
    return SimpleNamespace(id=id_, label=label, platform=platform)


def nearby_identity(session: Optional[FakeNearbySession] = None, *, available: bool = True, device_code: Optional[FakeSession] = None, calls: Optional[list] = None) -> SimpleNamespace:
    """``client.identity`` with nearby on: ``nearby.available`` and a ``sign_in.start`` that answers the nearby
    session for ``channel="nearby"`` and the device-code ``FakeSession`` otherwise."""

    def start(device_name: Any = None, **kw: Any) -> Any:
        if kw.get("channel") == "nearby":
            if calls is not None:
                calls.append("start")
            if session is None:
                raise PolarisError("nearby-unsupported", "no nearby here")
            return session
        return device_code or FakeSession(behave=signed_in())

    def is_available(*, role: str) -> bool:
        if calls is not None:
            calls.append(f"available:{role}")
        return available

    return SimpleNamespace(
        nearby=SimpleNamespace(available=is_available),
        sign_in=SimpleNamespace(start=start),
        current=lambda: SimpleNamespace(name="Mara Fennick", email="mara@fennick.studio"),
    )


class FakeAsk:
    """A device asking to sign in, as ``identity.nearby.on_request`` hands it to the handler."""

    def __init__(self, step: Any = None, *, device: Optional[str] = "New phone", codes: Any = ("111 111", "482 913", "777 777")) -> None:
        self.device = device
        self.platform = "linux"
        self.codes = list(codes)
        self.picks: list = []
        self.denied = 0
        self._step = step if step is not None else SimpleNamespace(kind="approved")

    def pick(self, code: str) -> Any:
        self.picks.append(code)
        return self._step(code) if callable(self._step) else self._step

    def deny(self) -> Any:
        self.denied += 1
        return SimpleNamespace(kind="denied")


def approver_identity(ask: Optional[FakeAsk] = None, *, raises_: Optional[BaseException] = None, calls: Optional[list] = None) -> SimpleNamespace:
    """``client.identity`` for ``devices approve``: ``nearby.on_request`` hands ``ask`` to the handler at once
    (or raises) and answers a handle that records ``stop``."""

    def on_request(handler: Any, **opts: Any) -> Any:
        if calls is not None:
            calls.append(f"on_request:{sorted(opts.items())}")
        if raises_ is not None:
            raise raises_
        if ask is not None:
            handler(ask)
        return SimpleNamespace(stop=lambda: calls.append("stop") if calls is not None else None)

    return SimpleNamespace(nearby=SimpleNamespace(available=lambda *, role: True, on_request=on_request))


_ESCAPES = __import__("re").compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)")


class WhenKeys:
    """A scripted KeyReader for the nearby flows: each key is pressed once the screen shows its trigger text
    (``None``: at once). A read with a timeout is a tick of a fake clock (``now``), so the 2 s, 3 s and 300 s
    windows pass in no time; a read with none waits for its trigger for a few real seconds."""

    def __init__(self, script: Any, *, end: Optional[BaseException] = None) -> None:
        self.script = list(script)
        self.end = end
        self.now = 1000.0
        self.terminal: Any = None

    def attach(self, terminal: Any) -> None:
        self.terminal = terminal
        terminal.clock = lambda: self.now

    def __enter__(self) -> "WhenKeys":
        return self

    def __exit__(self, *exc: Any) -> None:
        pass

    def screen(self) -> str:
        return _ESCAPES.sub("", self.terminal.device.out.getvalue())

    def _next(self) -> Optional[str]:
        if self.script:
            trigger, key = self.script[0]
            if trigger is None or trigger in self.screen():
                self.script.pop(0)
                return key
        return None

    def read(self, timeout: Optional[float] = None) -> Optional[str]:
        key = self._next()
        if key is not None:
            return key
        if timeout is None:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                key = self._next()
                if key is not None:
                    return key
                if self.end is not None and not self.script:
                    raise self.end
                time.sleep(0.002)
            raise AssertionError(f"the flow waited for a key the script does not have: {self.script!r}")
        if self.end is not None and not self.script:
            raise self.end
        self.now += timeout
        time.sleep(0.001)
        return None
