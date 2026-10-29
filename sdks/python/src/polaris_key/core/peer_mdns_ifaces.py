"""WIRE-CONTRACT-V5 §15.4: the local network interfaces the mDNS adapter uses. The standard library lists
interface names and indexes (``socket.if_nameindex``) but not their addresses or prefixes, and the
RFC 6762 §11 source check needs the connected subnets, so this module reads them with the C library's
``getifaddrs`` through :mod:`ctypes` (Linux and macOS). Where that is not available
:func:`interface_addresses` returns ``None`` and the adapter says so (``MdnsUnavailableError``) rather
than guess a subnet.

The device's own link-local address on an interface is the one the kernel would send from: a UDP socket
connected to ``ff02::fb%<index>`` sends nothing, and ``getsockname`` then names the source address. That
is the address that must go in the AAAA record, because a browser believes an AAAA record only when it
equals the packet's source.
"""

from __future__ import annotations

import ctypes
import socket
import struct
import sys
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence, Tuple

from .peer_lan_address import is_link_local, parse_address, text6

__all__ = [
    "MAX_INTERFACES",
    "InterfaceAddress",
    "MdnsInterface",
    "interface_addresses",
    "own_link_local",
    "v4_subnets",
    "v6_interfaces",
]

#: IPv6 interfaces used (§15.4).
MAX_INTERFACES = 8
_GROUP6 = "ff02::fb"
_MDNS_PORT = 5353
_IFF_UP, _IFF_LOOPBACK, _IFF_POINTOPOINT = 0x1, 0x8, 0x10
#: IFF_MULTICAST is 0x1000 on Linux and 0x8000 on the BSDs (macOS included).
_BSD = sys.platform in ("darwin", "freebsd", "openbsd", "netbsd")
_IFF_MULTICAST = 0x8000 if _BSD else 0x1000
#: Apple's wireless direct-link interfaces carry link-local addresses but are not a LAN.
_NOT_A_LAN = ("awdl", "llw")


class InterfaceAddress(NamedTuple):
    """One address of a local interface, as the platform reports it."""

    name: str
    ifindex: int
    #: Address text, no zone.
    address: str
    #: The connected subnet's prefix length.
    prefix: int
    v6: bool
    up: bool
    loopback: bool
    point_to_point: bool
    multicast: bool


class MdnsInterface(NamedTuple):
    """An interface the IPv6 mDNS sockets use."""

    name: str
    ifindex: int
    #: What follows ``%`` in an address on this link: the interface name (POSIX).
    zone: str
    #: Its fe80::/10 addresses, without a zone. They go in the AAAA records of an advert.
    addresses: Tuple[str, ...]
    #: Its connected subnets as CIDR text (``fe80::1/64``, ``fd12::5/64``).
    nets: Tuple[str, ...]


class _Ifaddrs(ctypes.Structure):
    pass


_Ifaddrs._fields_ = [
    ("ifa_next", ctypes.POINTER(_Ifaddrs)),
    ("ifa_name", ctypes.c_char_p),
    ("ifa_flags", ctypes.c_uint),
    ("ifa_addr", ctypes.c_void_p),
    ("ifa_netmask", ctypes.c_void_p),
    ("ifa_dstaddr", ctypes.c_void_p),
    ("ifa_data", ctypes.c_void_p),
]


def _family(buf: bytes) -> int:
    """``sa_family``: a byte after ``sa_len`` on the BSDs, a native ``uint16`` on Linux."""
    return buf[1] if _BSD else int(struct.unpack("=H", buf[:2])[0])


def _read_sockaddr(ptr: Any, fam: Optional[int] = None) -> Optional[Tuple[int, bytes]]:
    """``(family, address bytes)`` of a ``sockaddr_in`` or ``sockaddr_in6``, or ``None``. A netmask the
    BSDs trimmed (``sa_len`` shorter than the structure) reads its missing bytes as zero."""
    if not ptr:
        return None
    head = ctypes.string_at(ptr, 2)
    f = fam if fam is not None else _family(head)
    if f == socket.AF_INET:
        size, at, n = 16, 4, 4
    elif f == socket.AF_INET6:
        size, at, n = 28, 8, 16
    else:
        return None
    raw = bytearray(ctypes.string_at(ptr, size))
    if _BSD and fam is not None and head[0] < size:
        for i in range(head[0], size):  # past sa_len: zero
            raw[i] = 0
    return f, bytes(raw[at : at + n])


def _prefix(mask: bytes) -> Optional[int]:
    """The prefix length of a netmask, or ``None`` when its ones are not a leading run."""
    bits = bin(int.from_bytes(mask, "big"))[2:].zfill(len(mask) * 8)
    ones = bits.count("1")
    return ones if bits == "1" * ones + "0" * (len(bits) - ones) else None


