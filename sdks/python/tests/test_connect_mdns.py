# @pkey-feature connect.lan
"""The mDNS adapter (CC-10.11; WIRE-CONTRACT-V5 §15.4, G5): the responder and the browser over a fake
socket. Mirrors Node's ``connectMdns.test.ts``. No network: the live test needs ``PKEY_LIVE_MDNS=1``."""

from __future__ import annotations

import os
import socket
from typing import Any, Callable, List, Optional, Tuple

import pytest

from polaris_key.connect.loop import connect_loop
from polaris_key.core.peer_mdns import (
    ENTRY_TTL_SECONDS,
    MAX_ADDRS,
    MAX_INSTANCES,
    NEW_WINDOW_SECONDS,
    MdnsAdvert,
    MdnsFound,
    MdnsUnavailableError,
    MulticastDnsAdapter,
    is_lan_address,
    route_address,
)
from polaris_key.core.peer_mdns_packet import PEER_SERVICE, Packet, Record, build_query, build_response, parse_packet

INST = "p1-abcdefghijklmnop"
FQDN = INST + "." + PEER_SERVICE
HOST = INST + ".local"


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
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


#: The connected IPv4 subnets of the fake LAN: every source the tests use sits in one of them.
NETS = ["192.168.0.0/16", "10.0.0.0/8", "127.0.0.0/8"]


class Rig:
    def __init__(self, **kw: Any) -> None:
        self.socks: List[FakeSocket] = []
        self.clock = Clock()
        kw.setdefault("subnets", lambda: NETS)
        self.adapter = MulticastDnsAdapter(create=self._make, clock=self.clock, **kw)

    def _make(self, on_packet: Callable[[bytes, str], None]) -> FakeSocket:
        s = FakeSocket(on_packet)
        self.socks.append(s)
        return s

    @property
    def sock(self) -> FakeSocket:
        return self.socks[-1]


def srv(inst: str = INST, port: int = 4242, target: Optional[str] = None) -> Record:
    srv = {"port": port, "target": target or inst + ".local", "priority": 0, "weight": 0}
    return Record(inst + "." + PEER_SERVICE, "SRV", 120, srv)


def txt(inst: str = INST, entries: Tuple[str, ...] = ("v=1", "m=a")) -> Record:
    return Record(inst + "." + PEER_SERVICE, "TXT", 4500, list(entries))


def ptr(inst: str = INST, ttl: int = 120) -> Record:
    return Record(PEER_SERVICE, "PTR", ttl, inst + "." + PEER_SERVICE)


def a(inst: str = INST, ip: str = "192.168.1.20") -> Record:
    return Record(inst + ".local", "A", 120, ip)


def answer(rig: Rig, records: List[Record], src: str = "192.168.1.20") -> None:
    rig.sock.on_packet(build_response(records), src)


class Browser:
    def __init__(self, rig: Rig, **kw: Any) -> None:
        self.rig = rig
        self.up: List[MdnsFound] = []
        self.down: List[str] = []

        async def go() -> Any:
            return await rig.adapter.browse(self.up.append, self.down.append)

        self.handle = run(go())

    def push(self, records: List[Record], src: str = "192.168.1.20") -> None:
        async def go() -> None:
            answer(self.rig, records, src)

        run(go())

    def stop(self) -> None:
        run(self.handle.stop())


def full(inst: str = INST, ip: str = "192.168.1.20") -> List[Record]:
    return [ptr(inst), srv(inst), txt(inst), a(inst, ip)]


# -- addresses ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ip,ok",
    [
        ("10.0.0.1", True),
        ("172.16.0.1", True),
        ("172.31.255.254", True),
        ("172.32.0.1", False),
        ("172.15.0.1", False),
        ("192.168.0.1", True),
        ("192.169.0.1", False),
        ("169.254.1.1", False),
        ("100.64.0.1", False),
        ("8.8.8.8", False),
        ("127.0.0.1", False),
        ("010.0.0.1", False),
        ("\uff11\uff10.0.0.1", False),  # full-width digits
        ("10.0.0.256", False),
        ("10.0.0", False),
        ("::1", False),
        ("fe80::1", False),
    ],
)
def test_lan_addresses(ip: str, ok: bool) -> None:
    assert is_lan_address(ip) is ok


