# @pkey-feature connect.lan
"""IPv6 mDNS (WIRE-CONTRACT-V5 §15.4, CC-IPV6.4a): one socket per interface, AAAA adverts, learning by
source equality with the interface as the zone, the RFC 6762 §11 source check, and the interface list.
Fake sockets only: no network. The live test needs ``PKEY_LIVE_MDNS=1``."""

from __future__ import annotations

import os
import socket
from typing import Any, Callable, Dict, List, Optional

import pytest

from polaris_key.connect.loop import connect_loop
from polaris_key.core.peer_mdns import MAX_ADDRS, MdnsAdvert, MdnsFound, MdnsUnavailableError, MulticastDnsAdapter
from polaris_key.core.peer_mdns_ifaces import (
    MAX_INTERFACES,
    InterfaceAddress,
    MdnsInterface,
    interface_addresses,
    own_link_local,
    v4_subnets,
    v6_interfaces,
)
from polaris_key.core.peer_mdns_packet import PEER_SERVICE, Packet, Record, build_query, build_response, parse_packet

INST = "p1-abcdefghijklmnop"
FQDN = INST + "." + PEER_SERVICE
HOST = INST + ".local"
EN0 = MdnsInterface("en0", 4, "en0", ("fe80::1",), ("fe80::1/64", "fd12:0:0:1::5/64"))
EN1 = MdnsInterface("en1", 5, "en1", ("fe80::2",), ("fe80::2/64",))


def run(coro: Any, timeout: float = 10) -> Any:
    return connect_loop().submit(coro).result(timeout)


class FakeSocket:
    def __init__(self, on_packet: Callable[[bytes, str], None]) -> None:
        self.on_packet = on_packet
        self.sent: List[Packet] = []
        self.closed = False

    def send(self, data: bytes) -> None:
        self.sent.append(parse_packet(data))

    def close(self) -> None:
        self.closed = True


class Clock:
    t = 1000.0

    def __call__(self) -> float:
        return self.t


class Rig:
    def __init__(self, ifaces: Optional[List[MdnsInterface]] = None, **kw: Any) -> None:
        self.v4: List[FakeSocket] = []
        self.v6: Dict[str, FakeSocket] = {}
        self.clock = Clock()
        self.ifaces = [EN0, EN1] if ifaces is None else ifaces
        kw.setdefault("subnets", lambda: ["192.168.0.0/16"])
        self.adapter = MulticastDnsAdapter(
            create=self._make4,
            create6=self._make6,
            interfaces6=lambda: self.ifaces,
            clock=self.clock,
            **kw,
        )

    def _make4(self, on_packet: Callable[[bytes, str], None]) -> FakeSocket:
        s = FakeSocket(on_packet)
        self.v4.append(s)
        return s

    def _make6(self, iface: MdnsInterface, on_packet: Callable[[bytes, str], None]) -> FakeSocket:
        s = FakeSocket(on_packet)
        self.v6[iface.name] = s
        return s


def full(ip_record_type: str = "AAAA", ip: str = "fe80::7") -> List[Record]:
    srv = {"port": 4242, "target": HOST, "priority": 0, "weight": 0}
    return [
        Record(PEER_SERVICE, "PTR", 120, FQDN),
        Record(FQDN, "SRV", 120, srv),
        Record(FQDN, "TXT", 4500, ["v=1", "m=a"]),
        Record(HOST, ip_record_type, 120, ip),
    ]


class Browser:
    def __init__(self, rig: Rig) -> None:
        self.rig = rig
        self.up: List[MdnsFound] = []
        self.down: List[str] = []

        async def go() -> Any:
            return await rig.adapter.browse(self.up.append, self.down.append)

        self.handle = run(go())

    def push(self, face: Optional[str], records: List[Record], src: str) -> None:
        sock = self.rig.v4[-1] if face is None else self.rig.v6[face]
        data = build_response(records)

        async def go() -> None:
            sock.on_packet(data, src)

        run(go())


# -- advertise -----------------------------------------------------------------------------------------


def test_the_advert_has_an_a_record_on_ipv4_and_an_aaaa_record_on_each_interface() -> None:
    rig = Rig(addresses=lambda: ["192.168.1.20"])

    async def go() -> Any:
        return await rig.adapter.advertise(MdnsAdvert(INST, 4242, ["v=1", "m=a"]))

    run(go())
    v4 = rig.v4[0].sent[0]
    assert [(r.type, r.data) for r in v4.answers if r.type in ("A", "AAAA")] == [("A", "192.168.1.20")]
    for name, addr in (("en0", "fe80::1"), ("en1", "fe80::2")):
        pkt = rig.v6[name].sent[0]
        assert [(r.type, r.name, r.data) for r in pkt.answers if r.type in ("A", "AAAA")] == [("AAAA", HOST, addr)]
        by = {(r.type, r.name): r for r in pkt.answers}
        assert by[("SRV", FQDN)].data["target"] == HOST


