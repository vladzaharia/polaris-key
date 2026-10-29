"""WIRE-CONTRACT-V5 §15.4: the mDNS adapter (CC-10.11, CC-IPV6.4a). ``MdnsAdapter`` is the seam the LAN
service uses, so a test injects a fake; ``MulticastDnsAdapter`` implements it on our own bounded codec
(:mod:`polaris_key.core.peer_mdns_packet`) and UDP sockets on 5353 (decision D-1: no new dependency).
Mirrors ``packages/sdk-node/src/connect/mdns.ts``. It runs on the Connect loop (D-3): every method is a
coroutine or a loop callback.

Rules this module keeps:

- the host name in the advert is the instance name (``p1-....local``), never the machine's name;
- a browse hit is dropped unless its instance name has the advert shape and it names exactly one SRV and
  one TXT;
- a response is ignored unless its source is inside a connected subnet (address and prefix) of the
  receiving interface (RFC 6762 section 11); on IPv6 there is one socket per interface, so the interface
  is known, a link-local source is on-link by definition, and it takes the interface as its zone;
- an A or AAAA record is believed only when its address equals the packet's own UDP source (an IPv4-mapped
  source counts as its IPv4 address), so a neighbour cannot point another device's name at an address of
  its choosing. There is no filter on the address when it is learned: the dial-time ``lan_verdict``
  (:mod:`polaris_key.core.peer_lan_address`) decides what is dialled. A record with TTL 0 removes its
  address. Names compare by ASCII fold. Each name keeps at most four addresses, in the order they were
  first seen (the ``mdnsAnswers`` rows of ``peer-matrix.json``). The rate limit on new names is the
  only filter on a source;
- IPv6 mDNS runs on ``ff02::fb`` on at most eight interfaces that are up, multicast-capable and have an
  fe80 address, one socket each (``IPV6_JOIN_GROUP``, ``IPV6_MULTICAST_IF``); the zone is the interface
  name. The AAAA record carries the fe80 address the kernel sends from;
- the tables of instances and addresses hold at most 256 entries each, an entry expires five minutes
  after it was last refreshed, and when a table is full the least recently refreshed entry is evicted,
  so a flood cannot stop discovery;
- query replies are sent at most once a second per socket; the packet parser's own limits (G5) live in
  the codec.

The IPv4 socket joins 224.0.0.251 on the default multicast interface and advertises the RFC 1918 address
the kernel routes there; ``interfaces`` (the ``lan.interfaces`` option) names the addresses to use
instead. A host with several networks and no ``interfaces`` uses the routed one only. The connected
subnets and the IPv6 interfaces come from :mod:`polaris_key.core.peer_mdns_ifaces`; where the platform's
interface list cannot be read, browsing raises :class:`MdnsUnavailableError` rather than guess a subnet."""

from __future__ import annotations

import asyncio
import inspect
import re
import socket
import struct
import sys
import time
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Protocol, Sequence, Tuple, Union

from .peer_advert import is_instance_name
from .peer_lan_address import (
    canon_ip,
    fold_mapped,
    in_cidr,
    is_link_local,
    lan_verdict,
    parse_address,
    split_zone,
)
from .peer_mdns_ifaces import (
    MAX_INTERFACES,
    InterfaceAddress,
    MdnsInterface,
    interface_addresses,
    v4_subnets,
    v6_interfaces,
)
from .peer_mdns_packet import PEER_SERVICE, MdnsPacketError, Record, build_query, build_response, parse_packet

__all__ = [
    "AddressBook",
    "ENTRY_TTL_SECONDS",
    "MAX_ADDRS",
    "MAX_INSTANCES",
    "MAX_INTERFACES",
    "MDNS_GROUP",
    "MDNS_GROUP6",
    "MDNS_PORT",
    "MdnsAdapter",
    "MdnsAdvert",
    "MdnsFound",
    "MdnsHandle",
    "MdnsInterface",
    "MdnsSocket",
    "MdnsUnavailableError",
    "MulticastDnsAdapter",
    "PEER_SERVICE",
    "fold_name",
    "is_lan_address",
    "route_address",
    "source_in_subnets",
]