def test_is_lan_address_is_ipv4_and_literal_only() -> None:
    for bad in ("10.0.0.1\n", "10.0.0.1 ", "10.0.0.1:80", "0xa.0.0.1", "167772161", "fe80::1", "fd12::1"):
        assert not is_lan_address(bad), bad


def test_loopback_only_when_allowed() -> None:
    assert is_lan_address("127.0.0.1", True) and not is_lan_address("127.0.0.1", False)


class _RouteSock:
    def __init__(self, name: str = "192.168.7.9", fail: bool = False) -> None:
        self.name, self.fail, self.closed, self.peer = name, fail, False, None

    def connect(self, addr: Tuple[str, int]) -> None:
        if self.fail:
            raise OSError("unreachable")
        self.peer = addr

    def getsockname(self) -> Tuple[str, int]:
        return (self.name, 1234)

    def close(self) -> None:
        self.closed = True


def test_route_address_asks_the_routing_table_and_sends_nothing() -> None:
    s = _RouteSock()
    assert route_address(lambda *_a: s) == "192.168.7.9"
    assert s.peer == ("224.0.0.251", 5353) and s.closed
    f = _RouteSock(fail=True)
    assert route_address(lambda *_a: f) is None and f.closed
    assert socket.AF_INET  # the default factory is the stdlib's, never called here


# -- advertise ---------------------------------------------------------------------------------------


def advertise(rig: Rig, **kw: Any) -> Any:
    async def go() -> Any:
        return await rig.adapter.advertise(MdnsAdvert(INST, 4242, ["v=1", "m=a"]))

    return run(go())


def test_advert_announces_ptr_srv_txt_and_the_lan_address_with_the_instance_as_host_name() -> None:
    rig = Rig(addresses=lambda: ["192.168.1.20", "8.8.8.8", "169.254.3.3", "10.1.2.3"])
    advertise(rig)
    pkt = rig.sock.sent[0]
    assert pkt.is_response
    by = {(r.type, r.name): r for r in pkt.answers}
    assert by[("PTR", PEER_SERVICE)].data == FQDN
    assert by[("SRV", FQDN)].data == {"port": 4242, "target": HOST, "priority": 0, "weight": 0}
    assert by[("TXT", FQDN)].data == ["v=1", "m=a"]
    assert sorted(r.data for r in pkt.answers if r.type == "A") == ["10.1.2.3", "192.168.1.20"]
    assert all(r.name == HOST for r in pkt.answers if r.type == "A")


def test_interfaces_override_the_routed_address_and_only_lan_ones_are_advertised() -> None:
    rig = Rig(interfaces=["10.9.9.9", "100.64.1.1"], route=lambda: "192.168.0.5")
    advertise(rig)
    assert [r.data for r in rig.sock.sent[0].answers if r.type == "A"] == ["10.9.9.9"]
    r2 = Rig(route=lambda: "192.168.0.5")
    advertise(r2)
    assert [r.data for r in r2.sock.sent[0].answers if r.type == "A"] == ["192.168.0.5"]
    r3 = Rig(route=lambda: "8.8.4.4")
    advertise(r3)
    assert r3.sock.sent == []  # no LAN address: nothing to say


def test_a_bad_advert_is_refused() -> None:
    rig = Rig(addresses=lambda: ["10.0.0.2"])

    async def bad(inst: str, port: int) -> None:
        await rig.adapter.advertise(MdnsAdvert(inst, port, ["v=1"]))

    for inst, port in (("nope", 1), ("p1-ABCDEFGHIJKLMNOP", 1), (INST, 0), (INST, 70000)):
        with pytest.raises(ValueError):
            run(bad(inst, port))


def query(rig: Rig, name: str = PEER_SERVICE) -> int:
    before = len(rig.sock.sent)

    async def go() -> None:
        rig.sock.on_packet(build_query([(name, "PTR")]), "10.0.0.9")

    run(go())
    return len(rig.sock.sent) - before


