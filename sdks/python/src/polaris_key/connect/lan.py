"""The LAN half of Cloud Connect (CC-10.12; WIRE-CONTRACT-V5 §15.4 to §15.6): advertise this device
under the account instance name, browse for the person's other devices, listen on TCP and dial. Mirrors
``packages/sdk-node/src/connect/lan.ts``. A :class:`LanService` lives on the Connect loop (D-3): build
it with ``await LanService.start(...)`` there; the facade marshals the host's calls (CC-10.15).

Rules this module keeps:

- the advert is ``p1-`` plus HMAC(K_disc, epoch, deviceId) with ``v=1``, ``m=a`` and nothing else; it
  is renewed at every 15-minute epoch boundary and when K_disc changes, and uses only the newest key (G4);
- a browse hit is kept only if it matches a roster device (never this one) under the current or previous
  epoch and either delivered key; everything else is dropped, and a name that did not match is not
  worked out twice;
- the listener starts a handshake only when this device holds a verified identity. The handshake
  (XXpsk0) and admission (certificate, roster, expiry, revocation) run in the session engine; a failed
  tag closes the socket without a word (G2);
- sockets that have not been admitted are bounded: at most 32 in total, 4 per source address and 16 per
  /64, each living at most 30 seconds, handshake frames at most 16 KiB (G7);
- an address is allowed by ``lan_verdict`` (§15.4.1; RFC 1918, fe80::/10, a ULA or on-link global address;
  loopback only when the caller opts in, for tests). An accepted socket is judged on its own peer and local
  address before it takes a slot and before any byte is read, and one that fails is closed at once; a dialled
  address is judged as text before a socket exists and on the connected socket before its first byte (G6).
  The certificate's device must be the one dialled, or the session closes ``wrong_peer`` (G8);
- one TCP port serves both families: a dual-stack ``::`` listener (``IPV6_V6ONLY`` off), falling back to
  ``0.0.0.0``; a device with several learned addresses dials them in a race (:mod:`.dial`);
- the device's X25519 private key never leaves the key port (G1): the session is given the
  :class:`~polaris_key.connect.client.PeerSource` static-key handle, whose ``dh`` calls the port.
"""

from __future__ import annotations

import asyncio
import os
import socket
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Sequence, Set, Tuple

from ..core.peer_advert import ADVERT_EPOCH_SECONDS, BrowseHit, account_instance, advert_epoch, browse_table, parse_txt
from ..core.peer_link import SocketLink
from ..core.peer_mdns import MdnsAdapter, MdnsAdvert, MdnsFound, MdnsHandle, MulticastDnsAdapter
from .channel import ConnectNotice, PeerDocs, PeerDocsSource, channel_base
from .client import ConnectClient, PeerSource
from .dial import dial_race
from .errors import LanError
from .lan_judge import PendingLimiter, limiter_keys, socket_text, socket_verdict, text_verdict
from .session import ConnectSession, session_handlers, wait_opened

__all__ = [
    "LanOptions",
    "LanPeer",
    "LanService",
    "LanSource",
    "MAX_PENDING",
    "MAX_PENDING_PER_ADDRESS",
    "MAX_PENDING_PER_64",
    "MAX_SESSIONS",
    "MAX_SESSIONS_PER_PEER",
    "lan_source",
]

#: Unauthenticated sockets at once, per source address and per /64 (G7, §15.4.1).
MAX_PENDING = 32
MAX_PENDING_PER_ADDRESS = 4
MAX_PENDING_PER_64 = 16
#: Open sessions at once.
MAX_SESSIONS = 64
#: Open sessions with one device at once (the relay's ``max_pending_per_peer`` counts the same way).
MAX_SESSIONS_PER_PEER = 4
HANDSHAKE_SECONDS = 30.0
DIAL_SECONDS = 10.0
IDENTITY_TTL_S = 30
CERT_MARGIN_S = 60
MISS_CACHE = 1024


@dataclass
class LanSource:
    """What the LAN service needs of the client. ``load`` is blocking (it may read the key store and
    call the Worker); the service runs it on a worker thread. ``now`` is epoch seconds. ``refresh`` asks
    the Worker for a newer roster (raises on failure); ``adopt_ring`` stores a roster a peer pushed and
    ``apply_trust`` applies a trust manifest a peer pushed: each may be ``None`` (the document is then
    refused as ``unsupported``)."""

    load: Callable[[], PeerSource]
    now: Callable[[], int]
    refresh: Optional[Callable[[], Any]] = None
    adopt_ring: Optional[Callable[[str], Any]] = None
    apply_trust: Optional[Callable[[str], Any]] = None


