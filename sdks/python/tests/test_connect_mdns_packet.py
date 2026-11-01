# @pkey-feature connect.lan
"""The mDNS packet codec (WIRE-CONTRACT-V5 §15.4, G5 bounds): round trips and malformed packets."""

from __future__ import annotations

import struct

import pytest

from polaris_key.core.peer_mdns_packet import (
    MAX_PACKET,
    PEER_SERVICE,
    MdnsPacketError,
    Question,
    Record,
    build_query,
    build_response,
    parse_packet,
)

INST = "p1-abcdefghijklmnop"
FQDN = INST + "." + PEER_SERVICE
HOST = INST + ".local"


def _header(qd: int = 0, an: int = 0, ns: int = 0, ar: int = 0, flags: int = 0x8400) -> bytes:
    return struct.pack(">HHHHHH", 0, flags, qd, an, ns, ar)


def _name(s: str) -> bytes:
    return b"".join(bytes([len(p)]) + p.encode() for p in s.split(".")) + b"\x00"


def _rr(name: bytes, rtype: int, rdata: bytes, ttl: int = 120, rclass: int = 1) -> bytes:
    return name + struct.pack(">HHIH", rtype, rclass, ttl, len(rdata)) + rdata


def _answers():
    return [
        Record(PEER_SERVICE, "PTR", 120, FQDN),
        Record(FQDN, "SRV", 120, {"port": 4242, "target": HOST, "priority": 0, "weight": 0}),
        Record(FQDN, "TXT", 4500, ["v=1", "k=abc"]),
        Record(HOST, "A", 120, "192.168.1.20"),
    ]


def _reason(data: bytes) -> str:
    with pytest.raises(MdnsPacketError) as e:
        parse_packet(data)
    return e.value.reason


def test_query_round_trip() -> None:
    pkt = parse_packet(build_query([(PEER_SERVICE, "PTR"), (FQDN, "SRV"), (HOST, "A")]))
    assert not pkt.is_response
    assert pkt.questions == [Question(PEER_SERVICE, "PTR"), Question(FQDN, "SRV"), Question(HOST, "A")]
    assert pkt.answers == []


def test_response_round_trip() -> None:
    pkt = parse_packet(build_response(_answers()))
    assert pkt.is_response
    assert pkt.answers == _answers()


def test_names_are_lowercased_and_txt_empty_round_trips() -> None:
    raw = _header(an=2) + _rr(_name("_PkeyPeer._TCP.local"), 12, _name(FQDN.upper())) + _rr(
        _name(FQDN), 16, b"\x00"
    )
    pkt = parse_packet(raw)
    assert pkt.answers[0] == Record(PEER_SERVICE, "PTR", 120, FQDN)
    assert pkt.answers[1].data == []
    assert parse_packet(build_response([Record(FQDN, "TXT", 1, [])])).answers[0].data == []


def test_compression_backwards_is_followed() -> None:
    first = _rr(_name(PEER_SERVICE), 12, _name(INST)[:-1] + b"\xc0\x0c")  # INST + pointer to header end
    raw = _header(an=1) + first
    pkt = parse_packet(raw)
    assert pkt.answers[0].data == INST + "." + PEER_SERVICE


def test_unknown_types_and_classes_are_skipped() -> None:
    raw = (
        _header(an=3)
        + _rr(_name(HOST), 99, b"xyz")
        + _rr(_name(HOST), 1, b"\x0a\x00\x00\x01", rclass=3)
        + _rr(_name(HOST), 1, b"\x0a\x00\x00\x01", rclass=0x8001)  # cache-flush bit is fine
    )
    pkt = parse_packet(raw)
    assert pkt.answers == [Record(HOST, "A", 120, "10.0.0.1")]


def test_aaaa_is_decoded_to_rfc_5952_text_and_round_trips() -> None:
    ll = bytes.fromhex("fe800000000000000000000000000001")
    other = bytes.fromhex("20010db8000000000000000000000001")
    raw = _header(an=2) + _rr(_name(HOST), 28, ll) + _rr(_name(HOST), 28, other)
    assert [r.data for r in parse_packet(raw).answers] == ["fe80::1", "2001:db8::1"]
    out = [Record(HOST, "AAAA", 120, "fe80::1"), Record(HOST, "AAAA", 120, "fd12:0:0:1::7")]
    assert parse_packet(build_response(out)).answers == [
        Record(HOST, "AAAA", 120, "fe80::1"),
        Record(HOST, "AAAA", 120, "fd12:0:0:1::7"),
    ]
    # Only 16 bytes are an AAAA record.
    assert _reason(_header(an=1) + _rr(_name(HOST), 28, ll[:15])) == "bad_rdata"
    assert _reason(_header(an=1) + _rr(_name(HOST), 28, ll + b"\x00")) == "bad_rdata"
    # An AAAA question is understood too.
    assert parse_packet(build_query([(HOST, "AAAA")])).questions == [Question(HOST, "AAAA")]


def test_authority_is_dropped_additionals_are_kept() -> None:
    raw = (
        _header(an=0, ns=1, ar=1)
        + _rr(_name(HOST), 1, b"\x0a\x00\x00\x02")
        + _rr(_name(HOST), 1, b"\x0a\x00\x00\x01")
    )
    assert [r.data for r in parse_packet(raw).answers] == ["10.0.0.1"]


def test_txt_keeps_first_eight_entries() -> None:
    rdata = b"".join(bytes([len(b"k%d" % i)]) + b"k%d" % i for i in range(12))
    pkt = parse_packet(_header(an=1) + _rr(_name(FQDN), 16, rdata))
    assert pkt.answers[0].data == ["k%d" % i for i in range(8)]