def test_only_link_local_addresses_are_advertised_and_an_interface_without_one_says_nothing() -> None:
    odd = MdnsInterface("en2", 6, "en2", ("2001:db8::1", "fe80::3"), ())
    none = MdnsInterface("en3", 7, "en3", ("2001:db8::2",), ())
    rig = Rig([odd, none], addresses=lambda: [])

    async def go() -> Any:
        return await rig.adapter.advertise(MdnsAdvert(INST, 4242, ["v=1", "m=a"]))

    run(go())
    assert [r.data for r in rig.v6["en2"].sent[0].answers if r.type == "AAAA"] == ["fe80::3"]
    assert rig.v6["en3"].sent == [] and rig.v4[0].sent == []


def test_each_socket_answers_a_query_for_the_host_at_most_once_a_second_and_a_goodbye_leaves_on_all() -> None:
    rig = Rig(addresses=lambda: ["192.168.1.20"])

    async def adv() -> Any:
        return await rig.adapter.advertise(MdnsAdvert(INST, 4242, ["v=1", "m=a"]))

    h = run(adv())
    rig.clock.t += 5
    q = build_query([(HOST, "AAAA")])

    async def ask() -> None:
        rig.v6["en0"].on_packet(q, "fe80::9")
        rig.v6["en0"].on_packet(q, "fe80::9")  # within a second: no second reply
        rig.v6["en1"].on_packet(q, "fe80::9")  # another socket has its own gap

    before = (len(rig.v6["en0"].sent), len(rig.v6["en1"].sent), len(rig.v4[0].sent))
    run(ask())
    assert (len(rig.v6["en0"].sent), len(rig.v6["en1"].sent), len(rig.v4[0].sent)) == (
        before[0] + 1,
        before[1] + 1,
        before[2],
    )
    run(h.stop())
    for s in (rig.v6["en0"], rig.v6["en1"], rig.v4[0]):
        assert s.closed and all(r.ttl == 0 for r in s.sent[-1].answers)


# -- browse --------------------------------------------------------------------------------------------


def test_browse_asks_for_a_and_aaaa_of_a_host_with_no_address_on_every_socket() -> None:
    import threading

    rig = Rig()
    b = Browser(rig)
    for s in (rig.v4[0], rig.v6["en0"], rig.v6["en1"]):
        assert [(q.name, q.type) for q in s.sent[0].questions] == [(PEER_SERVICE, "PTR")]
    b.push("en0", full()[:3], "fe80::7")  # the instance, but no address yet
    threading.Event().wait(1.4)  # the second ask is after a second
    want = {(HOST, "A"), (HOST, "AAAA"), (FQDN, "SRV"), (FQDN, "TXT")}
    for s in (rig.v4[0], rig.v6["en0"], rig.v6["en1"]):
        assert want <= {(q.name, q.type) for q in s.sent[-1].questions}
    run(b.handle.stop())


def test_a_link_local_aaaa_equal_to_the_source_is_learned_with_the_interface_as_its_zone() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push("en0", full(), "fe80::7")
    assert b.up == [MdnsFound(INST, "fe80::7%en0", 4242, ["v=1", "m=a"], ("fe80::7%en0",))]


def test_the_same_link_local_address_on_two_interfaces_is_two_neighbours() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push("en0", full(), "fe80::7")
    b.push("en1", [Record(HOST, "AAAA", 120, "fe80::7")], "fe80::7")
    assert b.up[-1].hosts == ("fe80::7%en0", "fe80::7%en1")


def test_an_aaaa_that_is_not_the_source_is_not_believed() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push("en0", full(ip="fe80::8"), "fe80::7")
    assert b.up == []
    b.push("en0", full(ip="2001:db8::8"), "fe80::7")
    assert b.up == []


def test_a_non_link_local_source_must_be_on_one_of_the_interfaces_subnets() -> None:
    rig = Rig()
    b = Browser(rig)
    # fd12:0:0:1::/64 is on en0 only.
    b.push("en1", full(ip="fd12:0:0:1::7"), "fd12:0:0:1::7")
    assert b.up == []
    b.push("en0", full(ip="fd12:0:0:2::7"), "fd12:0:0:2::7")
    assert b.up == []
    b.push("en0", full(ip="fd12:0:0:1::7"), "fd12:0:0:1::7")
    assert [f.hosts for f in b.up] == [("fd12:0:0:1::7",)]  # no zone on a ULA address