def _load_libc() -> Any:
    lib = ctypes.CDLL(None, use_errno=True)
    lib.getifaddrs.argtypes = [ctypes.POINTER(ctypes.POINTER(_Ifaddrs))]
    lib.getifaddrs.restype = ctypes.c_int
    lib.freeifaddrs.argtypes = [ctypes.POINTER(_Ifaddrs)]
    lib.freeifaddrs.restype = None
    return lib


def interface_addresses() -> Optional[List[InterfaceAddress]]:
    """Every IPv4 and IPv6 address of every local interface, or ``None`` where the platform's list cannot
    be read (no ``getifaddrs``, as on Windows)."""
    if not hasattr(socket, "if_nameindex"):
        return None
    try:
        lib = _load_libc()
        head = ctypes.POINTER(_Ifaddrs)()
        if lib.getifaddrs(ctypes.byref(head)) != 0:
            return None
    except (OSError, AttributeError, TypeError):
        return None
    index: Dict[str, int] = {}
    try:
        for i, n in socket.if_nameindex():
            index[n] = i
    except OSError:
        pass
    out: List[InterfaceAddress] = []
    try:
        cur = head
        while cur:
            ifa = cur.contents
            cur = ifa.ifa_next
            name = (ifa.ifa_name or b"").decode("ascii", "replace")
            a = _read_sockaddr(ifa.ifa_addr)
            if a is None or name not in index:
                continue
            m = _read_sockaddr(ifa.ifa_netmask, a[0])
            if m is None:
                continue
            prefix = _prefix(m[1])
            if prefix is None:
                continue
            v6 = a[0] == socket.AF_INET6
            if v6 and a[1][0] == 0xFE and (a[1][1] & 0xC0) == 0x80:
                # The BSDs (macOS) embed the interface index in bytes 2 and 3 of a link-local address.
                a = (a[0], a[1][:2] + b"\x00\x00" + a[1][4:])
            text = socket.inet_ntop(socket.AF_INET6 if v6 else socket.AF_INET, a[1])
            flags = int(ifa.ifa_flags)
            out.append(
                InterfaceAddress(
                    name,
                    index[name],
                    text,
                    prefix,
                    v6,
                    bool(flags & _IFF_UP),
                    bool(flags & _IFF_LOOPBACK),
                    bool(flags & _IFF_POINTOPOINT),
                    bool(flags & _IFF_MULTICAST),
                )
            )
    finally:
        lib.freeifaddrs(head)
    return out


def _cidr(i: InterfaceAddress) -> str:
    return "%s/%d" % (i.address, i.prefix)


def v4_subnets(allow_loopback: bool, addrs: Optional[Sequence[InterfaceAddress]]) -> Optional[List[str]]:
    """The connected IPv4 subnets (CIDR) of the up, non-point-to-point interfaces; loopback only when
    allowed. ``None`` when the interface list is unavailable."""
    if addrs is None:
        return None
    return [
        _cidr(i)
        for i in addrs
        if not i.v6 and i.up and not i.point_to_point and (allow_loopback or not i.loopback)
    ]


def own_link_local(
    index: int, make_socket: Callable[..., Any] = socket.socket, name: Optional[str] = None
) -> Optional[str]:
    """The fe80 address the kernel sends from on interface ``index``: connect a UDP socket to
    ``ff02::fb%index`` (nothing is sent) and read ``getsockname``. ``None`` when there is none."""
    s = make_socket(socket.AF_INET6, socket.SOCK_DGRAM)
    try:
        s.connect((_GROUP6, _MDNS_PORT, 0, index))
        host = str(s.getsockname()[0]).split("%", 1)[0]
        p = parse_address(host)
        return text6(p[1]) if p is not None and p[0] == "v6" and is_link_local(host) else None
    except OSError:
        return None
    finally:
        s.close()


def v6_interfaces(
    allow_loopback: bool,
    addrs: Optional[Sequence[InterfaceAddress]],
    own: Callable[[int], Optional[str]] = own_link_local,
) -> List[MdnsInterface]:
    """The interfaces IPv6 mDNS uses: up, multicast-capable, not point-to-point, with an fe80 address
    (loopback only when allowed), at most eight, in name order. Each one's AAAA address is the one the
    kernel sends from (:func:`own_link_local`), else its own fe80 addresses."""
    if addrs is None:
        return []
    by: Dict[str, List[InterfaceAddress]] = {}
    for i in addrs:
        if i.v6:
            by.setdefault(i.name, []).append(i)
    out: List[MdnsInterface] = []
    for name in sorted(by):
        mine = by[name]
        first = mine[0]
        ll = [i.address for i in mine if is_link_local(i.address)]
        if not ll or not first.up or name.startswith(_NOT_A_LAN) or first.point_to_point:
            continue
        if first.loopback:
            if not allow_loopback:
                continue
        elif not first.multicast:
            continue
        sent = None if first.loopback else own(first.ifindex)
        out.append(
            MdnsInterface(
                name,
                first.ifindex,
                name,
                (sent,) if sent is not None else tuple(ll[:4]),
                tuple(_cidr(i) for i in mine),
            )
        )
    return out[:MAX_INTERFACES]