MDNS_GROUP = "224.0.0.251"
MDNS_GROUP6 = "ff02::fb"
MDNS_PORT = 5353
MAX_INSTANCES = 256
#: Addresses kept per host name, and how long a learned record is believed.
MAX_ADDRS = 4
ENTRY_TTL_SECONDS = 5 * 60.0
REPLY_GAP_SECONDS = 1.0
#: New table entries one source address may add in ``NEW_WINDOW_SECONDS`` (S4): a flood from one host
#: cannot evict the table. At most ``MAX_SOURCES`` sources are tracked.
MAX_NEW_PER_SOURCE = 16
NEW_WINDOW_SECONDS = 60.0
MAX_SOURCES = 256
TTL = 120
_TXT_TTL = 4500
_ASK_QUESTIONS = 32
_SUBNET_MEMO_SECONDS = 5.0
_INSTANCE_FQDN = re.compile(r"(p1-[a-z2-7]{16})\._pkeypeer\._tcp\.local\Z")


class MdnsAdvert(NamedTuple):
    #: ``p1-`` plus 16 base32 characters.
    instance: str
    port: int
    #: ``key=value`` entries.
    txt: Sequence[str]


class MdnsFound(NamedTuple):
    instance: str
    #: The first address learned.
    host: str
    port: int
    txt: List[str]
    #: Every address learned for the device (at most four), first seen first; a link-local one carries its
    #: ``%zone``. A dialler judges each (§15.4.1) and races the ones that pass.
    hosts: Tuple[str, ...] = ()


class MdnsHandle:
    """What ``advertise`` and ``browse`` return. ``stop`` is a coroutine; it may be awaited twice."""

    def __init__(self, stop: Callable[[], Awaitable[None]]) -> None:
        self._stop = stop
        self._done = False

    async def stop(self) -> None:
        if self._done:
            return
        self._done = True
        await self._stop()


class MdnsAdapter(Protocol):
    """The seam the LAN service uses; callbacks run on the Connect loop."""

    async def advertise(self, advert: MdnsAdvert) -> MdnsHandle: ...

    async def browse(
        self,
        on_up: Callable[[MdnsFound], None],
        on_down: Optional[Callable[[str], None]] = None,
    ) -> MdnsHandle: ...


class MdnsSocket(Protocol):
    """The multicast socket the adapter drives: ``send`` multicasts one packet to the group on the socket's
    interface(s), ``close`` ends it."""

    def send(self, data: bytes) -> None: ...

    def close(self) -> None: ...


#: Make a socket that calls ``on_packet(data, source_address)`` for every datagram it receives.
SocketFactory = Callable[
    [Callable[[bytes, str], None]],
    Union[MdnsSocket, Awaitable[MdnsSocket]],
]
#: The same for one IPv6 interface.
SocketFactory6 = Callable[
    [MdnsInterface, Callable[[bytes, str], None]],
    Union[MdnsSocket, Awaitable[MdnsSocket]],
]


class MdnsUnavailableError(Exception):
    """LAN discovery cannot run here: the socket could not be opened, or the interface list is unreadable."""

    reason = "mdns_unavailable"

    def __init__(self, message: str) -> None:
        super().__init__(message)


def is_lan_address(ip: str, allow_loopback: bool = False) -> bool:
    """An IPv4 address a LAN peer may legitimately have: RFC 1918, or loopback if allowed. Link-local
    (169.254/16) and CGNAT (100.64/10) are not dialled. For IPv6 and for every address a socket reports,
    use :func:`~polaris_key.core.peer_lan_address.lan_verdict`."""
    p = parse_address(ip)
    return p is not None and p[0] == "v4" and lan_verdict(ip, None, allow_loopback).dial


def route_address(
    make_socket: Callable[..., Any] = socket.socket, group: str = MDNS_GROUP, port: int = MDNS_PORT
) -> Optional[str]:
    """The local IPv4 address the kernel would send multicast from, or ``None``. A connected UDP socket
    sends nothing: ``connect`` only asks the routing table."""
    s = make_socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((group, port))
        host = s.getsockname()[0]
        return str(host)
    except OSError:
        return None
    finally:
        s.close()


#: ASCII fold: ``A`` to ``Z`` to ``a`` to ``z`` and nothing else (DNS names, §15.4).
_FOLD = {c: c + 32 for c in range(ord("A"), ord("Z") + 1)}


def fold_name(name: str) -> str:
    return name.translate(_FOLD)


