"""WIRE-CONTRACT-V5 §15.4: the mDNS packet codec for ``_pkeypeer._tcp.local``. Pure functions over
bytes: no socket, no clock. It parses and builds PTR queries and PTR, SRV, TXT, A and AAAA answers, and it
is the one place a neighbour's packet is decoded, so every limit is enforced here (G5):

- a packet is at most 9,000 bytes and a section holds at most 64 records;
- a name is at most 255 bytes and a label at most 63;
- a compression pointer must point strictly backwards, and a name follows at most 16 of them;
- a record's data must lie inside the packet and fill exactly what its length says;
- a TXT record keeps its first 8 entries; unknown record types and classes are skipped;
- an AAAA record is 16 bytes and is kept as RFC 5952 lower-case text, without a zone; its address is
  never trusted here (the adapter believes it only when it equals the packet's source).

A packet that breaks a limit raises ``MdnsPacketError``; the caller drops the whole packet. Names are
lower-cased on the way in (DNS names are case-insensitive). Whether an address is believed is the
adapter's business (it needs the packet's UDP source); this module only decodes.
Mirrors the record shapes of sdk-node ``src/connect/mdns.ts`` (``multicast-dns``)."""

from __future__ import annotations

import struct
from typing import Any, List, NamedTuple, Optional, Sequence, Tuple

from .peer_lan_address import parse_address, text6

__all__ = [
    "MAX_JUMPS",
    "MAX_NAME",
    "MAX_PACKET",
    "MAX_RECORDS",
    "MAX_TXT",
    "MdnsPacketError",
    "PEER_SERVICE",
    "Packet",
    "Question",
    "Record",
    "build_query",
    "build_response",
    "parse_packet",
]

PEER_SERVICE = "_pkeypeer._tcp.local"
MAX_PACKET = 9000
MAX_RECORDS = 64
MAX_NAME = 255
MAX_LABEL = 63
MAX_JUMPS = 16
MAX_TXT = 8

_A, _PTR, _TXT, _SRV, _AAAA = 1, 12, 16, 33, 28
_TYPE_NAMES = {_A: "A", _PTR: "PTR", _TXT: "TXT", _SRV: "SRV", _AAAA: "AAAA"}
_TYPE_CODES = {v: k for k, v in _TYPE_NAMES.items()}
_IN = 1
_CACHE_FLUSH = 0x8000
_RESPONSE_FLAGS = 0x8400
_HEADER = struct.Struct(">HHHHHH")


