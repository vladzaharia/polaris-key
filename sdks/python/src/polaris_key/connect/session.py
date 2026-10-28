"""One Cloud Connect session as the host sees it (CC-10.10; WIRE-CONTRACT-V5 §15.5, §15.6). Mirrors
``ConnectSession`` and ``routeRecord`` in ``packages/sdk-node/src/connect/session.ts``.

The engine (:class:`~polaris_key.core.peer_session.PeerSession`) and its stream binding
(:class:`~polaris_key.core.peer_link.SocketLink`) live on the Connect loop; this class is the thread-safe
handle the host holds: ``send``, ``receive``, ``on_message``, ``on_close`` and ``close``.

Rules this module keeps:

- the host sees only the APP range (0x0100 to 0x7FFF). An APP-critical type (0x8100 to 0xFFFD) it
  cannot understand closes the session with ``peer_unknown_critical``; other types the session does
  not own are ignored (G9);
- messages the host has not read yet are bounded (G10): the socket pauses at 4 MiB queued and resumes
  under 1 MiB; at 8 MiB, or at 256 queued messages, the session closes with ``peer_busy``; all sessions
  together hold at most 32 MiB (:class:`QueueBudget`);
- every failure is a typed :class:`~polaris_key.connect.errors.LanError`; nothing reaches the host
  before the session is open;
- a session's repr names its peer and path, never its keys.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any, Callable, Deque, List, NamedTuple, Optional

from ..core.peer_link import LinkHandlers, LinkRefused, SocketLink
from ..core.peer_session import Closed, Established, PeerHello
from .errors import LanError

__all__ = [
    "APP_DEFAULT_TYPE",
    "ConnectSession",
    "MAX_QUEUED_MESSAGES",
    "QUEUE_MAX_BYTES",
    "QUEUE_PAUSE_BYTES",
    "QUEUE_RESUME_BYTES",
    "QueueBudget",
    "SessionClosed",
    "SessionMessage",
    "session_handlers",
    "TOTAL_QUEUE_BYTES",
    "route_record",
    "wait_opened",
]

#: The first APP record type; ``send`` defaults to it.
APP_DEFAULT_TYPE = 0x0100
MAX_QUEUED_MESSAGES = 256
#: A peer that sends faster than the host reads: pause the socket at 4 MiB queued, resume under 1 MiB,
#: close with ``peer_busy`` at 8 MiB.
QUEUE_PAUSE_BYTES = 4 * 1024 * 1024
QUEUE_RESUME_BYTES = 1024 * 1024
QUEUE_MAX_BYTES = 8 * 1024 * 1024
#: All sessions of a process together.
TOTAL_QUEUE_BYTES = 32 * 1024 * 1024


class SessionMessage(NamedTuple):
    type: int
    body: bytes


class SessionClosed(NamedTuple):
    """Why a session ended: a session close code (``peer_bye``, ``peer_revoked``, ...), or
    ``connection_lost`` when the socket went away."""

    code: str
    by_peer: bool


class QueueBudget:
    """The bytes all sessions together may hold unread."""

    def __init__(self, limit: int = TOTAL_QUEUE_BYTES) -> None:
        self._limit = limit
        self._used = 0
        self._lock = threading.Lock()

    @property
    def used(self) -> int:
        return self._used

    def reserve(self, n: int) -> bool:
        with self._lock:
            if self._used + n > self._limit:
                return False
            self._used += n
            return True

    def release(self, n: int) -> None:
        with self._lock:
            self._used = max(0, self._used - n)


_SHARED_BUDGET = QueueBudget()


class ConnectSession:
    """An open session with one peer device. Thread-safe. ``link`` is anything with ``send_record``,
    ``close`` and, optionally, ``pause`` (a :class:`~polaris_key.core.peer_link.SocketLink` or a relay
    session)."""

    def __init__(
        self,
        link: Any,
        peer_device_id: str,
        caps: List[str],
        hello: PeerHello,
        role: str,
        remote_address: str,
        path: str = "lan",
        budget: Optional[QueueBudget] = None,
    ) -> None:
        self._link = link
        self.peer_device_id = peer_device_id
        self.caps = tuple(caps)
        self.hello = hello
        self.role = role
        self.remote_address = remote_address
        self.path = path
        self._budget = budget or _SHARED_BUDGET
        self._cv = threading.Condition()
        self._queue: Deque[SessionMessage] = deque()
        self._bytes = 0
        self._paused = False
        self._closed: Optional[SessionClosed] = None
        self._on_message: List[Callable[[SessionMessage], None]] = []
        self._on_close: List[Callable[[SessionClosed], None]] = []

    def __repr__(self) -> str:
        return "<ConnectSession peer=%s path=%s role=%s>" % (self.peer_device_id, self.path, self.role)

    def __reduce__(self) -> Any:
        raise TypeError("a session cannot be pickled")

    @property
    def closed(self) -> Optional[SessionClosed]:
        return self._closed

    # -- host calls (any thread) ------------------------------------------------------------------

    def send(self, body: bytes, type: int = APP_DEFAULT_TYPE) -> None:  # noqa: A002 - mirrors Node
        """Send one message (up to the peer's ``maxMessage``, at most 1 MiB) as an APP record."""
        if isinstance(type, bool) or not isinstance(type, int) or type < 0x0100 or type > 0x7FFF:
            raise LanError("bad_type", "Application types are 0x0100 to 0x7FFF.")
        if self._closed is not None:
            raise LanError("closed", "The session is closed.")
        try:
            self._link.send_record(type, bytes(body))
        except ValueError as e:
            if str(e) == "message too large":
                raise LanError("too_large", "The message is larger than the peer accepts.") from None
            raise LanError("closed", "The session is closed.") from e
        except Exception as e:
            raise LanError("closed", "The session is closed.") from e

    def send_record(self, type: int, body: bytes) -> None:  # noqa: A002
        """Send a record of any type the session does not own (a peer document, a later transfer
        type). The engine refuses HELLO, CLOSE, REKEY and SAS records."""
        self._link.send_record(type, bytes(body))

    def receive(self, timeout: Optional[float] = None) -> SessionMessage:
        """The next message. Blocks until one arrives; raises :class:`LanError` (``closed``) when the
        session closes with none waiting, and ``TimeoutError`` after ``timeout`` seconds."""
        end = None if timeout is None else time.monotonic() + timeout
        with self._cv:
            while not self._queue:
                if self._closed is not None:
                    raise LanError("closed", "The session is closed.")
                left = None if end is None else end - time.monotonic()
                if left is not None and left <= 0:
                    raise TimeoutError("no message")
                self._cv.wait(left)
            m = self._queue.popleft()
            self._bytes -= len(m.body)
            resume = self._paused and self._bytes < QUEUE_RESUME_BYTES
            if resume:
                self._paused = False
        self._budget.release(len(m.body))
        if resume:
            self._pause(False)
        return m

    def on_message(self, fn: Callable[[SessionMessage], None]) -> Callable[[], None]:
        """Called for each message instead of queueing it (on the Connect loop's thread). Returns the
        unsubscribe."""
        with self._cv:
            self._on_message.append(fn)

        def off() -> None:
            with self._cv:
                if fn in self._on_message:
                    self._on_message.remove(fn)

        return off

    def on_close(self, fn: Callable[[SessionClosed], None]) -> Callable[[], None]:
        with self._cv:
            self._on_close.append(fn)
            done = self._closed
        if done is not None:
            fn(done)

        def off() -> None:
            with self._cv:
                if fn in self._on_close:
                    self._on_close.remove(fn)

        return off

    def close(self, code: str = "peer_bye") -> None:
        """Close with ``peer_bye`` (or ``peer_busy``); the CLOSE record is sent first."""
        if code not in ("peer_bye", "peer_busy"):
            raise ValueError("close code")
        try:
            self._link.close(code)
        except RuntimeError:
            pass  # the loop is already gone: the session is over

    # -- the link's calls (the Connect loop's thread) ---------------------------------------------

    def deliver(self, m: SessionMessage) -> None:
        full = pause = False
        with self._cv:
            if self._closed is not None:
                return
            subs = list(self._on_message)
            if not subs:
                over = (
                    len(self._queue) >= MAX_QUEUED_MESSAGES
                    or self._bytes + len(m.body) > QUEUE_MAX_BYTES
                    or not self._budget.reserve(len(m.body))
                )
                if over:
                    full = True
                else:
                    self._queue.append(m)
                    self._bytes += len(m.body)
                    pause = not self._paused and self._bytes > QUEUE_PAUSE_BYTES
                    if pause:
                        self._paused = True
                    self._cv.notify()
        if subs:
            for f in subs:
                try:
                    f(m)
                except Exception:
                    pass  # a host callback never ends the session
            return
        if full:
            self._busy()
        elif pause:
            self._pause(True)

    def ended(self, c: SessionClosed) -> None:
        with self._cv:
            if self._closed is not None:
                return
            self._closed = c
            dropped = self._bytes
            self._queue.clear()
            self._bytes = 0
            subs = list(self._on_close)
            self._cv.notify_all()
        self._budget.release(dropped)
        for f in subs:
            try:
                f(c)
            except Exception:
                pass

    def _pause(self, on: bool) -> None:
        p = getattr(self._link, "pause", None)
        if p is not None:
            p(on)

    def _busy(self) -> None:
        c = getattr(self._link, "close_nowait", None)
        try:
            (c or self._link.close)("peer_busy")
        except Exception:
            pass


def route_record(link: Any, session: Optional[ConnectSession], type_: int, body: bytes) -> None:
    """A record the engine hands up: the APP range goes to the host's session; an APP-critical type
    (0x8100 to 0xFFFD) the host cannot understand closes the session; the rest is ignored. ``link``
    needs ``close_nowait`` (it runs on the loop's thread)."""
    if 0x0100 <= type_ <= 0x7FFF:
        if session is not None:
            session.deliver(SessionMessage(type_, body))
    elif 0x8100 <= type_ <= 0xFFFD:
        link.close_nowait("peer_unknown_critical")


async def wait_opened(link: Any, timeout: Optional[float] = None) -> ConnectSession:
    """Await a link's admission: the :class:`ConnectSession`, or a :class:`LanError`
    (``handshake_failed`` with ``close_code``) when the peer was not admitted."""
    import asyncio

    try:
        aw = link.opened
        return await (asyncio.wait_for(aw, timeout) if timeout is not None else aw)  # type: ignore[no-any-return]
    except LinkRefused as e:
        raise LanError("handshake_failed", "The peer was not admitted.", close_code=e.close_code) from None


def session_handlers(
    role: str,
    *,
    on_established: Optional[Callable[[ConnectSession], None]] = None,
    on_ring: Optional[Callable[[str, int], None]] = None,
    on_trust: Optional[Callable[[str], None]] = None,
    on_ring_wanted: Optional[Callable[[], None]] = None,
    on_ended: Optional[Callable[[], None]] = None,
    budget: Optional[QueueBudget] = None,
    path: str = "lan",
) -> LinkHandlers:
    """The link callbacks that make a :class:`ConnectSession`: it is built when the peer is admitted,
    APP records are routed to it, and the link's close ends it."""
    box: List[Optional[ConnectSession]] = [None]

    def established(link: SocketLink, e: Established) -> ConnectSession:
        assert e.peer_device_id is not None
        s = ConnectSession(
            link, e.peer_device_id, e.caps, e.hello, role, link.remote_address, path=path, budget=budget
        )
        box[0] = s
        if on_established is not None:
            on_established(s)
        return s

    def record(link: SocketLink, type_: int, body: bytes) -> None:
        route_record(link, box[0], type_, body)

    def closed(c: Closed) -> None:
        if box[0] is not None:
            box[0].ended(SessionClosed(c.code, c.by_peer))

    return LinkHandlers(
        on_established=established,
        on_record=record,
        on_ring=on_ring,
        on_trust=on_trust,
        on_ring_wanted=on_ring_wanted,
        on_closed=closed,
        on_ended=on_ended,
    )
