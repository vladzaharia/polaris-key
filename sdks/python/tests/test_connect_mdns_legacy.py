# @pkey-feature connect.lan
"""Legacy unicast answers (RFC 6762 section 6.7; WIRE-CONTRACT-V5 §15.4): a querier on a port other than 5353
(a Godot device is one) gets the answer at its own address and port, with its query ID, the matching
questions repeated, no cache-flush bit and a TTL of 10 s. A 5353 query is still answered by multicast, and
a source off the link gets nothing. Mirrors Node's ``connectMdns.test.ts``. Loopback sockets only."""

from __future__ import annotations

import asyncio
import socket
from typing import Any, Callable, Dict, List, Optional, Tuple

from polaris_key.connect.loop import connect_loop
from polaris_key.core.peer_mdns import (
    MdnsAdvert,
    MulticastDnsAdapter,
    _Receiver,
    _UdpSocket,
)
from polaris_key.core.peer_mdns_ifaces import MdnsInterface
from polaris_key.core.peer_mdns_packet import PEER_SERVICE, Packet, build_query, parse_packet

INST = "p1-abcdefghijklmnop"
FQDN = INST + "." + PEER_SERVICE
HOST = INST + ".local"
EN0 = MdnsInterface("en0", 4, "en0", ("fe80::1",), ("fe80::1/64",))
NETS = ["192.168.0.0/16"]
CLIENT = "192.168.1.30"


def run(coro: Any, timeout: float = 10) -> Any:
    return connect_loop().submit(coro).result(timeout)


class FakeSocket:
    def __init__(self, on_packet: Callable[..., None]) -> None:
        self.on_packet = on_packet
        self.sent: List[bytes] = []
        self.unicast: List[Tuple[bytes, str, int]] = []
        self.closed = False

    def send(self, data: bytes) -> None:
        self.sent.append(data)

    def send_to(self, data: bytes, host: str, port: int) -> None:
        self.unicast.append((data, host, port))

    def close(self) -> None:
        self.closed = True


class Clock:
    t = 1000.0

    def __call__(self) -> float:
        return self.t


class Rig:
    def __init__(self, v6: bool = False) -> None:
        self.v4: List[FakeSocket] = []
        self.v6: Dict[str, FakeSocket] = {}
        self.clock = Clock()
        kw: Dict[str, Any] = {}
        if v6:
            kw = {"create6": self._make6, "interfaces6": lambda: [EN0]}
        self.adapter = MulticastDnsAdapter(
            create=self._make4,
            addresses=lambda: ["192.168.1.20"],
            subnets=lambda: NETS,
            clock=self.clock,
            **kw,
        )
        run(self.adapter.advertise(MdnsAdvert(INST, 4242, ["v=1", "m=a"])))

    def _make4(self, on_packet: Callable[..., None]) -> FakeSocket:
        s = FakeSocket(on_packet)
        self.v4.append(s)
        return s

    def _make6(self, iface: MdnsInterface, on_packet: Callable[..., None]) -> FakeSocket:
        s = FakeSocket(on_packet)
        self.v6[iface.name] = s
        return s


ASK = build_query([(PEER_SERVICE, "PTR")], 0x1234)


def test_a_querier_on_an_ephemeral_port_gets_a_unicast_answer_with_its_id() -> None:
    rig = Rig()
    s = rig.v4[0]
    sent = len(s.sent)
    s.on_packet(ASK, CLIENT, 51234)
    assert len(s.sent) == sent  # nothing to the group
    assert len(s.unicast) == 1
    data, host, port = s.unicast[0]
    assert (host, port) == (CLIENT, 51234)
    p = parse_packet(data)
    assert p.is_response and p.id == 0x1234
    assert [(q.name, q.type) for q in p.questions] == [(PEER_SERVICE, "PTR")]
    assert [r.type for r in p.answers] == ["PTR", "SRV", "TXT", "A"]
    assert all(r.ttl == 10 for r in p.answers)
    # No cache-flush bit on any record: the class field of each answer is plain IN.
    assert data.count(b"\x00\x01\x00\x00\x00\x0a") == 4


def test_a_query_from_port_5353_is_still_answered_by_multicast() -> None:
    rig = Rig()
    s = rig.v4[0]
    sent = len(s.sent)
    s.on_packet(ASK, CLIENT, 5353)
    s.on_packet(ASK, CLIENT)  # a socket that reports no port is the multicast case too
    assert len(s.sent) == sent + 1  # the second is inside the one-second gap
    assert parse_packet(s.sent[-1]).answers[0].ttl == 120
    assert s.unicast == []


