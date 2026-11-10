"""The LAN half of Cloud Connect (CC-10.12; WIRE-CONTRACT-V5 §15.4 to §15.6): advertise this device
under the account instance name, browse for the person's other devices, listen on TCP and dial. Mirrors
``packages/sdk-node/src/connect/lan.ts``. A :class:`LanService` lives on the Connect loop (D-3): build
it with ``await LanService.start(...)`` there; the facade marshals the host's calls (CC-10.15).

Rules this module keeps:

- the advert is ``p1-`` plus HMAC(K_disc, epoch, deviceId) with ``v=1``, ``m=a`` and nothing else; it
  is renewed at every 15-minute epoch boundary and when K_disc changes, and uses only the newest key (G4);
- a browse hit is kept only if it matches a roster device (never this one) under the current or previous
  epoch and either delivered key; everything else is dropped, and a name that did not match is not
  worked out twice. The mDNS adapter is given the same names up front (``accept``), so a name no roster
  device can announce never takes a place in its tables;
- the listener starts a handshake only when this device holds a verified identity. The handshake
  (XXpsk0) and admission (certificate, roster, expiry, revocation) run in the session engine; a failed
  tag closes the socket without a word (G2);
- sockets that have not been admitted are bounded: at most 32 in total, 4 per source address and 16 per
  group (a link, an IPv4 /24 or an IPv6 /64), each living at most 30 seconds, handshake frames at most
  16 KiB (G7). A socket whose identity read hangs gives its slot back at the 30 second deadline;
- an address is allowed by ``lan_verdict`` (§15.4.1; RFC 1918, fe80::/10, a ULA or on-link global address;
  loopback only when the caller opts in, for tests). An accepted socket is judged on its own peer and local
  address before it takes a slot and before any byte is read, and one that fails is closed at once; a dialled
  address is judged as text before a socket exists and on the connected socket before its first byte (G6).
  The certificate's device must be the one dialled, or the session closes ``wrong_peer`` (G8);
- one TCP port serves both families: a dual-stack ``::`` listener (``IPV6_V6ONLY`` off), falling back to
  ``0.0.0.0``. The listener can be reached from beyond the LAN, so a connection whose source fails the
  verdict is closed in ``connection_made`` before the transport reads: no slot, no read, no byte written.
  A device with several learned addresses dials them in a race (:mod:`.dial`), and when the handshake with
  the winner fails it races the addresses that are left; a handshake that completes with another device
  ends the dial as ``wrong_peer``;
- the device's X25519 private key never leaves the key port (G1): the session is given the
  :class:`~polaris_key.connect.client.PeerSource` static-key handle, whose ``dh`` calls the port;
- inter-account links (CC-19.6, §15.10) ride the same listener: a responder that holds contacts tries the
  account's keys, then each contact's secret in ``contact_trial_order`` under one
  :class:`~polaris_key.core.peer_session.HandshakeLimiter`; ``m=c`` adverts (at most 8) are published on the
  same port and browsed with ``browse_contact_instance``; a name no contact can announce never enters the
  adapter's tables; with links off (no cached ``interAccount``) the contacts are empty, so nothing is
  advertised and no mode ``c`` is answered;
- local links (CC-29.9, §15.5 "One listener, one order", §15.12 "Mode l") ride the same listener too: it also
  tries the local-link secrets after the account keys and the contacts, under the one limiter, and publishes
  ``m=l`` names (at most 8) for the links the host marked reachable. With no account (:meth:`LanService.start_local`)
  the service has no identity: it serves local links alone and advertises and browses no account name, and a
  listener that serves nothing (no link held, or the gate off) closes every connection before reading a byte.
  Every local call reads the gate again (``local_allowed``).
"""

from __future__ import annotations

import asyncio
import socket
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Sequence, Set, Tuple

from ..core.peer_advert import ADVERT_EPOCH_SECONDS, BrowseHit, account_instance, advert_epoch, browse_table, parse_txt
from ..core.peer_contact import (
    MAX_LIVE_CONTACT_ADVERTS,
    ContactKey,
    browse_contact_instance,
    contact_instance,
    parse_contact_txt,
)
from ..core.peer_dial import dial_race
from ..core.peer_lan_gate import Admitted, GatedProtocol, admit_transport, listen_socket
from ..core.peer_lan_judge import PendingLimiter, limiter_keys, text_verdict
from ..core.peer_link import SocketLink
from ..core.peer_local import (
    MAX_LIVE_LOCAL_ADVERTS,
    LocalLinkKey,
    browse_local_instance,
    local_instance,
    parse_local_txt,
)
from ..core.peer_mdns import MdnsAdapter, MdnsAdvert, MdnsFound, MdnsHandle, MulticastDnsAdapter
from ..core.peer_session import ContactLink, HandshakeLimiter, LocalLink
from .channel import ConnectNotice, PeerDocs, PeerDocsSource, channel_base, contact_channel, local_channel
from .client import ConnectClient, PeerSource
from .contacts import ContactRef, LiveContact, ref_of, wipe_live
from .errors import LanError
from .local_state import LiveLocal, LocalRef, ref_of_local, wipe_locals
from .session import ConnectSession, session_handlers, wait_opened

