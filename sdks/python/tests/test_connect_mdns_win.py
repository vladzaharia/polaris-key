# @pkey-feature connect.lan
"""The Windows interface list (CC-IPV6.4w): the ``GetAdaptersAddresses`` parser over a fake buffer laid out
like ``IP_ADAPTER_ADDRESSES`` and ``IP_ADAPTER_UNICAST_ADDRESS``. Runs on every platform; the real call
is UNVERIFIED on Windows (no Windows machine was available)."""

from __future__ import annotations

import ctypes
import socket
import struct
from typing import Any, Callable, List, Optional, Sequence, Tuple

import pytest

import polaris_key.core.peer_mdns as m
import polaris_key.core.peer_mdns_ifaces as ifaces
from polaris_key.connect.loop import connect_loop
from polaris_key.core.peer_mdns_ifaces import InterfaceAddress, v4_subnets, v6_interfaces

WIN_AF_INET, WIN_AF_INET6 = 2, 23
PREFERRED = 4

# (address text, prefix, dad state)
Addr = Tuple[str, int, int]


def sockaddr(text: str, scope: int = 0) -> bytes:
    """A Winsock ``SOCKADDR_IN6`` (28 bytes) or ``SOCKADDR_IN`` (16 bytes); Winsock's family numbers."""
    if ":" in text:
        head = struct.pack("=HHI", WIN_AF_INET6, 0, 0)
        return head + socket.inet_pton(socket.AF_INET6, text) + struct.pack("=I", scope)
    return struct.pack("=HH", WIN_AF_INET, 0) + socket.inet_aton(text) + b"\0" * 8


class Adapter:
    def __init__(
        self,
        guid: str,
        ifindex: int,
        ipv6_index: int,
        addrs: Sequence[Addr],
        iftype: int = 6,
        up: bool = True,
        no_multicast: bool = False,
    ) -> None:
        self.guid, self.ifindex, self.ipv6_index, self.addrs = guid, ifindex, ipv6_index, addrs
        self.iftype, self.up, self.no_multicast = iftype, up, no_multicast


def lay_out(buf: Any, adapters: Sequence[Adapter]) -> None:
    """Write the adapter chain into ``buf`` (a ctypes buffer), every pointer aimed inside ``buf``."""
    base = ctypes.addressof(buf)
    at = [0]

    def alloc(n: int) -> int:
        off = (at[0] + 7) & ~7
        at[0] = off + n
        assert at[0] <= len(buf), "fake buffer too small"
        return base + off

    prev_a: Any = None
    for ad in adapters:
        a = ctypes.cast(
            alloc(ctypes.sizeof(ifaces._AdapterAddresses)), ctypes.POINTER(ifaces._AdapterAddresses)
        ).contents
        name = alloc(len(ad.guid) + 1)
        ctypes.memmove(name, ad.guid.encode("ascii") + b"\0", len(ad.guid) + 1)
        # AdapterName is a char* into the buffer, not a Python bytes object that could be collected.
        ctypes.memmove(
            ctypes.addressof(a) + type(a).AdapterName.offset,
            ctypes.byref(ctypes.c_void_p(name)),
            ctypes.sizeof(ctypes.c_void_p),
        )
        a.Length = ctypes.sizeof(ifaces._AdapterAddresses)
        a.IfIndex = ad.ifindex
        a.Ipv6IfIndex = ad.ipv6_index
        a.IfType = ad.iftype
        a.OperStatus = 1 if ad.up else 2  # IfOperStatusUp / IfOperStatusDown
        a.Flags = 0x10 if ad.no_multicast else 0  # IP_ADAPTER_NO_MULTICAST
        prev_u: Any = None
        for text, prefix, dad in ad.addrs:
            raw = sockaddr(text, ad.ipv6_index)
            sa = alloc(len(raw))
            ctypes.memmove(sa, raw, len(raw))
            u = ctypes.cast(
                alloc(ctypes.sizeof(ifaces._UnicastAddress)), ctypes.POINTER(ifaces._UnicastAddress)
            ).contents
            u.Length = ctypes.sizeof(ifaces._UnicastAddress)
            u.Address.lpSockaddr = sa
            u.Address.iSockaddrLength = len(raw)
            u.DadState = dad
            u.OnLinkPrefixLength = prefix
            if prev_u is None:
                a.FirstUnicastAddress = ctypes.pointer(u)
            else:
                prev_u.Next = ctypes.pointer(u)
            prev_u = u
        if prev_a is not None:
            prev_a.Next = ctypes.pointer(a)
        prev_a = a