def test_a_source_off_the_link_gets_nothing_and_does_not_use_the_slot() -> None:
    rig = Rig()
    s = rig.v4[0]
    sent = len(s.sent)
    for src in ("8.8.8.8", "10.9.9.9", "fe80::5%en0", "not an address"):
        s.on_packet(ASK, src, 51234)
    assert s.unicast == [] and len(s.sent) == sent
    s.on_packet(ASK, CLIENT, 51234)
    assert len(s.unicast) == 1


def test_a_legacy_query_from_a_privileged_port_gets_nothing() -> None:
    rig = Rig()
    s = rig.v4[0]
    sent = len(s.sent)
    for port in (1, 53, 1023):
        s.on_packet(ASK, CLIENT, port)
    assert s.unicast == [] and len(s.sent) == sent
    s.on_packet(ASK, CLIENT, 1024)
    assert len(s.unicast) == 1


def test_a_multicast_query_from_off_the_link_is_dropped_too() -> None:
    rig = Rig()
    s = rig.v4[0]
    sent = len(s.sent)
    s.on_packet(ASK, "8.8.8.8", 5353)
    assert len(s.sent) == sent and s.unicast == []


def test_only_our_own_names_and_once_a_second() -> None:
    rig = Rig()
    s = rig.v4[0]
    s.on_packet(build_query([("_other._tcp.local", "PTR")], 7), CLIENT, 51234)
    assert s.unicast == []
    s.on_packet(ASK, CLIENT, 51234)
    s.on_packet(ASK, CLIENT, 51235)
    assert len(s.unicast) == 1
    rig.clock.t += 1.5
    s.on_packet(ASK, CLIENT, 51235)
    assert len(s.unicast) == 2


def test_the_answer_repeats_only_our_questions_a_bounded_number() -> None:
    rig = Rig()
    s = rig.v4[0]
    qs = [("x.local", "A")] + [(FQDN, "SRV")] * 10
    s.on_packet(build_query(qs, 9), CLIENT, 51234)
    p = parse_packet(s.unicast[0][0])
    assert [(q.name, q.type) for q in p.questions] == [(FQDN, "SRV")] * 4


def test_an_ipv6_legacy_query_is_answered_on_its_own_interface_only() -> None:
    rig = Rig(v6=True)
    s = rig.v6["en0"]
    s.on_packet(ASK, "fe80::5%wlan0", 51234)
    s.on_packet(ASK, "fe80::5", 51234)
    assert s.unicast == []
    s.on_packet(ASK, "fe80::5%en0", 51234)
    assert len(s.unicast) == 1
    assert s.unicast[0][1:] == ("fe80::5%en0", 51234)
    assert [r.type for r in parse_packet(s.unicast[0][0]).answers][-1] == "AAAA"


def test_real_udp_sockets_over_loopback() -> None:
    holder: Dict[str, Any] = {}

    async def make(on_packet: Callable[..., None]) -> Any:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("127.0.0.1", 0))
        sock.setblocking(False)
        holder["port"] = sock.getsockname()[1]
        transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(
            lambda: _Receiver(on_packet), sock=sock
        )
        return _UdpSocket(transport, sock, [])

    adapter = MulticastDnsAdapter(
        create=make, addresses=lambda: ["127.0.0.1"], allow_loopback=True, subnets=lambda: ["127.0.0.0/8"], v6=False
    )
    handle = run(adapter.advertise(MdnsAdvert(INST, 4242, ["v=1", "m=a"])))
    q = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        q.bind(("127.0.0.1", 0))
        q.settimeout(3)
        q.sendto(build_query([(PEER_SERVICE, "PTR")], 0xBEEF), ("127.0.0.1", holder["port"]))
        data, addr = q.recvfrom(9000)
        p: Optional[Packet] = parse_packet(data)
        assert p is not None and p.is_response and p.id == 0xBEEF
        assert addr[1] == holder["port"]
        assert [(x.name, x.type) for x in p.questions] == [(PEER_SERVICE, "PTR")]
        assert all(r.ttl == 10 for r in p.answers)
    finally:
        q.close()
        run(handle.stop())