def source_in_subnets(source: str, nets: Sequence[str]) -> bool:
    """RFC 6762 section 11: the response's source is inside one of the receiving interface's connected subnets."""
    return any(in_cidr(source, n) for n in nets)


class _Entry:
    __slots__ = ("at", "port", "target", "txt", "up")

    def __init__(self, at: float) -> None:
        self.at = at
        self.port: Optional[int] = None
        self.target: Optional[str] = None
        self.txt: Optional[List[str]] = None
        self.up: Optional[str] = None


class _Addrs:
    __slots__ = ("at", "ips")

    def __init__(self, at: float) -> None:
        self.at = at
        self.ips: List[str] = []


class AddressBook:
    """The addresses learned for each host name (§15.4 Addresses; the ``mdnsAnswers`` rows). The rule is the
    whole of learning: a record counts only when its address equals the packet's source (an IPv4-mapped
    source as its IPv4 address), whatever the address is; TTL 0 removes it; names fold by ASCII; four per
    name, first seen first. Bounded in names: the least recently refreshed is evicted."""

    def __init__(self, max_names: int = MAX_INSTANCES) -> None:
        self._max = max_names
        self._m: "OrderedDict[str, _Addrs]" = OrderedDict()

    def learn(
        self,
        r: Record,
        source: str,
        zone: Optional[str],
        now: float,
        admit: Optional[Callable[[], bool]] = None,
    ) -> None:
        """Apply one address record from a packet sent by ``source`` and received on ``zone`` (``None``:
        none). ``admit`` is asked only when the record would add a name."""
        want = canon_ip(split_zone(source)[0])
        got = canon_ip(r.data) if isinstance(r.data, str) else None
        if want is None or got is None or fold_mapped(want) != got:
            return
        address = "%s%%%s" % (got, zone) if zone is not None and is_link_local(got) else got
        name = fold_name(r.name)
        e = self._m.get(name)
        if r.ttl == 0:
            if e is None:
                return
            e.ips = [x for x in e.ips if x != address]
            if not e.ips:
                del self._m[name]
            return
        if e is None:
            if admit is not None and not admit():
                return
            if len(self._m) >= self._max:
                self.trim(now)
            e = _Addrs(now)
        else:
            del self._m[name]
        if address not in e.ips and len(e.ips) < MAX_ADDRS:
            e.ips.append(address)
        e.at = now
        self._m[name] = e  # most recently refreshed last

    def hosts(self, name: str) -> List[str]:
        """The addresses held for ``name``, first seen first."""
        e = self._m.get(fold_name(name))
        return list(e.ips) if e is not None else []

    def hold(self, name: str, address: str, now: float = 0.0) -> None:
        """Seed the table (a conformance row's ``prior``)."""
        n = fold_name(name)
        e = self._m.get(n)
        if e is None:
            e = self._m[n] = _Addrs(now)
        e.ips.append(address)

    def table(self) -> List[Tuple[str, str]]:
        """The table as ``(name, address)`` entries, grouped by name, each name first seen first."""
        return [(n, a) for n, e in self._m.items() for a in e.ips]

    def expire(self, now: float) -> None:
        for k in [k for k, v in self._m.items() if now - v.at > ENTRY_TTL_SECONDS]:
            del self._m[k]

    def trim(self, now: float) -> None:
        """Drop expired entries, then the oldest while full."""
        self.expire(now)
        while len(self._m) >= self._max:
            self._m.popitem(last=False)


def _fqdn(instance: str) -> str:
    return instance + "." + PEER_SERVICE


def _host_of(instance: str) -> str:
    return instance + ".local"


class _UdpSocket:
    """The real IPv4 socket: one UDP socket on 5353, joined to the group on each interface."""

    def __init__(self, transport: Any, sock: Any, interfaces: Sequence[str]) -> None:
        self._t = transport
        self._sock = sock
        self._ifaces = list(interfaces)

    def send(self, data: bytes) -> None:
        if self._t.is_closing():
            return
        dest = (MDNS_GROUP, MDNS_PORT)
        if len(self._ifaces) <= 1:
            self._t.sendto(data, dest)
            return
        for addr in self._ifaces:
            try:
                self._sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(addr))
                self._t.sendto(data, dest)
            except OSError:
                continue

    def close(self) -> None:
        self._t.close()


