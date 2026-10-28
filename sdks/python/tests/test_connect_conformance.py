# @pkey-feature connect.identity
"""``cases.json`` sections ``peerCertCases``, ``ringCases`` and ``peerAdmissionCases`` (WIRE-CONTRACT-V5
§15.2, §15.3) through the Python verifiers. Mirrors the Node runner's Cloud Connect suites."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.core.peer_cert import (
    PeerSession,
    admit_peer,
    replace_ring,
    ring_expired,
    verify_peer_cert,
    verify_ring,
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