def test_replies_to_matching_queries_at_most_once_a_second() -> None:
    rig = Rig(addresses=lambda: ["10.0.0.2"])
    advertise(rig)
    rig.clock.t += 5
    assert query(rig) == 1
    assert query(rig) == 0  # same instant
    rig.clock.t += 0.5
    assert query(rig) == 0
    rig.clock.t += 0.6
    assert query(rig, FQDN) == 1
    rig.clock.t += 2
    assert query(rig, "other.local") == 0  # not ours
    assert query(rig, HOST) == 1


def test_responses_and_malformed_packets_are_ignored_by_the_responder() -> None:
    rig = Rig(addresses=lambda: ["10.0.0.2"])
    advertise(rig)
    n = len(rig.sock.sent)

    async def go() -> None:
        rig.sock.on_packet(build_response([ptr()]), "10.0.0.9")
        rig.sock.on_packet(b"\xff" * 40, "10.0.0.9")
        rig.sock.on_packet(b"", "10.0.0.9")

    run(go())
    assert len(rig.sock.sent) == n


def test_stop_says_goodbye_with_zero_ttl_and_closes_the_socket() -> None:
    rig = Rig(addresses=lambda: ["10.0.0.2"])
    h = advertise(rig)
    run(h.stop())
    bye = rig.sock.sent[-1]
    assert all(r.ttl == 0 for r in bye.answers) and rig.sock.closed
    run(h.stop())  # twice is fine
    assert rig.sock.sent[-1] is bye


def test_the_advert_is_repeated_after_a_second() -> None:
    import threading

    rig = Rig(addresses=lambda: ["10.0.0.2"])
    advertise(rig)
    threading.Event().wait(1.4)
    assert len(rig.sock.sent) >= 2


def test_a_socket_that_cannot_open_is_mdns_unavailable() -> None:
    def boom(_on: Any) -> Any:
        raise MdnsUnavailableError("no socket")

    adapter = MulticastDnsAdapter(create=boom)
    with pytest.raises(MdnsUnavailableError) as e:
        run(adapter.browse(lambda f: None))
    assert e.value.reason == "mdns_unavailable"


# -- browse ------------------------------------------------------------------------------------------


def test_browse_asks_for_the_service_at_once() -> None:
    rig = Rig()
    b = Browser(rig)
    q = rig.sock.sent[0]
    assert not q.is_response and [(x.name, x.type) for x in q.questions] == [(PEER_SERVICE, "PTR")]
    b.stop()
    assert rig.sock.closed


def test_a_complete_advert_is_reported_once_with_the_address_to_dial() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push(full())
    assert b.up == [MdnsFound(INST, "192.168.1.20", 4242, ["v=1", "m=a"], ("192.168.1.20",))]
    b.push(full())
    assert len(b.up) == 1  # same signature: not repeated
    b.push([srv(port=4243)])
    assert len(b.up) == 2 and b.up[1].port == 4243


def test_records_arriving_in_pieces_join_up() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push([ptr()])
    b.push([srv()])
    b.push([txt()])
    assert b.up == []
    b.push([a()])
    assert len(b.up) == 1


def test_a_goodbye_ptr_reports_down_once() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push(full())
    b.push([ptr(ttl=0)])
    assert b.down == [INST]
    b.push([ptr(ttl=0)])
    assert b.down == [INST]


def test_an_a_record_is_believed_only_from_its_own_source() -> None:
    rig = Rig()
    b = Browser(rig)
    # A neighbour at .66 claims the instance lives at .20.
    b.push(full(ip="192.168.1.20"), src="192.168.1.66")
    assert b.up == []
    b.push([a(ip="192.168.1.20")], src="192.168.1.20")
    assert b.up[0].host == "192.168.1.20"


