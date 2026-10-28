"""The relay half of Cloud Connect, socket side (CC-10.13; WIRE-CONTRACT-V5 §15.7). One WebSocket to the
account room carries envelopes. Mirrors the socket half of ``packages/sdk-node/src/connect/relay.ts``. A
:class:`RelayService` lives on the Connect loop (D-3): build and ``start()`` it there. The peer sessions
that ride the socket are CC-10.14.

Rules this module keeps:

- a ticket is single use and lives 60 seconds, so every connect fetches a new one. The socket is opened
  offering ``pkey-relay.1`` and then the ticket as subprotocols, and the client requires ``pkey-relay.1``
  echoed back (G14). The ticket is never logged, stored past the open or put in an error: the WebSocket
  library's own logger is replaced by a silent one, and a failed open reports no cause (G13);
- a message is at most 65,564 bytes; an envelope that fails its layout, or a text frame, closes the
  socket with 1002 and is never answered (G14); each running service has one socket;
- the room stamps ``from``; this module never uses it for identity;
- reconnects back off exponentially with jitter and a floor, and the backoff resets only after the
  socket stayed up 30 seconds. ``Retry-After`` is capped at 3,600 seconds. A product that turned the
  relay off, or a spent quota, ends the loop with a typed error; 4009 (replaced) stops without fighting
  back; 4003 fetches the roster once and stops after three in a row; 4001 simply gets a new ticket; after
  five attempts that never open the status is ``unavailable`` and a retry waits at least five minutes (G15);
- without the optional ``connect`` extra (``websockets``) the relay is ``off`` with reason
  ``dependency``; nothing else in the SDK needs it.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Protocol, Set

from ..core.b64url import b64url_encode
from ..core.peer_relay_codec import RELAY_MAX_MESSAGE, decode_relay, encode_relay
from .channel import ConnectNotice, PeerDocs, PeerDocsSource
from .client import PeerSource, RelayGrant
from .errors import RELAY_PROTOCOL, RelayError
from .lan import LanSource

__all__ = [
    "RELAY_MODES",
    "RelayDependencyMissing",
    "RelayOptions",
    "RelaySocket",
    "RelayService",
    "RelayState",
    "RelayStatus",
    "SocketClosed",
    "assert_relay_mode",
    "websockets_opener",
]

#: The only PeerSession mode that may cross the relay (G16).
RELAY_MODES = ("a",)
MAX_RETRY_AFTER_S = 3600
#: After this many attempts that never opened, the status is ``unavailable`` and retries slow down.
UNAVAILABLE_AFTER = 5
UNAVAILABLE_RETRY_S = 300.0
IDENTITY_TTL_S = 30
CERT_MARGIN_S = 60

RelayState = str  # idle | connecting | open | backoff | unavailable | blocked | off | stopped


def assert_relay_mode(mode: str) -> str:
    """Raises :class:`RelayError` for a mode the relay must never carry (``v``, ``p``, anything else)."""
    if mode != "a":
        raise RelayError("mode_not_allowed", "Mode %s never crosses the relay; it is LAN only." % mode)
    return "a"


class RelayStatus(NamedTuple):
    state: str
    error: Optional[RelayError]
    #: Failed attempts since the last open.
    attempts: int
    #: Why the relay is ``off`` (``dependency``), else ``None``.
    reason: Optional[str] = None


class SocketClosed(Exception):
    """The socket closed (or could not open). ``code`` is the close code, ``None`` when there was none."""

    def __init__(self, code: Optional[int]) -> None:
        super().__init__("socket closed")
        self.code = code


class RelayDependencyMissing(Exception):
    """The optional ``connect`` extra (``websockets``) is not installed."""

    reason = "dependency"


class RelaySocket(Protocol):
    """What the service uses of a WebSocket: binary messages in and out. ``recv`` returns ``bytes`` (or
    ``str`` for a text frame, which the service refuses) and raises :class:`SocketClosed`."""

    async def send(self, data: bytes) -> None: ...

    async def recv(self) -> Any: ...

    async def close(self, code: int = 1000) -> None: ...


Opener = Callable[[str, List[str]], Awaitable[RelaySocket]]


class RelayOptions(NamedTuple):
    """``opener`` opens a socket (default :func:`websockets_opener`). ``sleep`` and ``random`` drive the
    backoff and ping (tests pass fakes). ``clock`` is monotonic seconds."""

    opener: Optional[Opener] = None
    sleep: Optional[Callable[[float], Awaitable[None]]] = None
    random: Optional[Callable[[], float]] = None
    clock: Callable[[], float] = time.monotonic
    caps: Any = ("app/1",)
    label: Optional[str] = None
    #: Reconnect backoff: base 1 s, doubling to 60 s, with jitter; never under ``backoff_min``.
    backoff_base: float = 1.0
    backoff_max: float = 60.0
    backoff_min: float = 0.5
    #: How long a socket must stay open before the backoff resets.
    stable_seconds: float = 30.0
    ping_seconds: float = 25.0
    #: Wait for the socket to open.
    open_seconds: float = 15.0
    max_sessions: int = 64
    max_pending_per_peer: int = 4
    handshake_seconds: float = 30.0
    rekey_messages: Optional[int] = None
    rekey_seconds: Optional[float] = None


# -- the default opener (websockets, imported on first use) ------------------------------------------


class _Silent(logging.Logger):
    """A logger that never emits: websockets logs handshake headers (and so the ticket) at DEBUG."""

    def isEnabledFor(self, level: int) -> bool:  # noqa: N802 - logging API
        return False


def websockets_opener(open_seconds: float = 15.0) -> Opener:
    """The default opener over ``websockets`` (extra ``connect``). It offers ``["pkey-relay.1",
    <ticket>]``, requires ``pkey-relay.1`` echoed back, caps messages at 65,564 bytes, verifies TLS
    against certifi (the store the SDK's HTTP client uses) and never turns verification off."""

    async def open_(url: str, protocols: List[str]) -> RelaySocket:
        try:
            from websockets.asyncio.client import connect
            from websockets.exceptions import ConnectionClosed
        except ImportError as e:
            raise RelayDependencyMissing("websockets is not installed") from e
        ctx = None
        if url.startswith("wss:"):
            import ssl

            import certifi

            ctx = ssl.create_default_context(cafile=certifi.where())
        kw: Dict[str, Any] = {
            "subprotocols": list(protocols),
            "max_size": RELAY_MAX_MESSAGE,
            "logger": _Silent("polaris_key.relay"),
            "open_timeout": open_seconds,
            "ping_interval": None,
        }
        if ctx is not None:
            kw["ssl"] = ctx
        try:
            ws = await connect(url, **kw)
        except RelayDependencyMissing:
            raise
        except Exception:
            # No cause: a handshake error could carry the request.
            raise SocketClosed(None) from None
        if ws.subprotocol != RELAY_PROTOCOL:
            await ws.close(1002)
            raise SocketClosed(1002)

        class _Ws:
            async def send(self, data: bytes) -> None:
                try:
                    await ws.send(data)
                except ConnectionClosed as e:
                    raise SocketClosed(_code(e)) from None

            async def recv(self) -> Any:
                try:
                    return await ws.recv()
                except ConnectionClosed as e:
                    raise SocketClosed(_code(e)) from None

            async def close(self, code: int = 1000) -> None:
                try:
                    await ws.close(code)
                except Exception:
                    pass

            def __repr__(self) -> str:
                return "<RelaySocket>"

        return _Ws()

    return open_


def _code(e: Any) -> Optional[int]:
    # The code the peer sent; else the one this side closed with (1009 for an oversize message).
    for frame in (getattr(e, "rcvd", None), getattr(e, "sent", None)):
        if frame is not None:
            return int(frame.code)
    return None


# -- the service ---------------------------------------------------------------------------------------


class RelayService:
    def __init__(
        self,
        src: LanSource,
        ticket: Callable[[], RelayGrant],
        options: Optional[RelayOptions] = None,
    ) -> None:
        self._src = src
        self._ticket = ticket
        self._o = options or RelayOptions()
        self._loop = asyncio.get_running_loop()
        self._open_socket: Opener = self._o.opener or websockets_opener(self._o.open_seconds)
        self._sleep: Callable[[float], Awaitable[None]] = self._o.sleep or asyncio.sleep
        self._rand: Callable[[], float] = self._o.random or _random
        self._state = "idle"
        self._error: Optional[RelayError] = None
        self._reason: Optional[str] = None
        self._attempts = 0
        self._stopped = False
        self._started = False
        self._ws: Optional[RelaySocket] = None
        self._open = False
        self._members: Set[str] = set()
        self._on_state: List[Callable[[RelayStatus], None]] = []
        self._on_members: List[Callable[[List[str]], None]] = []
        self._waiters: List["asyncio.Future[None]"] = []
        self._sleeping: Optional["asyncio.Future[None]"] = None
        self._last_limit: Optional[int] = None
        self._not_member = 0
        self._task: Optional["asyncio.Future[Any]"] = None
        self._id: Optional[Any] = None
        self._outbox: Optional["asyncio.Queue[bytes]"] = None
        self._docs = PeerDocs(
            PeerDocsSource(
                now=src.now, refresh=src.refresh, adopt_ring=src.adopt_ring, apply_trust=src.apply_trust
            ),
            self._stored,
        )

    def __repr__(self) -> str:
        return "<RelayService state=%s>" % self._state

    def __reduce__(self) -> Any:
        raise TypeError("a relay service cannot be pickled")

    def _stored(self) -> None:
        self._id = None

    # -- the surface --------------------------------------------------------------------------------

    def start(self) -> None:
        """Begin connecting; use :meth:`ready` to wait for the socket."""
        if self._started or self._stopped:
            return
        self._started = True
        self._task = asyncio.ensure_future(self._run())

    @property
    def status(self) -> RelayStatus:
        return RelayStatus(self._state, self._error, self._attempts, self._reason)

    def on_state(self, fn: Callable[[RelayStatus], None]) -> Callable[[], None]:
        self._on_state.append(fn)
        return lambda: self._on_state.remove(fn) if fn in self._on_state else None

    def on_members(self, fn: Callable[[List[str]], None]) -> Callable[[], None]:
        """Called when the room's member list changes (device ids of this person's online devices)."""
        self._on_members.append(fn)
        return lambda: self._on_members.remove(fn) if fn in self._on_members else None

    def on_notice(self, fn: Callable[[ConnectNotice], None]) -> Callable[[], None]:
        return self._docs.on_notice(fn)

    def members(self) -> List[str]:
        """The person's devices online in the room, as of the last MEMBERS (this device included)."""
        return sorted(self._members)

    async def refresh_members(self, timeout: float = 2.0) -> List[str]:
        """Ask the room who is online now (a LIST); returns on the answer or after ``timeout``. The room
        never pushes joins, so this is how a device learns of a new arrival."""
        if not self._open:
            return self.members()
        done: "asyncio.Future[None]" = self._loop.create_future()

        def fire(_m: List[str]) -> None:
            if not done.done():
                done.set_result(None)

        off = self.on_members(fire)
        try:
            self._send_env({"op": "list"})
            await asyncio.wait_for(done, timeout)
        except asyncio.TimeoutError:
            pass
        finally:
            off()
        return self.members()

    async def ready(self, timeout: Optional[float] = None) -> None:
        """Resolves once the socket is open; raises the typed error when the loop is blocked."""
        if self._open:
            return
        if self._state in ("blocked", "stopped", "off"):
            raise self._error or self._stopped_error()
        if not self._started:
            self.start()
        w: "asyncio.Future[None]" = self._loop.create_future()
        self._waiters.append(w)
        try:
            await asyncio.wait_for(w, self._o.open_seconds if timeout is None else timeout)
        except asyncio.TimeoutError:
            raise self._error or RelayError("not_connected", "The relay is not connected.") from None
        finally:
            if w in self._waiters:
                self._waiters.remove(w)

    def resume(self) -> None:
        """After a block (a quota), try again now; otherwise cut a backoff short."""
        if self._stopped:
            return
        if self._state == "blocked":
            self._error = None
            self._attempts = 0
            self._started = True
            self._task = asyncio.ensure_future(self._run())
        elif self._sleeping is not None and not self._sleeping.done():
            self._sleeping.cancel()

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        self._docs.close()
        self._set("stopped")
        self._lose_links()
        ws, self._ws = self._ws, None
        self._open = False
        if self._sleeping is not None:
            self._sleeping.cancel()
        if ws is not None:
            try:
                await ws.close(1000)
            except Exception:
                pass
        task = self._task
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        self._flush(self._stopped_error())

    # -- the connect loop ---------------------------------------------------------------------------

    async def _run(self) -> None:
        while not self._stopped:
            self._set("connecting")
            code: Optional[int] = None
            wait_s = 0.0
            try:
                grant = await self._loop.run_in_executor(None, self._ticket)
                if self._stopped:
                    return
                code = await self._session(grant)
            except RelayDependencyMissing:
                self._reason = "dependency"
                self._error = RelayError("unavailable", "The relay needs the polaris-key[connect] extra.")
                self._set("off")
                self._flush(self._error)
                return
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._stopped:
                    return
                err = e if isinstance(e, RelayError) else RelayError("unavailable", "The relay could not be reached.")
                self._error = err
                if err.reason in ("disabled", "quota"):
                    return self._block(err)
                wait_s = float(err.retry_after_seconds or 0)
            if self._stopped:
                return
            stop = self._after_close(code)
            if stop is not None:
                return self._block(stop)
            self._attempts += 1
            delay = max(self._backoff(), min(wait_s, MAX_RETRY_AFTER_S))
            if self._attempts >= UNAVAILABLE_AFTER:
                self._set("unavailable")
                delay = max(delay, UNAVAILABLE_RETRY_S)
            else:
                self._set("backoff")
            await self._nap(delay)

    async def _nap(self, seconds: float) -> None:
        sleeper = asyncio.ensure_future(self._sleep(seconds))
        self._sleeping = sleeper
        try:
            await sleeper
        except asyncio.CancelledError:
            if self._stopped or not sleeper.cancelled():
                raise
        finally:
            self._sleeping = None

    def _after_close(self, code: Optional[int]) -> Optional[RelayError]:
        """What a close means for the loop: ``None`` to reconnect, else the error that ends it."""
        limit, self._last_limit = self._last_limit, None
        if code is None:
            return None
        if code == 4009:
            return RelayError(
                "replaced", "Another connection of this device took the relay socket.", close_code=code
            )
        if code == 4003:
            # The roster this device holds is out of date: fetch it, and stop if it keeps happening.
            self._want_ring()
            self._not_member += 1
            if self._not_member >= 3:
                return RelayError("not_member", "The room does not know this device.", close_code=code)
            return None
        self._not_member = 0
        if code == 4008 and limit in (2, 3):
            return RelayError(
                "quota", "The relay quota is spent.", close_code=code, scope="product" if limit == 3 else "person"
            )
        return None

    def _block(self, e: RelayError) -> None:
        self._error = e
        self._open = False
        self._set("blocked")
        self._flush(e)

    def _backoff(self) -> float:
        o = self._o
        cap = min(o.backoff_max, o.backoff_base * 2 ** min(max(self._attempts - 1, 0), 16))
        # Equal jitter: half fixed, half random, never under the floor.
        return max(o.backoff_min, cap / 2 + self._rand() * cap / 2)

    # -- one socket ---------------------------------------------------------------------------------

    async def _session(self, grant: RelayGrant) -> Optional[int]:
        """Open one socket and run it to its close. Returns the close code."""
        try:
            ws = await asyncio.wait_for(
                self._open_socket(grant.url, [RELAY_PROTOCOL, grant.ticket]), self._o.open_seconds + 1
            )
        except SocketClosed as e:
            return e.code
        except (asyncio.TimeoutError, OSError):
            return None
        if self._stopped:
            await _quiet(ws.close(1000))
            return None
        self._ws = ws
        self._open = True
        opened_at = self._o.clock()
        self._last_limit = None
        self._error = None
        self._outbox = asyncio.Queue()
        self._set("open")
        for w in self._waiters:
            if not w.done():
                w.set_result(None)
        self._waiters.clear()
        writer = asyncio.ensure_future(self._write(ws, self._outbox))
        pinger = asyncio.ensure_future(self._ping())
        self._send_env({"op": "list"})
        code: Optional[int] = None
        try:
            while True:
                data = await ws.recv()
                if not isinstance(data, (bytes, bytearray)):
                    code = await self._refuse(ws)
                    break
                try:
                    await self._handle(bytes(data))
                except Exception:
                    code = await self._refuse(ws)
                    break
        except SocketClosed as e:
            code = e.code
        finally:
            writer.cancel()
            pinger.cancel()
            was = self._open
            if was and self._o.clock() - opened_at >= self._o.stable_seconds:
                self._attempts = 0
            self._open = False
            if self._ws is ws:
                self._ws = None
            self._outbox = None
            self._members.clear()
            self._lose_links()
            if was:
                self._emit_members()
        return code

    async def _refuse(self, ws: RelaySocket) -> int:
        """A refused envelope: close 1002 and answer nothing."""
        await _quiet(ws.close(1002))
        return 1002

    async def _write(self, ws: RelaySocket, q: "asyncio.Queue[bytes]") -> None:
        try:
            while True:
                await ws.send(await q.get())
        except (SocketClosed, asyncio.CancelledError):
            pass
        except Exception:
            pass  # the reader sees the close

    async def _ping(self) -> None:
        ws = self._ws
        try:
            while self._ws is ws and not self._stopped:
                await self._sleep(self._o.ping_seconds)
                if self._ws is not ws:
                    return
                self._send_env({"op": "ping", "data": os.urandom(8)})
                self._send_env({"op": "list"})
        except asyncio.CancelledError:
            pass

    def _send_env(self, m: Dict[str, Any]) -> None:
        q = self._outbox
        if q is None or not self._open:
            return
        try:
            q.put_nowait(encode_relay(m))
        except ValueError:
            pass

    async def _handle(self, data: bytes) -> None:
        m = decode_relay("toClient", data)
        if m is None:
            raise ValueError("relay envelope")
        op = m["op"]
        if op == "recv":
            await self._recv(m["from"], m["session"], m["noise"])
        elif op == "members":
            self._members = {b64url_encode(d) for d in m["devices"]}
            self._emit_members()
        elif op == "ring":
            # The roster changed. Fetch the newer one under the normal replacement rules; the epoch
            # is only a hint of whether it is newer than the one held.
            ident = await self._identity(False, quiet=True)
            if ident is None or m["epoch"] > ident.ring_epoch:
                self._want_ring()
        elif op == "gone":
            self._members.discard(b64url_encode(m["device"]))
            self._gone(m["device"])
            self._emit_members()
        elif op == "limit":
            self._limit(m["reason"])
        # pong: nothing to do

    def _limit(self, reason: int) -> None:
        self._last_limit = reason
        why = "rate_limited" if reason == 1 else "paused" if reason == 4 else "quota"
        msg = (
            "The relay is paused."
            if why == "paused"
            else "The relay quota is spent."
            if why == "quota"
            else "Slow down: the relay is rate limiting this device."
        )
        scope = ("product" if reason == 3 else "person") if reason in (2, 3) else None
        self._error = RelayError(why, msg, scope=scope)
        self._set(self._state)

    # -- sessions (CC-10.14) ------------------------------------------------------------------------

    async def _recv(self, frm: bytes, session: int, noise: bytes) -> None:
        """A RECV envelope. Peer sessions are CC-10.14; until then it is dropped."""

    def _gone(self, device: bytes) -> None:
        """The room dropped a device: its sessions end (CC-10.14)."""

    def _lose_links(self) -> None:
        """The socket is gone: every session ends without a word (CC-10.14)."""

    # -- identity and documents ---------------------------------------------------------------------

    async def _identity(self, force: bool, quiet: bool = False) -> Optional[PeerSource]:
        now = self._src.now()
        held = self._id
        if not force and held is not None and now - held[0] < IDENTITY_TTL_S and held[1].cert_expires_at - now > CERT_MARGIN_S:
            return held[1]  # type: ignore[no-any-return]
        try:
            v: PeerSource = await self._loop.run_in_executor(None, self._src.load)
        except Exception:
            if quiet:
                return None
            raise
        self._id = (now, v)
        pushed = self._docs.pushed
        if pushed is not None and pushed[1] <= v.ring_epoch:
            self._docs.pushed = None
        return v

    def _want_ring(self) -> None:
        # The refresh calls the Worker: never on the loop.
        self._loop.run_in_executor(None, self._docs.want_ring)

    # -- bookkeeping --------------------------------------------------------------------------------

    def _set(self, s: str) -> None:
        self._state = s
        st = self.status
        for f in list(self._on_state):
            try:
                f(st)
            except Exception:
                pass

    def _emit_members(self) -> None:
        m = self.members()
        for f in list(self._on_members):
            try:
                f(m)
            except Exception:
                pass

    def _flush(self, e: RelayError) -> None:
        for w in self._waiters:
            if not w.done():
                w.set_exception(e)
        self._waiters.clear()

    @staticmethod
    def _stopped_error() -> RelayError:
        return RelayError("stopped", "The relay is stopped.")


def _random() -> float:
    import random

    return random.random()


async def _quiet(aw: Awaitable[Any]) -> None:
    try:
        await aw
    except Exception:
        pass
