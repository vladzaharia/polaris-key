"""The contact relay (CC-19.6; WIRE-CONTRACT-V5 §15.7 "Contact rooms", §15.10). A room joins the two devices
of one link, who may belong to two accounts. Each contact has its own room, named by the ``rid`` both sides
derive from the contact secret, and each session inside it is a :class:`~polaris_key.core.peer_session.PeerSession`
in mode ``c``: Noise XXpsk0 under the contact secret, the device's agreeKey as the static key and the pin on
the contact's key. Mirrors ``packages/sdk-node/src/connect/contactRelay.ts``. Lives on the Connect loop (D-3).

Rules this module keeps:

- a contact ticket is asked for with the body ``{"room": "c", "rid": ...}``; the answer must echo
  ``room: "c"`` (``ConnectClient.relay_ticket``), else the Worker predates contact rooms and nothing is
  connected;
- the room speaks aliases, never device ids: ``from``, ``to`` and ``MEMBERS`` carry
  SHA-256(rid || deviceId)[0..24]. This device computes its own and learns the peer's as the member that is
  not it; nothing here sees the peer's device id, subject or certificate;
- the relay carries mode ``c`` here and nothing else; the Noise pin (the contact's agreeKey) is what names
  the peer, not the room's stamp;
- a room is kept for each contact marked reachable (at most ``MAX_LIVE_CONTACT_ADVERTS``); any other contact
  gets a short-lived room for one dial, stopped when its last session ends. The Worker allows 30 contact
  tickets an hour per device, so a reconnect backs off to minutes;
- an envelope that fails its layout, or a text frame, closes the socket with 1002; a SEND to an offline peer
  is dropped by the room silently, so a dial is made only to a peer ``MEMBERS`` lists;
- the contact secret is held as a copy for the room and wiped when the room stops.
"""

from __future__ import annotations

import asyncio
import os
from collections import deque
from typing import Any, Awaitable, Callable, Deque, Dict, List, Optional, Tuple

from ..core.peer_contact import MAX_LIVE_CONTACT_ADVERTS, contact_alias, contact_rid
from ..core.peer_relay_codec import decode_relay, encode_relay
from ..core.peer_session import ContactLink, HandshakeLimiter
from .channel import contact_channel
from .client import PeerSource, RelayGrant
from .contacts import LiveContact, ref_of, wipe_live
from .errors import RELAY_PROTOCOL, RelayError
from .lan import LanSource
from .pacer import Outbox, Pacer
from .relay import (
    ENDED_MEMORY,
    MAX_RETRY_AFTER_S,
    RelayLink,
    RelayOptions,
    RelaySocket,
    RelayStatus,
    SocketClosed,
    websockets_opener,
)
from .session import ConnectSession, session_handlers

__all__ = ["ContactRelay", "ContactRelaySource", "ContactRoom"]

MAX_ROOM_SESSIONS = 4
#: First messages held before ``MEMBERS`` names the peer (WIRE-CONTRACT-V5 section 15.7).
MAX_DEFERRED = 8
#: Contact tickets are limited to 30 an hour per device (§15.7): back off in minutes.
BACKOFF_BASE_S = 5.0
BACKOFF_MAX_S = 600.0
_MAX_SESSION_ID = 0xFFFFFFFF


class ContactRelaySource:
    """What the contact relay needs: the LAN source (identity, contacts) plus a contact ticket."""

    def __init__(
        self,
        lan: LanSource,
        ticket: Callable[[str], RelayGrant],
    ) -> None:
        self.lan = lan
        #: ``POST relay/ticket`` with ``{"room": "c", "rid": rid}``. Raises :class:`RelayError`. Blocking.
        self.ticket = ticket