def test_a_global_source_on_the_interfaces_subnet_is_learned_and_left_to_the_dial_time_verdict() -> None:
    gl = MdnsInterface("en0", 4, "en0", ("fe80::1",), ("2001:db8:1:2::5/64",))
    rig = Rig([gl])
    b = Browser(rig)
    b.push("en0", full(ip="2001:db8:1:2::9"), "2001:db8:1:2::9")
    assert b.up[0].hosts == ("2001:db8:1:2::9",)


def test_an_a_record_on_the_ipv4_socket_needs_an_ipv4_subnet() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push(None, full("A", "10.1.1.1"), "10.1.1.1")  # not in 192.168/16
    assert b.up == []
    b.push(None, full("A", "192.168.1.20"), "192.168.1.20")
    assert b.up[0].hosts == ("192.168.1.20",)


def test_addresses_of_both_families_are_kept_first_seen_first_four_at_most() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push(None, full("A", "192.168.1.20"), "192.168.1.20")
    b.push("en0", [Record(HOST, "AAAA", 120, "fe80::7")], "fe80::7")
    for n in range(8, 12):
        b.push("en0", [Record(HOST, "AAAA", 120, "fe80::%d" % n)], "fe80::%d" % n)
    assert MAX_ADDRS == 4
    assert b.up[-1].hosts == ("192.168.1.20", "fe80::7%en0", "fe80::8%en0", "fe80::9%en0")
    assert b.up[-1].host == "192.168.1.20"


def test_an_address_goodbye_withdraws_the_address_and_the_peer_goes_down_when_none_is_left() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push("en0", full(), "fe80::7")
    b.push("en0", [Record(HOST, "AAAA", 0, "fe80::7")], "fe80::7")
    assert b.down == [INST]
    b.push("en0", [Record(HOST, "AAAA", 120, "fe80::7")], "fe80::7")
    assert len(b.up) == 2  # it is reported again once an address is back


def test_a_name_in_capitals_is_the_same_name() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push("en0", [Record(HOST.upper(), "AAAA", 120, "fe80::7")], "fe80::7")
    b.push("en0", full()[:3], "fe80::7")
    assert [f.hosts for f in b.up] == [("fe80::7%en0",)]


def test_stop_closes_every_socket() -> None:
    rig = Rig()
    b = Browser(rig)
    run(b.handle.stop())
    assert rig.v4[0].closed and all(s.closed for s in rig.v6.values())


def test_a_v6_socket_that_cannot_open_is_skipped_but_v4_failing_is_unavailable() -> None:
    made: List[str] = []

    def make6(iface: MdnsInterface, on: Callable[[bytes, str], None]) -> FakeSocket:
        if iface.name == "en0":
            raise MdnsUnavailableError("no")
        made.append(iface.name)
        return FakeSocket(on)

    rig = Rig()
    rig.adapter._create6 = make6
    run(rig.adapter.browse(lambda f: None))
    assert made == ["en1"]


def test_ipv6_is_off_when_a_test_injects_only_the_ipv4_socket_and_when_asked() -> None:
    socks: List[FakeSocket] = []
    a = MulticastDnsAdapter(
        create=lambda on: socks.append(FakeSocket(on)) or socks[-1],
        interfaces6=lambda: [EN0],
        subnets=lambda: [],
    )
    run(a.browse(lambda f: None))
    assert len(socks) == 1
    rig = Rig(v6=False)
    run(rig.adapter.browse(lambda f: None))
    assert rig.v6 == {}


# -- the interface list --------------------------------------------------------------------------------


def ia(name: str, index: int, addr: str, prefix: int = 64, v6: bool = True, **kw: bool) -> InterfaceAddress:
    flags = dict(up=True, loopback=False, point_to_point=False, multicast=True)
    flags.update(kw)
    return InterfaceAddress(name, index, addr, prefix, v6, **flags)


def test_the_interfaces_are_up_multicast_capable_and_have_an_fe80_address() -> None:
    table = [
        ia("en0", 4, "fe80::1"),
        ia("en0", 4, "fd12::5"),
        ia("en0", 4, "192.168.1.9", 24, v6=False),
        ia("lo0", 1, "fe80::1", loopback=True),
        ia("utun0", 9, "fe80::9", point_to_point=True),
        ia("en5", 8, "fd00::1"),  # no fe80 address
        ia("en6", 10, "fe80::6", up=False),
        ia("en7", 11, "fe80::7", multicast=False),
        ia("awdl0", 12, "fe80::c"),
        ia("llw0", 13, "fe80::d"),
    ]
    got = v6_interfaces(False, table, own=lambda i: None)
    assert [(i.name, i.ifindex, i.zone, i.addresses, i.nets) for i in got] == [
        ("en0", 4, "en0", ("fe80::1",), ("fe80::1/64", "fd12::5/64")),
    ]
    assert [i.name for i in v6_interfaces(True, table, own=lambda i: None)] == ["en0", "lo0"]
    assert v6_interfaces(False, None) == []


