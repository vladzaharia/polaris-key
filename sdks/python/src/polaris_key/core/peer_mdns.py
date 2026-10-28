"""WIRE-CONTRACT-V5 §15.4: the mDNS adapter (CC-10.11). ``MdnsAdapter`` is the seam the LAN service
uses, so a test injects a fake; ``MulticastDnsAdapter`` implements it on our own bounded codec
(:mod:`polaris_key.core.peer_mdns_packet`) and one UDP socket on 5353 (decision D-1: no new dependency).
Mirrors ``packages/sdk-node/src/connect/mdns.ts``. It runs on the Connect loop (D-3): every method is a
coroutine or a loop callback.

Rules this module keeps:

- the host name in the advert is the instance name (``p1-....local``), never the machine's name;
- a browse hit is dropped unless its instance name has the advert shape, it names exactly one SRV and
  one TXT, and it has an address in a private (or, opt-in, loopback) range: a LAN peer cannot make this
  device dial a public, link-local or CGNAT address;
- an A record is believed only when its address is the packet's own UDP source, so a neighbour cannot
  point another device's name at an address of its choosing; each name keeps at most four addresses and
  the first one seen is dialled (no ordering a neighbour can steer);
- the tables of instances and addresses hold at most 256 entries each, an entry expires five minutes
  after it was last refreshed, and when a table is full the least recently refreshed entry is evicted,
  so a flood cannot stop discovery;
- query replies are sent at most once a second; the packet parser's own limits (G5) live in the codec.

The socket is IPv4 only. It joins 224.0.0.251 on the default multicast interface and advertises the
RFC 1918 address the kernel routes there; ``interfaces`` (the ``lan.interfaces`` option) names the
addresses to use instead. A host with several networks and no ``interfaces`` uses the routed one only."""

from __future__ import annotations

import asyncio
import inspect
import re
import socket
import time
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Protocol, Sequence, Tuple, Union

from .peer_advert import is_instance_name
from .peer_mdns_packet import PEER_SERVICE, MdnsPacketError, Record, build_query, build_response, parse_packet

__all__ = [
    "ENTRY_TTL_SECONDS",
    "MAX_ADDRS",
    "MAX_INSTANCES",
    "MDNS_GROUP",
    "MDNS_PORT",
    "MdnsAdapter",
    "MdnsAdvert",
    "MdnsFound",
    "MdnsHandle",
    "MdnsSocket",
    "MdnsUnavailableError",
    "MulticastDnsAdapter",
    "PEER_SERVICE",
    "is_lan_address",
    "route_address",
]