class ContactRoom:
    """The room of one contact: a socket, its members and the sessions inside."""

    def __init__(
        self,
        src: ContactRelaySource,
        contact: LiveContact,
        options: RelayOptions,
        on_session: Callable[[ConnectSession], None],
        on_idle: Callable[["ContactRoom"], None],
        transient: bool,
    ) -> None:
        self._src = src
        self._contact = contact
        self._o = options
        self._on_session = on_session
        self._on_idle = on_idle
        self.transient = transient
        self.id = contact.id
        self.pending = contact.pending
        self.rid = contact_rid(bytes(contact.secret))
        self._secret = bytearray(contact.secret)
        self._agree = contact.agree_key
        self._ref = ref_of(contact)
        self._loop = asyncio.get_running_loop()
        self._open_socket = options.opener or websockets_opener(options.open_seconds)
        self._sleep: Callable[[float], Awaitable[None]] = options.sleep or asyncio.sleep
        self._rand: Callable[[], float] = options.random or _random
        self._state = "idle"
        self._error: Optional[RelayError] = None
        self._attempts = 0
        self._stopped = False
        self._started = False
        self._ws: Optional[RelaySocket] = None
        self._open = False
        self._outbox: Optional[Outbox] = None
        self._pacer: Optional[Pacer] = None
        self._pong_at = 0.0
        self._own: Optional[bytes] = None
        self._peer_alias: Optional[bytes] = None
        #: Messages that arrived before ``MEMBERS``: (from, session, noise), at most ``MAX_DEFERRED``.
        self._deferred: List[Tuple[bytes, int, bytes]] = []
        self._links: Dict[str, RelayLink] = {}
        self._ended: Deque[str] = deque(maxlen=ENDED_MEMORY)
        self._waiters: List["asyncio.Future[None]"] = []
        self._on_members: List[Callable[[], None]] = []
        self._sleeping: Optional["asyncio.Future[None]"] = None
        self._task: Optional["asyncio.Future[Any]"] = None
        self._last_limit: Optional[int] = None
        self._not_member = 0
        self._limiter = HandshakeLimiter(5, 4)
        self._id: Optional[PeerSource] = None

    def __repr__(self) -> str:
        return "<ContactRoom state=%s>" % self._state

    def __reduce__(self) -> Any:
        raise TypeError("a contact room cannot be pickled")

    @property
    def status(self) -> RelayStatus:
        return RelayStatus(self._state, self._error, self._attempts)

    @property
    def peer_online(self) -> bool:
        """Whether the room's peer is listed in the room now."""
        return self._peer_alias is not None

    def start(self) -> None:
        if self._started or self._stopped:
            return
        self._started = True
        self._task = asyncio.ensure_future(self._run())

    async def ready(self, timeout: Optional[float] = None) -> None:
        """Resolves once the socket is open; raises the typed error when the loop is blocked."""
        if self._open:
            return
        if self._state in ("blocked", "stopped", "off"):
            raise self._error or RelayError("stopped", "The relay is stopped.")
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

    async def refresh_members(self, timeout: float = 2.0) -> None:
        """Ask the room who is in it; returns on the answer or after ``timeout``."""
        if not self._open:
            return
        done: "asyncio.Future[None]" = self._loop.create_future()

        def fire() -> None:
            if not done.done():
                done.set_result(None)

        self._on_members.append(fire)
        try:
            self._send_env({"op": "list"})
            await asyncio.wait_for(done, timeout)
        except asyncio.TimeoutError:
            pass
        finally:
            if fire in self._on_members:
                self._on_members.remove(fire)

    async def dial(self) -> ConnectSession:
        """Open a session to the contact in this room: the peer must be listed (a SEND to an absent one
        is dropped by the room)."""
        await self.ready()
        if self._peer_alias is None:
            await self.refresh_members()
        peer = self._peer_alias
        if peer is None:
            raise RelayError("unknown_peer", "That contact is not online.")
        ident = await self._identity()
        assert ident is not None  # not quiet: a failed load raised
        link = self._make_link(peer, self._new_session_id(peer), "initiator", ident)
        if link is None:
            raise RelayError("busy", "Too many relay sessions are open.")
        link.start()
        try:
            return await link.opened  # type: ignore[no-any-return]
        except RelayError:
            raise
        except Exception:
            raise RelayError("handshake_failed", "The handshake failed.") from None

    def abort(self) -> None:
        """Force-end from another thread: no goodbye, nothing waited on."""
        self._stopped = True
        try:
            self._loop.call_soon_threadsafe(self._abort_on_loop)
        except RuntimeError:
            pass

    def _abort_on_loop(self) -> None:
        self._set("stopped")
        self._lose_links()
        ws, self._ws = self._ws, None
        self._open = False
        if self._sleeping is not None:
            self._sleeping.cancel()
        if self._task is not None:
            self._task.cancel()
        if ws is not None:
            asyncio.ensure_future(ws.close(1001))
        self._flush(RelayError("stopped", "The relay is stopped."))
        self._wipe()

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        self._set("stopped")
        q = self._outbox
        for lk in list(self._links.values()):
            lk.close_nowait("peer_bye")
        if q is not None and self._open:
            await q.drained(1.0)
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
        self._flush(RelayError("stopped", "The relay is stopped."))
        self._wipe()

    def _wipe(self) -> None:
        for i in range(len(self._secret)):
            self._secret[i] = 0

    # -- the connect loop ---------------------------------------------------------------------------

    async def _run(self) -> None:
        while not self._stopped:
            self._set("connecting")
            code: Optional[int] = None
            wait_s = 0.0
            try:
                grant = await self._loop.run_in_executor(None, self._src.ticket, self.rid)
                if self._stopped:
                    return
                code = await self._session(grant)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._stopped:
                    return
                err = e if isinstance(e, RelayError) else RelayError("unavailable", "The relay could not be reached.")
                self._error = err
                if err.reason in ("disabled", "links_disabled", "contact_unsupported", "quota"):
                    return self._block(err)
                wait_s = float(err.retry_after_seconds or 0)
                if err.code == "rate_limited" and wait_s == 0:
                    wait_s = 60.0
            if self._stopped:
                return
            stop = self._after_close(code)
            if stop is not None:
                return self._block(stop)
            self._attempts += 1
            self._set("backoff")
            await self._nap(max(self._backoff(), min(wait_s, MAX_RETRY_AFTER_S)))

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
        limit, self._last_limit = self._last_limit, None
        if code is None:
            return None
        if code == 4009:
            return RelayError("replaced", "Another socket took this room.", close_code=code)
        if code == 4003:
            # The room is full, or links were switched off: a few tries, then stop.
            self._not_member += 1
            if self._not_member >= 3:
                return RelayError("not_member", "The room does not admit this device.", close_code=code)
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
        base = max(o.backoff_base, BACKOFF_BASE_S)
        top = max(o.backoff_max, BACKOFF_MAX_S)
        cap = min(top, base * 2 ** min(max(self._attempts - 1, 0), 16))
        return max(o.backoff_min, cap / 2 + self._rand() * cap / 2)

    # -- one socket ---------------------------------------------------------------------------------

    async def _session(self, grant: RelayGrant) -> Optional[int]:
        try:
            ws = await asyncio.wait_for(
                self._open_socket(grant.url, [RELAY_PROTOCOL, grant.ticket]), self._o.open_seconds + 1
            )
        except SocketClosed as e:
            return e.code
        except (asyncio.TimeoutError, OSError):
            return None
        if self._stopped:
            try:
                await ws.close(1000)
            except Exception:
                pass
            return None
        self._ws = ws
        self._open = True
        opened_at = self._pong_at = self._o.clock()
        self._last_limit = None
        self._error = None
        outbox = self._outbox = Outbox()
        self._pacer = pacer = (self._o.pacer or Pacer)()
        self._set("open")
        for w in self._waiters:
            if not w.done():
                w.set_result(None)
        self._waiters.clear()
        writer = asyncio.ensure_future(self._write(ws, outbox, pacer))
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
            self._outbox = self._pacer = None
            self._peer_alias = None
            self._deferred = []
            self._lose_links()
        return code

    async def _refuse(self, ws: RelaySocket) -> int:
        try:
            await ws.close(1002)
        except Exception:
            pass
        return 1002

    async def _write(self, ws: RelaySocket, q: Outbox, pacer: Pacer) -> None:
        try:
            while True:
                data = await q.get()
                await pacer.acquire()
                await ws.send(data)
                q.sent()
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
                if ws is not None and self._o.clock() - self._pong_at > 2 * self._o.ping_seconds:
                    try:
                        await asyncio.wait_for(ws.close(1001), 5.0)
                    except Exception:
                        pass
                    return
                self._send_env({"op": "ping", "data": os.urandom(8)})
        except asyncio.CancelledError:
            pass

    def _send_env(self, m: Dict[str, Any]) -> None:
        q = self._outbox
        if q is None or not self._open:
            return
        try:
            q.put(encode_relay(m), force=True)
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
            own = await self._own_alias()
            # The room holds this device and the one peer: the member that is not this device.
            self._peer_alias = next((d for d in m["devices"] if bytes(d) != own), None)
            for f in list(self._on_members):
                f()
            held, self._deferred = self._deferred, []
            for frm, sess, noise in held:
                await self._recv(frm, sess, noise, False)
        elif op == "gone":
            if self._peer_alias is not None and bytes(self._peer_alias) == bytes(m["device"]):
                self._peer_alias = None
                for lk in [lk for lk in self._links.values() if lk.peer == bytes(m["device"])]:
                    lk.lost()
        elif op == "limit":
            self._limit(m["reason"])
        elif op == "pong":
            self._pong_at = self._o.clock()
        # ``ring`` never comes from a contact room.

    def _limit(self, reason: int) -> None:
        self._last_limit = reason
        if reason == 1 and self._pacer is not None:
            self._pacer.halve()
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

    # -- sessions -----------------------------------------------------------------------------------

    async def _recv(self, frm: bytes, session: int, noise: bytes, can_defer: bool = True) -> None:
        frm = bytes(frm)
        key = "%s:%d" % (frm.hex(), session)
        known = self._links.get(key)
        if known is not None:
            known.receive(noise)
            return
        if key in self._ended:
            return
        own = await self._own_alias()
        # The room stamps ``from``; one that is this device's own alias cannot be the peer.
        if frm == own:
            return
        # The peer is whom MEMBERS says, never whom a first message claims: hold it (bounded) until MEMBERS.
        peer = self._peer_alias
        if peer is None:
            if can_defer and len(self._deferred) < MAX_DEFERRED:
                self._deferred.append((frm, session, noise))
                self._send_env({"op": "list"})
            return
        if bytes(peer) != frm:
            return
        ident = await self._identity(quiet=True)
        if ident is None or self._stopped or not self._open:
            return
        live = sum(1 for lk in self._links.values() if not lk.ended)
        if live >= MAX_ROOM_SESSIONS:
            return
        link = self._make_link(frm, session, "responder", ident)
        if link is not None:
            link.receive(noise)

    def _make_link(self, peer: bytes, session_id: int, role: str, ident: PeerSource) -> Optional[RelayLink]:
        if len(self._links) >= MAX_ROOM_SESSIONS:
            return None
        peer = bytes(peer)
        key = "%s:%d" % (peer.hex(), session_id)
        o = self._o

        def established(s: ConnectSession) -> None:
            ref = s.contact
            if ref is not None and ref.pending:
                fn = self._src.lan.contact_established
                if fn is not None:
                    self._loop.run_in_executor(None, lambda: _quiet_call(fn, ref))
            if role == "responder":
                self._on_session(s)

        def ended() -> None:
            if self.transient and not any(not lk.ended for lk in self._links.values()):
                self._on_idle(self)

        handlers = session_handlers(
            role, on_established=established, on_ended=ended, path="relay", contacts=[self._ref], xfer=o.xfer
        )
        options: Dict[str, Any] = {
            **contact_channel(
                ident,
                caps=o.caps,
                label=o.label,
                now=self._src.lan.now,
                rekey_messages=o.rekey_messages,
                rekey_seconds=o.rekey_seconds,
            ),
            "role": role,
            "contacts": [ContactLink(bytes(self._secret), self._agree)],
        }
        if role == "responder":
            options["admission"] = self._limiter
        link = RelayLink(self, peer, session_id, key, role, options, handlers, o.handshake_seconds)
        self._links[key] = link
        return link

    def _link_ended(self, link: RelayLink) -> None:
        if self._links.get(link.key) is link:
            del self._links[link.key]
        self._ended.append(link.key)

    def _new_session_id(self, peer: bytes) -> int:
        while True:
            n = int.from_bytes(os.urandom(4), "big")
            k = "%s:%d" % (bytes(peer).hex(), n)
            if n <= _MAX_SESSION_ID and k not in self._links and k not in self._ended:
                return n

    def _lose_links(self) -> None:
        for lk in list(self._links.values()):
            lk.lost()

    def _send_session(self, peer: bytes, session: int, noise: bytes) -> None:
        self._send_env({"op": "send", "to": peer, "session": session, "noise": noise})

    def _has_room(self, n: int) -> bool:
        q = self._outbox
        return q is not None and q.room_for(n)

    async def _identity(self, quiet: bool = False) -> Optional[PeerSource]:
        try:
            v: PeerSource = await self._loop.run_in_executor(None, self._src.lan.load)
        except Exception:
            if quiet:
                return None
            raise
        self._id = v
        return v

    async def _own_alias(self) -> bytes:
        if self._own is None:
            ident = await self._identity()
            assert ident is not None
            self._own = contact_alias(self.rid, ident.device_id)
        return self._own

    # -- bookkeeping --------------------------------------------------------------------------------

    def _set(self, s: str) -> None:
        self._state = s

    def _flush(self, e: RelayError) -> None:
        for w in self._waiters:
            if not w.done():
                w.set_exception(e)
        self._waiters.clear()