def test_the_aaaa_address_is_the_one_the_kernel_sends_from_else_the_interfaces_own() -> None:
    table = [ia("en0", 4, "fe80::1"), ia("en0", 4, "fe80::2")]
    assert v6_interfaces(False, table, own=lambda i: "fe80::2")[0].addresses == ("fe80::2",)
    assert v6_interfaces(False, table, own=lambda i: None)[0].addresses == ("fe80::1", "fe80::2")


def test_at_most_eight_interfaces_in_name_order() -> None:
    table = [ia("en%d" % n, 20 + n, "fe80::%x" % (n + 1)) for n in range(12)]
    got = v6_interfaces(False, table, own=lambda i: None)
    assert len(got) == MAX_INTERFACES == 8
    assert [i.name for i in got] == sorted(i.name for i in got)


def test_the_connected_ipv4_subnets() -> None:
    table = [
        ia("en0", 4, "192.168.191.205", 23, v6=False),
        ia("lo0", 1, "127.0.0.1", 8, v6=False, loopback=True),
        ia("utun2", 20, "100.105.91.82", 32, v6=False, point_to_point=True),
        ia("en1", 5, "10.0.0.2", 8, v6=False, up=False),
        ia("en0", 4, "fe80::1"),
    ]
    assert v4_subnets(False, table) == ["192.168.191.205/23"]
    assert v4_subnets(True, table) == ["192.168.191.205/23", "127.0.0.1/8"]
    assert v4_subnets(False, None) is None


class _Sock:
    def __init__(self, name: str = "fe80::abcd%en0", fail: bool = False) -> None:
        self.name, self.fail, self.peer, self.closed = name, fail, None, False

    def connect(self, addr: Any) -> None:
        if self.fail:
            raise OSError("no route")
        self.peer = addr

    def getsockname(self) -> Any:
        return (self.name, 5353, 0, 4)

    def close(self) -> None:
        self.closed = True


def test_own_link_local_connects_a_udp_socket_to_the_group_on_the_interface_and_reads_the_name() -> None:
    s = _Sock()
    assert own_link_local(4, lambda *_a: s) == "fe80::abcd"
    assert s.peer == ("ff02::fb", 5353, 0, 4) and s.closed
    assert own_link_local(4, lambda *_a: _Sock(fail=True)) is None
    assert own_link_local(4, lambda *_a: _Sock("2001:db8::1")) is None  # not a link-local source


def test_the_real_interface_list_reads_on_this_platform() -> None:
    addrs = interface_addresses()
    if addrs is None:
        pytest.skip("no getifaddrs here")
    assert any(a.loopback and a.address in ("127.0.0.1", "::1") for a in addrs)
    lo4 = [a for a in addrs if a.address == "127.0.0.1"]
    assert lo4 and lo4[0].prefix == 8 and lo4[0].up
    # No link-local address carries a KAME-embedded scope.
    assert all(not a.address.startswith("fe80:") or a.address.split(":")[1] == "" for a in addrs if a.v6)
    assert socket.if_nametoindex(lo4[0].name) == lo4[0].ifindex


@pytest.mark.skipif(os.environ.get("PKEY_LIVE_MDNS") != "1", reason="live multicast: PKEY_LIVE_MDNS=1")
def test_live_two_adapters_find_each_other_over_ipv6() -> None:
    import threading

    addrs = interface_addresses()
    ifaces = v6_interfaces(False, addrs)
    if not ifaces:
        pytest.skip("no multicast IPv6 interface here")
    got: List[MdnsFound] = []
    seen = threading.Event()

    def up(f: MdnsFound) -> None:
        got.append(f)
        seen.set()

    adapter = MulticastDnsAdapter(interfaces6=lambda: ifaces, subnets=lambda: [], addresses=lambda: [], v6=True)
    try:
        bh = run(adapter.browse(up, None))
    except MdnsUnavailableError:
        pytest.skip("no multicast socket here")
    ah = run(adapter.advertise(MdnsAdvert(INST, 4242, ["v=1", "m=a"])))
    try:
        assert seen.wait(8)
        assert got[0].instance == INST and "%" in got[0].host
    finally:
        run(ah.stop())
        run(bh.stop())
