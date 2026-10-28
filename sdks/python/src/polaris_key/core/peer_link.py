"""WIRE-CONTRACT-V5 §15.6: a ``PeerSession`` bound to one asyncio stream pair (CC-10.10). Mirrors
``SocketLink`` in ``packages/sdk-node/src/connect/session.ts``.

The session engine owns the handshake, admission, records, MORE reassembly and rekey; this module owns
the bytes: it cuts TCP frames with :class:`~polaris_key.core.peer_frame.FrameReader`, writes the
engine's Noise messages as frames, drives its deadlines from the loop's clock, and turns its events
into six callbacks. It lives on the Connect loop (D-3): construct and ``run()`` it there.

Rules this module keeps:

- a frame is at most 65,535 bytes; before the session is admitted a frame over ``HANDSHAKE_FRAME_MAX``
  (16 KiB) ends it, and so does a socket still unadmitted after ``handshake_seconds`` (30);
- every failure ends the link and says why; nothing reaches the host before the session is open;
- ``pause(True)`` stops reading from the socket, so a peer that sends faster than the host reads is
  held back by TCP (the host-side queue caps live in :mod:`polaris_key.connect.session`);
- nothing here knows an error taxonomy: a refused handshake rejects ``opened`` with
  :class:`LinkRefused` and the code the engine closed with.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
from typing import Any, Awaitable, Callable, Dict, Optional

from .peer_frame import FrameReader, encode_frame
from .peer_session import Closed, Established, PeerSession, Record, RingReceived, RingWanted, TrustUnverified

__all__ = [
    "HANDSHAKE_FRAME_MAX",
    "HANDSHAKE_SECONDS",
    "LinkHandlers",
    "LinkRefused",
    "SocketLink",
]

HANDSHAKE_FRAME_MAX = 16_384
HANDSHAKE_SECONDS = 30.0
_READ_CHUNK = 65_536
#: What may sit unsent in the socket's write buffer (G10, S5): a peer that never reads (and keeps
#: sending PINGs, each answered with a PONG) is closed ``peer_busy`` rather than growing it forever.
WRITE_BUFFER_MAX = 8 * 1024 * 1024
_ABORT_AFTER = 2.0
#: The least a deadline timer waits, so a deadline that is due now cannot spin the loop.
_MIN_WAKE = 0.05


class LinkRefused(Exception):
    """The peer was not admitted. ``close_code`` is the session's close code."""

    def __init__(self, close_code: str) -> None:
        super().__init__("peer not admitted")
        self.close_code = close_code


class LinkHandlers:
    """What a link reports. All are optional and run on the loop's thread. ``on_established`` returns
    the host object (a ``ConnectSession``) that ``opened`` resolves to; ``on_record`` gets every record
    the engine hands up; ``on_ended`` gets the final :class:`Closed`."""

    def __init__(
        self,
        on_established: Optional[Callable[["SocketLink", Established], Any]] = None,
        on_record: Optional[Callable[["SocketLink", int, bytes], None]] = None,
        on_ring: Optional[Callable[[str, int], None]] = None,
        on_trust: Optional[Callable[[str], None]] = None,
        on_ring_wanted: Optional[Callable[[], None]] = None,
        on_closed: Optional[Callable[[Closed], None]] = None,
        on_ended: Optional[Callable[[], None]] = None,
    ) -> None:
        self.on_established = on_established
        self.on_record = on_record
        self.on_ring = on_ring
        self.on_trust = on_trust
        self.on_ring_wanted = on_ring_wanted
        self.on_closed = on_closed
        self.on_ended = on_ended


