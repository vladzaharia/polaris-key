# @pkey-feature connect.identity connect.protocol
"""``cases.json`` sections ``peerCertCases``, ``ringCases`` and ``peerAdmissionCases`` (WIRE-CONTRACT-V5
§15.2, §15.3) through the Python verifiers, and the ``vouch`` section of ``peer-matrix.json`` (§15.6.1)
through the Python vouch codecs. Mirrors the Node runner's Cloud Connect suites."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional

import pytest

from polaris_key.core.peer_cert import (
    PeerSession,
    admit_peer,
    replace_ring,
    ring_expired,
    verify_peer_cert,
    verify_ring,
)
from polaris_key.core.peer_frame import RECORD
from polaris_key.core.peer_vouch import (
    ApproveAnswer,
    VouchFlow,
    VouchHello,
    build_vouch_result,
    finish_map,
    parse_vouch_result,
    verify_vouch_request,
)

_CORPUS = json.loads((Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "cases.json").read_text())
_CERTS: List[Dict[str, Any]] = _CORPUS["peerCertCases"]
_RINGS: List[Dict[str, Any]] = _CORPUS["ringCases"]
_ADMIT: List[Dict[str, Any]] = _CORPUS["peerAdmissionCases"]


def test_every_vector_is_present() -> None:
    assert len(_CERTS) == 113
    assert len(_RINGS) == 76
    assert len(_ADMIT) == 17


@pytest.mark.parametrize("c", _CERTS, ids=[c["id"] for c in _CERTS])
def test_peer_cert(c: Dict[str, Any]) -> None:
    s = c.get("session")
    session = PeerSession(s["mode"], s["remoteStatic"], s.get("ownSub"), s.get("ownDeviceId")) if s else None
    r = verify_peer_cert(c["jws"], trust=c["trust"], expected_aud=c["expectedAud"], now=c["now"], session=session)
    assert r.ok is c["expect"]["valid"], c["description"]
    if r.ok:
        assert r.cert is not None and r.cert.to_json() == c["expect"]["cert"]
    else:
        assert r.reason == c["expect"]["reason"], c["description"]


@pytest.mark.parametrize("c", _RINGS, ids=[c["id"] for c in _RINGS])
def test_ring(c: Dict[str, Any]) -> None:
    e = c["expect"]
    if c["kind"] == "verify":
        r = verify_ring(c["jws"], trust=c["trust"], expected_aud=c["expectedAud"])
        assert r.ok is e["valid"], c["description"]
        if r.ok and r.ring is not None:
            assert r.ring.epoch == e["epoch"]
            assert len(r.ring.devices) == e["devices"]
            assert ring_expired(r.ring, c["now"]) is e["expired"], c["description"]
        else:
            assert r.reason == e["reason"], c["description"]
    else:
        p = replace_ring(c.get("heldJws"), c["jws"], trust=c["trust"], expected_aud=c["expectedAud"], now=c["now"])
        assert p.replace is e["replace"], c["description"]
        if not p.replace:
            assert p.reason == e["reason"], c["description"]


@pytest.mark.parametrize("c", _ADMIT, ids=[c["id"] for c in _ADMIT])
def test_admission(c: Dict[str, Any]) -> None:
    r = admit_peer(c["certJws"], c["ringJws"], trust=c["trust"], expected_aud=c["expectedAud"], now=c["now"])
    e = c["expect"]
    assert r.admit is e["admit"], c["description"]
    if r.admit:
        assert r.ring_sync == e["ringSync"], c["description"]
    else:
        assert r.reason == e["reason"], c["description"]


# -- peer-matrix.json ``vouch`` (WIRE-CONTRACT-V5 §15.6.1) ---------------------------------------------

_PEER_MATRIX = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "peer-matrix.json").read_text()
)
_VOUCH: Dict[str, List[Dict[str, Any]]] = _PEER_MATRIX["vouch"]


def _vouch_body(r: Dict[str, Any]) -> bytes:
    """A row's body bytes: text, hex, or a prefix, a filler and a suffix."""
    if "bodyHex" in r:
        return bytes.fromhex(r["bodyHex"])
    if "bodyPad" in r:
        p = r["bodyPad"]
        return (p["prefix"] + p["fill"] * p["count"] + p["suffix"]).encode("utf-8")
    return r["body"].encode("utf-8")


