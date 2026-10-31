# @pkey-feature connect.transfer
"""The session's side of Direct Transfer (WIRE-CONTRACT-V5 §15.11): the six record types belong to the
transfer port. Both sides must list ``xfer/1``; without it an xfer record closes ``peer_not_allowed``, MORE
on one closes ``peer_bad_frame``, and the generic send path refuses the types."""

from __future__ import annotations

from typing import Any, List

import pytest
from test_connect_peer_session import Side, pair, pump

from polaris_key.core.peer_frame import PeerRecord, encode_record
from polaris_key.core.peer_session import Closed, Established, Record

BOTH = ["app/1", "ring/1", "xfer/1"]


def _open(a_caps: List[str], b_caps: List[str]) -> Any:
    a, b, _, _ = pair(a={"caps": a_caps}, b={"caps": b_caps})
    a.s.start()
    pump(a, b)
    assert a.s.is_open and b.s.is_open
    return a, b


def _inject(a: Side, b: Side, type_: int, body: bytes = b"{}", flags: int = 0) -> None:
    tp = a.s._tp
    assert tp is not None
    b.s.receive(tp.send.encrypt(b"", encode_record(PeerRecord(type_, flags, body))))


def test_the_capability_needs_both_sides() -> None:
    for caps_a, caps_b in ((BOTH, ["app/1"]), (["app/1"], BOTH), (["app/1"], ["app/1"])):
        a, b = _open(caps_a, caps_b)
        assert "xfer/1" not in a.of(Established)[0].caps
        with pytest.raises(RuntimeError):
            a.s.attach_xfer(lambda t, body: None)
        _inject(a, b, 0x0020)
        assert b.of(Closed) == [Closed("peer_not_allowed", False)]
        assert not b.of(Record)


def test_an_xfer_record_reaches_only_the_port() -> None:
    a, b = _open(BOTH, BOTH)
    got: List[Any] = []
    b.s.attach_xfer(lambda t, body: got.append((t, body)))
    _inject(a, b, 0x0022, b"abc")
    assert got == [(0x0022, b"abc")]
    assert not b.of(Record) and not b.of(Closed)
    with pytest.raises(RuntimeError):
        b.s.attach_xfer(lambda t, body: None)  # once


def test_without_a_port_an_xfer_record_is_not_allowed() -> None:
    a, b = _open(BOTH, BOTH)
    _inject(a, b, 0x0021)
    assert b.of(Closed) == [Closed("peer_not_allowed", False)]


@pytest.mark.parametrize("t", range(0x20, 0x26))
def test_more_on_an_xfer_record_is_a_bad_frame(t: int) -> None:
    a, b = _open(BOTH, BOTH)
    b.s.attach_xfer(lambda t_, body: None)
    _inject(a, b, t, b"{}", flags=1)
    assert b.of(Closed) == [Closed("peer_bad_frame", False)]


@pytest.mark.parametrize("t", range(0x20, 0x26))
def test_the_generic_send_path_refuses_the_types(t: int) -> None:
    a, _ = _open(BOTH, BOTH)
    with pytest.raises(ValueError):
        a.s.send_record(t, b"{}")


def test_the_writer_sends_only_xfer_types_and_obeys_the_peers_size() -> None:
    a, b = _open(BOTH, BOTH)
    write = a.s.attach_xfer(lambda t, body: None)
    got: List[Any] = []
    b.s.attach_xfer(lambda t, body: got.append((t, len(body))))
    write(0x0023, b"{}")
    pump(a, b)
    assert got == [(0x0023, 2)]
    with pytest.raises(RuntimeError):
        write(0x0100, b"x")
    with pytest.raises(ValueError):
        write(0x0022, bytes(2 * 1024 * 1024))