class SocketLink:
    """One engine over one stream pair. ``session_options`` are the keyword arguments of
    :class:`PeerSession` except ``send`` and ``on_event`` (which the link supplies)."""

    def __init__(
        self,
        reader: "asyncio.StreamReader",
        writer: "asyncio.StreamWriter",
        session_options: Dict[str, Any],
        handlers: Optional[LinkHandlers] = None,
        *,
        handshake_seconds: float = HANDSHAKE_SECONDS,
        expect_peer: Optional[str] = None,
        peer_full: Optional[Callable[[str], bool]] = None,
    ) -> None:
        self._loop = asyncio.get_running_loop()
        #: The device id a dialling side expects; the session is refused, before it is registered or
        #: announced, when the certificate names another.
        self._expect_peer = expect_peer
        #: Asked once the peer is admitted: True ends the link with ``peer_busy`` before a session exists.
        self._peer_full = peer_full
        #: True when the link was refused because the certificate named an unexpected device.
        self.wrong_peer = False
        self._reader = reader
        self._writer = writer
        self._h = handlers or LinkHandlers()
        self._frames = FrameReader()
        self._host: Any = None
        self._ended = False
        self._lost = False
        self._open = False
        self._flooded = False
        self._final = False
        self._gate = asyncio.Event()
        self._gate.set()
        self._wake: Optional[asyncio.TimerHandle] = None
        self.opened: "asyncio.Future[Any]" = self._loop.create_future()
        # A rejection nobody awaits (an inbound session) must not warn.
        self.opened.add_done_callback(lambda f: f.cancelled() or f.exception())
        self.channel = PeerSession(send=self._send, on_event=self._event, **session_options)
        self._deadline: Optional[asyncio.TimerHandle] = self._loop.call_later(
            handshake_seconds, self._fail, "peer_timeout"
        )

    def __repr__(self) -> str:
        return "<SocketLink>"

    def __reduce__(self) -> Any:
        raise TypeError("a link cannot be pickled")

    @property
    def remote_address(self) -> str:
        peer = self._writer.get_extra_info("peername")
        return str(peer[0]) if peer else ""

    # -- the loop ---------------------------------------------------------------------------------

    async def run(self) -> None:
        """Read until the socket ends. The caller starts it as a task; for an initiator, call
        ``channel.start()`` first (or use :meth:`start`)."""
        try:
            while not self._ended:
                await self._gate.wait()
                chunk = await self._reader.read(_READ_CHUNK)
                if not chunk:
                    break
                self._data(chunk)
        except (OSError, asyncio.IncompleteReadError):
            pass
        finally:
            self._lost = True
            # Frames that arrived before the FIN were handled above; now end the session.
            self.channel.close("peer_bye")
            self._finish(Closed("connection_lost", False))

    def start(self) -> None:
        """Initiator: write message 1."""
        self.channel.start()
        self._arm()

    def pause(self, on: bool) -> None:
        """Stop (True) or resume (False) reading from the socket. Safe from any thread."""
        self._on_loop(lambda: self._gate.clear() if on else self._gate.set())

    # -- calls from any thread --------------------------------------------------------------------

    def send_record(self, type_: int, body: bytes) -> None:
        """Send one record message; blocks the calling thread until the loop has queued it."""
        self._call(lambda: self.channel.send_record(type_, body))

    def close(self, code: str = "peer_bye") -> None:
        """End the session with a code (a CLOSE record when the transport exists)."""
        self._call(lambda: self.channel.close(code))

    def close_nowait(self, code: str) -> None:
        """The loop-thread form of :meth:`close`, for a callback already on the loop."""
        self.channel.close(code)

    def _on_loop(self, fn: Callable[[], None]) -> None:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            fn()
        elif not self._loop.is_closed():
            self._loop.call_soon_threadsafe(fn)

    def _call(self, fn: Callable[[], Any]) -> Any:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            return fn()
        if self._loop.is_closed():
            raise RuntimeError("closed")
        done: "concurrent.futures.Future[Any]" = concurrent.futures.Future()

        def go() -> None:
            try:
                done.set_result(fn())
            except BaseException as e:  # noqa: BLE001 - handed to the caller
                done.set_exception(e)

        self._loop.call_soon_threadsafe(go)
        return done.result(10)

    # -- internals --------------------------------------------------------------------------------

    def _send(self, noise: bytes) -> None:
        if self._writer.is_closing():
            return
        if self._flooded and not self._final:
            return
        if not self._flooded and self._buffered() > WRITE_BUFFER_MAX:
            # Not inline: closing sends a record, which comes back here.
            self._flooded = True
            self._loop.call_soon(self._flood_close)
            return
        self._writer.write(encode_frame(noise))

    def _buffered(self) -> int:
        t = getattr(self._writer, "transport", None)
        try:
            return int(t.get_write_buffer_size()) if t is not None else 0
        except Exception:
            return 0

    def _flood_close(self) -> None:
        self._final = True  # the CLOSE record is the one last write
        try:
            self._fail("peer_busy")
        finally:
            self._final = False
        t = getattr(self._writer, "transport", None)
        if t is not None:
            self._loop.call_later(_ABORT_AFTER, t.abort)

    def _data(self, chunk: bytes) -> None:
        if self._ended:
            return
        frames = self._frames.push(chunk)
        if frames is None:
            return self._fail("peer_bad_frame")
        for f in frames:
            if self._ended:
                return
            if not self._open and len(f) > HANDSHAKE_FRAME_MAX:
                return self._fail("peer_bad_frame")
            self.channel.receive(f)
        self._arm()

    def _arm(self) -> None:
        if self._wake is not None:
            self._wake.cancel()
            self._wake = None
        if self._ended:
            return
        w = self.channel.wake_in()
        if w is not None:
            self._wake = self._loop.call_later(max(w, _MIN_WAKE), self._tick)

    def _tick(self) -> None:
        self._wake = None
        self.channel.tick()
        self._arm()

    def _fail(self, code: str) -> None:
        if self._ended:
            return
        if not self._open:
            # Not a live session: the engine has nothing to send.
            self._finish(Closed(code, False))
        # The closing side names its reason (V5 15.6); a CLOSE goes out only when the transport exists.
        self.channel.close(code)

    def _event(self, e: Any) -> None:
        h = self._h
        if isinstance(e, Established):
            if e.peer_device_id is None:
                return
            if self._expect_peer is not None and e.peer_device_id != self._expect_peer:
                self.wrong_peer = True
                self.channel.close("peer_bye")
                self._finish(Closed("handshake_failed", False))
                return
            if self._peer_full is not None and self._peer_full(e.peer_device_id):
                self.channel.close("peer_busy")
                self._finish(Closed("peer_busy", False))
                return
            if self._deadline is not None:
                self._deadline.cancel()
                self._deadline = None
            self._open = True
            self._host = h.on_established(self, e) if h.on_established else None
            if not self.opened.done():
                self.opened.set_result(self._host)
        elif isinstance(e, Record):
            if h.on_record:
                h.on_record(self, e.record_type, e.body)
        elif isinstance(e, RingReceived):
            if h.on_ring:
                h.on_ring(e.jws, e.epoch)
        elif isinstance(e, TrustUnverified):
            if h.on_trust:
                h.on_trust(e.jws)
        elif isinstance(e, RingWanted):
            if h.on_ring_wanted:
                h.on_ring_wanted()
        elif isinstance(e, Closed):
            if self._lost and not e.by_peer:
                e = Closed("connection_lost", False)
            self._finish(e)

    def _finish(self, c: Closed) -> None:
        if self._ended:
            return
        self._ended = True
        for t in (self._deadline, self._wake):
            if t is not None:
                t.cancel()
        self._deadline = self._wake = None
        if self._h.on_closed:
            self._h.on_closed(c)
        if not self.opened.done():
            self.opened.set_exception(LinkRefused(c.code))
        # Closing flushes what the CLOSE record wrote, then drops the socket.
        try:
            self._writer.close()
        except Exception:
            pass
        if self._h.on_ended:
            self._h.on_ended()


async def open_initiator(link: SocketLink, timeout: Optional[float] = None) -> Any:
    """Start an initiator link and wait for it to be admitted (or refused)."""
    link.start()
    aw: Awaitable[Any] = link.opened
    return await (asyncio.wait_for(aw, timeout) if timeout is not None else aw)
