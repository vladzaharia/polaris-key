# @pkey-feature connect.protocol
"""``core/peer_session.py`` in mode ``a`` (WIRE-CONTRACT-V5 §15.5, §15.6): two sessions wired in memory,
the refusals the matrix cannot show, and the mode-a ``records.sessions`` rows of ``peer-matrix.json``
driven through a real session. Mirrors ``packages/client-core/test/peerSession.test.ts``."""

from __future__ import annotations

import hashlib
import json
import pickle
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat
from helpers import KID, PRIVATE_PEM, PUBKEY_RAW

from polaris_key.core.b64url import b64url_encode
from polaris_key.core.jws import sign_jws
from polaris_key.core.peer_frame import RECORD, PeerRecord, encode_record
from polaris_key.core.peer_noise import NoiseError, NoiseHandshake, peer_noise_protocol, peer_prologue, peer_psk
from polaris_key.core.peer_payload import payload1, payload23
from polaris_key.core.peer_session import (
    TRANSPORT_DEADLINE_SECONDS,
    AccountContext,
    Closed,
    Established,
    PeerSession,
    Record,
    RingReceived,
    RingWanted,
    TrustUnverified,
)

SUB = "ps_AAAAAAAAAAAAAAAAAAAAAA"
NOW = 1_700_001_000
TRUST = {KID: PUBKEY_RAW}
ID_A = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
ID_B = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
_CORPUS = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
M: Dict[str, Any] = json.loads((_CORPUS / "peer-matrix.json").read_text())


def _x25519() -> Tuple[bytes, bytes]:
    k = X25519PrivateKey.generate()
    return (
        k.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()),
        k.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw),
    )


def _rnd() -> bytes:
    return _x25519()[0]


class Dev:
    def __init__(self, device_id: str, *, exp: int = NOW + 1000, epoch: int = 1, sub: str = SUB) -> None:
        self.id = device_id
        self.priv, self.pub = _x25519()
        self.sign_key = b64url_encode(bytes(range(32)))  # only shape-checked
        self.exp = exp
        self.epoch = epoch
        self.sub = sub

    @property
    def cert(self) -> str:
        return sign_jws(
            {
                "iss": "key.plrs.im",
                "aud": "djdl",
                "sub": self.sub,
                "deviceId": self.id,
                "signKey": self.sign_key,
                "agreeKey": b64url_encode(self.pub),
                "ringEpoch": self.epoch,
                "issuedAt": NOW - 10,
                "expiresAt": self.exp,
            },
            PRIVATE_PEM,
            KID,
            "pkey-peer+jws",
        )

    def keys(self) -> Dict[str, str]:
        return {"deviceId": self.id, "signKey": self.sign_key, "agreeKey": b64url_encode(self.pub)}


def _ring(devs: List[Dev], epoch: int = 1, sub: str = SUB) -> str:
    entries = sorted((d.keys() for d in devs), key=lambda e: e["deviceId"])
    return sign_jws(
        {
            "iss": "key.plrs.im",
            "aud": "djdl",
            "sub": sub,
            "epoch": epoch,
            "issuedAt": NOW - 10,
            "expiresAt": NOW + 1000,
            "devices": entries,
        },
        PRIVATE_PEM,
        KID,
        "pkey-ring+jws",
    )