__all__ = [
    "Admitted",
    "GatedProtocol",
    "LanOptions",
    "LanPeer",
    "LanService",
    "LanSource",
    "MAX_PENDING",
    "MAX_PENDING_PER_ADDRESS",
    "MAX_PENDING_PER_64",
    "MAX_SESSIONS",
    "MAX_SESSIONS_PER_PEER",
    "admit_transport",
    "lan_source",
    "listen_socket",
]

#: Unauthenticated sockets at once, per source address and per group (G7, §15.4.1).
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
    #: The inter-account links (§15.10) in trial order, secrets decoded: empty while links are off (no
    #: cached ``interAccount``) or none are held. Blocking; the service wipes what it replaces.
    contacts: Optional[Callable[[], List[LiveContact]]] = None
    #: Called when the contacts changed (from any thread); returns the unsubscribe.
    on_contacts: Optional[Callable[[Callable[[], None]], Callable[[], None]]] = None
    #: A session opened under a pending contact passed the pin: it replaces the held one. Blocking.
    contact_established: Optional[Callable[[ContactRef], None]] = None
    #: The product slug. A service with no identity (:meth:`LanService.start_local`) has no other way to know it.
    slug: Optional[str] = None
    #: The local links (§15.12) in held order, secrets and keys decoded: empty while the gate is off or none
    #: are held. Blocking; the service wipes what it replaces.
    locals: Optional[Callable[[], List[LiveLocal]]] = None
    #: Called when the local links changed (added, removed, renamed, re-marked) or the gate moved (from any
    #: thread); returns the unsubscribe.
    on_locals: Optional[Callable[[Callable[[], None]], Callable[[], None]]] = None
    #: The cached ``localPairing`` answer, read again for every local call (§15.12 "Gates"). Absent: allowed.
    local_allowed: Optional[Callable[[], bool]] = None
    #: A session opened under a local link: its last-seen time moves. Blocking.
    local_established: Optional[Callable[[LocalRef], None]] = None


def _zero(b: bytearray) -> None:
    for i in range(len(b)):
        b[i] = 0


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
        # A client without links (a test's stand-in) serves no contacts.
        contacts=getattr(client, "live_contacts", None),
        on_contacts=getattr(client, "on_contacts_changed", None),
        contact_established=(lambda ref: client.promote_contact(ref.agree_key, ref.tag))
        if hasattr(client, "promote_contact")
        else None,
        slug=getattr(client, "slug", None),
        locals=getattr(client, "live_locals", None),
        on_locals=getattr(client, "on_locals_changed", None),
        local_allowed=getattr(client, "local_pairing", None),
        local_established=getattr(client, "touch_local", None),
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
    #: Direct Transfer (CC-20): called as ``xfer(link, session, established)`` when a session is established
    #: with ``xfer/1`` on both sides. Set by ``cloud_connect.start``.
    xfer: Any = None
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