def lan_source(
    client: ConnectClient,
    *,
    now: Optional[Callable[[], int]] = None,
    apply_trust: Optional[Callable[[str], Any]] = None,
) -> LanSource:
    """The LAN service's source over a :class:`ConnectClient`."""
    return LanSource(
        load=client.peer_source,
        now=now or (lambda: int(time.time())),
        refresh=lambda: client.identity(refresh=True),
        adopt_ring=client.adopt_ring,
        apply_trust=apply_trust,
    )


@dataclass
class LanOptions:
    """``mdns`` is the discovery adapter (default :class:`MulticastDnsAdapter`, with ``interfaces`` as
    the ``lan.interfaces`` override). ``port`` 0 picks a random port each listen (§15.4).
    ``allow_loopback`` accepts and dials 127.0.0.0/8 and ``::1``: for tests and same-host use only, and not
    public API. ``host`` is where to listen: by default ``::`` (both families on one port), or ``0.0.0.0``
    where IPv6 is unavailable."""

    mdns: Optional[MdnsAdapter] = None
    host: Optional[str] = None
    port: int = 0
    caps: Sequence[str] = ("app/1",)
    label: Optional[str] = None
    advertise: bool = True
    browse: bool = True
    allow_loopback: bool = False
    interfaces: Optional[Sequence[str]] = None
    max_pending: int = MAX_PENDING
    max_pending_per_address: int = MAX_PENDING_PER_ADDRESS
    max_pending_per_64: int = MAX_PENDING_PER_64
    max_sessions: int = MAX_SESSIONS
    max_sessions_per_peer: int = MAX_SESSIONS_PER_PEER
    rekey_messages: Optional[int] = None
    rekey_seconds: Optional[float] = None
    handshake_seconds: float = HANDSHAKE_SECONDS
    dial_seconds: float = DIAL_SECONDS
    #: Schedule ``fn`` after ``seconds``; returns the cancel. Default: the running loop's ``call_later``.
    timer: Optional[Callable[[Callable[[], None], float], Callable[[], None]]] = None


class LanPeer(NamedTuple):
    device_id: str
    host: str
    port: int
    #: Other addresses seen for the device; tried in order when ``host`` does not answer.
    alt_hosts: Tuple[str, ...] = ()