def test_pointer_loop_and_self_pointer() -> None:
    # A name that is a pointer to itself.
    assert _reason(_header(an=1) + b"\xc0\x0c" + b"\x00" * 10) == "bad_pointer"
    # Two pointers aimed at each other cannot both be backwards.
    raw = _header(qd=1) + b"\xc0\x0e" + b"\xc0\x0c" + b"\x00\x0c\x00\x01"
    assert _reason(raw) == "bad_pointer"


def test_forward_pointer() -> None:
    raw = _header(qd=1) + b"\xc0\x20" + b"\x00\x0c\x00\x01" + b"\x00" * 40
    assert _reason(raw) == "bad_pointer"


def _chain_packet(chain: int) -> bytes:
    """Record 1 (skipped, type 99) owns the name "a" and carries ``chain`` pointers in its rdata, each
    pointing at the one before (the first at the name). Record 2 is an A record whose owner is a
    pointer to the last of them, so reading it makes ``chain + 1`` jumps."""
    first_owner = b"\x01a\x00"  # offset 12
    rdata_at = 12 + len(first_owner) + 10
    rdata = bytearray()
    prev = 12
    for i in range(chain):
        rdata += struct.pack(">H", 0xC000 | prev)
        prev = rdata_at + 2 * i
    second = struct.pack(">H", 0xC000 | prev) + struct.pack(">HHIH", 1, 1, 120, 4) + b"\x0a\x00\x00\x01"
    return _header(an=2) + _rr(first_owner, 99, bytes(rdata)) + second


def test_jump_limit() -> None:
    assert parse_packet(_chain_packet(15)).answers == [Record("a", "A", 120, "10.0.0.1")]
    assert _reason(_chain_packet(16)) == "too_many_jumps"


def test_truncated_rdata() -> None:
    # rdlength runs past the end.
    good = _header(an=1) + _rr(_name(HOST), 1, b"\x0a\x00\x00\x01")
    assert _reason(good[:-2]) == "truncated"
    # A rdata whose A length is wrong, a TXT string running past its record, a SRV name past its record.
    assert _reason(_header(an=1) + _rr(_name(HOST), 1, b"\x0a\x00\x00")) == "bad_rdata"
    assert _reason(_header(an=1) + _rr(_name(FQDN), 16, b"\x05ab")) == "bad_rdata"
    srv = struct.pack(">HHH", 0, 0, 80) + _name(HOST)
    assert _reason(_header(an=1) + _rr(_name(FQDN), 33, srv[:-3])) in ("bad_rdata", "truncated")
    assert _reason(_header(an=1) + _rr(_name(FQDN), 33, srv[:5])) == "bad_rdata"
    assert _reason(_header(an=1) + _rr(_name(FQDN), 12, _name(INST)[:-1])) in ("bad_rdata", "truncated")


def test_truncated_header_and_fields() -> None:
    assert _reason(b"\x00" * 11) == "truncated"
    assert _reason(_header(an=1)) == "truncated"
    assert _reason(_header(qd=1) + _name(HOST)) == "truncated"
    assert _reason(_header(an=1) + _name(HOST) + b"\x00\x01") == "truncated"


def test_oversize_packet_and_sections() -> None:
    assert _reason(b"\x00" * (MAX_PACKET + 1)) == "packet_too_large"
    for field in ("qd", "an", "ns", "ar"):
        assert _reason(_header(**{field: 65})) == "too_many_records"
    # Exactly 64 records is fine.
    rr = _rr(_name(HOST), 1, b"\x0a\x00\x00\x01")
    assert len(parse_packet(_header(an=64) + rr * 64).answers) == 64


def test_name_and_label_limits() -> None:
    long_label = bytes([64]) + b"a" * 64 + b"\x00"
    assert _reason(_header(qd=1) + long_label + b"\x00\x0c\x00\x01") == "bad_label"
    ok = b"".join(bytes([63]) + b"a" * 63 for _ in range(3)) + bytes([61]) + b"b" * 61 + b"\x00"  # 255 wire
    assert len(ok) == 255
    assert parse_packet(_header(qd=1) + ok + b"\x00\x0c\x00\x01").questions[0].type == "PTR"
    too_long = b"".join(bytes([63]) + b"a" * 63 for _ in range(4)) + b"\x00"  # 257
    assert _reason(_header(qd=1) + too_long + b"\x00\x0c\x00\x01") == "name_too_long"
    # 0x40 and 0x80 label types are reserved.
    assert _reason(_header(qd=1) + b"\x40a\x00\x00\x0c\x00\x01") == "bad_label"
    assert _reason(_header(qd=1) + b"\x01\xe9\x00\x00\x0c\x00\x01") == "bad_label"


def test_builders_refuse_out_of_bounds_input() -> None:
    with pytest.raises(ValueError):
        build_query([("a" * 64 + ".local", "PTR")])
    with pytest.raises(ValueError):
        build_query([(PEER_SERVICE, "NS")])
    for bad in ("10.0.0.1", "fe80::1%en0", "not-an-address", "::ffff:1.2.3.4\n"):
        with pytest.raises(ValueError):
            build_response([Record(HOST, "AAAA", 1, bad)])
    with pytest.raises(ValueError):
        build_response([Record(HOST, "A", 1, "300.1.1.1")])
    with pytest.raises(ValueError):
        build_response([Record(FQDN, "TXT", 1, ["x"] * 9)])
    with pytest.raises(ValueError):
        build_response([Record(FQDN, "TXT", 1, ["x" * 256])])
    with pytest.raises(ValueError):
        build_response([Record(HOST, "A", 1, "10.0.0.1")] * 65)
    with pytest.raises(ValueError):
        build_response([Record(FQDN, "SRV", 1, {"port": 70000, "target": HOST})])