_GatedProtocol = GatedProtocol


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
        #: The last identity read, kept when ``_id`` is dropped: the roster filter works from it (``_accepts``).
        self._known: Optional[PeerSource] = None
        self._names: Optional[Tuple[Optional[PeerSource], int, "frozenset[str]", str]] = None
        self._pending: Set[Any] = set()
        self._limit = PendingLimiter(o.max_pending, o.max_pending_per_address, o.max_pending_per_64)
        #: Accepted transports that hold a slot and have not reached ``_accept`` yet.
        self._slots: Dict[Any, Callable[[], None]] = {}
        #: The source group of each accepted transport (the pre-handshake limiter's own key).
        self._groups: Dict[Any, str] = {}
        self._links: Set[SocketLink] = set()
        #: For a handshake still running: the contacts (``c|id|tag``) and local links (``l|id|tag``) its trial list
        #: holds.
        self._serves: Dict[SocketLink, Set[str]] = {}
        self._sessions: Set[ConnectSession] = set()
        self._tasks: Set["asyncio.Future[Any]"] = set()
        self._on_session: List[Callable[[ConnectSession], None]] = []
        self._on_peer: List[Callable[[LanPeer], None]] = []
        #: The inter-account links held now (empty while off), in trial order.
        self._contacts: List[LiveContact] = []
        self._contacts_sig = ""
        #: One live contact advert per name; at most ``MAX_LIVE_CONTACT_ADVERTS``.
        self._contact_adv: Dict[str, MdnsHandle] = {}
        #: ``(id, pending)`` to ``(instance, hosts, port)``.
        self._contact_peers: Dict[Tuple[str, bool], Tuple[str, List[str], int]] = {}
        self._on_contact_session: List[Callable[[ConnectSession], None]] = []
        self._un_contacts: Optional[Callable[[], None]] = None
        #: No account: the service serves local links only (:meth:`start_local`).
        self._local_only = False
        #: The local links held now (empty while the gate is off), in held order.
        self._locals: List[LiveLocal] = []
        self._locals_sig = ""
        #: One live ``m=l`` advert per name; at most ``MAX_LIVE_LOCAL_ADVERTS``.
        self._local_adv: Dict[str, MdnsHandle] = {}
        #: link id to ``(instance, hosts, port)``.
        self._local_peers: Dict[str, Tuple[str, List[str], int]] = {}
        self._on_local_session: List[Callable[[ConnectSession], None]] = []
        #: One limiter per listener for the contact trial (§15.10, "Admission").
        self._limiter = HandshakeLimiter(5, 4)
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
        return await cls._begin(src, options or LanOptions(), False)

    @classmethod
    async def start_local(cls, src: LanSource, options: Optional[LanOptions] = None) -> "LanService":
        """The service with no account (§15.5, §15.12): it listens, and advertises and browses ``m=l`` names for
        the local links, and holds no identity, no K_disc and no roster. A listener that serves nothing (no link
        held, or the gate off) closes every connection before reading a byte. Needs ``src.slug``."""
        if src.slug is None:
            raise LanError("bad_input", "A local-only service needs the slug.")
        return await cls._begin(src, options or LanOptions(), True)

    @classmethod
    async def _begin(cls, src: LanSource, options: LanOptions, local_only: bool) -> "LanService":
        s = cls(src, options)
        s._local_only = local_only
        try:
            if not local_only:
                await s._identity(True)
                await s._load_contacts()
            await s._load_locals()
            await s._listen()
            # Subscribed before the first advert, and read once more right after: a gate or a link that moved
            # while the service was starting is applied, not left advertised.
            offs = [f(s._contacts_changed) for f in (src.on_contacts, src.on_locals) if f is not None]

            def unsubscribe() -> None:
                for off in offs:
                    off()

            s._un_contacts = unsubscribe
            if s._o.advertise:
                await s._rotate()
            if s._o.browse:
                await s._start_browse()
            await s._quiet(s._reload(False))
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

    def on_contact_session(self, fn: Callable[[ConnectSession], None]) -> Callable[[], None]:
        """Called for each inbound mode-``c`` session (a contact dialled this device) once it is open."""
        self._on_contact_session.append(fn)
        return lambda: self._on_contact_session.remove(fn) if fn in self._on_contact_session else None

    def on_local_session(self, fn: Callable[[ConnectSession], None]) -> Callable[[], None]:
        """Called for each inbound mode-``l`` session (a local link dialled this device) once it is open."""
        self._on_local_session.append(fn)
        return lambda: self._on_local_session.remove(fn) if fn in self._on_local_session else None

    def local_peers(self) -> List[str]:
        """The local links seen on this network now, by link id. The host picks one to dial
        (:meth:`connect_local`)."""
        return list(self._local_peers.keys())

    def contact_peers(self) -> List[Tuple[str, bool]]:
        """The contacts seen on this network now, as ``(id, pending)`` (``pending`` is the pending secret
        of a re-pair, §15.10). The host picks one to dial; :meth:`connect_contact` runs the handshake."""
        return list(self._contact_peers.keys())

    async def refresh_contacts(self) -> None:
        """Read the contacts and the local links again (stored, promoted, removed, re-marked, or the gate moved)
        and bring the adverts, the accepted names and the listener's trial order to match."""
        await self._reload(True)

    async def _reload(self, account: bool) -> None:
        async with self._rotate_lock:
            if self._stopped:
                return
            # The local links first: a withdrawal (the gate moved, a link was forgotten) must not wait on the
            # account half, which can fail when there is no account.
            await self._load_locals()
            await self._advert_locals(advert_epoch(self._src.now()))
            if not account or self._local_only:
                return
            await self._load_contacts()
            ident = await self._identity(True)
            await self._advert_contacts(ident, advert_epoch(self._src.now()))

    def drop_local(self, link_id: str) -> None:
        """A link was forgotten: it leaves the held list now (on the loop thread, no await), so no dial or
        handshake can use it afterwards."""
        gone = [x for x in self._locals if x.id == link_id]
        if gone:
            self._locals = [x for x in self._locals if x.id != link_id]
            self._local_peers.pop(link_id, None)
            self._prune_serves()
            # The old list may be read by a dial or a browse that began before this: wiping it makes those
            # copies fail closed, and they re-check the list afterwards.
            wipe_locals(gone)

    async def forget_local(self, link_id: str) -> None:
        """:meth:`drop_local`, then the reload. Resolves once the reload has run (adverts and accepted names
        follow)."""
        self.drop_local(link_id)
        try:
            await self.refresh_contacts()
        except Exception:
            pass

    def _contacts_changed(self) -> None:
        """From any thread: the contacts moved."""
        try:
            self._loop.call_soon_threadsafe(self._contacts_changed_on_loop)
        except RuntimeError:
            pass  # the loop is gone: the service is over

    def _contacts_changed_on_loop(self) -> None:
        if not self._stopped:
            self._spawn(self._quiet(self.refresh_contacts()))

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        self._docs.close()
        if self._un_contacts is not None:
            self._un_contacts()
            self._un_contacts = None
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
            *[self._quiet(h.stop()) for h in [*self._contact_adv.values(), *self._local_adv.values()]],
            self._quiet(self._browse.stop() if self._browse is not None else None),
            self._close_server(),
        )
        self._adv = self._browse = None
        self._contact_adv.clear()
        self._contact_peers.clear()
        self._local_adv.clear()
        self._local_peers.clear()
        wipe_live(self._contacts)
        self._contacts = []
        wipe_locals(self._locals)
        self._locals = []

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
        if self._un_contacts is not None:
            self._un_contacts()
            self._un_contacts = None
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
        for h in (self._adv, self._browse, *self._contact_adv.values(), *self._local_adv.values()):
            if h is not None:
                asyncio.ensure_future(self._stop_handle(h))
        self._adv = self._browse = None
        self._contact_adv.clear()
        self._contact_peers.clear()
        self._local_adv.clear()
        self._local_peers.clear()
        wipe_live(self._contacts)
        self._contacts = []
        wipe_locals(self._locals)
        self._locals = []

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
            self._abort(writer)  # the failed socket closes before the next race
            return None, e, host
        except Exception:
            task.cancel()
            self._abort(writer)
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
        self._known = v
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
        self,
        reader: Any,
        writer: Any,
        ident: Optional[PeerSource],
        role: str,
        expect: Optional[str] = None,
        group: Optional[str] = None,
    ) -> SocketLink:
        o = self._o
        docs = self._docs

        # The shared listener (§15.5, §15.10, §15.12): a responder that holds contacts or local links tries the
        # account's keys, then each contact's secret, then each local link's, under the one limiter. Copies of
        # the secrets go to the engine; they are wiped when the link ends.
        served = list(self._contacts) if role == "responder" else []
        live = list(self._locals) if role == "responder" and self._locals_on() else []
        refs = [ref_of(c) for c in served]
        lrefs = [ref_of_local(x) for x in live]
        # The list is read and the secrets copied in one synchronous step on the loop, and ``wipe_locals`` runs only on
        # the loop (``drop_local``, ``_load_locals``, ``stop``): no wipe can fall between the two.
        locals_copy = [LocalLink(bytearray(x.secret), bytearray(x.own_key), bytes(x.peer_key)) for x in live]
        trial = bool(served) or bool(live)

        def established(s: ConnectSession) -> None:
            self._serves.pop(link, None)
            self._sessions.add(s)
            s.on_close(lambda _c: self._sessions.discard(s))
            self._promote_if_pending(s)
            self._touch_local(s)

        link: SocketLink

        def ended() -> None:
            self._links.discard(link)
            self._serves.pop(link, None)
            for lk in locals_copy:
                _zero(lk.secret)  # type: ignore[arg-type]
                _zero(lk.own_key)  # type: ignore[arg-type]

        def ring_wanted() -> None:
            # The refresh calls the Worker: never on the loop.
            self._loop.run_in_executor(None, docs.want_ring)

        handlers = session_handlers(
            role,
            on_established=established,
            on_ring=docs.on_ring,
            on_trust=docs.on_trust,
            on_ring_wanted=ring_wanted,
            on_ended=ended,
            contacts=refs,
            locals_=lrefs,
            xfer=o.xfer,
        )
        extra: Dict[str, Any] = {}
        if ident is None:
            # No account: the listener serves local links alone, and the mode is ``l``. No account key to try:
            # the source group's budget comes first (§15.10, "Admission").
            base = {
                **local_channel(
                    self._slug(),
                    caps=o.caps,
                    label=o.label,
                    now=self._src.now,
                    rekey_messages=o.rekey_messages,
                    rekey_seconds=o.rekey_seconds,
                ),
                "local_links": locals_copy,
                "admission": self._limiter,
            }
            if group is not None:
                base["admission_group"] = group
        else:
            base = channel_base(
                ident,
                caps=o.caps,
                label=o.label,
                ring=lambda: docs.pushed,
                now=self._src.now,
                rekey_messages=o.rekey_messages,
                rekey_seconds=o.rekey_seconds,
            )
            if served:
                extra["contacts"] = [ContactLink(bytes(c.secret), c.agree_key) for c in served]
            if locals_copy:
                extra["local_links"] = locals_copy
            if trial:
                extra["admission"] = self._limiter
        link = SocketLink(
            reader,
            writer,
            {**base, "role": role, **extra},
            handlers,
            handshake_seconds=o.handshake_seconds,
            expect_peer=expect,
            peer_full=self._peer_full,
        )
        self._links.add(link)
        if trial:
            self._serves[link] = {
                *("c|%s|%s" % (c.id, c.tag) for c in served),
                *("l|%s|%s" % (x.id, x.tag) for x in live),
            }
        return link

    def _slug(self) -> str:
        if self._src.slug is not None:
            return self._src.slug
        held = self._known
        return held.slug if held is not None else ""

    def _touch_local(self, s: ConnectSession) -> None:
        ref = s.local
        fn = self._src.local_established
        if ref is not None and fn is not None:
            self._loop.run_in_executor(None, lambda: self._quiet_sync(fn, ref))

    def _peer_full(self, device_id: str) -> bool:
        """True when this device already holds its share of the open sessions."""
        n = sum(1 for s in self._sessions if s.peer_device_id == device_id)
        return n >= self._o.max_sessions_per_peer

    # -- TCP --------------------------------------------------------------------------------------

    def _listen_socket(self) -> "socket.socket":
        return listen_socket(self._o.host, self._o.port)

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
        return GatedProtocol(reader, self._accept, self._gate, self._loop)

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
        try:
            admitted = admit_transport(
                transport,
                self._limit,
                self._o.allow_loopback,
                refuse=self._stopped
                or len(self._sessions) >= self._o.max_sessions
                # With no account the listener serves local links alone: with none to try (or the gate off) a
                # connection is closed before a byte is read.
                or (self._local_only and (not self._locals or not self._locals_on())),
            )
        except Exception:
            # A fault here must end this socket and nothing else: the listener keeps serving.
            return False
        if admitted is None:
            return False
        self._slots[transport] = admitted.release
        keys = limiter_keys(admitted.address)
        self._groups[transport] = keys.group or keys.address
        return True

    async def _accept(self, reader: Any, writer: Any) -> None:
        release = self._slots.pop(writer.transport, None)
        group = self._groups.pop(writer.transport, None)
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
            # The identity is read before the first byte is handled; the socket buffers meanwhile. The
            # read is cancelled at the handshake deadline, so a hung ``load`` cannot hold the slot. With no
            # account there is none to read.
            ident: Optional[PeerSource] = None
            if not self._local_only:
                ident = await asyncio.wait_for(self._identity(False), self._o.handshake_seconds)
            if self._stopped:
                return self._abort(writer)
            link = self._link(reader, writer, ident, "responder", group=group)
            link.opened.add_done_callback(lambda f: self._admitted(f, done))
            await link.run()
        except asyncio.CancelledError:
            self._abort(writer)
            raise
        except Exception:
            # A fault here must end this socket and nothing else: the listener keeps serving.
            self._abort(writer)
        finally:
            done()

    def _admitted(self, f: "asyncio.Future[Any]", done: Callable[[], None]) -> None:
        if f.cancelled() or f.exception() is not None:
            return
        done()
        self._deliver(f.result())

    def _deliver(self, session: ConnectSession) -> None:
        """Hand an open inbound session to the handlers of its kind."""
        if session.contact is not None:
            to = self._on_contact_session
        elif session.local is not None:
            to = self._on_local_session
        else:
            to = self._on_session
        # A local session nobody is listening for (the host has not attached yet) is ended, not left open and
        # untracked: the peer dials again.
        if session.local is not None and not to:
            try:
                session.close("peer_bye")
            except Exception:
                pass
            return
        for fn in list(to):
            try:
                fn(session)
            except Exception:
                pass  # a host callback never ends a session

    # -- contacts ---------------------------------------------------------------------------------

    def _promote_if_pending(self, s: ConnectSession) -> None:
        """The first handshake under a pending contact passed the pin: it replaces the held one."""
        ref = s.contact
        fn = self._src.contact_established
        if ref is not None and ref.pending and fn is not None:
            self._loop.run_in_executor(None, lambda: self._quiet_sync(fn, ref))

    @staticmethod
    def _quiet_sync(fn: Callable[[Any], Any], arg: Any) -> None:
        try:
            fn(arg)
        except Exception:
            pass

    async def _load_contacts(self) -> None:
        """Read the contacts from the source; the old ones are wiped."""
        fn = self._src.contacts
        nxt: List[LiveContact] = list(await self._loop.run_in_executor(None, fn)) if fn is not None else []
        old, self._contacts = self._contacts, nxt
        self._contacts_sig = ",".join(
            "%s%s%s" % (c.id, "p" if c.pending else "h", "r" if c.reachable else "-") for c in nxt
        )
        wipe_live(old)
        self._prune_serves()
        # A peer seen under a contact that is gone is forgotten.
        have = {(c.id, c.pending) for c in nxt}
        for k in [k for k in self._contact_peers if k not in have]:
            del self._contact_peers[k]

    def _prune_serves(self) -> None:
        """A handshake still running under a contact or local link that is gone (or whose secret was replaced),
        or while links are off, is ended; an established session is the links layer's to close."""
        held = {
            *("c|%s|%s" % (c.id, c.tag) for c in self._contacts),
            *("l|%s|%s" % (x.id, x.tag) for x in self._locals),
        }
        for lk in [k for k, served in self._serves.items() if not served <= held]:
            self._serves.pop(lk, None)
            lk.destroy()

    def _locals_on(self) -> bool:
        """The gate, read again: False stops every local call (§15.12 "Gates")."""
        f = self._src.local_allowed
        return f is None or f() is not False

    async def _load_locals(self) -> None:
        """Read the local links from the source; the old ones are wiped."""
        fn = self._src.locals
        nxt: List[LiveLocal] = list(await self._loop.run_in_executor(None, fn)) if fn is not None else []
        old, self._locals = self._locals, nxt
        sig = ",".join("%s%s%s" % (x.id, x.tag, "r" if x.reachable else "-") for x in nxt)
        # A name judged a miss before a link existed may be that link's.
        if sig != self._locals_sig:
            self._miss.clear()
        self._locals_sig = sig
        wipe_locals(old)
        self._prune_serves()
        # A peer seen under a link that is gone is forgotten.
        have = {x.id for x in nxt}
        for k in [k for k in self._local_peers if k not in have]:
            del self._local_peers[k]

    async def _advert_locals(self, epoch: int) -> None:
        """The ``m=l`` adverts for the links marked reachable, at most 8, on this listener's port."""
        if not self._o.advertise:
            return
        want: List[str] = []
        if self._locals_on():
            want = [
                local_instance(bytes(x.secret), x.own_public, epoch)
                for x in [x for x in self._locals if x.reachable][:MAX_LIVE_LOCAL_ADVERTS]
            ]
        await self._sync_adverts(self._local_adv, want, "l")

    async def _sync_adverts(self, live: Dict[str, MdnsHandle], want: Sequence[str], mode: str) -> None:
        """Bring the live adverts of one mode to exactly ``want``: stop the others, start the missing."""
        for name in [n for n in live if n not in want]:
            await self._quiet(live.pop(name).stop())
        for name in want:
            if name in live or self._stopped:
                continue
            live[name] = await self._mdns.advertise(MdnsAdvert(name, self._port, ["v=1", "m=" + mode]))

    async def _advert_contacts(self, ident: PeerSource, epoch: int) -> None:
        """The contact adverts for the contacts marked reachable, at most 8, on this listener's port."""
        if not self._o.advertise:
            return
        want = [
            contact_instance(bytes(c.secret), ident.agree_public, epoch)
            for c in [c for c in self._contacts if c.reachable][:MAX_LIVE_CONTACT_ADVERTS]
        ]
        await self._sync_adverts(self._contact_adv, want, "c")

    def _remember(self, instance: str) -> None:
        """Bounded negative cache: a forged instance is not worked out twice."""
        if len(self._miss) >= MISS_CACHE:
            del self._miss[next(iter(self._miss))]
        self._miss[instance] = self._src.now()

    def _found_contact(self, f: MdnsFound, hosts: List[str]) -> None:
        contacts = self._contacts
        if not contacts or f.instance in self._miss:
            return
        hit = browse_contact_instance(
            f.instance, [ContactKey(bytes(c.secret), c.agree_key_bytes) for c in contacts], self._src.now()
        )
        if hit is None:
            self._remember(f.instance)
            return
        c = contacts[hit["contact"]]
        self._contact_peers[(c.id, c.pending)] = (f.instance, hosts, f.port)

    def _found_local(self, f: MdnsFound, hosts: List[str]) -> None:
        """A local-link advert (``m=l``): at most 64 HMACs, on the links held now."""
        links = self._locals
        if not links or not self._locals_on() or f.instance in self._miss:
            return
        hit = browse_local_instance(
            f.instance, [LocalLinkKey(bytes(x.secret), x.peer_key) for x in links], self._src.now()
        )
        if hit is None:
            self._remember(f.instance)
            return
        x = links[hit["link"]]
        self._local_peers[x.id] = (f.instance, hosts, f.port)

    async def connect_local(self, link_id: str) -> ConnectSession:
        """Dial a local link seen on this network and run the mode-``l`` handshake under its secret (§15.12).
        The gate and the held list are read again before every dial. The pin is the session's: a peer that does
        not hold the link's key ends it as ``peer_revoked`` before a byte is sent back."""
        if self._stopped:
            raise LanError("not_listening", "The LAN service is stopped.")
        found = next((x for x in self._locals if x.id == link_id), None)
        seen = self._local_peers.get(link_id)
        hosts = [h for h in (seen[1] if seen is not None else []) if self._dialable(h)]
        if found is None or seen is None or not hosts:
            raise LanError("unknown_peer", "That link was not found on this network.")
        ref = ref_of_local(found)
        left = list(hosts)
        failure: Optional[LanError] = None
        while left:
            # The gate and the link are read again for every dial (§15.12 "Gates").
            still = next((x for x in self._locals if x.id == link_id and x.tag == ref.tag), None)
            if self._stopped or not self._locals_on() or still is None:
                raise LanError("closed", "That link is no longer available.")
            # The key and secret are copied before the dial: a reload during it wipes the held ones, and a copy
            # made after would hold zeros and fail the handshake. The read above and this copy are one synchronous
            # step on the loop, which is the only place ``wipe_locals`` runs, so the copy is never of wiped bytes.
            own = LocalLink(bytearray(still.secret), bytearray(still.own_key), bytes(still.peer_key))
            try:
                reader, writer, host = await self._dial(left, seen[2])
            except BaseException:
                _zero(own.secret)  # type: ignore[arg-type]
                _zero(own.own_key)  # type: ignore[arg-type]
                raise
            # The link may have been forgotten, or the gate cleared, while the socket was opening.
            if (
                self._stopped
                or not self._locals_on()
                or not any(x.id == link_id and x.tag == ref.tag for x in self._locals)
            ):
                _zero(own.secret)  # type: ignore[arg-type]
                _zero(own.own_key)  # type: ignore[arg-type]
                self._abort(writer)
                raise LanError("closed", "That link is no longer available.")
            link = self._local_link(reader, writer, ref, own)
            task = self._spawn(link.run())
            link.start()
            try:
                return await wait_opened(link, self._o.handshake_seconds + 5)  # type: ignore[no-any-return]
            except LanError as e:
                self._abort(writer)
                if e.reason not in ("connect_failed", "handshake_failed"):
                    raise
                failure = e
                left = [h for h in left if h != host]
            except Exception:
                task.cancel()
                self._abort(writer)
                failure = LanError("handshake_failed", "The handshake failed.")
                left = [h for h in left if h != host]
            finally:
                # The channel needed the key for the handshake only.
                _zero(own.secret)  # type: ignore[arg-type]
                _zero(own.own_key)  # type: ignore[arg-type]
        raise failure or LanError("handshake_failed", "The handshake failed.")

    def _local_link(self, reader: Any, writer: Any, ref: LocalRef, own: LocalLink) -> SocketLink:
        o = self._o

        def established(s: ConnectSession) -> None:
            self._sessions.add(s)
            s.on_close(lambda _c: self._sessions.discard(s))
            self._touch_local(s)

        link: SocketLink
        handlers = session_handlers(
            "initiator",
            on_established=established,
            on_ended=lambda: self._links.discard(link),
            locals_=[ref],
            xfer=o.xfer,
        )
        link = SocketLink(
            reader,
            writer,
            {
                **local_channel(
                    self._slug(),
                    caps=o.caps,
                    label=o.label,
                    now=self._src.now,
                    rekey_messages=o.rekey_messages,
                    rekey_seconds=o.rekey_seconds,
                ),
                "role": "initiator",
                "local_links": [own],
            },
            handlers,
            handshake_seconds=o.handshake_seconds,
        )
        self._links.add(link)
        return link

    async def connect_contact(self, contact_id: str, pending: bool = False) -> ConnectSession:
        """Dial a contact seen on this network and run the mode-``c`` handshake under its secret (§15.10).
        ``pending`` picks the pending secret of a re-pair. The pin is the session's: a peer that does not
        hold the contact's key ends it as ``peer_revoked`` before a byte is sent back."""
        if self._stopped:
            raise LanError("not_listening", "The LAN service is stopped.")
        c = next((x for x in self._contacts if x.id == contact_id and x.pending == pending), None)
        seen = self._contact_peers.get((contact_id, pending))
        hosts = [h for h in (seen[1] if seen is not None else []) if self._dialable(h)]
        if c is None or seen is None or not hosts:
            raise LanError("unknown_peer", "That contact was not found on this network.")
        ident = await self._identity(False)
        ref = ref_of(c)
        secret = bytes(c.secret)
        agree = c.agree_key
        err: Optional[LanError] = None
        while hosts:
            try:
                reader, writer, host = await self._dial(hosts, seen[2])
            except LanError as e:
                raise e
            link = self._contact_link(reader, writer, ident, ref, secret, agree)
            task = self._spawn(link.run())
            link.start()
            try:
                return await wait_opened(link, self._o.handshake_seconds + 5)  # type: ignore[no-any-return]
            except LanError as e:
                self._abort(writer)
                if e.reason not in ("connect_failed", "handshake_failed"):
                    raise
                err = e
                hosts = [h for h in hosts if h != host]
            except Exception:
                task.cancel()
                self._abort(writer)
                err = LanError("handshake_failed", "The handshake failed.")
                hosts = [h for h in hosts if h != host]
        raise err or LanError("handshake_failed", "The handshake failed.")

    def _contact_link(
        self, reader: Any, writer: Any, ident: PeerSource, ref: ContactRef, secret: bytes, agree_key: str
    ) -> SocketLink:
        o = self._o

        def established(s: ConnectSession) -> None:
            self._sessions.add(s)
            s.on_close(lambda _c: self._sessions.discard(s))
            self._promote_if_pending(s)

        link: SocketLink
        handlers = session_handlers(
            "initiator",
            on_established=established,
            on_ended=lambda: self._links.discard(link),
            contacts=[ref],
            xfer=o.xfer,
        )
        link = SocketLink(
            reader,
            writer,
            {
                **contact_channel(
                    ident,
                    caps=o.caps,
                    label=o.label,
                    now=self._src.now,
                    rekey_messages=o.rekey_messages,
                    rekey_seconds=o.rekey_seconds,
                ),
                "role": "initiator",
                "contacts": [ContactLink(secret, agree_key)],
            },
            handlers,
            handshake_seconds=o.handshake_seconds,
        )
        self._links.add(link)
        return link

    # -- mDNS -------------------------------------------------------------------------------------

    async def _rotate(self) -> None:
        """Advertise under the current epoch and key; set the timer for the next boundary."""
        async with self._rotate_lock:
            if self._stopped:
                return
            epoch = advert_epoch(self._src.now())
            if not self._local_only:
                ident = await self._identity(True)
                name = account_instance(ident.keys.current, epoch, ident.device_id)
                if name != self._adv_name:
                    old = self._adv
                    self._adv = await self._mdns.advertise(MdnsAdvert(name, self._port, ["v=1", "m=a"]))
                    self._adv_name = name
                    if old is not None:
                        await self._quiet(old.stop())
                # Contacts: the names rotate with the epoch like the account's.
                await self._load_contacts()
                await self._advert_contacts(ident, epoch)
            # Local links: their names rotate with the epoch too.
            await self._load_locals()
            await self._advert_locals(epoch)
            nxt = (epoch + 1) * ADVERT_EPOCH_SECONDS - self._src.now()
            if self._cancel_epoch is not None:
                self._cancel_epoch()
            timer = self._o.timer or self._default_timer
            self._cancel_epoch = timer(self._rotate_later, float(max(1, nxt)))

    def _default_timer(self, fn: Callable[[], None], seconds: float) -> Callable[[], None]:
        h = self._loop.call_later(seconds, fn)
        return h.cancel

    async def _start_browse(self) -> None:
        self._browse = await self._mdns.browse(self._found_later, self._gone, self._accepts)

    def _accepts(self, instance: str) -> bool:
        """The adapter's roster filter: may this instance name enter its tables? Only a name a roster
        device (never this one) can announce, under the current or previous epoch and either delivered key,
        or one a contact or local link's peer can announce. The names are worked out once per (epoch, keys,
        roster) (``_table``)."""
        ident = self._known
        if ident is None and not self._local_only:
            return False
        epoch = advert_epoch(self._src.now())
        held = self._names
        sig = "%s|%s" % (self._contacts_sig, self._locals_sig)
        if held is None or held[0] is not ident or held[1] != epoch or held[3] != sig:
            names: Set[str] = set()
            if ident is not None:
                keys = [ident.keys.current] + ([ident.keys.previous] if ident.keys.previous else [])
                names.update(self._table(keys, [d for d in ident.roster if d != ident.device_id]))
            # The names a contact or a local link's peer can announce (its own key in the MAC): this and the
            # last epoch.
            for back in (0, 1):
                if epoch - back < 0:
                    continue
                for c in self._contacts:
                    names.add(contact_instance(bytes(c.secret), c.agree_key_bytes, epoch - back))
                for x in self._locals:
                    names.add(local_instance(bytes(x.secret), x.peer_key, epoch - back))
            held = self._names = (ident, epoch, frozenset(names), sig)
        return instance in held[2]

    def _found_later(self, f: MdnsFound) -> None:
        self._spawn(self._quiet(self._found(f)))

    def _rotate_later(self) -> None:
        self._spawn(self._quiet(self._rotate()))

    def _gone(self, instance: str) -> None:
        for k in [k for k, (_, inst) in self._peers.items() if inst == instance]:
            del self._peers[k]
        for ck in [k for k, (inst, _h, _p) in self._contact_peers.items() if inst == instance]:
            del self._contact_peers[ck]
        for lk in [k for k, (inst, _h, _p) in self._local_peers.items() if inst == instance]:
            del self._local_peers[lk]

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
        # A local-link advert (``m=l``) is judged by parse_local_txt and by no other path (§15.4).
        if parse_local_txt(f.txt)["ok"]:
            return self._found_local(f, hosts)
        if self._local_only:
            return
        # A contact advert (``m=c``) is judged by parse_contact_txt and by no other path (§15.4): the
        # generic parser answers an unknown mode, so it can never be dialled as a or v.
        if parse_contact_txt(f.txt)["ok"]:
            return self._found_contact(f, hosts)
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