class _UdpSocket6:
    """The real IPv6 socket of one interface."""

    def __init__(self, transport: Any, index: int) -> None:
        self._t = transport
        self._index = index

    def send(self, data: bytes) -> None:
        if not self._t.is_closing():
            self._t.sendto(data, (MDNS_GROUP6, MDNS_PORT, 0, self._index))

    def close(self) -> None:
        self._t.close()


class _Receiver(asyncio.DatagramProtocol):
    def __init__(self, on_packet: Callable[[bytes, str], None], index: int = 0) -> None:
        self._on_packet = on_packet
        self._index = index

    def datagram_received(self, data: bytes, addr: Any) -> None:
        try:
            src = split_zone(str(addr[0]))[0]
            # A link-local source names its interface: one that arrived on another is not ours.
            if self._index and len(addr) >= 4 and addr[3] not in (0, self._index) and is_link_local(src):
                return
            self._on_packet(data, src)
        except Exception:
            pass  # a bad packet or a host callback never stops the socket

    def error_received(self, exc: Exception) -> None:
        pass


async def _open_udp(on_packet: Callable[[bytes, str], None], interfaces: Sequence[str]) -> MdnsSocket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        reuse_port = getattr(socket, "SO_REUSEPORT", None)
        if reuse_port is not None:
            try:
                sock.setsockopt(socket.SOL_SOCKET, reuse_port, 1)
            except OSError:
                pass
        sock.bind(("", MDNS_PORT))
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
        group = socket.inet_aton(MDNS_GROUP)
        if interfaces:
            for addr in interfaces:
                sock.setsockopt(
                    socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, group + socket.inet_aton(addr)
                )
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interfaces[0]))
        else:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, group + socket.inet_aton("0.0.0.0"))
        sock.setblocking(False)
        transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(
            lambda: _Receiver(on_packet), sock=sock
        )
    except OSError as e:
        sock.close()
        raise MdnsUnavailableError("The mDNS socket could not be opened; LAN discovery is off.") from e
    return _UdpSocket(transport, sock, interfaces)


async def _open_udp6(iface: MdnsInterface, on_packet: Callable[[bytes, str], None]) -> MdnsSocket:
    """One IPv6 socket for one interface: ``ff02::fb`` joined on it (``IPV6_JOIN_GROUP``), sent from it
    (``IPV6_MULTICAST_IF``), IPv6 only so it never shares IPv4 traffic with the other socket."""
    sock = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        reuse_port = getattr(socket, "SO_REUSEPORT", None)
        if reuse_port is not None:
            try:
                sock.setsockopt(socket.SOL_SOCKET, reuse_port, 1)
            except OSError:
                pass
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        if sys.platform.startswith("linux"):
            try:
                # IPV6_MULTICAST_ALL = 29: receive only the groups this socket joined.
                sock.setsockopt(socket.IPPROTO_IPV6, 29, 0)
            except OSError:
                pass
        if sys.platform.startswith("linux"):
            try:
                # Bound to the group and the interface, so only that traffic arrives.
                sock.bind((MDNS_GROUP6, MDNS_PORT, 0, iface.ifindex))
            except OSError:
                sock.bind(("::", MDNS_PORT))
        else:
            # The BSDs (macOS) deliver a group's traffic to the sockets that joined it on that interface.
            sock.bind(("::", MDNS_PORT))
        sock.setsockopt(
            socket.IPPROTO_IPV6,
            socket.IPV6_JOIN_GROUP,
            struct.pack("16sI", socket.inet_pton(socket.AF_INET6, MDNS_GROUP6), iface.ifindex),
        )
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_IF, iface.ifindex)
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_HOPS, 255)
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_LOOP, 1)
        sock.setblocking(False)
        transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(
            lambda: _Receiver(on_packet, iface.ifindex), sock=sock
        )
    except OSError as e:
        sock.close()
        raise MdnsUnavailableError("The IPv6 mDNS socket could not be opened.") from e
    return _UdpSocket6(transport, iface.ifindex)


#: A socket and the interface it is on (``None``: the IPv4 socket).
_Face = Tuple[MdnsSocket, Optional[MdnsInterface]]