MDNS_GROUP = "224.0.0.251"
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
_IPV4 = re.compile(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\Z", re.ASCII)
_INSTANCE_FQDN = re.compile(r"(p1-[a-z2-7]{16})\._pkeypeer\._tcp\.local\Z")


class MdnsAdvert(NamedTuple):
    #: ``p1-`` plus 16 base32 characters.
    instance: str
    port: int
    #: ``key=value`` entries.
    txt: Sequence[str]


class MdnsFound(NamedTuple):
    instance: str
    #: The address to dial.
    host: str
    port: int
    txt: List[str]
    #: Every address learned for the device, ``host`` first; a dialler falls through on a refused connect.
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
    """The multicast socket the adapter drives: ``send`` multicasts one packet to the group on every
    selected interface, ``close`` ends it."""

    def send(self, data: bytes) -> None: ...

    def close(self) -> None: ...


#: Make a socket that calls ``on_packet(data, source_address)`` for every datagram it receives.
SocketFactory = Callable[
    [Callable[[bytes, str], None]],
    Union[MdnsSocket, Awaitable[MdnsSocket]],
]


class MdnsUnavailableError(Exception):
    """LAN discovery cannot run here: the socket could not be opened."""

    reason = "mdns_unavailable"

    def __init__(self, message: str) -> None:
        super().__init__(message)


def is_lan_address(ip: str, allow_loopback: bool = False) -> bool:
    """An address a LAN peer may legitimately have: RFC 1918, or loopback if allowed. Link-local
    (169.254/16) and CGNAT (100.64/10) are not dialled."""
    m = _IPV4.match(ip) if isinstance(ip, str) else None
    if m is None:
        return False
    parts = [int(g) for g in m.groups()]
    if any(n > 255 for n in parts) or any(len(g) > 1 and g[0] == "0" for g in m.groups()):
        return False
    a, b = parts[0], parts[1]
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    return a == 127 and allow_loopback


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


def _fqdn(instance: str) -> str:
    return instance + "." + PEER_SERVICE


def _host_of(instance: str) -> str:
    return instance + ".local"


class _UdpSocket:
    """The real socket: one UDP socket on 5353, joined to the group on each interface."""

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


class _Receiver(asyncio.DatagramProtocol):
    def __init__(self, on_packet: Callable[[bytes, str], None]) -> None:
        self._on_packet = on_packet

    def datagram_received(self, data: bytes, addr: Any) -> None:
        try:
            self._on_packet(data, str(addr[0]))
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


class MulticastDnsAdapter:
    """``create(on_packet)`` makes a socket (default: the real one). ``interfaces`` are the IPv4
    addresses of the networks to use; without them the routed address is used. ``addresses`` are the
    addresses to put in an advert (default: the interfaces). ``allow_loopback`` accepts (and
    advertises) 127.0.0.0/8, for tests and same-host peers only. ``clock`` is monotonic seconds."""

    def __init__(
        self,
        create: Optional[SocketFactory] = None,
        addresses: Optional[Callable[[], List[str]]] = None,
        allow_loopback: bool = False,
        interfaces: Optional[Sequence[str]] = None,
        clock: Callable[[], float] = time.monotonic,
        route: Callable[[], Optional[str]] = route_address,
    ) -> None:
        self._create = create
        self._addresses = addresses
        self._loop_ok = allow_loopback
        self._interfaces = list(interfaces) if interfaces is not None else None
        self._clock = clock
        self._route = route

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

    async def _socket(self, on_packet: Callable[[bytes, str], None]) -> MdnsSocket:
        if self._create is not None:
            made = self._create(on_packet)
            if inspect.isawaitable(made):
                made = await made
            return made  # type: ignore[return-value]
        return await _open_udp(on_packet, self._own())

    # -- advertise --------------------------------------------------------------------------------

    async def advertise(self, a: MdnsAdvert) -> MdnsHandle:
        if not is_instance_name(a.instance):
            raise ValueError("instance name")
        if not 1 <= a.port <= 65535:
            raise ValueError("port")
        addrs = self._own()
        fq, host = _fqdn(a.instance), _host_of(a.instance)
        txt = list(a.txt)
        last_reply = [float("-inf")]
        state: Dict[str, Any] = {"sock": None, "again": None, "closed": False}

        def records(ttl: int) -> List[Record]:
            out = [
                Record(PEER_SERVICE, "PTR", ttl, fq),
                Record(fq, "SRV", ttl, {"port": a.port, "target": host, "priority": 0, "weight": 0}),
                Record(fq, "TXT", 0 if ttl == 0 else _TXT_TTL, txt),
            ]
            out.extend(Record(host, "A", ttl, ip) for ip in addrs)
            return out

        def send_records(ttl: int) -> None:
            sock = state["sock"]
            if sock is not None and not state["closed"] and addrs:
                try:
                    sock.send(build_response(records(ttl)))
                except (ValueError, OSError):
                    pass

        def on_packet(data: bytes, src: str) -> None:
            if state["closed"]:
                return
            try:
                p = parse_packet(data)
            except MdnsPacketError:
                return
            if p.is_response:
                return
            if not any(q.name in (PEER_SERVICE, fq, host) for q in p.questions):
                return
            t = self._clock()
            if t - last_reply[0] >= REPLY_GAP_SECONDS:
                last_reply[0] = t
                send_records(TTL)

        state["sock"] = await self._socket(on_packet)
        send_records(TTL)
        state["again"] = asyncio.get_running_loop().call_later(1.0, lambda: send_records(TTL))

        async def stop() -> None:
            again = state["again"]
            if again is not None:
                again.cancel()
            send_records(0)
            state["closed"] = True
            sock = state["sock"]
            if sock is not None:
                sock.close()

        return MdnsHandle(stop)

    # -- browse -----------------------------------------------------------------------------------

    async def browse(
        self,
        on_up: Callable[[MdnsFound], None],
        on_down: Optional[Callable[[str], None]] = None,
    ) -> MdnsHandle:
        clock = self._clock
        loop_ok = self._loop_ok
        seen: "OrderedDict[str, _Entry]" = OrderedDict()
        addr: "OrderedDict[str, _Addrs]" = OrderedDict()
        state: Dict[str, Any] = {"sock": None, "t1": None, "t2": None, "closed": False}

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

        def trim_addr(now: float) -> None:
            for k in [k for k, v in addr.items() if now - v.at > ENTRY_TTL_SECONDS]:
                del addr[k]
            while len(addr) >= MAX_INSTANCES:
                addr.popitem(last=False)

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

        def learn_a(r: Record, src: str, now: float) -> None:
            # Only the sender's own address, and only a LAN one.
            if not isinstance(r.data, str) or r.data != src or not is_lan_address(r.data, loop_ok):
                return
            e = addr.pop(r.name, None)
            if e is None:
                if not admit(src, now):
                    return
                if len(addr) >= MAX_INSTANCES:
                    trim_addr(now)
                e = _Addrs(now)
            if r.data not in e.ips and len(e.ips) < MAX_ADDRS:
                e.ips.append(r.data)
            e.at = now
            addr[r.name] = e  # most recently refreshed last

        def learn(records: Sequence[Record], src: str) -> None:
            now = clock()
            for r in records:
                if r.type == "A":
                    learn_a(r, src, now)
                    continue
                name = r.data if r.type == "PTR" else r.name
                m = _INSTANCE_FQDN.match(name) if isinstance(name, str) else None
                if m is None or (r.type == "PTR" and r.name != PEER_SERVICE):
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
                ips = addr[e.target].ips if e.target is not None and e.target in addr else None
                if e.port is None or e.txt is None or not ips:
                    continue
                host = ips[0]
                sig = "%s|%d|%s" % (",".join(ips), e.port, "\n".join(e.txt))
                if e.up == sig:
                    continue
                e.up = sig
                try:
                    on_up(MdnsFound(inst, host, e.port, list(e.txt), tuple(ips)))
                except Exception:
                    pass  # a host callback never stops discovery

        def on_packet(data: bytes, src: str) -> None:
            if state["closed"]:
                return
            try:
                p = parse_packet(data)
            except MdnsPacketError:
                return
            if p.is_response:
                learn(p.answers, src)

        def ask() -> None:
            sock = state["sock"]
            if sock is None or state["closed"]:
                return
            trim_expired()
            qs: List[Tuple[str, str]] = [(PEER_SERVICE, "PTR")]
            for inst, e in seen.items():
                if e.up is None:
                    qs.append((_fqdn(inst), "SRV"))
                    qs.append((_fqdn(inst), "TXT"))
                    qs.append((_host_of(inst), "A"))
            try:
                sock.send(build_query(qs[:_ASK_QUESTIONS]))
            except (ValueError, OSError):
                pass

        def trim_expired() -> None:
            now = clock()
            for k in [k for k, v in seen.items() if now - v.at > ENTRY_TTL_SECONDS]:
                e = seen.pop(k)
                if e.up is not None:
                    down(k)
            for k in [k for k, v in addr.items() if now - v.at > ENTRY_TTL_SECONDS]:
                del addr[k]

        state["sock"] = await self._socket(on_packet)
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
            sock = state["sock"]
            if sock is not None:
                sock.close()

        return MdnsHandle(stop)