class _GatedProtocol(asyncio.StreamReaderProtocol):
    """``start_server``'s protocol with the address gate in ``connection_made``: a transport the gate
    refuses is aborted there, before its reader is added, so no byte is ever read from it."""

    def __init__(
        self,
        reader: asyncio.StreamReader,
        callback: Callable[[Any, Any], Awaitable[None]],
        gate: Callable[[Any], bool],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        super().__init__(reader, callback, loop=loop)
        self._gate = gate

    def connection_made(self, transport: Any) -> None:
        if not self._gate(transport):
            transport.abort()
            return
        super().connection_made(transport)


class LanService:
    def __init__(self, src: LanSource, o: LanOptions) -> None:
        self._src = src
        self._o = o
        self._loop = asyncio.get_running_loop()
        self._server: Any = None
        self._port = 0
        self._mdns: MdnsAdapter = o.mdns or MulticastDnsAdapter(
            allow_loopback=o.allow_loopback, interfaces=o.interfaces
        )
        self._adv: Optional[MdnsHandle] = None
        self._adv_name = ""
        self._browse: Optional[MdnsHandle] = None
        self._cancel_epoch: Optional[Callable[[], None]] = None
        self._id: Optional[Tuple[int, PeerSource]] = None
        self._peers: Dict[str, Tuple[LanPeer, str]] = {}
        self._miss: Dict[str, int] = {}
        self._tab: Optional[Tuple[Tuple[int, Tuple[bytes, ...], Tuple[str, ...]], Dict[str, BrowseHit]]] = None
        self._pending: Set[Any] = set()
        self._limit = PendingLimiter(o.max_pending, o.max_pending_per_address, o.max_pending_per_64)
        #: Accepted transports that hold a slot and have not reached ``_accept`` yet.
        self._slots: Dict[Any, Callable[[], None]] = {}
        self._links: Set[SocketLink] = set()
        self._sessions: Set[ConnectSession] = set()
        self._tasks: Set["asyncio.Future[Any]"] = set()
        self._on_session: List[Callable[[ConnectSession], None]] = []
        self._on_peer: List[Callable[[LanPeer], None]] = []
        self._stopped = False
        self._rotate_lock = asyncio.Lock()
        self._docs = PeerDocs(
            PeerDocsSource(
                now=src.now, refresh=src.refresh, adopt_ring=src.adopt_ring, apply_trust=src.apply_trust
            ),
            self._stored_from_worker,
        )

    def __repr__(self) -> str:
        return "<LanService port=%d>" % self._port

    def __reduce__(self) -> Any:
        raise TypeError("a LAN service cannot be pickled")

    # -- lifecycle --------------------------------------------------------------------------------

    @classmethod
    async def start(cls, src: LanSource, options: Optional[LanOptions] = None) -> "LanService":
        """Listen, then advertise and browse. Raises :class:`LanError` (``no_identity``, ``no_keys``)
        when there is no identity to start with."""
        s = cls(src, options or LanOptions())
        try:
            await s._identity(True)
            await s._listen()
            if s._o.advertise:
                await s._rotate()
            if s._o.browse:
                await s._start_browse()
        except BaseException:
            await s.stop()
            raise
        return s

    @property
    def port(self) -> int:
        """The TCP port this listen uses."""
        return self._port

    def peers(self) -> List[LanPeer]:
        """Roster devices seen on the network right now."""
        return [p for p, _ in self._peers.values()]

    def on_notice(self, fn: Callable[[ConnectNotice], None]) -> Callable[[], None]:
        """Called for each pushed ``RING`` or ``TRUST`` once it is stored, applied or refused."""
        return self._docs.on_notice(fn)

    def on_peer(self, fn: Callable[[LanPeer], None]) -> Callable[[], None]:
        self._on_peer.append(fn)
        return lambda: self._on_peer.remove(fn) if fn in self._on_peer else None

    def on_session(self, fn: Callable[[ConnectSession], None]) -> Callable[[], None]:
        """Called for each inbound session once it is open and admitted."""
        self._on_session.append(fn)
        return lambda: self._on_session.remove(fn) if fn in self._on_session else None

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        self._docs.close()
        if self._cancel_epoch is not None:
            self._cancel_epoch()
            self._cancel_epoch = None
        self._abort_unadmitted()
        for t in list(self._tasks):
            t.cancel()
        for s in list(self._sessions):
            try:
                s.close()
            except Exception:
                pass
        await asyncio.gather(
            self._quiet(self._adv.stop() if self._adv is not None else None),
            self._quiet(self._browse.stop() if self._browse is not None else None),
            self._close_server(),
        )
        self._adv = self._browse = None

    def abort(self) -> None:
        """Force-end the service from another thread, without a graceful close, when the loop's thread is
        held by a host callback. The derived discovery table is dropped now; the listener, the browser,
        the advert and every socket are cancelled on the loop as soon as it is free."""
        self._stopped = True
        self._tab = None
        try:
            self._loop.call_soon_threadsafe(self._abort_on_loop)
        except RuntimeError:
            pass

    def _abort_on_loop(self) -> None:
        self._docs.close()
        if self._cancel_epoch is not None:
            self._cancel_epoch()
            self._cancel_epoch = None
        self._abort_unadmitted()
        for t in list(self._tasks):
            t.cancel()
        for s in list(self._sessions):
            try:
                s.close()
            except Exception:
                pass
        srv = self._server
        if srv is not None:
            try:
                srv.close()
            except Exception:
                pass
        for h in (self._adv, self._browse):
            if h is not None:
                asyncio.ensure_future(self._stop_handle(h))
        self._adv = self._browse = None

    def _abort_unadmitted(self) -> None:
        for w in list(self._pending):
            self._abort(w)
        for t in list(self._slots):
            self._abort(t)

    @staticmethod
    async def _stop_handle(h: Any) -> None:
        try:
            await h.stop()
        except Exception:
            pass

    @staticmethod
    async def _quiet(aw: Optional[Awaitable[Any]]) -> None:
        if aw is None:
            return
        try:
            await aw
        except Exception:
            pass

    async def _close_server(self) -> None:
        srv = self._server
        if srv is None:
            return
        srv.close()
        try:
            await asyncio.wait_for(srv.wait_closed(), 2.0)
        except (asyncio.TimeoutError, Exception):
            pass

    # -- dial -------------------------------------------------------------------------------------

    def _dialable(self, host: str) -> bool:
        # The address text is judged before a socket exists (§15.4.1); the address itself stands in for
        # "some local address in the same /64" until the connected socket is judged.
        return text_verdict(host, self._o.allow_loopback)

    async def connect(self, target: Any) -> ConnectSession:
        """Dial a discovered device (a device id, or a :class:`LanPeer`) and run the handshake. Raises
        :class:`LanError`: ``unknown_peer``, ``connect_failed``, ``handshake_failed``, ``wrong_peer``."""
        if self._stopped:
            raise LanError("not_listening", "The LAN service is stopped.")
        if isinstance(target, str):
            want = target
            known = self._peers.get(target)
            peer: Optional[LanPeer] = known[0] if known is not None else None
        else:
            want, peer = target.device_id, target
        hosts: List[str] = []
        if peer is not None:
            for h in (peer.host,) + tuple(peer.alt_hosts):
                if h not in hosts and self._dialable(h):
                    hosts.append(h)
        if peer is None or not hosts:
            raise LanError("unknown_peer", "That device was not found on this network.")
        ident = await self._identity(False)
        # A neighbour can answer first with its own address (S4): when the winner of the race fails the
        # handshake, the race runs again over the addresses left, so the real device is still reached.
        err: Optional[LanError] = None
        session: Any = None
        while hosts and session is None:
            session, err, failed = await self._connect_one(hosts, peer.port, ident, peer.device_id)
            if failed is None:
                break  # nothing connected: there is no address left to try
            hosts = [h for h in hosts if h != failed]
        if session is None:
            assert err is not None
            raise err
        if session.peer_device_id != want:
            session.close()
            raise LanError("wrong_peer", "The device that answered is not the one that advertised.")
        return session

    async def _connect_one(
        self, hosts: List[str], port: int, ident: PeerSource, expect: str
    ) -> Tuple[Any, Optional[LanError], Optional[str]]:
        """Race the addresses, then handshake with the winner: ``(session, None, None)``, or
        ``(None, error, host)`` for a winner whose handshake failed, or ``(None, error, None)`` when no
        address connected. ``wrong_peer`` and other reasons are raised."""
        try:
            reader, writer, host = await self._dial(hosts, port)
        except LanError as e:
            return None, e, None
        link = self._link(reader, writer, ident, "initiator", expect=expect)
        task = self._spawn(link.run())
        link.start()
        try:
            return await wait_opened(link, self._o.handshake_seconds + 5), None, None
        except LanError as e:
            if link.wrong_peer:
                raise LanError("wrong_peer", "The device that answered is not the one that advertised.") from None
            if e.reason not in ("connect_failed", "handshake_failed"):
                raise
            return None, e, host
        except Exception:
            task.cancel()
            return None, LanError("handshake_failed", "The handshake failed."), host

    async def _dial(self, hosts: List[str], port: int) -> Tuple[Any, Any, str]:
        """Race the addresses (dial.py); the winner was judged as text and on its own addresses."""
        try:
            sock, host = await dial_race(hosts, port, self._o.allow_loopback, timeout=self._o.dial_seconds)
        except OSError as e:
            raise LanError("connect_failed", "The device did not answer.") from e
        try:
            reader, writer = await asyncio.open_connection(sock=sock)
        except OSError as e:
            sock.close()
            raise LanError("connect_failed", "The device did not answer.") from e
        return reader, writer, host

    # -- identity ---------------------------------------------------------------------------------

    async def _identity(self, force: bool) -> PeerSource:
        now = self._src.now()
        held = self._id
        if (
            not force
            and held is not None
            and now - held[0] < IDENTITY_TTL_S
            and held[1].cert_expires_at - now > CERT_MARGIN_S
        ):
            return held[1]
        v: PeerSource = await self._loop.run_in_executor(None, self._src.load)
        if held is not None and held[1].ring_epoch != v.ring_epoch:
            self._miss.clear()
        self._id = (now, v)
        pushed = self._docs.pushed
        if pushed is not None and pushed[1] <= v.ring_epoch:
            self._docs.pushed = None
        return v

    def _stored_from_worker(self) -> None:
        """A roster or identity was stored (a worker thread): the next read reloads, and the advert
        follows a new K_disc inside the epoch."""
        try:
            self._loop.call_soon_threadsafe(self._stored)
        except RuntimeError:
            pass  # the loop is gone: the service is over

    def _stored(self) -> None:
        self._id = None
        if not self._stopped and self._adv is not None:
            self._spawn(self._quiet(self._rotate()))

    def _spawn(self, coro: Awaitable[Any]) -> "asyncio.Future[Any]":
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        t.add_done_callback(lambda f: f.cancelled() or f.exception())
        return t

    # -- links ------------------------------------------------------------------------------------

    def _link(
        self, reader: Any, writer: Any, ident: PeerSource, role: str, expect: Optional[str] = None
    ) -> SocketLink:
        o = self._o
        docs = self._docs

        def established(s: ConnectSession) -> None:
            self._sessions.add(s)
            s.on_close(lambda _c: self._sessions.discard(s))

        link: SocketLink

        def ring_wanted() -> None:
            # The refresh calls the Worker: never on the loop.
            self._loop.run_in_executor(None, docs.want_ring)

        handlers = session_handlers(
            role,
            on_established=established,
            on_ring=docs.on_ring,
            on_trust=docs.on_trust,
            on_ring_wanted=ring_wanted,
            on_ended=lambda: self._links.discard(link),
        )
        link = SocketLink(
            reader,
            writer,
            {
                **channel_base(
                    ident,
                    caps=o.caps,
                    label=o.label,
                    ring=lambda: docs.pushed,
                    now=self._src.now,
                    rekey_messages=o.rekey_messages,
                    rekey_seconds=o.rekey_seconds,
                ),
                "role": role,
            },
            handlers,
            handshake_seconds=o.handshake_seconds,
            expect_peer=expect,
            peer_full=self._peer_full,
        )
        self._links.add(link)
        return link

    def _peer_full(self, device_id: str) -> bool:
        """True when this device already holds its share of the open sessions."""
        n = sum(1 for s in self._sessions if s.peer_device_id == device_id)
        return n >= self._o.max_sessions_per_peer

    # -- TCP --------------------------------------------------------------------------------------

    def _listen_socket(self) -> "socket.socket":
        """One dual-stack ``::`` socket (``IPV6_V6ONLY`` off) so one port serves both families, or an IPv4
        socket where IPv6 is unavailable. An explicit ``host`` binds only that."""
        host, port = self._o.host, self._o.port
        if host is None or ":" in host:
            s6: Optional[socket.socket] = None
            try:
                s6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
                if os.name == "posix":
                    s6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                s6.bind((host or "::", port))
                return s6
            except OSError:
                if s6 is not None:
                    s6.close()
                if host is not None:
                    raise
        s4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if os.name == "posix":
                s4.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s4.bind((host or "0.0.0.0", port))
        except OSError:
            s4.close()
            raise
        return s4

    async def _listen(self) -> None:
        sock = self._listen_socket()
        # One socket passed as ``sock=``: ``start_server`` given a host binds a random port per family.
        try:
            self._server = await self._loop.create_server(self._protocol, sock=sock)
        except BaseException:
            sock.close()
            raise
        self._port = int(sock.getsockname()[1])

    def _protocol(self) -> "asyncio.StreamReaderProtocol":
        reader = asyncio.StreamReader(loop=self._loop)
        return _GatedProtocol(reader, self._accept, self._gate, self._loop)

    @staticmethod
    def _abort(writer: Any) -> None:
        try:
            t = getattr(writer, "transport", writer)
            t.abort()
        except Exception:
            pass

    def _gate(self, transport: Any) -> bool:
        """An accepted socket is judged first, on its own addresses, before a slot and before any byte is
        read: a source off the LAN is closed at once and costs nothing (§15.4.1)."""
        v = socket_verdict(
            socket_text(transport.get_extra_info("peername")),
            socket_text(transport.get_extra_info("sockname")),
            self._o.allow_loopback,
        )
        if not v.dial or v.key is None or self._stopped or len(self._sessions) >= self._o.max_sessions:
            return False
        release = self._limit.take(transport, limiter_keys(v.key))
        if release is None:
            return False
        self._slots[transport] = release
        return True

    async def _accept(self, reader: Any, writer: Any) -> None:
        release = self._slots.pop(writer.transport, None)
        if release is None:  # not admitted by the gate: cannot happen, and closes if it does
            return self._abort(writer)
        self._pending.add(writer)
        # An unauthenticated socket lives for the handshake window and no longer.
        deadline = self._loop.call_later(self._o.handshake_seconds, self._abort, writer)

        def done(*_a: Any) -> None:
            deadline.cancel()
            if writer not in self._pending:
                return
            self._pending.discard(writer)
            release()

        link: Optional[SocketLink] = None
        try:
            # The identity is read before the first byte is handled; the socket buffers meanwhile.
            ident = await self._identity(False)
            if self._stopped:
                return self._abort(writer)
            link = self._link(reader, writer, ident, "responder")
            link.opened.add_done_callback(lambda f: self._admitted(f, done))
            await link.run()
        except asyncio.CancelledError:
            self._abort(writer)
            raise
        except Exception:
            self._abort(writer)
        finally:
            done()

    def _admitted(self, f: "asyncio.Future[Any]", done: Callable[[], None]) -> None:
        if f.cancelled() or f.exception() is not None:
            return
        done()
        session = f.result()
        for fn in list(self._on_session):
            try:
                fn(session)
            except Exception:
                pass  # a host callback never ends a session

    # -- mDNS -------------------------------------------------------------------------------------

    async def _rotate(self) -> None:
        """Advertise under the current epoch and key; set the timer for the next boundary."""
        async with self._rotate_lock:
            if self._stopped:
                return
            ident = await self._identity(True)
            now = self._src.now()
            epoch = advert_epoch(now)
            name = account_instance(ident.keys.current, epoch, ident.device_id)
            if name != self._adv_name:
                old = self._adv
                self._adv = await self._mdns.advertise(MdnsAdvert(name, self._port, ["v=1", "m=a"]))
                self._adv_name = name
                if old is not None:
                    await self._quiet(old.stop())
            nxt = (epoch + 1) * ADVERT_EPOCH_SECONDS - self._src.now()
            if self._cancel_epoch is not None:
                self._cancel_epoch()
            timer = self._o.timer or self._default_timer
            self._cancel_epoch = timer(self._rotate_later, float(max(1, nxt)))

    def _default_timer(self, fn: Callable[[], None], seconds: float) -> Callable[[], None]:
        h = self._loop.call_later(seconds, fn)
        return h.cancel

    async def _start_browse(self) -> None:
        self._browse = await self._mdns.browse(self._found_later, self._gone)

    def _found_later(self, f: MdnsFound) -> None:
        self._spawn(self._quiet(self._found(f)))

    def _rotate_later(self) -> None:
        self._spawn(self._quiet(self._rotate()))

    def _gone(self, instance: str) -> None:
        for k in [k for k, (_, inst) in self._peers.items() if inst == instance]:
            del self._peers[k]

    def _table(self, keys: List[bytes], roster: List[str]) -> Dict[str, BrowseHit]:
        """The expected instance names, worked out once per (epoch, keys, roster): a forged name is an
        O(1) miss (S3), not up to 512 HMACs on the loop."""
        now = self._src.now()
        sig = (advert_epoch(now), tuple(keys), tuple(roster))
        if self._tab is None or self._tab[0] != sig:
            self._tab = (sig, browse_table(keys, now, roster))
        return self._tab[1]

    async def _found(self, f: MdnsFound) -> None:
        # Keep the addresses that could be dialled; the connected socket is judged again.
        hosts = [h for h in (f.hosts or (f.host,)) if self._dialable(h)]
        if self._stopped or not hosts:
            return
        txt = parse_txt(f.txt)
        if not txt["ok"] or txt["mode"] != "a":
            return
        if f.instance in self._miss:
            return
        ident = await self._identity(False)
        keys = [ident.keys.current] + ([ident.keys.previous] if ident.keys.previous else [])
        hit = self._table(keys, [d for d in ident.roster if d != ident.device_id]).get(f.instance)
        if hit is None:
            # Bounded negative cache: a forged instance is not worked out twice.
            if len(self._miss) >= MISS_CACHE:
                del self._miss[next(iter(self._miss))]
            self._miss[f.instance] = self._src.now()
            return
        peer = LanPeer(hit.device_id, hosts[0], f.port, tuple(hosts[1:]))
        self._peers[hit.device_id] = (peer, f.instance)
        for fn in list(self._on_peer):
            try:
                fn(peer)
            except Exception:
                pass