def test_no_filter_on_the_address_at_learn_time_the_dial_time_verdict_decides() -> None:
    # A source on a connected subnet is believed for its own address, whatever the address is.
    for ip in ("8.8.8.8", "169.254.9.9", "100.64.0.9", "127.0.0.1"):
        rig = Rig(subnets=lambda: ["0.0.0.0/0"])
        b = Browser(rig)
        b.push(full(ip=ip), src=ip)
        assert [f.host for f in b.up] == [ip], ip


def test_a_response_from_outside_the_receiving_interfaces_subnets_teaches_nothing() -> None:
    # RFC 6762 section 11: the source must be on a connected subnet.
    for ip in ("8.8.8.8", "172.16.0.9", "100.64.0.9"):
        rig = Rig()
        b = Browser(rig)
        b.push(full(ip=ip), src=ip)
        assert b.up == [], ip
    rig = Rig(subnets=lambda: ["172.16.0.0/12"])
    b = Browser(rig)
    b.push(full(ip="172.16.0.9"), src="172.16.0.9")
    assert [f.host for f in b.up] == ["172.16.0.9"]
    b.push(full(ip="192.168.1.20"), src="192.168.1.20")  # now off the subnet
    assert len(b.up) == 1


def test_unreadable_interfaces_are_unavailable_not_guessed(monkeypatch: pytest.MonkeyPatch) -> None:
    import polaris_key.core.peer_mdns as m

    monkeypatch.setattr(m, "interface_addresses", lambda: None)
    rig = Rig(subnets=None)
    rig.adapter._subnets = None
    with pytest.raises(MdnsUnavailableError):
        run(rig.adapter.browse(lambda f: None))


def test_the_first_address_seen_is_dialled_and_at_most_four_are_kept() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push([ptr(), srv(), txt()])
    b.push([a(ip="192.168.1.30")], src="192.168.1.30")
    for n in range(31, 40):
        b.push([a(ip="192.168.1.%d" % n)], src="192.168.1.%d" % n)
    assert {f.host for f in b.up} == {"192.168.1.30"}
    # Only MAX_ADDRS addresses are kept, in the order seen, all handed up so a dialler can fall through.
    assert MAX_ADDRS == 4
    assert b.up[-1].hosts == ("192.168.1.30", "192.168.1.31", "192.168.1.32", "192.168.1.33")
    b.push([srv(port=5000)])
    assert b.up[-1].host == "192.168.1.30" and b.up[-1].port == 5000