FIXTURE = [
    Adapter(
        "{AAAA-ETH}",
        11,
        11,
        [
            ("fe80::1234:5678:9abc:def0", 64, PREFERRED),
            ("192.168.1.20", 24, PREFERRED),
            ("fd12:0:0:1::5", 64, PREFERRED),
        ],
    ),
    Adapter("{BBBB-WIFI}", 7, 7, [("10.0.0.9", 8, PREFERRED), ("fe80::2", 64, 3)]),  # 3: deprecated, still usable
    Adapter("{CCCC-DOWN}", 9, 9, [("169.254.3.4", 16, PREFERRED), ("fe80::9", 64, PREFERRED)], up=False),
    Adapter("{DDDD-LO}", 1, 1, [("::1", 128, PREFERRED), ("127.0.0.1", 8, PREFERRED)], iftype=24),
    Adapter("{EEEE-TENT}", 13, 13, [("fe80::dead", 64, 1), ("fe80::beef", 64, 2)]),  # tentative, duplicate
    Adapter("{FFFF-VPN}", 14, 14, [("172.16.0.2", 32, PREFERRED), ("fe80::7", 64, PREFERRED)], iftype=23),
]


def parsed(adapters: Sequence[Adapter] = FIXTURE) -> List[InterfaceAddress]:
    buf = ctypes.create_string_buffer(16384)
    lay_out(buf, adapters)
    return ifaces._parse_adapters(ctypes.addressof(buf))


def test_the_parser_reads_names_indexes_flags_and_prefixes() -> None:
    by = {(r.name, r.address): r for r in parsed()}
    eth6 = by[("{AAAA-ETH}", "fe80::1234:5678:9abc:def0")]
    assert (eth6.ifindex, eth6.prefix, eth6.v6, eth6.up, eth6.loopback, eth6.point_to_point, eth6.multicast) == (
        11,
        64,
        True,
        True,
        False,
        False,
        True,
    )
    eth4 = by[("{AAAA-ETH}", "192.168.1.20")]
    assert (eth4.ifindex, eth4.prefix, eth4.v6) == (11, 24, False)
    assert by[("{AAAA-ETH}", "fd12:0:0:1::5")].prefix == 64
    wifi = by[("{BBBB-WIFI}", "10.0.0.9")]
    assert (wifi.ifindex, wifi.prefix) == (7, 8)
    assert by[("{BBBB-WIFI}", "fe80::2")].prefix == 64


def test_down_loopback_vpn_and_unusable_addresses() -> None:
    rows = parsed()
    by = {(r.name, r.address): r for r in rows}
    assert not by[("{CCCC-DOWN}", "169.254.3.4")].up
    lo = by[("{DDDD-LO}", "127.0.0.1")]
    assert lo.loopback and lo.up and lo.prefix == 8
    assert by[("{DDDD-LO}", "::1")].prefix == 128
    assert by[("{FFFF-VPN}", "172.16.0.2")].point_to_point
    assert not any(r.name == "{EEEE-TENT}" for r in rows)  # tentative and duplicate are not addresses yet


def test_a_disabled_ip_version_and_a_bad_prefix_give_no_row() -> None:
    odd = Adapter("{X}", 5, 0, [("fe80::1", 64, PREFERRED), ("10.1.1.1", 24, PREFERRED), ("10.1.1.2", 40, PREFERRED)])
    assert [(r.address, r.ifindex) for r in parsed([odd])] == [("10.1.1.1", 5)]  # IPv6 index 0: IPv6 off