class Side:
    def __init__(self, role: str, dev: Dev, disc: List[Optional[bytes]], held: Any = None, **kw: Any) -> None:
        self.events: List[Any] = []
        self.out: List[bytes] = []
        self.clock = [0.0]
        self.now = [NOW]
        self.held = held
        # A distinct sign key per device keeps the roster's duplicate-key rule happy.
        acct = AccountContext(
            trust=TRUST,
            expected_aud="djdl",
            cert_jws=dev.cert,
            own_sub=SUB,
            own_device_id=dev.id,
            held_ring=lambda: self.held,
            disc_keys=disc,
        )
        self.s = PeerSession(
            role=role,
            slug="djdl",
            static_key=dev.priv,
            account=acct,
            caps=["app/1", "ring/1"],
            hello={"platform": "test", "app": "demo"},
            send=self.out.append,
            on_event=self.events.append,
            now=lambda: self.now[0],
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


def pair(**kw: Any) -> Tuple[Side, Side, Dev, Dev]:
    A, B = Dev(ID_A), Dev(ID_B)
    A.sign_key = b64url_encode(bytes([1]) * 32)
    B.sign_key = b64url_encode(bytes([2]) * 32)
    k = _rnd()
    a = Side("initiator", A, [k], **kw.pop("a", {}))
    b = Side("responder", B, [k], **kw.pop("b", {}))
    return a, b, A, B


def test_admits_both_certificates_answers_ping_rekeys_and_closes() -> None:
    a, b, A, B = pair(a={"rekey_messages": 2})
    a.s.start()
    pump(a, b)
    est = a.of(Established)[0]
    assert est.peer_device_id == B.id and est.hello_authenticated is True
    assert est.caps == ["app/1", "ring/1"] and est.hello.platform == "test"
    assert b.of(Established)[0].peer_device_id == A.id
    a.s.send_record(0x0100, b"one")
    a.s.send_record(0x0100, b"two")
    a.s.send_record(0x0100, b"three")
    pump(a, b)
    assert [len(e.body) for e in b.of(Record)] == [3, 3, 5]
    b.s.send_record(RECORD["PING"], bytes(8))
    pump(a, b)
    assert b.of(Record) and len(b.of(Record)) == 3  # the PONG is the session's, not the host's
    a.s.close()
    pump(a, b)
    assert b.of(Closed) == [Closed("peer_bye", True)]
    assert a.of(Closed) == [Closed("peer_bye", False)]
    assert a.s.closed and b.s.closed


def test_a_wrong_discovery_key_ends_the_responder_silently() -> None:
    A, B = Dev(ID_A), Dev(ID_B)
    a = Side("initiator", A, [_rnd()])
    b = Side("responder", B, [_rnd()])
    a.s.start()
    pump(a, b)
    assert b.out == []
    assert b.of(Closed) == [Closed("handshake_failed", False)]


def test_the_responder_also_tries_the_previous_discovery_key() -> None:
    A, B = Dev(ID_A), Dev(ID_B)
    A.sign_key, B.sign_key = b64url_encode(bytes([1]) * 32), b64url_encode(bytes([2]) * 32)
    old = _rnd()
    a = Side("initiator", A, [old])
    b = Side("responder", B, [_rnd(), old])
    a.s.start()
    pump(a, b)
    assert len(b.of(Established)) == 1


def test_an_absent_previous_key_is_skipped_and_a_wrong_current_key_fails_cleanly() -> None:
    A, B = Dev(ID_A), Dev(ID_B)
    k = _rnd()
    a = Side("initiator", A, [k])
    b = Side("responder", B, [k, None])
    a.s.start()
    pump(a, b)
    assert len(b.of(Established)) == 1
    c = Side("initiator", A, [_rnd()])
    d = Side("responder", B, [k, None])
    c.s.start()
    pump(c, d)
    assert len(d.of(Closed)) == 1 and not d.of(Established)


def test_the_initiator_without_a_current_key_closes() -> None:
    a = Side("initiator", Dev(ID_A), [None])
    a.s.start()
    assert a.of(Closed) == [Closed("handshake_failed", False)] and a.out == []


def test_an_unusable_held_roster_refuses_and_asks_for_a_fresh_one_but_none_at_all_admits() -> None:
    A, B = Dev(ID_A), Dev(ID_B)
    k = _rnd()
    a = Side("initiator", A, [k])
    b = Side("responder", B, [k], held=("not-a-roster", 1))
    a.s.start()
    pump(a, b)
    assert len(b.of(RingWanted)) == 1 and not b.of(Established) and len(b.of(Closed)) == 1
    c = Side("initiator", A, [k])
    d = Side("responder", B, [k])
    c.s.start()
    pump(c, d)
    assert len(d.of(Established)) == 1 and len(d.of(RingWanted)) == 1


def test_a_peer_missing_from_a_newer_roster_is_revoked() -> None:
    A, B = Dev(ID_A), Dev(ID_B)
    k = _rnd()
    a = Side("initiator", A, [k])
    # B holds a roster at epoch 2 that does not list A, and A's certificate says epoch 1.
    b = Side("responder", B, [k], held=(_ring([B], epoch=2), 2))
    a.s.start()
    pump(a, b)
    assert b.of(Closed) == [Closed("peer_revoked", False)]


def test_a_newer_roster_is_pushed_verified_and_applied() -> None:
    A, B = Dev(ID_A), Dev(ID_B)
    A.sign_key, B.sign_key = b64url_encode(bytes([1]) * 32), b64url_encode(bytes([2]) * 32)
    k = _rnd()
    new = _ring([A, B], epoch=3)
    a = Side("initiator", A, [k], held=(new, 3))
    b = Side("responder", B, [k], held=(_ring([A, B], epoch=2), 2))
    a.s.start()
    pump(a, b)
    got = b.of(RingReceived)
    assert [g.epoch for g in got] == [3]
    assert b.s.is_open and a.s.is_open
    # A roster of another subject changes nothing; a malformed RING body closes.
    b.s.send_record(0x0100, b"x")


def test_a_peer_on_a_newer_roster_than_the_held_one_asks_for_it() -> None:
    A, B = Dev(ID_A, epoch=5), Dev(ID_B)
    A.sign_key, B.sign_key = b64url_encode(bytes([1]) * 32), b64url_encode(bytes([2]) * 32)
    k = _rnd()
    a = Side("initiator", A, [k], held=(_ring([A, B], epoch=5), 5))
    b = Side("responder", B, [k], held=(_ring([A, B], epoch=2), 2))
    a.s.start()
    pump(a, b)
    assert len(b.of(RingWanted)) == 1 and len(b.of(Established)) == 1


def test_trust_and_bad_ring_records() -> None:
    a, b, A, B = pair()
    a.s.start()
    pump(a, b)
    tp = a.s._tp
    assert tp is not None
    b.s.receive(tp.send.encrypt(b"", encode_record(PeerRecord(RECORD["TRUST"], 0, b'{"trust":"x.y.z"}'))))
    assert b.of(TrustUnverified) == [TrustUnverified("x.y.z")]
    b.s.receive(tp.send.encrypt(b"", encode_record(PeerRecord(RECORD["TRUST"], 0, b'{"nope":1}'))))
    assert b.of(Closed) == [Closed("peer_bad_frame", False)]


def test_hello_display_data_is_cleaned() -> None:
    A, B = Dev(ID_A), Dev(ID_B)
    k = _rnd()
    a = Side("initiator", A, [k])
    a.s._hello["label"] = "  Café ‮TV\x00  "
    b = Side("responder", B, [k])
    a.s.start()
    pump(a, b)
    assert b.of(Established)[0].hello.label == "Café TV"


def test_a_hello_over_4_kib_is_fine_in_mode_a() -> None:
    A, B = Dev(ID_A), Dev(ID_B)
    k = _rnd()
    a = Side("initiator", A, [k])
    a.s._hello["label"] = "x" * 4100
    a.s._hello["platform"] = "<b>"
    b = Side("responder", B, [k])
    a.s.start()
    pump(a, b)
    est = b.of(Established)[0]
    # The cap is for the modes whose peer is not verified; the display cleaning is not.
    assert est.hello.platform == "Unknown" and est.hello.label is not None and len(est.hello.label) == 64


def test_the_first_record_must_be_hello_and_the_refusal_is_said() -> None:
    B = Dev(ID_B)
    A = Dev(ID_A)
    k = _rnd()
    b = Side("responder", B, [k])
    raw = NoiseHandshake(
        "initiator",
        peer_noise_protocol("a"),
        peer_prologue("djdl", "a"),
        A.priv,
        psk=peer_psk(k, "djdl"),
    )
    b.s.receive(raw.write_message(payload1()))
    raw.read_message(b.out.pop(0))
    b.s.receive(raw.write_message(payload23("a", [], {"cert": A.cert, "ring": 1})))
    tp = raw.transport()
    # The responder's HELLO is out; answer with a PING instead of HELLO.
    b.s.receive(tp.send.encrypt(b"", encode_record(PeerRecord(RECORD["PING"], 0, bytes(8)))))
    assert b.of(Closed) == [Closed("peer_bad_frame", False)]
    tp.receive.decrypt(b"", b.out[0])  # HELLO
    close = tp.receive.decrypt(b"", b.out[1])
    assert close[3:] == b'{"code":"peer_bad_frame"}'


def test_message_two_and_three_are_checked_in_order() -> None:
    a, b, A, B = pair()
    a.s.start()
    # A message 3 to the responder before it answered, or a second message 1, closes.
    m1 = a.out.pop(0)
    b.s.receive(m1)
    b.s.receive(m1)
    assert b.of(Closed) == [Closed("handshake_failed", False)]


def test_deadlines_are_enforced_by_tick_on_injected_clocks() -> None:
    a, b, A, B = pair()
    a.s.start()
    assert a.s.wake_in() == TRANSPORT_DEADLINE_SECONDS
    a.clock[0] = TRANSPORT_DEADLINE_SECONDS - 1
    a.s.tick()
    assert not a.of(Closed) and a.s.wake_in() == 1
    a.clock[0] = TRANSPORT_DEADLINE_SECONDS
    a.s.tick()
    assert a.of(Closed) == [Closed("peer_timeout", False)] and a.s.wake_in() is None
    # A responder's clock starts at its first byte, and ends at the transport.
    c, d, _, _ = pair()
    assert d.s.wake_in() is None
    c.s.start()
    pump(c, d)
    assert d.s.is_open and d.s.wake_in() is not None  # the peer certificate's expiry
    d.clock[0] = 10_000
    d.s.tick()
    assert not d.of(Closed)


def test_a_peer_certificate_that_runs_out_closes_the_session() -> None:
    A, B = Dev(ID_A, exp=NOW + 50), Dev(ID_B)
    k = _rnd()
    a = Side("initiator", A, [k])
    b = Side("responder", B, [k])
    a.s.start()
    pump(a, b)
    assert b.s.wake_in() == 50
    b.now[0] = NOW + 50
    b.s.tick()
    assert b.of(Closed) == [Closed("peer_expired", False)]
    pump(a, b)
    assert a.of(Closed) == [Closed("peer_expired", True)]


def test_an_already_expired_peer_certificate_is_refused_at_the_handshake() -> None:
    A, B = Dev(ID_A, exp=NOW - 1000), Dev(ID_B)
    k = _rnd()
    a = Side("initiator", A, [k])
    b = Side("responder", B, [k])
    a.s.start()
    pump(a, b)
    assert b.of(Closed) == [Closed("handshake_failed", False)] and not b.of(Established)


def test_the_age_of_a_key_rekeys_too() -> None:
    a, b, _, _ = pair(a={"rekey_seconds": 10})
    a.s.start()
    pump(a, b)
    a.clock[0] = 11
    a.s.send_record(0x0100, b"late")
    assert len(a.out) == 2  # REKEY, then the record
    pump(a, b)
    assert [e.body for e in b.of(Record)] == [b"late"]
    a.s.send_record(0x0100, b"again")
    assert len(a.out) == 1


def test_send_record_refuses_what_the_session_owns_or_cannot_carry() -> None:
    a, b, _, _ = pair()
    with pytest.raises(RuntimeError):
        a.s.send_record(0x0100, b"early")
    a.s.start()
    pump(a, b)
    for t in (RECORD["HELLO"], RECORD["CLOSE"], RECORD["REKEY"], RECORD["SAS_COMMIT"]):
        with pytest.raises(ValueError):
            a.s.send_record(t, b"")
    a.s._max_send = 4
    with pytest.raises(ValueError):
        a.s.send_record(0x0100, b"12345")


def test_modes_v_and_p_are_not_here_yet() -> None:
    with pytest.raises(ValueError):
        PeerSession(
            role="initiator",
            slug="djdl",
            static_key=_rnd(),
            account=AccountContext(TRUST, "djdl", "x", SUB, ID_A, lambda: None, ()),
            send=lambda b: None,
            on_event=lambda e: None,
            hello={"platform": "t", "app": "a"},
            mode="v",
        )


def test_no_secret_in_a_repr_and_no_pickle() -> None:
    a, b, A, B = pair()
    a.s.start()
    pump(a, b)
    a.s.send_record(0x0100, b"secret-body")
    pump(a, b)
    text = repr(a.s) + repr(a.s._acct) + repr(a.events) + repr(b.events)
    assert "secret-body" not in text and A.cert not in text
    for key in (a.s._acct.disc_keys[0],):
        assert key is not None and key.hex() not in text and repr(key) not in text
    with pytest.raises(TypeError):
        pickle.dumps(a.s)


def test_a_failing_event_callback_cannot_wedge_the_close() -> None:
    a, b, _, _ = pair()
    boom = []

    def on_event(e: Any) -> None:
        boom.append(e)
        raise RuntimeError("host bug")

    b.s._on_event = on_event
    a.s.start()
    pump(a, b)
    assert b.s.closed  # the host's exception ended the session, not the process
    assert any(isinstance(e, Closed) for e in boom)


# -- the mode-a rows of records.sessions, through a real session ------------------------------------

_INTERNAL = {0x0002, 0x0003, 0x0004, 0x0005, 0x80FE, 0x80FF, 0x8001}


def _bytes(v: Any) -> bytes:
    if isinstance(v, dict):
        return bytes([int(v["fill"], 16)]) * v["count"]
    return bytes.fromhex(v)


def _rows() -> List[Dict[str, Any]]:
    out = []
    for s in M["records"]["sessions"]:
        if s["mode"] != "a":
            continue
        types = {int(r["type"], 16) for r in s["records"]}
        if types & _INTERNAL:
            continue  # the session answers or consumes these itself; the assembler rows cover them
        out.append(s)
    return out


@pytest.mark.parametrize("s", _rows(), ids=lambda s: s["id"])
def test_matrix_session_rows_through_a_session(s: Dict[str, Any]) -> None:
    a, b, _, _ = pair()
    a.s.start()
    pump(a, b)
    tp = a.s._tp
    assert tp is not None and b.s.is_open
    for rec in s["records"]:
        try:
            wire = tp.send.encrypt(
                b"", encode_record(PeerRecord(int(rec["type"], 16), rec.get("flags", 0), _bytes(rec["body"])))
            )
        except NoiseError:
            pytest.skip("a single Noise message cannot carry this record")
        b.s.receive(wire)
        if b.s.closed:
            break
    want = s["want"]
    if "close" in want:
        assert b.of(Closed) == [Closed(want["close"], False)]
    else:
        got = [
            {"type": "%04x" % e.record_type, "length": len(e.body), "sha256": hashlib.sha256(e.body).hexdigest()}
            for e in b.of(Record)
        ]
        assert {"delivered": got} == want and not b.of(Closed)


def test_an_account_context_cannot_be_pickled() -> None:
    import pickle

    ctx = AccountContext(TRUST, "djdl", "x", SUB, ID_A, lambda: None, (_rnd(),))
    with pytest.raises(TypeError):
        pickle.dumps(ctx)
