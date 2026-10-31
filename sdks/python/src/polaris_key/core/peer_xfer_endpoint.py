"""WIRE-CONTRACT-V5 §15.11: runs an :class:`~polaris_key.core.peer_xfer.XferMachine` over a session.
Mirrors ``packages/client-core/src/peer/xferEndpoint.ts``.

The machine decides; this layer performs what it asks, in order: effects on the partial files, then the
records, then the events for the host. It reads the sender's bytes and stores the receiver's through
ports. Calls come from the session's thread (a record) and from the host's threads (offer, consent,
cancel) and a timer; one lock serialises the machine, and the work a call leaves is done by whichever
thread gets there first, in the order it was produced (so two endpoints wired to each other in one
thread never nest). A source failure cancels the transfer without its ``DONE``; a store or session
failure closes ``peer_bye`` and keeps the partials.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any, Callable, Deque, Dict, Optional, Set, Tuple

from .peer_xfer import (
    XFER,
    XferMachine,
    XferOut,
    is_xfer_type,
    xfer_cancel_body,
    xfer_chunk_body,
    xfer_done_body,
    xfer_offer_body,
    xfer_offset_body,
)

__all__ = ["XferEndpoint", "XferEvents"]

Json = Dict[str, Any]


class XferEvents:
    """What the host sees of a transfer. Every method is optional; they run on whichever thread did the
    work, so keep them short."""

    def ask(self, a: Json) -> None:
        """The host is asked about an ``OFFER``; it answers with ``consent``."""

    def withdraw(self, id_: str) -> None:
        """The question for this id is withdrawn (the peer or a timer ended the transfer)."""

    def result(self, r: Json) -> None:
        """``{id, outcome: delivered | cancelled | closed, reason?}``."""

    def refused(self, id_: str) -> None:
        """The host's own ``offer`` was refused locally: too many live transfers."""

    def error(self, err: BaseException) -> None:
        """A port failed; the session is being closed and the partials are kept."""


