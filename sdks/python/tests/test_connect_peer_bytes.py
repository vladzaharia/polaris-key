# @pkey-feature connect.protocol
"""The ``frames``, ``records`` and ``relayEnvelopes`` rows of ``peer-matrix.json`` (WIRE-CONTRACT-V5
§15.6, §15.7) through the Python byte layer. Mirrors the Node runner ``peerMatrix.test.ts``."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import pytest

from polaris_key.core.peer_frame import (
    MAX_CHAIN_RECORDS,
    FrameReader,
    PeerRecord,
    RecordAssembler,
    decode_frames,
    encode_frame,
    encode_record,
    parse_record,
    split_message,
)
from polaris_key.core.peer_relay_codec import decode_relay, encode_relay

M: Dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "peer-matrix.json").read_text()
)
_SHA = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731


def _bytes(b: Union[str, Dict[str, Any]]) -> bytes:
    return bytes.fromhex(b) if isinstance(b, str) else bytes([int(b["fill"], 16)]) * b["count"]


def test_row_counts() -> None:
    assert len(M["frames"]["encode"]) == 4
    assert len(M["records"]["parse"]) == 14
    assert len(M["records"]["sessions"]) == 85
    assert len(M["relayEnvelopes"]["messages"]) + len(M["relayEnvelopes"]["refused"]) + len(
        M["relayEnvelopes"]["sizes"]
    ) == 56


# -- frames -----------------------------------------------------------------------------------------


def test_frame_encode() -> None:
    for r in M["frames"]["encode"]:
        assert encode_frame(bytes.fromhex(r["noise"])).hex() == r["frame"]


def test_frame_limits() -> None:
    for r in M["frames"]["limits"]:
        body = bytes([0x5A]) * r["len"]
        if r["want"].get("refused"):
            with pytest.raises(ValueError):
                encode_frame(body)
        else:
            f = encode_frame(body)
            assert f[:2].hex() == r["want"]["header"]
            assert _SHA(f) == r["want"]["frameSha256"], r["len"]


@pytest.mark.parametrize("r", M["frames"]["decode"], ids=[r["id"] for r in M["frames"]["decode"]])
def test_frame_decode(r: Dict[str, Any]) -> None:
    got = decode_frames(bytes.fromhex(r["stream"]))
    if "error" in r["want"]:
        assert got == r["want"]["error"]
    else:
        assert not isinstance(got, str)
        assert [f.hex() for f in got[0]] == r["want"]["frames"]
        assert got[1].hex() == r["want"]["rest"]


def test_frame_reader_matches_decode_byte_by_byte_and_in_linear_work() -> None:
    for r in M["frames"]["decode"]:
        stream = bytes.fromhex(r["stream"])
        rd = FrameReader()
        frames: List[bytes] = []
        closed = False
        for i in range(len(stream)):
            out = rd.push(stream[i : i + 1])
            if out is None:
                closed = True
                break
            frames += out
        if "error" in r["want"]:
            assert closed, r["id"]
        else:
            assert not closed and [f.hex() for f in frames] == r["want"]["frames"], r["id"]
    big = encode_frame(bytes(65535)) * 3
    rd = FrameReader()
    n = 0
    for i in range(len(big)):
        n += len(rd.push(big[i : i + 1]) or [])
    assert n == 3
    assert rd.copied < 4 * len(big)


# -- records ----------------------------------------------------------------------------------------


def test_record_parse() -> None:
    for r in M["records"]["parse"]:
        got = parse_record(bytes.fromhex(r["plaintext"]))
        if "error" in r["want"]:
            assert got is None, r["plaintext"]
        else:
            assert got is not None
            assert "%04x" % got.type == r["want"]["type"]
            assert bool(got.flags & 1) is r["want"]["more"]
            assert got.body.hex() == r["want"]["body"]


def test_the_type_table_matches_the_corpus() -> None:
    from polaris_key.core.peer_frame import RECORD_TYPES

    rows = [
        (int(t["from"], 16), int(t["to"], 16), t["name"], t["modes"], t.get("bodyLen"))
        for t in M["records"]["types"]
    ]
    assert [tuple(r) for r in RECORD_TYPES] == rows


@pytest.mark.parametrize("s", M["records"]["sessions"], ids=[s["id"] for s in M["records"]["sessions"]])
def test_record_session(s: Dict[str, Any]) -> None:
    asm = RecordAssembler(s["mode"])
    delivered: List[Dict[str, Any]] = []
    close: Optional[Dict[str, Any]] = None
    for i, rec in enumerate(s["records"]):
        r = asm.push(PeerRecord(int(rec["type"], 16), rec.get("flags", 0), _bytes(rec["body"])))
        if r.kind == "close":
            close = {"close": r.code, "at": i}
            break
        if r.kind == "message":
            delivered.append({"type": "%04x" % r.type, "length": len(r.body), "sha256": _SHA(r.body)})
    if "close" in s["want"]:
        assert close == s["want"]
    else:
        assert close is None
        assert {"delivered": delivered} == s["want"]


def test_split_and_reassemble_round_trip() -> None:
    body = bytes(range(256)) * 4096  # 1 MiB
    recs = split_message(0x0100, body)
    assert len(recs) == MAX_CHAIN_RECORDS - 1
    asm = RecordAssembler("a")
    out = None
    for raw in recs:
        r = parse_record(raw)
        assert r is not None
        out = asm.push(r)
    assert out is not None and out.kind == "message" and out.body == body
    with pytest.raises(ValueError):
        split_message(0x0100, body + b"x")
    assert len(split_message(0x0100, b"")) == 1
    assert encode_record(PeerRecord(0x8001, 0, b"ab")).hex() == "8001006162"


# -- relay envelopes --------------------------------------------------------------------------------


def _to_msg(x: Dict[str, Any]) -> Dict[str, Any]:
    o = dict(x)
    for k in ("to", "from", "noise", "data", "device"):
        if isinstance(o.get(k), str):
            o[k] = bytes.fromhex(o[k])
    if "devices" in o:
        o["devices"] = [bytes.fromhex(d) for d in o["devices"]]
    return o


@pytest.mark.parametrize("r", M["relayEnvelopes"]["messages"], ids=[r["id"] for r in M["relayEnvelopes"]["messages"]])
def test_relay_round_trip(r: Dict[str, Any]) -> None:
    msg = _to_msg(r["message"])
    assert encode_relay(msg).hex() == r["bytes"]
    assert decode_relay(r["dir"], bytes.fromhex(r["bytes"])) == msg


@pytest.mark.parametrize("r", M["relayEnvelopes"]["refused"], ids=[r["id"] for r in M["relayEnvelopes"]["refused"]])
def test_relay_refused(r: Dict[str, Any]) -> None:
    assert decode_relay(r["dir"], bytes.fromhex(r["bytes"])) is None


@pytest.mark.parametrize("r", M["relayEnvelopes"]["sizes"], ids=[r["id"] for r in M["relayEnvelopes"]["sizes"]])
def test_relay_sizes(r: Dict[str, Any]) -> None:
    b = bytearray([int(r["bytes"]["fill"], 16)]) * r["total"]
    prefix = bytes.fromhex(r["bytes"]["prefix"])
    b[: len(prefix)] = prefix
    got = decode_relay(r["dir"], bytes(b))
    assert (got is None) is bool(r["want"].get("refused"))


def test_relay_encode_refuses_what_a_layout_cannot_hold() -> None:
    dev, noise = bytes(24), b"x"
    for bad in (
        {"op": "send", "to": bytes(23), "session": 1, "noise": noise},
        {"op": "send", "to": dev, "session": 2**32, "noise": noise},
        {"op": "send", "to": dev, "session": True, "noise": noise},
        {"op": "send", "to": dev, "session": 1, "noise": b""},
        {"op": "send", "to": dev, "session": 1, "noise": bytes(65536)},
        {"op": "ping", "data": bytes(7)},
        {"op": "members", "devices": [dev] * 256},
        {"op": "ring", "epoch": -1},
        {"op": "ring", "epoch": 2**53},
        {"op": "gone", "device": bytes(25)},
        {"op": "limit", "reason": 5},
        {"op": "nope"},
    ):
        with pytest.raises(ValueError):
            encode_relay(bad)
    assert decode_relay("toClient", b"\x83" + (2**53).to_bytes(8, "big")) is None