class MulticastDnsAdapter:
    """``create(on_packet)`` makes the IPv4 socket (default: the real one). ``interfaces`` are the IPv4
    addresses of the networks to use; without them the routed address is used. ``addresses`` are the
    addresses to put in an advert (default: the interfaces). ``allow_loopback`` accepts (and advertises)
    127.0.0.0/8, for tests and same-host peers only. ``clock`` is monotonic seconds.

    IPv6 is on by default, except when ``create`` is injected and ``create6`` is not (a test has then chosen
    its sockets); ``v6=False`` is IPv4 only. ``interfaces6`` lists the IPv6 interfaces, ``create6(iface,
    on_packet)`` makes the socket of one, and ``subnets`` lists the connected IPv4 subnets (CIDR) a response
    on the IPv4 socket must come from (default: this machine's)."""

    def __init__(
        self,
        create: Optional[SocketFactory] = None,
        addresses: Optional[Callable[[], List[str]]] = None,
        allow_loopback: bool = False,
        interfaces: Optional[Sequence[str]] = None,
        clock: Callable[[], float] = time.monotonic,
        route: Callable[[], Optional[str]] = route_address,
        create6: Optional[SocketFactory6] = None,
        interfaces6: Optional[Callable[[], List[MdnsInterface]]] = None,
        subnets: Optional[Callable[[], List[str]]] = None,
        v6: Optional[bool] = None,
    ) -> None:
        self._create = create
        self._create6 = create6
        self._addresses = addresses
        self._loop_ok = allow_loopback
        self._interfaces = list(interfaces) if interfaces is not None else None
        self._clock = clock
        self._route = route
        self._interfaces6 = interfaces6
        self._subnets = subnets
        self._v6 = v6 if v6 is not None else (create is None or create6 is not None)
        self._memo: Optional[Tuple[float, List[str]]] = None

    def __repr__(self) -> str:
        return "<MulticastDnsAdapter>"

    def _own(self) -> List[str]:
        """The LAN addresses of the chosen interfaces (only these are ever advertised)."""
        if self._addresses is not None:
            found = list(self._addresses())
        elif self._interfaces is not None:
            found = list(self._interfaces)
        else:
            r = self._route()
            found = [r] if r else []
        out: List[str] = []
        for a in found:
            if is_lan_address(a, self._loop_ok) and a not in out:
                out.append(a)
        return out

    def _ifaces6(self) -> List[MdnsInterface]:
        if self._interfaces6 is not None:
            return list(self._interfaces6())
        return v6_interfaces(self._loop_ok, interface_addresses())

    def _nets4(self) -> List[str]:
        """The connected IPv4 subnets, read at most every few seconds. Unreadable is unavailable."""
        if self._subnets is not None:
            return list(self._subnets())
        now = self._clock()
        if self._memo is None or now - self._memo[0] >= _SUBNET_MEMO_SECONDS:
            addrs: Optional[List[InterfaceAddress]] = interface_addresses()
            nets = v4_subnets(self._loop_ok, addrs)
            if nets is None:
                raise MdnsUnavailableError("The network interfaces cannot be listed here; LAN discovery is off.")
            self._memo = (now, nets)
        return self._memo[1]

    async def _socket(self, on_packet: Callable[[bytes, str], None]) -> MdnsSocket:
        if self._create is not None:
            made = self._create(on_packet)
            if inspect.isawaitable(made):
                made = await made
            return made  # type: ignore[return-value]
        return await _open_udp(on_packet, self._own())

    async def _faces(self, handler: Callable[[Optional[MdnsInterface]], Callable[[bytes, str], None]]) -> List[_Face]:
        """The IPv4 socket, then one IPv6 socket per usable interface. A v6 socket that cannot be made is skipped."""
        faces: List[_Face] = [(await self._socket(handler(None)), None)]
        if not self._v6:
            return faces
        try:
            for iface in self._ifaces6()[:MAX_INTERFACES]:
                try:
                    made: Any = (self._create6 or _open_udp6)(iface, handler(iface))
                    if inspect.isawaitable(made):
                        made = await made
                except MdnsUnavailableError:
                    continue
                faces.append((made, iface))
        except BaseException:
            for sock, _ in faces:
                sock.close()
            raise
        return faces

    # -- advertise --------------------------------------------------------------------------------

    async def advertise(self, a: MdnsAdvert) -> MdnsHandle:
        if not is_instance_name(a.instance):
            raise ValueError("instance name")
        if not 1 <= a.port <= 65535:
            raise ValueError("port")
        addrs = self._own()
        fq, host = _fqdn(a.instance), _host_of(a.instance)
        txt = list(a.txt)
        last_reply: Dict[Optional[str], float] = {}
        state: Dict[str, Any] = {"faces": [], "again": None, "closed": False}

        def records(ttl: int, iface: Optional[MdnsInterface]) -> List[Record]:
            out = [
                Record(PEER_SERVICE, "PTR", ttl, fq),
                Record(fq, "SRV", ttl, {"port": a.port, "target": host, "priority": 0, "weight": 0}),
                Record(fq, "TXT", 0 if ttl == 0 else _TXT_TTL, txt),
            ]
            # An A record leaves on the IPv4 socket and an AAAA on its interface's own: a browser believes
            # only an address equal to the packet's source.
            if iface is None:
                out.extend(Record(host, "A", ttl, ip) for ip in addrs)
            else:
                own = [x for x in iface.addresses if is_link_local(x)][:MAX_ADDRS]
                out.extend(Record(host, "AAAA", ttl, ip) for ip in own)
            return out

        def send_face(face: _Face, ttl: int) -> None:
            sock, iface = face
            recs = records(ttl, iface)
            # Without an address there is nothing to say: the PTR alone cannot be dialled.
            if state["closed"] or not any(r.type in ("A", "AAAA") for r in recs):
                return
            try:
                sock.send(build_response(recs))
            except (ValueError, OSError):
                pass

        def send_records(ttl: int) -> None:
            for face in list(state["faces"]):
                send_face(face, ttl)

        def handler(iface: Optional[MdnsInterface]) -> Callable[[bytes, str], None]:
            key = None if iface is None else iface.name

            def on_packet(data: bytes, src: str) -> None:
                if state["closed"]:
                    return
                try:
                    p = parse_packet(data)
                except MdnsPacketError:
                    return
                if p.is_response:
                    return
                if not any(fold_name(q.name) in (PEER_SERVICE, fq, host) for q in p.questions):
                    return
                t = self._clock()
                if t - last_reply.get(key, float("-inf")) >= REPLY_GAP_SECONDS:
                    last_reply[key] = t
                    for face in list(state["faces"]):
                        if face[1] is iface:
                            send_face(face, TTL)

            return on_packet

        state["faces"] = await self._faces(handler)
        send_records(TTL)
        state["again"] = asyncio.get_running_loop().call_later(1.0, lambda: send_records(TTL))

        async def stop() -> None:
            again = state["again"]
            if again is not None:
                again.cancel()
            send_records(0)
            state["closed"] = True
            for sock, _ in state["faces"]:
                sock.close()

        return MdnsHandle(stop)

    # -- browse -----------------------------------------------------------------------------------

    async def browse(
        self,
        on_up: Callable[[MdnsFound], None],
        on_down: Optional[Callable[[str], None]] = None,
    ) -> MdnsHandle:
        clock = self._clock
        seen: "OrderedDict[str, _Entry]" = OrderedDict()
        book = AddressBook()
        state: Dict[str, Any] = {"faces": [], "t1": None, "t2": None, "closed": False}

        def down(k: str) -> None:
            if on_down is not None:
                try:
                    on_down(k)
                except Exception:
                    pass

        def trim_seen(now: float) -> None:
            for k in [k for k, v in seen.items() if now - v.at > ENTRY_TTL_SECONDS]:
                e = seen.pop(k)
                if e.up is not None:
                    down(k)
            while len(seen) >= MAX_INSTANCES:
                k, e = seen.popitem(last=False)
                if e.up is not None:
                    down(k)

        fresh: "OrderedDict[str, List[float]]" = OrderedDict()

        def admit(src: str, now: float) -> bool:
            """May ``src`` add one more new entry? 16 a minute each."""
            ts = fresh.pop(src, None)
            ts = [t for t in (ts or []) if now - t < NEW_WINDOW_SECONDS]
            ok = len(ts) < MAX_NEW_PER_SOURCE
            if ok:
                ts.append(now)
            fresh[src] = ts
            while len(fresh) > MAX_SOURCES:
                fresh.popitem(last=False)
            return ok

        def learn(records: Sequence[Record], src: str, zone: Optional[str]) -> None:
            now = clock()
            for r in records:
                if r.type in ("A", "AAAA"):
                    book.learn(r, src, zone, now, lambda: admit(src, now))
                    continue
                name = r.data if r.type == "PTR" else r.name
                m = _INSTANCE_FQDN.match(fold_name(name)) if isinstance(name, str) else None
                if m is None or (r.type == "PTR" and fold_name(r.name) != PEER_SERVICE):
                    continue
                inst = m.group(1)
                if r.type == "PTR" and r.ttl == 0:
                    if seen.pop(inst, None) is not None:
                        down(inst)
                    continue
                e = seen.pop(inst, None)
                if e is None:
                    if not admit(src, now):
                        continue
                    if len(seen) >= MAX_INSTANCES:
                        trim_seen(now)
                    e = _Entry(now)
                e.at = now
                seen[inst] = e
                if r.type == "SRV" and isinstance(r.data, dict):
                    port = r.data.get("port")
                    if not isinstance(port, int) or not 1 <= port <= 65535:
                        continue
                    e.port = port
                    # Only our own host name shape: the target is the instance's ``.local`` name.
                    if r.data.get("target") == _host_of(inst):
                        e.target = r.data["target"]
                elif r.type == "TXT" and isinstance(r.data, list):
                    e.txt = list(r.data)
            for inst, e in list(seen.items()):
                if e.port is None or e.txt is None:
                    continue
                ips = book.hosts(e.target) if e.target is not None else []
                if not ips:
                    # Every address was withdrawn: the peer cannot be dialled until one is learned again.
                    if e.up is not None:
                        e.up = None
                        down(inst)
                    continue
                sig = "%s|%d|%s" % (",".join(ips), e.port, "\n".join(e.txt))
                if e.up == sig:
                    continue
                e.up = sig
                try:
                    on_up(MdnsFound(inst, ips[0], e.port, list(e.txt), tuple(ips)))
                except Exception:
                    pass  # a host callback never stops discovery

        def handler(iface: Optional[MdnsInterface]) -> Callable[[bytes, str], None]:
            def on_packet(data: bytes, src: str) -> None:
                if state["closed"]:
                    return
                try:
                    p = parse_packet(data)
                except MdnsPacketError:
                    return
                if not p.is_response:
                    return
                # A response from outside the link's subnets teaches nothing (RFC 6762 section 11). On
                # IPv6 a link-local source is on-link by definition and takes the interface as its zone.
                if iface is None:
                    if not source_in_subnets(src, self._nets4()):
                        return
                elif not (is_link_local(src) or source_in_subnets(src, iface.nets)):
                    return
                learn(p.answers, src, None if iface is None else iface.zone)

            return on_packet

        def ask() -> None:
            if state["closed"]:
                return
            now = clock()
            trim_expired(now)
            qs: List[Tuple[str, str]] = [(PEER_SERVICE, "PTR")]
            for inst, e in seen.items():
                if e.up is None:
                    qs.append((_fqdn(inst), "SRV"))
                    qs.append((_fqdn(inst), "TXT"))
                    qs.append((_host_of(inst), "A"))
                    qs.append((_host_of(inst), "AAAA"))
            try:
                packet = build_query(qs[:_ASK_QUESTIONS])
            except ValueError:
                return
            for sock, _ in list(state["faces"]):
                try:
                    sock.send(packet)
                except (ValueError, OSError):
                    pass

        def trim_expired(now: float) -> None:
            for k in [k for k, v in seen.items() if now - v.at > ENTRY_TTL_SECONDS]:
                e = seen.pop(k)
                if e.up is not None:
                    down(k)
            book.expire(now)

        if self._subnets is None:
            self._nets4()  # unreadable interfaces fail now, not on the first packet
        state["faces"] = await self._faces(handler)
        ask()
        loop = asyncio.get_running_loop()
        state["t1"] = loop.call_later(1.0, ask)

        def again() -> None:
            ask()
            if not state["closed"]:
                state["t2"] = loop.call_later(30.0, again)

        state["t2"] = loop.call_later(30.0, again)

        async def stop() -> None:
            state["closed"] = True
            for k in ("t1", "t2"):
                if state[k] is not None:
                    state[k].cancel()
            for sock, _ in state["faces"]:
                sock.close()

        return MdnsHandle(stop)