class XferEndpoint:
    """``send(type, body)`` writes one message (the writer ``PeerSession.attach_xfer`` returned),
    ``close(code)`` closes the session, ``read(id, offset, length)`` returns the sender's bytes, and
    ``apply(effect)`` performs an effect on the partial files or a write into one. ``now`` is a clock in
    seconds and ``timer(fn, seconds)`` returns the cancel."""

    def __init__(
        self,
        machine: XferMachine,
        *,
        send: Callable[[int, bytes], None],
        close: Callable[[str], None],
        read: Callable[[str, int, int], bytes],
        apply: Callable[[Json], None],
        events: Optional[XferEvents] = None,
        now: Callable[[], float] = time.monotonic,
        timer: Optional[Callable[[Callable[[], None], float], Callable[[], None]]] = None,
    ) -> None:
        self.machine = machine
        self._send = send
        self._close = close
        self._read = read
        self._apply = apply
        self._ev = events or XferEvents()
        self._now = now
        self._timer = timer or _thread_timer
        self._lock = threading.RLock()
        self._queue: Deque[Tuple[XferOut, Optional[str]]] = deque()
        self._draining = False
        self._chunk: Dict[str, int] = {}
        self._cancel_timer: Optional[Callable[[], None]] = None
        self._dead = False
        self._failed = False
        self._machine_thread: Optional[int] = None

    # -- calls --------------------------------------------------------------------------------------

    def receive(self, type_: int, body: bytes) -> None:
        """A record of the session: one of the six types."""
        if self._dead or not is_xfer_type(type_):
            return
        self._do(lambda at: self.machine.receive(at, type_, bytes(body)))

    def offer(self, **a: Any) -> None:
        """The host sends an ``OFFER`` (the machine's ``offer`` arguments)."""
        with self._lock:
            self._guard()
            out = self.machine.offer(self._now(), **a)
            if out.refused is None:
                self._chunk[a["id"]] = a["chunk"]
            self._enqueue(out, a["id"])
        self._drain()

    def consent(self, id_: str, answer: str) -> None:
        self._do(lambda at: self.machine.consent(at, id_, answer))

    def cancel(self, id_: str) -> None:
        self._do(lambda at: self.machine.cancel(at, id_))

    def closed(self) -> None:
        """The session closed: every live transfer ends ``closed`` and the partials stay."""
        with self._lock:
            if self._dead:
                return
            self._enqueue(self.machine.abandon(self._now()), None)
            self._dead = True
            self._disarm()
        self._drain()

    def in_machine(self) -> bool:
        """True on the thread that is inside a machine call (a handler the machine is asking)."""
        return self._machine_thread == threading.get_ident()

    # -- internals ----------------------------------------------------------------------------------

    def _guard(self) -> None:
        if self._machine_thread == threading.get_ident():
            raise RuntimeError("a transfer call cannot be made from inside the offer handler")

    def _do(self, fn: Callable[[float], XferOut]) -> None:
        with self._lock:
            self._guard()
            if self._dead:
                return
            self._machine_thread = threading.get_ident()
            try:
                out = fn(self._now())
            finally:
                self._machine_thread = None
            self._enqueue(out, None)
        self._drain()

    def _enqueue(self, out: XferOut, offered: Optional[str]) -> None:
        self._queue.append((out, offered))
        if out.close is not None:
            # A close ends the endpoint: the transfers still live report ``closed`` after it.
            self._queue.append((_CLOSE_MARK, out.close))
            self._queue.append((self.machine.abandon(self._now()), None))
            self._dead = True
        self._arm()

    def _drain(self) -> None:
        with self._lock:
            if self._draining:
                return
            self._draining = True
        try:
            while True:
                with self._lock:
                    if not self._queue:
                        self._draining = False
                        return
                    out, offered = self._queue.popleft()
                self._run(out, offered)
        except BaseException:
            with self._lock:
                self._draining = False
            raise

    def _run(self, out: XferOut, offered: Optional[str]) -> None:
        if out is _CLOSE_MARK:
            try:
                self._close(str(offered))
            except Exception:
                pass
            return
        failed: Set[str] = set()
        if not self._failed:
            try:
                for e in out.partial:
                    self._apply(e)
                for s in out.send:
                    self._perform(s, failed)
            except Exception as err:  # noqa: BLE001 - a port failed: end the session, keep the partials
                self._failed = True
                self._safe(self._ev.error, err)
                try:
                    self._close("peer_bye")
                except Exception:
                    pass
                with self._lock:
                    if not self._dead:
                        self._dead = True
                        self._queue.append((self.machine.abandon(self._now()), None))
                    self._disarm()
                return
        for id_ in out.withdraw:
            self._safe(self._ev.withdraw, id_)
        if out.ask is not None:
            self._safe(self._ev.ask, out.ask)
        if out.refused is not None and offered is not None:
            self._safe(self._ev.refused, offered)
        for r in out.results:
            self._safe(self._ev.result, r)
        for id_ in failed:
            with self._lock:
                if self._dead:
                    continue
                self._enqueue(self.machine.fail(self._now(), id_), None)

    @staticmethod
    def _safe(fn: Callable[[Any], None], arg: Any) -> None:
        try:
            fn(arg)
        except Exception:
            pass  # a host callback never ends a session

    def _perform(self, s: Json, failed: Set[str]) -> None:
        t = s["t"]
        if t in ("CHUNKS", "DONE") and s["id"] in failed:
            return
        if t == "OFFER":
            return self._send(XFER["OFFER"], xfer_offer_body(s))
        if t == "ACCEPT":
            return self._send(XFER["ACCEPT"], xfer_offset_body(s["id"], s["offset"]))
        if t == "ACK":
            return self._send(XFER["ACK"], xfer_offset_body(s["id"], s["offset"]))
        if t == "DONE":
            return self._send(XFER["DONE"], xfer_done_body(s["id"], s.get("sha256")))
        if t == "CANCEL":
            return self._send(XFER["CANCEL"], xfer_cancel_body(s["id"], s["reason"]))
        if t == "CHUNKS":
            chunk = self._chunk[s["id"]]
            at = s["offset"]
            end = at + s["bytes"]
            while at < end:
                n = min(chunk, end - at)
                try:
                    data = self._read(s["id"], at, n)
                    if len(data) != n:
                        raise ValueError("source length")
                except Exception:  # noqa: BLE001
                    # The source failed: the transfer ends here, and its DONE never goes out.
                    failed.add(s["id"])
                    return
                self._send(XFER["CHUNK"], xfer_chunk_body(s["id"], at, data))
                at += n

    # -- the clock ----------------------------------------------------------------------------------

    def _disarm(self) -> None:
        c, self._cancel_timer = self._cancel_timer, None
        if c is not None:
            c()

    def _arm(self) -> None:
        """One timer, set for the machine's next wait."""
        self._disarm()
        if self._dead:
            return
        at = self.machine.next_deadline()
        if at is None:
            return
        self._cancel_timer = self._timer(self._fire, max(0.0, at - self._now()))

    def _fire(self) -> None:
        with self._lock:
            self._cancel_timer = None
            if self._dead:
                return
            self._machine_thread = threading.get_ident()
            try:
                out = self.machine.tick(self._now())
            finally:
                self._machine_thread = None
            self._enqueue(out, None)
        self._drain()


_CLOSE_MARK = XferOut()


def _thread_timer(fn: Callable[[], None], seconds: float) -> Callable[[], None]:
    t = threading.Timer(seconds, fn)
    t.daemon = True
    t.start()
    return t.cancel

