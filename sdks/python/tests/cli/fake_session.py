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