def test_every_vouch_row_is_present() -> None:
    # Exact: a row added or dropped is a deliberate corpus change, never a silent one.
    assert len(_VOUCH["requests"]) == 80
    assert len(_VOUCH["results"]) == 26
    assert len(_VOUCH["flows"]) == 30
    assert len(_VOUCH["finish"]) == 29
    for k in ("requests", "results", "flows", "finish"):
        ids = [r["id"] for r in _VOUCH[k]]
        assert len(set(ids)) == len(ids), k


@pytest.mark.parametrize("r", _VOUCH["requests"], ids=[r["id"] for r in _VOUCH["requests"]])
def test_vouch_request(r: Dict[str, Any]) -> None:
    body = _vouch_body(r)
    if "bodyPad" in r:
        assert len(body) == r["length"]
    hello = r["hello"]
    got = verify_vouch_request(
        slug=r["slug"],
        h=bytes.fromhex(r["hHex"]),
        hello=VouchHello(label=hello.get("label"), platform=hello["platform"]),
        body=body,
    )
    if r["verdict"] == "ok":
        assert got is not None and got.to_json() == r["result"], r["note"]
    else:
        assert got is None, r["note"]
        assert r["close"] == "peer_bad_frame"


@pytest.mark.parametrize("r", _VOUCH["results"], ids=[r["id"] for r in _VOUCH["results"]])
def test_vouch_result(r: Dict[str, Any]) -> None:
    got = parse_vouch_result(_vouch_body(r))
    if "refuse" in r:
        assert got.refuse == r["refuse"] and got.status is None
    else:
        assert got.status == r["status"] and got.refuse is None


def _run_vouch_flow(steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    """One requester flow and one approver flow, the receiving end checking each record first, as the two
    ends of one session."""
    d: VouchFlow[Any] = VouchFlow("requester")
    m: VouchFlow[Any] = VouchFlow("approver")
    delivered: List[int] = []

    def take(v: Any, on_m: bool = False) -> Optional[str]:
        if not v.ok:
            return str(v.close)
        for rec in v.deliver:
            delivered.append(rec.at)
            if on_m and rec.type == RECORD["VOUCH_REQ"]:
                m.verified()
        return None

    for i, s in enumerate(steps):
        ev = s.get("ev")
        code: Optional[str] = None
        if ev == "handshake":
            code = take(d.negotiate(s["capsD"], s["capsM"]))
            code = code or take(m.negotiate(s["capsM"], s["capsD"]))
        elif ev == "shown":
            d.code_shown()
            m.code_shown()
        elif ev == "picked":
            code = take(m.picked(), True)
        elif ev in ("wrong-pick", "none-match", "timeout"):
            code = take(m.abandon(ev))
        elif ev == "confirmed":
            code = take(d.confirm_account())
        elif ev is None:
            t = int(s["type"], 16)
            body = build_vouch_result(s["status"]) if t == RECORD["VOUCH_RESULT"] else bytes(s.get("bytes", 0))
            record = _FlowRecord(t, body, i)
            sender, receiver = (d, m) if s["dir"] == "d2m" else (m, d)
            code = take(receiver.receive(record), receiver is m)
            # The sender's verdict only gates: what the receiver delivers is what counts.
            sent = sender.send(record)
            if code is None and not sent.ok:
                code = str(sent.close)
        else:
            raise AssertionError("unknown event %s" % ev)
        if code is not None:
            return {"close": code, "at": i, "delivered": delivered}
    return {"close": None, "at": None, "delivered": delivered}


class _FlowRecord(NamedTuple):
    type: int
    body: bytes
    at: int


@pytest.mark.parametrize("r", _VOUCH["flows"], ids=[r["id"] for r in _VOUCH["flows"]])
def test_vouch_flow(r: Dict[str, Any]) -> None:
    assert _run_vouch_flow(r["steps"]) == r["want"], r["note"]


@pytest.mark.parametrize("r", _VOUCH["finish"], ids=[r["id"] for r in _VOUCH["finish"]])
def test_vouch_finish(r: Dict[str, Any]) -> None:
    got = finish_map(
        ApproveAnswer(
            http=r["http"], body=r["body"], discovery_nearby=r["discoveryNearby"], keys_retried=r["keysRetried"]
        )
    )
    want = r["result"]
    if "send" in want:
        assert got.send == want["send"] and got.wait is None and not got.close
    elif "wait" in want:
        assert got.wait == want["wait"] and got.send is None and not got.close
    else:
        assert got.close is True and got.stop_advert is want["stopAdvert"]
        assert got.send is None and got.wait is None