def _quiet_call(fn: Callable[[Any], Any], arg: Any) -> None:
    try:
        fn(arg)
    except Exception:
        pass


def _random() -> float:
    import random

    return random.random()


class ContactRelay:
    """The contact rooms of one device: a room kept for each contact marked reachable, and a short-lived
    one for a dial to any other."""

    def __init__(self, src: ContactRelaySource, options: Optional[RelayOptions] = None) -> None:
        self._src = src
        self._o = options or RelayOptions()
        self._rooms: Dict[Tuple[str, bool], ContactRoom] = {}
        self._stopped = False
        self._on_session: List[Callable[[ConnectSession], None]] = []
        self._lock = asyncio.Lock()
        self._unsub: Optional[Callable[[], None]] = None
        self._loop = asyncio.get_running_loop()
        self._held: List[LiveContact] = []
        self._tasks: "set[asyncio.Future[Any]]" = set()

    def __repr__(self) -> str:
        return "<ContactRelay rooms=%d>" % len(self._rooms)

    async def start(self) -> None:
        """Keep a room for each contact marked reachable now, and follow the list."""
        fn = self._src.lan.on_contacts
        if fn is not None:
            self._unsub = fn(self._changed)
        await self.sync()

    def _changed(self) -> None:
        try:
            self._loop.call_soon_threadsafe(self._spawn_sync)
        except RuntimeError:
            pass

    def _spawn_sync(self) -> None:
        if self._stopped:
            return
        t = asyncio.ensure_future(self._quiet_sync())
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def _quiet_sync(self) -> None:
        try:
            await self.sync()
        except Exception:
            pass

    def on_session(self, fn: Callable[[ConnectSession], None]) -> Callable[[], None]:
        self._on_session.append(fn)
        return lambda: self._on_session.remove(fn) if fn in self._on_session else None

    def rooms(self) -> List[Tuple[str, bool, RelayStatus, bool]]:
        """The rooms and their state, as ``(id, pending, status, transient)``."""
        return [(r.id, r.pending, r.status, r.transient) for r in self._rooms.values()]

    async def sync(self) -> None:
        """Bring the standing rooms to match the contacts: one per reachable contact, at most 8."""
        async with self._lock:
            if self._stopped:
                return
            fn = self._src.lan.contacts
            nxt: List[LiveContact] = list(await self._loop.run_in_executor(None, fn)) if fn is not None else []
            old, self._held = self._held, nxt
            wipe_live(old)
            want = {(c.id, c.pending): c for c in [c for c in nxt if c.reachable][:MAX_LIVE_CONTACT_ADVERTS]}
            for k, room in list(self._rooms.items()):
                # A transient room is the dial's own; a standing one goes when its contact is gone.
                if room.transient or k in want:
                    continue
                del self._rooms[k]
                await _quiet(room.stop())
            for k, c in want.items():
                if k in self._rooms:
                    continue
                room = ContactRoom(self._src, c, self._o, self._deliver, self._idle, False)
                self._rooms[k] = room
                room.start()

    def _deliver(self, s: ConnectSession) -> None:
        for f in list(self._on_session):
            try:
                f(s)
            except Exception:
                pass  # a host callback never ends a session

    def _idle(self, room: ContactRoom) -> None:
        t = asyncio.ensure_future(self._drop(room))
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def _drop(self, room: ContactRoom) -> None:
        k = (room.id, room.pending)
        if self._rooms.get(k) is room:
            del self._rooms[k]
        await _quiet(room.stop())

    async def dial(self, contact_id: str, pending: bool = False) -> ConnectSession:
        """A session to a contact over its room. Raises :class:`RelayError`."""
        if self._stopped:
            raise RelayError("stopped", "The relay is stopped.")
        k = (contact_id, pending)
        room = self._rooms.get(k)
        if room is None:
            fn = self._src.lan.contacts
            live: List[LiveContact] = list(await self._loop.run_in_executor(None, fn)) if fn is not None else []
            try:
                c = next((x for x in live if x.id == contact_id and x.pending == pending), None)
                if c is None:
                    raise RelayError("unknown_peer", "That is not a contact.")
                room = ContactRoom(self._src, c, self._o, self._deliver, self._idle, True)
            finally:
                wipe_live(live)
            self._rooms[k] = room
            room.start()
        try:
            return await room.dial()
        except BaseException:
            if room.transient:
                await self._drop(room)
            raise

    def abort(self) -> None:
        self._stopped = True
        if self._unsub is not None:
            self._unsub()
            self._unsub = None
        for r in list(self._rooms.values()):
            r.abort()
        self._rooms.clear()
        wipe_live(self._held)
        self._held = []

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self._unsub is not None:
            self._unsub()
            self._unsub = None
        async with self._lock:
            pass
        for r in list(self._rooms.values()):
            await _quiet(r.stop())
        self._rooms.clear()
        wipe_live(self._held)
        self._held = []


async def _quiet(aw: Awaitable[Any]) -> None:
    try:
        await aw
    except Exception:
        pass