def test_the_ipv4_subnets_and_ipv6_interfaces_come_out_of_the_windows_rows() -> None:
    rows = parsed()
    assert v4_subnets(False, rows) == ["192.168.1.20/24", "10.0.0.9/8"]  # up, not p2p, not loopback
    assert v4_subnets(True, rows) == ["192.168.1.20/24", "10.0.0.9/8", "127.0.0.1/8"]
    got = v6_interfaces(False, rows, own=lambda i: None, zone_is_index=True)
    # The down adapter, the VPN (point-to-point), the loopback and the tentative ones are out.
    assert [(i.name, i.ifindex, i.zone, i.addresses, i.nets) for i in got] == [
        (
            "{AAAA-ETH}",
            11,
            "11",
            ("fe80::1234:5678:9abc:def0",),
            ("fe80::1234:5678:9abc:def0/64", "fd12:0:0:1::5/64"),
        ),
        ("{BBBB-WIFI}", 7, "7", ("fe80::2",), ("fe80::2/64",)),
    ]


def test_no_multicast_flag_drops_the_adapter_from_ipv6() -> None:
    rows = parsed([Adapter("{NM}", 3, 3, [("fe80::3", 64, PREFERRED)], no_multicast=True)])
    assert rows and not rows[0].multicast
    assert v6_interfaces(False, rows, own=lambda i: None) == []


def test_the_zone_is_the_name_on_posix_and_the_index_on_windows() -> None:
    rows = parsed([FIXTURE[0]])
    assert v6_interfaces(False, rows, own=lambda i: None, zone_is_index=False)[0].zone == "{AAAA-ETH}"
    assert v6_interfaces(False, rows, own=lambda i: None, zone_is_index=True)[0].zone == "11"


def fake_call(
    adapters: Sequence[Adapter], overflow: int = 0, rc: Optional[int] = None
) -> Tuple[Callable[..., int], List[int]]:
    seen: List[int] = []

    def call(flags: int, buf: Any, size: "ctypes.c_uint32") -> int:
        seen.append(size.value)
        assert flags == 0x2 | 0x4 | 0x8  # skip anycast, multicast and DNS servers
        if rc is not None:
            return rc
        if len(seen) <= overflow:
            size.value = 40000
            return 111  # ERROR_BUFFER_OVERFLOW
        lay_out(buf, adapters)
        return 0

    return call, seen


def test_the_call_retries_with_the_size_it_is_given() -> None:
    call, seen = fake_call(FIXTURE, overflow=2)
    rows = ifaces._windows_adapter_rows(call)
    assert seen == [15000, 40000, 40000]
    assert rows is not None and {r.name for r in rows} == {
        "{AAAA-ETH}",
        "{BBBB-WIFI}",
        "{CCCC-DOWN}",
        "{DDDD-LO}",
        "{FFFF-VPN}",
    }


def test_a_call_that_keeps_overflowing_or_fails_is_none_and_no_data_is_empty() -> None:
    assert ifaces._windows_adapter_rows(fake_call(FIXTURE, overflow=99)[0]) is None
    assert ifaces._windows_adapter_rows(fake_call(FIXTURE, rc=87)[0]) is None  # ERROR_INVALID_PARAMETER
    assert ifaces._windows_adapter_rows(fake_call(FIXTURE, rc=232)[0]) == []  # ERROR_NO_DATA


def test_enumeration_failure_is_unavailable_not_guessed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(m, "interface_addresses", lambda: None)  # what a failed enumeration returns
    adapter = m.MulticastDnsAdapter(addresses=lambda: [], v6=False)
    with pytest.raises(m.MdnsUnavailableError, match="GetAdaptersAddresses"):
        connect_loop().submit(adapter.browse(lambda f: None)).result(10)


def test_the_windows_loader_declines_off_windows() -> None:
    if ifaces.sys.platform != "win32":
        assert ifaces._windows_interface_addresses() is None