def test_one_source_cannot_flood_the_table_and_evict_real_devices() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push(full())  # the real device
    alphabet = "abcdefghijklmnopqrstuvwxyz234567"
    for i in range(MAX_INSTANCES * 2):
        n = "p1-" + alphabet[i // 32] + alphabet[i % 32] + "d" * 14
        b.push([ptr(n), srv(n), txt(n)], src="192.168.9.9")
    assert b.down == []  # nothing real was evicted
    b.push([srv(port=4243)])
    assert b.up[-1].port == 4243 and b.up[-1].instance == INST
    # The cap is per minute: the same source adds more once the window has passed.
    rig.clock.t += NEW_WINDOW_SECONDS + 1
    n = "p1-" + "zzzzzzzzzzzzzzzz"
    b.push([ptr(n), srv(n), txt(n), a(n, "192.168.9.9")], src="192.168.9.9")
    assert any(f.instance == n for f in b.up)


def test_an_attacker_answering_first_does_not_hide_the_real_address() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push([ptr(), srv(), txt(), a(ip="10.0.0.66")], src="10.0.0.66")
    b.push([a(ip="10.0.0.5")], src="10.0.0.5")
    assert b.up[-1].host == "10.0.0.66" and b.up[-1].hosts == ("10.0.0.66", "10.0.0.5")


def test_an_srv_to_a_foreign_target_never_reports() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push([ptr(), srv(target="evil.local"), txt(), a()])
    assert b.up == []


def test_names_of_the_wrong_shape_and_bad_ports_are_dropped() -> None:
    rig = Rig()
    b = Browser(rig)
    for inst in ("p1-short", "x1-abcdefghijklmnop", "p1-abcdefghijklmn89"):
        b.push(full(inst=inst))
    b.push([ptr(), srv(port=0), txt(), a()])
    assert b.up == []
    # A PTR that is not the service's own name is not an advert.
    b.push([Record("_other._tcp.local", "PTR", 0, FQDN)])
    assert b.down == []


def test_the_instance_table_is_bounded_and_evicts_the_least_recently_refreshed() -> None:
    rig = Rig()
    b = Browser(rig)

    # Distinct valid instance names from the base32 alphabet.
    alphabet = "abcdefghijklmnopqrstuvwxyz234567"
    names = [("p1-" + alphabet[i // 32] + alphabet[i % 32] + "a" * 14) for i in range(MAX_INSTANCES + 40)]
    assert len(set(names)) == len(names)
    for i, n in enumerate(names):
        b.push([ptr(n), srv(n), txt(n)], src="192.168.%d.%d" % (i // 200, i % 200 + 1))
    # Only the table's worth remain known; the first ones are gone and a re-announce still works.
    ip = "192.168.2.2"
    b.push([a(names[-1], ip)], src=ip)
    assert any(f.instance == names[-1] for f in b.up)
    b.push([a(names[0], ip)], src=ip)
    assert not any(f.instance == names[0] for f in b.up)  # evicted: its SRV and TXT are forgotten


def test_an_up_entry_that_is_evicted_reports_down_and_expiry_does_too() -> None:
    rig = Rig()
    b = Browser(rig)
    b.push(full())
    rig.clock.t += ENTRY_TTL_SECONDS + 1
    # Expiry is checked when a table is full (and on the 30 s ask): fill it.
    alphabet = "abcdefghijklmnopqrstuvwxyz234567"
    for i in range(MAX_INSTANCES + 2):
        n = "p1-" + alphabet[i // 32] + alphabet[i % 32] + "c" * 14
        b.push([ptr(n)], src="192.168.%d.%d" % (i // 200, i % 200 + 1))
    assert b.down == [INST]


def test_malformed_and_oversize_packets_are_dropped() -> None:
    rig = Rig()
    b = Browser(rig)

    async def go() -> None:
        rig.sock.on_packet(b"\x00" * 9001, "192.168.1.20")
        rig.sock.on_packet(b"\x00\x00\x84\x00\x00\x00\x00\x41" + b"\x00" * 40, "192.168.1.20")
        rig.sock.on_packet(build_query([(PEER_SERVICE, "PTR")]), "192.168.1.20")

    run(go())
    assert b.up == []
    b.push(full())
    assert len(b.up) == 1  # still working


def test_a_raising_callback_does_not_stop_discovery() -> None:
    rig = Rig()

    def boom(f: MdnsFound) -> None:
        raise RuntimeError("host bug")

    run(rig.adapter.browse(boom, None))
    answer(rig, full())
    answer(rig, [srv(port=4243)])  # a second callback after the first raised


def test_stop_cancels_the_timers_and_ignores_late_packets() -> None:
    rig = Rig()
    b = Browser(rig)
    b.stop()
    answer(rig, full())
    assert b.up == []


# -- live (opt in) -----------------------------------------------------------------------------------


@pytest.mark.skipif(os.environ.get("PKEY_LIVE_MDNS") != "1", reason="live multicast: PKEY_LIVE_MDNS=1")
def test_live_two_adapters_on_this_host_find_each_other() -> None:
    import threading

    got: List[MdnsFound] = []
    seen = threading.Event()

    def up(f: MdnsFound) -> None:
        got.append(f)
        seen.set()

    adapter = MulticastDnsAdapter(allow_loopback=True, interfaces=["127.0.0.1"])
    try:
        bh = run(adapter.browse(up, None))
    except MdnsUnavailableError:
        pytest.skip("no multicast socket here")
    ah = run(adapter.advertise(MdnsAdvert(INST, 4242, ["v=1", "m=a"])))
    try:
        assert seen.wait(8)
        assert got[0].instance == INST and got[0].port == 4242
    finally:
        run(ah.stop())
        run(bh.stop())
