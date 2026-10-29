"""WIRE-CONTRACT-V5 §15.4: the local network interfaces the mDNS adapter uses. The standard library lists
interface names and indexes (``socket.if_nameindex``) but not their addresses or prefixes, and the
RFC 6762 §11 source check needs the connected subnets, so this module reads them with the C library's
``getifaddrs`` through :mod:`ctypes` (Linux and macOS), and on Windows with iphlpapi's
``GetAdaptersAddresses`` (``AF_UNSPEC``), which has no ``getifaddrs``. Both give the same
:class:`InterfaceAddress` rows. Where neither works :func:`interface_addresses` returns ``None`` and the
adapter says so (``MdnsUnavailableError``) rather than guess a subnet.

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
    #: What follows ``%`` in an address on this link: the interface name (POSIX), or its index (Windows).
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


# -- Windows: iphlpapi GetAdaptersAddresses ---------------------------------------------------------
# The structures below mirror IP_ADAPTER_ADDRESSES_LH and IP_ADAPTER_UNICAST_ADDRESS_LH (Vista and later)
# as far as the fields this module reads; ULONG and DWORD are 32-bit on every Windows, so fixed-width
# types are used, not ``c_ulong``. They are defined on every platform so the parser is testable anywhere.
# UNVERIFIED on a real Windows machine: the layout is from the Windows SDK headers (iptypes.h).

#: Winsock's own constants; the running platform's ``socket.AF_INET6`` differs (23 on Windows, 30 on macOS).
_WIN_AF_INET, _WIN_AF_INET6 = 2, 23
_GAA_SKIP_ANYCAST, _GAA_SKIP_MULTICAST, _GAA_SKIP_DNS_SERVER = 0x2, 0x4, 0x8
_ERROR_NO_DATA, _ERROR_BUFFER_OVERFLOW = 232, 111
#: IP_ADAPTER_NO_MULTICAST in IP_ADAPTER_ADDRESSES.Flags.
_WIN_NO_MULTICAST = 0x10
_IF_OPER_STATUS_UP = 1
_IF_TYPE_LOOPBACK = 24
#: Serial, PPP and tunnel interfaces: point-to-point, as the POSIX ``IFF_POINTOPOINT`` is.
_IF_TYPES_POINT_TO_POINT = (22, 23, 131)
#: IpDadStateInvalid, Tentative and Duplicate: not usable (Deprecated 3 and Preferred 4 are).
_DAD_UNUSABLE = (0, 1, 2)
#: Bounds on the lists a corrupt buffer could make endless.
_WIN_MAX_ADAPTERS, _WIN_MAX_ADDRESSES = 512, 256


class _SocketAddress(ctypes.Structure):
    _fields_ = [("lpSockaddr", ctypes.c_void_p), ("iSockaddrLength", ctypes.c_int32)]


class _UnicastAddress(ctypes.Structure):
    pass


_UnicastAddress._fields_ = [
    ("Length", ctypes.c_uint32),
    ("Flags", ctypes.c_uint32),
    ("Next", ctypes.POINTER(_UnicastAddress)),
    ("Address", _SocketAddress),
    ("PrefixOrigin", ctypes.c_int32),
    ("SuffixOrigin", ctypes.c_int32),
    ("DadState", ctypes.c_int32),
    ("ValidLifetime", ctypes.c_uint32),
    ("PreferredLifetime", ctypes.c_uint32),
    ("LeaseLifetime", ctypes.c_uint32),
    ("OnLinkPrefixLength", ctypes.c_uint8),
]


class _AdapterAddresses(ctypes.Structure):
    pass


_AdapterAddresses._fields_ = [
    ("Length", ctypes.c_uint32),
    ("IfIndex", ctypes.c_uint32),
    ("Next", ctypes.POINTER(_AdapterAddresses)),
    ("AdapterName", ctypes.c_char_p),
    ("FirstUnicastAddress", ctypes.POINTER(_UnicastAddress)),
    ("FirstAnycastAddress", ctypes.c_void_p),
    ("FirstMulticastAddress", ctypes.c_void_p),
    ("FirstDnsServerAddress", ctypes.c_void_p),
    ("DnsSuffix", ctypes.c_void_p),
    ("Description", ctypes.c_void_p),
    ("FriendlyName", ctypes.c_void_p),
    ("PhysicalAddress", ctypes.c_uint8 * 8),
    ("PhysicalAddressLength", ctypes.c_uint32),
    ("Flags", ctypes.c_uint32),
    ("Mtu", ctypes.c_uint32),
    ("IfType", ctypes.c_uint32),
    ("OperStatus", ctypes.c_int32),
    ("Ipv6IfIndex", ctypes.c_uint32),
]

#: ``GetAdaptersAddresses(AF_UNSPEC, flags, NULL, buffer, &size)`` as a function of ``(flags, buffer, size)``.
_GetAdapters = Callable[[int, Any, "ctypes.c_uint32"], int]


def _read_win_sockaddr(ptr: Optional[int], length: int) -> Optional[Tuple[bool, bytes, int]]:
    """``(is_v6, address bytes, scope_id)`` of a Winsock ``SOCKADDR_IN`` or ``SOCKADDR_IN6``, or ``None``."""
    if not ptr or length < 2:
        return None
    family = int(struct.unpack("=H", ctypes.string_at(ptr, 2))[0])
    if family == _WIN_AF_INET and length >= 8:
        return False, ctypes.string_at(ptr + 4, 4), 0
    if family == _WIN_AF_INET6 and length >= 28:
        # sin6_family(2) sin6_port(2) sin6_flowinfo(4) sin6_addr(16) sin6_scope_id(4)
        return True, ctypes.string_at(ptr + 8, 16), int(struct.unpack("=I", ctypes.string_at(ptr + 24, 4))[0])
    return None


def _parse_adapters(head: int) -> List[InterfaceAddress]:
    """The rows of the ``IP_ADAPTER_ADDRESSES`` chain starting at address ``head``. An adapter is named
    by its ``AdapterName`` (a GUID, ASCII and unique); its index is ``IfIndex`` for IPv4 and
    ``Ipv6IfIndex`` for IPv6, which is also the zone of its fe80 addresses (``fe80::1%12``)."""
    out: List[InterfaceAddress] = []
    adapter = ctypes.cast(head, ctypes.POINTER(_AdapterAddresses))
    for _ in range(_WIN_MAX_ADAPTERS):
        if not adapter:
            break
        a = adapter.contents
        adapter = a.Next
        name = (a.AdapterName or b"").decode("ascii", "replace")
        loopback = a.IfType == _IF_TYPE_LOOPBACK
        row = (
            name,
            a.OperStatus == _IF_OPER_STATUS_UP,
            loopback,
            a.IfType in _IF_TYPES_POINT_TO_POINT,
            not (a.Flags & _WIN_NO_MULTICAST),
        )
        unicast = a.FirstUnicastAddress
        for _ in range(_WIN_MAX_ADDRESSES):
            if not unicast:
                break
            u = unicast.contents
            unicast = u.Next
            if u.DadState in _DAD_UNUSABLE:
                continue
            sa = _read_win_sockaddr(u.Address.lpSockaddr, int(u.Address.iSockaddrLength))
            if sa is None:
                continue
            v6, raw, _scope = sa
            ifindex = int(a.Ipv6IfIndex if v6 else a.IfIndex)
            prefix = int(u.OnLinkPrefixLength)
            if not name or ifindex == 0 or prefix > (128 if v6 else 32):
                continue
            text = socket.inet_ntop(socket.AF_INET6 if v6 else socket.AF_INET, raw)
            out.append(InterfaceAddress(name, ifindex, text, prefix, v6, row[1], row[2], row[3], row[4]))
    return out


def _windows_adapter_rows(call: _GetAdapters) -> Optional[List[InterfaceAddress]]:
    """Call ``GetAdaptersAddresses`` with a buffer it may ask to grow (a few tries, as adapters can appear
    between the sizing call and the next), and parse the result. ``None`` on any other error."""
    flags = _GAA_SKIP_ANYCAST | _GAA_SKIP_MULTICAST | _GAA_SKIP_DNS_SERVER
    size = ctypes.c_uint32(15000)  # Microsoft's suggested starting size
    for _ in range(4):
        buf = ctypes.create_string_buffer(max(int(size.value), 1))
        rc = call(flags, buf, size)
        if rc == _ERROR_BUFFER_OVERFLOW:
            continue  # ``size`` now holds the needed length
        if rc == _ERROR_NO_DATA:
            return []
        if rc != 0:
            return None
        return _parse_adapters(ctypes.addressof(buf))
    return None


def _windows_interface_addresses() -> Optional[List[InterfaceAddress]]:
    if sys.platform != "win32":
        return None
    try:
        fn = ctypes.WinDLL("iphlpapi", use_last_error=True).GetAdaptersAddresses
        fn.argtypes = [
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint32),
        ]
        fn.restype = ctypes.c_uint32  # a Win32 error code; 0 is success

        def call(flags: int, buf: Any, size: "ctypes.c_uint32") -> int:
            return int(fn(0, flags, None, buf, ctypes.byref(size)))  # AF_UNSPEC = 0

        return _windows_adapter_rows(call)
    except (OSError, AttributeError, TypeError, ValueError):
        return None


def _load_libc() -> Any:
    lib = ctypes.CDLL(None, use_errno=True)
    lib.getifaddrs.argtypes = [ctypes.POINTER(ctypes.POINTER(_Ifaddrs))]
    lib.getifaddrs.restype = ctypes.c_int
    lib.freeifaddrs.argtypes = [ctypes.POINTER(_Ifaddrs)]
    lib.freeifaddrs.restype = None
    return lib


def interface_addresses() -> Optional[List[InterfaceAddress]]:
    """Every IPv4 and IPv6 address of every local interface, or ``None`` where the platform's list cannot
    be read (``getifaddrs`` on POSIX, ``GetAdaptersAddresses`` on Windows)."""
    if sys.platform == "win32":
        return _windows_interface_addresses()
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
    zone_is_index: Optional[bool] = None,
) -> List[MdnsInterface]:
    """The interfaces IPv6 mDNS uses: up, multicast-capable, not point-to-point, with an fe80 address
    (loopback only when allowed), at most eight, in name order. Each one's AAAA address is the one the
    kernel sends from (:func:`own_link_local`), else its own fe80 addresses. The zone of an fe80 address is
    the interface name on POSIX and its index on Windows (``zone_is_index``, default: the platform)."""
    by_index = sys.platform == "win32" if zone_is_index is None else zone_is_index
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
                str(first.ifindex) if by_index else name,
                (sent,) if sent is not None else tuple(ll[:4]),
                tuple(_cidr(i) for i in mine),
            )
        )
    return out[:MAX_INTERFACES]
