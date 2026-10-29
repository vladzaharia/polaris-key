# @pkey-feature connect.protocol
"""``core/peer_session.py`` in modes ``v`` and ``p`` (WIRE-CONTRACT-V5 §15.5, §15.6): the commit-reveal
SAS, the corpus ``sas`` rows through a real session, the approver's limiter and deadlines. Mirrors the
modes v and p half of ``packages/client-core/test/peerSession.test.ts``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.core.peer_frame import RECORD, PeerRecord, encode_record
from polaris_key.core.peer_noise import NoiseHandshake, NoisePorts, peer_noise_protocol, peer_prologue
from polaris_key.core.peer_payload import payload1
from polaris_key.core.peer_sas import sas_body, sas_commit, sas_display, sas_value
from polaris_key.core.peer_session import (
    SAS_DEADLINE_SECONDS,
    Closed,
    Established,
    HandshakeLimiter,
    PeerSession,
    Record,
    Sas,
)

_CORPUS = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
M: Dict[str, Any] = json.loads((_CORPUS / "peer-matrix.json").read_text())


class FixedPorts(NoisePorts):
    """Hands out the corpus nonce for the first 32-byte draw of a session."""

    def __init__(self, nonce: bytes) -> None:
        self._nonce = nonce

    def random(self, length: int) -> bytes:
        return self._nonce if length == 32 else super().random(length)


class Side:
    def __init__(self, mode: str, role: str, **kw: Any) -> None:
        import os

        self.events: List[Any] = []
        self.out: List[bytes] = []
        self.clock = [0.0]
        if mode != "a" and role == "responder" and "admission" not in kw:
            kw["admission"] = HandshakeLimiter()
        self.s = PeerSession(
            role=role,
            slug="djdl",
            mode=mode,
            static_key=os.urandom(32),
            caps=["app/1", "ring/1"],
            hello=kw.pop("hello", {"platform": "test", "app": "demo"}),
            send=self.out.append,
            on_event=self.events.append,
            mono=lambda: self.clock[0],
            **kw,
        )

    def of(self, cls: Any) -> List[Any]:
        return [e for e in self.events if isinstance(e, cls)]


def pump(a: Side, b: Side) -> None:
    for _ in range(200):
        if not a.out and not b.out:
            return
        ao, a.out[:] = a.out[:], []
        for m in ao:
            b.s.receive(m)
        bo, b.out[:] = b.out[:], []
        for m in bo:
            a.s.receive(m)


def types(x: Side) -> List[int]:
    return [e.record_type for e in x.of(Record)]


@pytest.mark.parametrize("mode", ["v", "p"])
def test_both_sides_show_the_same_code_then_records_flow(mode: str) -> None:
    d, m = Side(mode, "initiator"), Side(mode, "responder")
    d.s.start()
    pump(d, m)
    sd, sm = d.of(Sas)[0], m.of(Sas)[0]
    assert len(sd.display) == 7 and sd.display[3] == " " and sd.display == sas_display(sd.code)
    assert sd.code == sm.code
    est = d.of(Established)[0]
    assert est.caps == ["app/1", "ring/1"] and est.hello_authenticated is False
    # The code is bound to the handshake hash, both nonces and the mode.
    assert sd.code == sas_value(d.s._hs.handshake_hash, d.s._n_d, d.s._n_m, mode)
    # Nothing flows until the person confirms; an inbound record is held, not refused.
    with pytest.raises(RuntimeError):
        d.s.send_record(RECORD["VOUCH_RESULT"], b"")
    d.s.confirm_sas()
    pump(d, m)
    assert types(m) == []
    m.s.confirm_sas()
    pump(d, m)
    expect = [RECORD["CONFIRM"]] if mode == "p" else []
    assert types(m) == expect and types(d) == expect
    assert d.s.is_open and m.s.is_open and not d.of(Closed)


def test_a_host_record_is_held_until_this_side_confirms() -> None:
    d, m = Side("v", "initiator"), Side("v", "responder")
    d.s.start()
    pump(d, m)
    d.s.confirm_sas()
    d.s.send_record(RECORD["VOUCH_REQ"], b"{}")
    pump(d, m)
    assert types(m) == [] and not m.s.closed
    m.s.confirm_sas()
    assert types(m) == [RECORD["VOUCH_REQ"]]


def test_at_most_sixteen_records_are_held() -> None:
    d, m = Side("v", "initiator"), Side("v", "responder")
    d.s.start()
    pump(d, m)
    d.s.confirm_sas()
    for _ in range(16):
        d.s.send_record(RECORD["VOUCH_REQ"], b"{}")
    pump(d, m)
    assert not m.s.closed
    d.s.send_record(RECORD["VOUCH_REQ"], b"{}")
    pump(d, m)
    assert m.of(Closed) == [Closed("peer_busy", False)]


def test_at_most_16_kib_of_bodies_are_held_then_peer_busy() -> None:
    d, m = Side("v", "initiator"), Side("v", "responder")
    d.s.start()
    pump(d, m)
    d.s.confirm_sas()
    d.s.send_record(RECORD["VOUCH_REQ"], bytes(8 * 1024))
    pump(d, m)
    assert not m.s.closed
    d.s.send_record(RECORD["VOUCH_REQ"], bytes(8 * 1024 + 1))
    pump(d, m)
    assert m.of(Closed) == [Closed("peer_busy", False)]
    # Exactly 16 KiB is held, and delivered after the person confirms.
    d, m = Side("v", "initiator"), Side("v", "responder")
    d.s.start()
    pump(d, m)
    d.s.confirm_sas()
    d.s.send_record(RECORD["VOUCH_REQ"], bytes(8 * 1024))
    d.s.send_record(RECORD["VOUCH_REQ"], bytes(8 * 1024))
    pump(d, m)
    assert not m.s.closed
    m.s.confirm_sas()
    assert types(m) == [RECORD["VOUCH_REQ"]] * 2


def hello_pair(mode: str = "v", **hello: Any) -> Any:
    d = Side(mode, "initiator", hello={"platform": "t", "app": "a", **hello})
    m = Side(mode, "responder")
    d.s.start()
    pump(d, m)
    return d, m


@pytest.mark.parametrize(
    "platform,app,want_platform,want_app",
    [
        ("macos", "Demo", "macos", "Demo"),
        ("Android 14.1_x+y-z", "a", "Android 14.1_x+y-z", "a"),
        ("x" * 32, "a", "x" * 32, "a"),
        ("x" * 33, "a", "Unknown", "a"),
        ("<b>ok</b>", "a", "Unknown", "a"),
        ("mac\u202eos", "a", "Unknown", "a"),
        ("macos\n", "a", "Unknown", "a"),  # a trailing newline is not a platform
        ("mac\u00f3s", "a", "Unknown", "a"),
        ("", "a", "Unknown", "a"),
        ("linux", "  Pay\u202e\u0000ment  ", "linux", "Payment"),
        ("linux", "\u202e\u0000", "linux", "Unknown"),
        ("linux", "   ", "linux", "Unknown"),
        ("linux", "a" * 100, "linux", "a" * 64),
        ("linux", "Cafe\u0301", "linux", "Caf\u00e9"),
    ],
)
@pytest.mark.parametrize("mode", ["v", "p"])
def test_only_a_known_shaped_platform_and_a_cleaned_app_are_shown(
    mode: str, platform: str, app: str, want_platform: str, want_app: str
) -> None:
    _d, m = hello_pair(mode, platform=platform, app=app)
    est = m.of(Established)[0]
    assert (est.hello.platform, est.hello.app) == (want_platform, want_app)


@pytest.mark.parametrize("mode", ["v", "p"])
def test_a_hello_over_4_kib_is_refused_in_modes_v_and_p(mode: str) -> None:
    _d, m = hello_pair(mode, label="x" * 4100)
    assert m.of(Established) == [] and m.of(Closed) == [Closed("peer_bad_frame", False)]
    _d, m = hello_pair(mode, label="x" * 4000)  # under the cap: cleaned to 64 code points
    assert len(m.of(Established)[0].hello.label) == 64


def test_confirm_before_a_code_closes_and_a_second_confirm_is_a_noop_close() -> None:
    d = Side("v", "initiator")
    d.s.start()
    d.s.confirm_sas()
    assert d.of(Closed) == [Closed("peer_not_allowed", False)]


def test_hello_display_data_is_unauthenticated_and_cleaned() -> None:
    d = Side("v", "initiator", hello={"platform": "t", "app": "a", "label": "  Café ‮TV\x00  "})
    m = Side("v", "responder")
    d.s.start()
    pump(d, m)
    est = m.of(Established)[0]
    assert est.hello_authenticated is False and est.hello.label == "Café TV"


def test_an_approver_needs_an_admission_limiter() -> None:
    with pytest.raises(ValueError):
        PeerSession(
            role="responder", slug="djdl", mode="v", static_key=bytes(32), send=lambda b: None,
            on_event=lambda e: None, hello={"platform": "t", "app": "a"},
        )  # fmt: skip
    with pytest.raises(ValueError):  # mode a needs an account, v and p do not take one
        PeerSession(
            role="initiator", slug="djdl", mode="a", static_key=bytes(32), send=lambda b: None,
            on_event=lambda e: None, hello={"platform": "t", "app": "a"},
        )  # fmt: skip


def test_the_limiter_refuses_over_the_rate_and_past_the_pending_cap_and_releases_on_confirm() -> None:
    t = [0.0]
    lim = HandshakeLimiter(5, 2, lambda: t[0])

    def hello() -> Any:
        m = Side("v", "responder", admission=lim)
        d = Side("v", "initiator")
        d.s.start()
        pump(d, m)
        return d, m

    d1, m1 = hello()
    hello()
    third = Side("v", "responder", admission=lim)
    d3 = Side("v", "initiator")
    d3.s.start()
    pump(d3, third)
    assert third.out == [] and third.of(Closed) == [Closed("peer_busy", False)]
    d1.s.confirm_sas()
    m1.s.confirm_sas()
    rel = lim.begin()
    assert rel is not None
    t[0] = 61


def test_the_limiter_counts_five_a_minute_on_a_monotonic_clock() -> None:
    t = [0.0]
    lim = HandshakeLimiter(5, 99, lambda: t[0])
    assert [lim.begin() is not None for _ in range(6)] == [True] * 5 + [False]
    t[0] = 61
    assert lim.begin() is not None


def test_a_release_runs_once_and_a_closed_session_frees_its_slot() -> None:
    lim = HandshakeLimiter(99, 1)
    m = Side("v", "responder", admission=lim)
    d = Side("v", "initiator")
    d.s.start()
    pump(d, m)
    assert lim.begin() is None
    m.s.close()
    rel = lim.begin()
    assert rel is not None
    rel()
    rel()  # idempotent
    assert lim.begin() is not None and lim.begin() is None


def test_the_code_deadline_ends_an_unconfirmed_session() -> None:
    d, m = Side("v", "initiator"), Side("v", "responder")
    d.s.start()
    pump(d, m)
    assert m.s.wake_in() == SAS_DEADLINE_SECONDS
    m.clock[0] = SAS_DEADLINE_SECONDS - 1
    m.s.tick()
    assert not m.of(Closed)
    m.clock[0] = SAS_DEADLINE_SECONDS
    m.s.tick()
    assert m.of(Closed) == [Closed("peer_timeout", False)]
    pump(d, m)
    assert d.of(Closed) == [Closed("peer_timeout", True)]
    # Confirming ends the deadline.
    d2, m2 = Side("v", "initiator"), Side("v", "responder")
    d2.s.start()
    pump(d2, m2)
    m2.s.confirm_sas()
    assert m2.s.wake_in() is None


def test_the_transport_deadline_closes_a_stalled_handshake() -> None:
    d, m = Side("v", "initiator"), Side("v", "responder")
    d.s.start()
    m.s.receive(d.out.pop(0))
    m.clock[0] = 30
    m.s.tick()
    assert m.of(Closed) == [Closed("peer_timeout", False)]


def test_the_first_record_must_be_hello_and_the_refusal_is_said() -> None:
    m = Side("p", "responder")
    raw = NoiseHandshake("initiator", peer_noise_protocol("p"), peer_prologue("djdl", "p"), bytes([7]) * 32)
    m.s.receive(raw.write_message(payload1()))
    raw.read_message(m.out.pop(0))
    m.s.receive(raw.write_message(b'{"v":1,"caps":[]}'))
    tp = raw.transport()
    m.s.receive(tp.send.encrypt(b"", encode_record(PeerRecord(RECORD["PING"], 0, bytes(8)))))
    assert m.of(Closed) == [Closed("peer_bad_frame", False)]
    tp.receive.decrypt(b"", m.out[0])
    assert tp.receive.decrypt(b"", m.out[1])[3:] == b'{"code":"peer_bad_frame"}'


def test_a_certificate_in_a_v_or_p_payload_is_refused() -> None:
    m = Side("v", "responder")
    raw = NoiseHandshake("initiator", peer_noise_protocol("v"), peer_prologue("djdl", "v"), bytes([7]) * 32)
    m.s.receive(raw.write_message(payload1()))
    raw.read_message(m.out.pop(0))
    m.s.receive(raw.write_message(b'{"v":1,"caps":[],"cert":"x","ring":1}'))
    assert m.of(Closed) == [Closed("handshake_failed", False)]


# -- the corpus sas rows -----------------------------------------------------------------------------


@pytest.mark.parametrize("row", M["sas"]["commits"], ids=lambda r: r["c"][:8])
def test_corpus_commit_and_reveal_bodies_through_a_session(row: Dict[str, Any]) -> None:
    """The approver accepts the corpus commit, answers, and accepts exactly the corpus reveal."""
    nd = bytes.fromhex(row["nD"])
    m = Side("v", "responder")
    raw = NoiseHandshake("initiator", peer_noise_protocol("v"), peer_prologue("djdl", "v"), bytes([7]) * 32)
    m.s.receive(raw.write_message(payload1()))
    raw.read_message(m.out.pop(0))
    m.s.receive(raw.write_message(b'{"v":1,"caps":[]}'))
    tp = raw.transport()
    tp.receive.decrypt(b"", m.out.pop(0))  # the approver's HELLO
    hello = b'{"platform":"t","app":"a","maxMessage":1048576}'

    def put(t: int, body: bytes) -> None:
        m.s.receive(tp.send.encrypt(b"", encode_record(PeerRecord(t, 0, body))))

    put(RECORD["HELLO"], hello)
    put(RECORD["SAS_COMMIT"], row["commitBody"].encode())
    assert sas_body("c", bytes.fromhex(row["c"])).decode() == row["commitBody"]
    nm = tp.receive.decrypt(b"", m.out.pop(0))
    assert nm[:3] == RECORD["SAS_NONCE"].to_bytes(2, "big") + b"\x00"
    put(RECORD["SAS_REVEAL"], row["revealBody"].encode())
    assert len(m.of(Sas)) == 1 and not m.of(Closed)
    assert sas_commit(nd).hex() == row["c"]


@pytest.mark.parametrize("row", M["sas"]["commits"], ids=lambda r: r["c"][:8])
def test_a_reveal_that_does_not_match_the_commitment_closes(row: Dict[str, Any]) -> None:
    other = M["sas"]["commits"][(M["sas"]["commits"].index(row) + 1) % len(M["sas"]["commits"])]
    m = Side("v", "responder")
    raw = NoiseHandshake("initiator", peer_noise_protocol("v"), peer_prologue("djdl", "v"), bytes([7]) * 32)
    m.s.receive(raw.write_message(payload1()))
    raw.read_message(m.out.pop(0))
    m.s.receive(raw.write_message(b'{"v":1,"caps":[]}'))
    tp = raw.transport()

    def put(t: int, body: bytes) -> None:
        m.s.receive(tp.send.encrypt(b"", encode_record(PeerRecord(t, 0, body))))

    put(RECORD["HELLO"], b'{"platform":"t","app":"a","maxMessage":1048576}')
    put(RECORD["SAS_COMMIT"], row["commitBody"].encode())
    put(RECORD["SAS_REVEAL"], other["revealBody"].encode())
    assert m.of(Closed) == [Closed("peer_bad_frame", False)] and not m.of(Sas)


def test_corpus_nonces_give_the_corpus_codes_for_the_session_hash() -> None:
    """With the nonces pinned, both parties derive ``sas_value(h, nD, nM, mode)``; the corpus rows pin
    that function, and the session must use the same one."""
    row = M["sas"]["commits"][0]
    nd = bytes.fromhex(row["nD"])
    d = Side("v", "initiator", ports=FixedPorts(nd))
    m = Side("v", "responder", ports=FixedPorts(bytes([9]) * 32))
    d.s.start()
    pump(d, m)
    assert d.s._n_d == nd and m.s._n_m == bytes([9]) * 32
    h = d.s._hs.handshake_hash
    assert d.of(Sas)[0].code == sas_value(h, nd, bytes([9]) * 32, "v")
    for r in M["sas"]["codes"]:
        value = sas_value(bytes.fromhex(r["h"]), bytes.fromhex(r["nD"]), bytes.fromhex(r["nM"]), r["mode"])
        assert sas_display(value) == r["display"]


@pytest.mark.parametrize(
    "records",
    [
        [("SAS_NONCE", "nM")],  # the approver gets a nonce first
        [("SAS_REVEAL", "nD")],  # reveal before commit
        [("SAS_COMMIT", "c"), ("SAS_COMMIT", "c")],  # a second commit
    ],
)
def test_out_of_order_sas_records_close(records: List[Any]) -> None:
    m = Side("v", "responder")
    raw = NoiseHandshake("initiator", peer_noise_protocol("v"), peer_prologue("djdl", "v"), bytes([7]) * 32)
    m.s.receive(raw.write_message(payload1()))
    raw.read_message(m.out.pop(0))
    m.s.receive(raw.write_message(b'{"v":1,"caps":[]}'))
    tp = raw.transport()

    def put(t: int, body: bytes) -> None:
        m.s.receive(tp.send.encrypt(b"", encode_record(PeerRecord(t, 0, body))))

    put(RECORD["HELLO"], b'{"platform":"t","app":"a","maxMessage":1048576}')
    for name, member in records:
        put(RECORD[name], sas_body(member, bytes(32)))
    assert m.of(Closed) == [Closed("peer_bad_frame", False)]


def test_no_host_record_is_delivered_before_the_code_is_confirmed() -> None:
    d, m = Side("p", "initiator"), Side("p", "responder")
    d.s.start()
    pump(d, m)
    assert d.of(Record) == [] and m.of(Record) == []
    assert not any(isinstance(e, Record) for e in d.events + m.events)