class MdnsPacketError(ValueError):
    """A packet that cannot be decoded within the limits. ``reason`` is a short stable code."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Question(NamedTuple):
    name: str
    type: str


class Record(NamedTuple):
    """``data`` by type: PTR a name; SRV ``{"port", "target", "priority", "weight"}``; TXT a list of
    strings; A a dotted IPv4 string; AAAA RFC 5952 IPv6 text."""

    name: str
    type: str
    ttl: int
    data: Any


class Packet(NamedTuple):
    is_response: bool
    questions: List[Question]
    #: Answers followed by additionals (the authority section is decoded for bounds and dropped).
    answers: List[Record]


# --- parse -----------------------------------------------------------------------------------------


def _read_name(buf: bytes, pos: int) -> Tuple[str, int]:
    """Read a name at ``pos``. Returns it and the offset just after its first (uncompressed) form."""
    labels: List[str] = []
    total = 0  # wire length of the expanded name
    jumps = 0
    end: Optional[int] = None
    cur = pos
    while True:
        if cur >= len(buf):
            raise MdnsPacketError("truncated")
        n = buf[cur]
        if n == 0:
            if end is None:
                end = cur + 1
            break
        kind = n & 0xC0
        if kind == 0xC0:
            if cur + 1 >= len(buf):
                raise MdnsPacketError("truncated")
            target = ((n & 0x3F) << 8) | buf[cur + 1]
            if end is None:
                end = cur + 2
            # Strictly backwards: a forward or self pointer (and so any loop) is refused.
            if target >= cur:
                raise MdnsPacketError("bad_pointer")
            jumps += 1
            if jumps > MAX_JUMPS:
                raise MdnsPacketError("too_many_jumps")
            cur = target
            continue
        if kind != 0 or n > MAX_LABEL:
            raise MdnsPacketError("bad_label")
        if cur + 1 + n > len(buf):
            raise MdnsPacketError("truncated")
        total += n + 1
        if total + 1 > MAX_NAME:
            raise MdnsPacketError("name_too_long")
        try:
            labels.append(buf[cur + 1 : cur + 1 + n].decode("ascii").lower())
        except UnicodeDecodeError:
            raise MdnsPacketError("bad_label") from None
        cur += 1 + n
    assert end is not None
    return ".".join(labels), end


def _parse_rdata(buf: bytes, rtype: int, start: int, end: int) -> Any:
    if rtype == _A:
        if end - start != 4:
            raise MdnsPacketError("bad_rdata")
        return ".".join(str(b) for b in buf[start:end])
    if rtype == _AAAA:
        if end - start != 16:
            raise MdnsPacketError("bad_rdata")
        return text6([(buf[i] << 8) | buf[i + 1] for i in range(start, end, 2)])
    if rtype == _PTR:
        name, after = _read_name(buf, start)
        if after > end:
            raise MdnsPacketError("bad_rdata")
        return name
    if rtype == _SRV:
        if end - start < 7:
            raise MdnsPacketError("bad_rdata")
        priority, weight, port = struct.unpack_from(">HHH", buf, start)
        target, after = _read_name(buf, start + 6)
        if after > end:
            raise MdnsPacketError("bad_rdata")
        return {"port": port, "target": target, "priority": priority, "weight": weight}
    # TXT: length-prefixed strings that fill the record exactly.
    out: List[str] = []
    cur = start
    while cur < end:
        n = buf[cur]
        if cur + 1 + n > end:
            raise MdnsPacketError("bad_rdata")
        if n > 0 and len(out) < MAX_TXT:
            out.append(buf[cur + 1 : cur + 1 + n].decode("utf-8", "replace"))
        cur += 1 + n
    return out


def _parse_records(buf: bytes, pos: int, count: int, keep: bool) -> Tuple[List[Record], int]:
    out: List[Record] = []
    for _ in range(count):
        name, pos = _read_name(buf, pos)
        if pos + 10 > len(buf):
            raise MdnsPacketError("truncated")
        rtype, rclass, ttl, rdlen = struct.unpack_from(">HHIH", buf, pos)
        pos += 10
        end = pos + rdlen
        if end > len(buf):
            raise MdnsPacketError("truncated")
        if keep and rtype in _TYPE_NAMES and (rclass & ~_CACHE_FLUSH) == _IN:
            out.append(Record(name, _TYPE_NAMES[rtype], ttl, _parse_rdata(buf, rtype, pos, end)))
        pos = end
    return out, pos


def parse_packet(data: bytes) -> Packet:
    """Decode a datagram, or raise ``MdnsPacketError``."""
    buf = bytes(data)
    if len(buf) > MAX_PACKET:
        raise MdnsPacketError("packet_too_large")
    if len(buf) < _HEADER.size:
        raise MdnsPacketError("truncated")
    _id, flags, qd, an, ns, ar = _HEADER.unpack_from(buf, 0)
    if max(qd, an, ns, ar) > MAX_RECORDS:
        raise MdnsPacketError("too_many_records")
    pos = _HEADER.size
    questions: List[Question] = []
    for _ in range(qd):
        name, pos = _read_name(buf, pos)
        if pos + 4 > len(buf):
            raise MdnsPacketError("truncated")
        qtype = struct.unpack_from(">H", buf, pos)[0]
        pos += 4
        if qtype in _TYPE_NAMES:
            questions.append(Question(name, _TYPE_NAMES[qtype]))
    answers, pos = _parse_records(buf, pos, an, True)
    _, pos = _parse_records(buf, pos, ns, False)
    extra, pos = _parse_records(buf, pos, ar, True)
    return Packet(bool(flags & 0x8000), questions, answers + extra)


# --- build -----------------------------------------------------------------------------------------


def _encode_name(name: str) -> bytes:
    if name.endswith("."):
        name = name[:-1]
    out = bytearray()
    for label in name.split(".") if name else []:
        try:
            raw = label.encode("ascii")
        except UnicodeEncodeError:
            raise ValueError("name: not ASCII") from None
        if not 0 < len(raw) <= MAX_LABEL:
            raise ValueError("name: label length")
        out.append(len(raw))
        out += raw
    out.append(0)
    if len(out) > MAX_NAME:
        raise ValueError("name: too long")
    return bytes(out)


def _type_code(t: str) -> int:
    try:
        return _TYPE_CODES[t]
    except KeyError:
        raise ValueError("record type: " + t) from None


def _encode_rdata(rtype: int, data: Any) -> bytes:
    if rtype == _PTR:
        return _encode_name(str(data))
    if rtype == _SRV:
        port, prio, weight = int(data["port"]), int(data.get("priority", 0)), int(data.get("weight", 0))
        if not (0 <= port <= 0xFFFF and 0 <= prio <= 0xFFFF and 0 <= weight <= 0xFFFF):
            raise ValueError("srv: field range")
        return struct.pack(">HHH", prio, weight, port) + _encode_name(str(data["target"]))
    if rtype == _TXT:
        entries = [str(e).encode("utf-8") for e in data]
        if len(entries) > MAX_TXT:
            raise ValueError("txt: too many entries")
        out = bytearray()
        for e in entries:
            if len(e) > 255:
                raise ValueError("txt: entry too long")
            out.append(len(e))
            out += e
        return bytes(out) if out else b"\x00"
    p = parse_address(str(data))
    if rtype == _AAAA:
        if p is None or p[0] != "v6" or p[2] is not None:
            raise ValueError("aaaa: not an IPv6 address")
        return b"".join(struct.pack(">H", x) for x in p[1])
    if p is None or p[0] != "v4":
        raise ValueError("a: not an IPv4 address")
    return bytes(p[1])


def build_query(questions: Sequence[Tuple[str, str]], packet_id: int = 0) -> bytes:
    """A query packet (flags 0). ``questions`` are ``(name, type)`` pairs, type one of PTR/SRV/TXT/A/AAAA."""
    if len(questions) > MAX_RECORDS:
        raise ValueError("too many questions")
    out = bytearray(_HEADER.pack(packet_id & 0xFFFF, 0, len(questions), 0, 0, 0))
    for name, rtype in questions:
        out += _encode_name(name) + struct.pack(">HH", _type_code(rtype), _IN)
    if len(out) > MAX_PACKET:
        raise ValueError("packet too large")
    return bytes(out)


def build_response(answers: Sequence[Record]) -> bytes:
    """An authoritative response packet (flags 0x8400) holding ``answers``. Class IN; the
    cache-flush bit is set on SRV, TXT, A and AAAA (unique records), never on the shared PTR."""
    if len(answers) > MAX_RECORDS:
        raise ValueError("too many records")
    out = bytearray(_HEADER.pack(0, _RESPONSE_FLAGS, 0, len(answers), 0, 0))
    for r in answers:
        code = _type_code(r.type)
        rdata = _encode_rdata(code, r.data)
        cls = _IN if code == _PTR else _IN | _CACHE_FLUSH
        out += _encode_name(r.name) + struct.pack(">HHIH", code, cls, int(r.ttl) & 0xFFFFFFFF, len(rdata))
        out += rdata
    if len(out) > MAX_PACKET:
        raise ValueError("packet too large")
    return bytes(out)
