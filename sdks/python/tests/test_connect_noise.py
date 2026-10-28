# @pkey-feature connect.noise
"""``noise-vectors.json`` and the ``prologue`` and ``psk`` rows of ``peer-matrix.json`` (WIRE-CONTRACT-V5
§15.5, §15.6) through the Python Noise engine. Mirrors ``conformance/runners/node/noiseVectors.test.ts``:
the X25519 and AES-256-GCM known answers, the low-order points, the three handshake modes byte for byte
with rekey, the 15 failure rows and the external anchors."""

from __future__ import annotations

import hashlib
import pickle
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import json

import pytest

from polaris_key.core.device_proof import is_x25519_low_order
from polaris_key.core.peer_noise import (
    CipherState,
    NoiseError,
    NoiseHandshake,
    NoisePorts,
    peer_noise_protocol,
    peer_prologue,
    peer_psk,
)

_CORPUS = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
V: Dict[str, Any] = json.loads((_CORPUS / "noise-vectors.json").read_text())
M: Dict[str, Any] = json.loads((_CORPUS / "peer-matrix.json").read_text())
NONE = b""
PORTS = NoisePorts()


class _SwapPublic(NoisePorts):
    """The reference swaps the initiator's message-1 public key before it mixes it; so does this."""

    def __init__(self, priv_hex: str, pub: bytes) -> None:
        self._priv = bytes.fromhex(priv_hex)
        self._pub = pub

    def public_key(self, private_key: bytes) -> bytes:
        return self._pub if bytes(private_key) == self._priv else super().public_key(private_key)


def _run(
    protocol: str,
    init: Dict[str, Any],
    resp: Dict[str, Any],
    payloads: List[bytes],
    swap: Optional[bytes] = None,
) -> Tuple[List[bytes], Optional[Tuple[int, str]], NoiseHandshake, NoiseHandshake]:
    def mk(role: str, s: Dict[str, Any]) -> NoiseHandshake:
        return NoiseHandshake(
            role,
            protocol,
            bytes.fromhex(s["prologue"]),
            bytes.fromhex(s.get("static") or "00" * 32),
            psk=bytes.fromhex(s["psk"]) if s.get("psk") else None,
            ephemeral_key=bytes.fromhex(s["ephemeral"]),
            ports=_SwapPublic(s["ephemeral"], swap) if role == "initiator" and swap is not None else None,
        )

    i, r = mk("initiator", init), mk("responder", resp)
    wire: List[bytes] = []
    for idx, p in enumerate(payloads):
        w, d = (i, r) if idx % 2 == 0 else (r, i)
        try:
            msg = w.write_message(p)
            wire.append(msg)
            assert d.read_message(msg) == p
        except NoiseError as e:
            return wire, (idx, e.code), i, r
    return wire, None, i, r


def _vector(h: Dict[str, Any], msgs: List[Dict[str, Any]]) -> Any:
    def side(own: str) -> Dict[str, Any]:
        return {
            "prologue": h["prologue"],
            "psk": h.get("psk"),
            "static": h["initStatic" if own == "init" else "respStatic"],
            "ephemeral": h["initEphemeral" if own == "init" else "respEphemeral"],
        }

    return _run(h["protocol"], side("init"), side("resp"), [bytes.fromhex(m["payload"]) for m in msgs])


def test_is_noise_vectors_version_1() -> None:
    assert V["noiseVectorsVersion"] == 1


def test_x25519_scalar_mult() -> None:
    for c in V["x25519"]["scalarMult"]:
        out = PORTS.dh(bytes.fromhex(c["scalar"]), bytes.fromhex(c["u"]))
        assert (out.hex() if out else None) == c["expect"], c["id"]


def test_x25519_agreement_and_public_keys() -> None:
    for c in V["x25519"]["agreement"]:
        a, b = bytes.fromhex(c["alicePrivate"]), bytes.fromhex(c["bobPrivate"])
        assert PORTS.public_key(a).hex() == c["alicePublic"]
        assert PORTS.public_key(b).hex() == c["bobPublic"]
        assert PORTS.dh(a, bytes.fromhex(c["bobPublic"])) == bytes.fromhex(c["shared"])
        assert PORTS.dh(b, bytes.fromhex(c["alicePublic"])) == bytes.fromhex(c["shared"])


def test_low_order_points_are_classified_and_refused() -> None:
    scalar = bytes.fromhex(V["lowOrder"]["scalar"])
    assert len(V["lowOrder"]["rows"]) == 17
    for r in V["lowOrder"]["rows"]:
        u = bytes.fromhex(r["u"])
        assert is_x25519_low_order(u) is r["lowOrder"], r["id"]
        out = PORTS.dh(scalar, u)
        if r["allZero"]:
            assert out is None or not any(out), r["id"]
        else:
            assert out is not None and out.hex() == r["output"], r["id"]


def test_aes_gcm_known_answers_and_a_flipped_bit_fails() -> None:
    assert len(V["aesGcm"]) == 4
    for c in V["aesGcm"]:
        key, nonce, aad = bytes.fromhex(c["key"]), bytes.fromhex(c["nonce"]), bytes.fromhex(c["aad"])
        sealed = PORTS.seal(key, nonce, aad, bytes.fromhex(c["plaintext"]))
        assert sealed.hex() == c["ciphertext"] + c["tag"], c["id"]
        opened = PORTS.open(key, nonce, aad, sealed)
        assert opened is not None and opened.hex() == c["plaintext"], c["id"]
        bad = bytearray(sealed)
        bad[-1] ^= 1
        assert PORTS.open(key, nonce, aad, bytes(bad)) is None, c["id"]


@pytest.mark.parametrize("h", V["handshakes"], ids=[h["id"] for h in V["handshakes"]])
def test_handshake_byte_for_byte_with_rekey(h: Dict[str, Any]) -> None:
    assert peer_noise_protocol(h["mode"]) == h["protocol"]
    assert peer_prologue(h["slug"], h["mode"]).hex() == h["prologue"]
    if h.get("psk"):
        k_disc = hashlib.sha256(b"pkey-peer/1 noise vector k_disc").digest()
        assert peer_psk(k_disc, h["slug"]).hex() == h["psk"]
    hs = [m for m in h["messages"] if m["kind"] == "handshake"]
    wire, failure, i, r = _vector(h, hs)
    assert failure is None
    for k, w in enumerate(wire):
        assert w.hex() == hs[k]["ciphertext"], "message %d" % k
    assert i.handshake_hash.hex() == h["handshakeHash"] == r.handshake_hash.hex()
    assert i.remote_static is not None and i.remote_static.hex() == h["respStaticPublic"]
    assert r.remote_static is not None and r.remote_static.hex() == h["initStaticPublic"]
    ti, tr = i.transport(), r.transport()
    for m in (x for x in h["messages"] if x["kind"] == "transport"):
        src, dst = (ti, tr) if m["from"] == "i" else (tr, ti)
        ct = src.send.encrypt(NONE, bytes.fromhex(m["payload"]))
        assert ct.hex() == m["ciphertext"], "record %d" % m["index"]
        assert dst.receive.decrypt(NONE, ct).hex() == m["payload"]
        if m.get("rekeyAfter"):
            src.send.rekey()
            dst.receive.rekey()


@pytest.mark.parametrize("h", V["handshakes"], ids=[h["id"] for h in V["handshakes"]])
def test_a_tampered_or_replayed_record_fails_and_does_not_advance(h: Dict[str, Any]) -> None:
    _, _, i, r = _vector(h, [m for m in h["messages"] if m["kind"] == "handshake"])
    ti, tr = i.transport(), r.transport()
    ct = ti.send.encrypt(NONE, b"\x01\x02")
    bad = bytearray(ct)
    bad[0] ^= 1
    with pytest.raises(NoiseError) as e:
        tr.receive.decrypt(NONE, bytes(bad))
    assert e.value.code == "decrypt"
    assert tr.receive.decrypt(NONE, ct) == b"\x01\x02"
    with pytest.raises(NoiseError) as e2:
        tr.receive.decrypt(NONE, ct)
    assert e2.value.code == "decrypt"


def test_the_three_modes_cover_a_v_and_p() -> None:
    assert sorted(h["mode"] for h in V["handshakes"]) == ["a", "p", "v"]


@pytest.mark.parametrize("f", V["failures"], ids=[f["id"] for f in V["failures"]])
def test_failure_rows(f: Dict[str, Any]) -> None:
    rp = f.get("responderPsk") or f.get("psk")
    _, failure, i, _r = _run(
        f["protocol"],
        {"prologue": f["prologue"], "psk": f.get("psk"), "static": f["initStatic"], "ephemeral": f["initEphemeral"]},
        {
            "prologue": f.get("responderPrologue") or f["prologue"],
            "psk": rp,
            "static": f["respStatic"],
            "ephemeral": f["respEphemeral"],
        },
        [bytes.fromhex(p) for p in f["payloads"]],
        bytes.fromhex(f["initEphemeralPublic"]) if f.get("initEphemeralPublic") else None,
    )
    assert failure == (f["failedAt"], f["reason"])
    # A dead handshake refuses further use.
    with pytest.raises(NoiseError):
        i.write_message(b"")


def test_covers_the_15_failure_rows() -> None:
    assert len(V["failures"]) == 15


def test_a_raised_exchange_and_an_all_zero_output_both_refuse_with_dh_zero() -> None:
    row = V["handshakes"][1]  # v: the responder reads message 1, then writes the DH in message 2

    class Raises(NoisePorts):
        def dh(self, private_key: bytes, public_key: bytes) -> Optional[bytes]:
            raise ValueError("backend refused")

    class Zeros(NoisePorts):
        def dh(self, private_key: bytes, public_key: bytes) -> Optional[bytes]:
            return bytes(32)

    for ports in (Raises(), Zeros()):
        r = NoiseHandshake(
            "responder",
            row["protocol"],
            bytes.fromhex(row["prologue"]),
            bytes.fromhex(row["respStatic"]),
            ephemeral_key=bytes.fromhex(row["respEphemeral"]),
            ports=ports,
        )
        i = NoiseHandshake(
            "initiator",
            row["protocol"],
            bytes.fromhex(row["prologue"]),
            bytes.fromhex(row["initStatic"]),
            ephemeral_key=bytes.fromhex(row["initEphemeral"]),
        )
        r.read_message(i.write_message(b"x"))
        with pytest.raises(NoiseError) as e:
            r.write_message(b"y")
        assert e.value.code == "dh_zero"
        with pytest.raises(NoiseError) as e2:
            r.write_message(b"y")
        assert e2.value.code == "state"


def test_a_key_port_stands_in_for_the_static_key() -> None:
    h = V["handshakes"][1]
    calls: List[bytes] = []

    class Port:
        def public_key(self) -> bytes:
            return bytes.fromhex(h["respStaticPublic"])

        def dh(self, remote: bytes) -> Optional[bytes]:
            calls.append(remote)
            return PORTS.dh(bytes.fromhex(h["respStatic"]), remote)

    hs = [m for m in h["messages"] if m["kind"] == "handshake"]
    i = NoiseHandshake(
        "initiator", h["protocol"], bytes.fromhex(h["prologue"]), bytes.fromhex(h["initStatic"]),
        ephemeral_key=bytes.fromhex(h["initEphemeral"]),
    )
    r = NoiseHandshake(
        "responder", h["protocol"], bytes.fromhex(h["prologue"]), Port(),
        ephemeral_key=bytes.fromhex(h["respEphemeral"]),
    )
    for k, m in enumerate(hs):
        w, d = (i, r) if k % 2 == 0 else (r, i)
        ct = w.write_message(bytes.fromhex(m["payload"]))
        assert ct.hex() == m["ciphertext"]
        d.read_message(ct)
    assert len(calls) == 1  # only `es` (message 2) uses the responder static


def test_the_engine_refuses_misuse() -> None:
    p = "Noise_XX_25519_AESGCM_SHA256"
    pro, s = b"p", bytes(range(1, 33))
    with pytest.raises(NoiseError) as e:
        NoiseHandshake("initiator", p, pro, s, psk=bytes(32))  # a PSK on plain XX
    assert e.value.code == "bad_key"
    with pytest.raises(NoiseError) as e0:
        NoiseHandshake("initiator", p, pro, s, ephemeral_key=b"short")
    assert e0.value.code == "bad_key"
    with pytest.raises(NoiseError):
        NoiseHandshake("initiator", p, pro, b"short")
    with pytest.raises(NoiseError):
        NoiseHandshake("initiator", "Noise_NN_25519_AESGCM_SHA256", pro, s)
    with pytest.raises(NoiseError):
        NoiseHandshake("initiator", "Noise_XXpsk0_25519_AESGCM_SHA256", pro, s)  # XXpsk0 needs a PSK
    h = NoiseHandshake("initiator", p, pro, s)
    with pytest.raises(NoiseError) as e3:
        h.read_message(b"x" * 32)  # not the initiator's turn
    assert e3.value.code == "state"
    h = NoiseHandshake("initiator", p, pro, s)
    with pytest.raises(NoiseError):
        _ = h.handshake_hash
    with pytest.raises(NoiseError):
        h.transport()
    with pytest.raises(NoiseError):
        peer_psk(b"short", "demo")
    # a message over the 65,535 byte bound
    r = NoiseHandshake("responder", p, pro, s)
    with pytest.raises(NoiseError) as e4:
        r.read_message(bytes(65536))
    assert e4.value.code == "malformed"


def test_the_cipher_refuses_a_short_ciphertext_and_an_oversize_plaintext() -> None:
    c = CipherState(bytes(32))
    with pytest.raises(NoiseError) as e:
        c.decrypt(NONE, bytes(15))
    assert e.value.code == "malformed"
    with pytest.raises(NoiseError) as e2:
        c.encrypt(NONE, bytes(65536 - 15))
    assert e2.value.code == "malformed"
    assert len(c.encrypt(NONE, bytes(65535 - 16))) == 65535


def test_prologue_rows() -> None:
    assert len(M["prologue"]) == 6
    for r in M["prologue"]:
        assert peer_prologue(r["slug"], r["mode"]).hex() == r["prologue"]


def test_psk_rows() -> None:
    assert len(M["psk"]) == 4
    for r in M["psk"]:
        assert peer_psk(bytes.fromhex(r["kDisc"]), r["slug"]).hex() == r["psk"]


def test_anchors_from_independent_implementations() -> None:
    ran = 0
    for a in V["anchors"]["vectors"]:
        v = a["vector"]
        if v["protocol_name"] != "Noise_XX_25519_AESGCM_SHA256":
            continue  # the engine implements XX only; NNpsk0 anchors the reference
        ran += 1
        wire, failure, i, r = _run(
            v["protocol_name"],
            {"prologue": v["init_prologue"], "static": v["init_static"], "ephemeral": v["init_ephemeral"]},
            {"prologue": v["resp_prologue"], "static": v["resp_static"], "ephemeral": v["resp_ephemeral"]},
            [bytes.fromhex(m["payload"]) for m in v["messages"][:3]],
        )
        assert failure is None
        for k, w in enumerate(wire):
            assert w.hex() == v["messages"][k]["ciphertext"], "message %d" % k
        if v.get("handshake_hash"):
            assert i.handshake_hash.hex() == v["handshake_hash"]
        ti, tr = i.transport(), r.transport()
        for k in range(3, len(v["messages"])):
            src, dst = (ti, tr) if k % 2 == 0 else (tr, ti)
            ct = src.send.encrypt(NONE, bytes.fromhex(v["messages"][k]["payload"]))
            assert ct.hex() == v["messages"][k]["ciphertext"], "message %d" % k
            assert dst.receive.decrypt(NONE, ct).hex() == v["messages"][k]["payload"]
    assert ran == 2


def test_nothing_secret_shows_in_a_repr_or_a_pickle() -> None:
    h = NoiseHandshake("initiator", "Noise_XX_25519_AESGCM_SHA256", b"p", bytes(range(1, 33)))
    for obj in (h, CipherState(bytes(range(32)))):
        assert "0102" not in repr(obj).lower() and len(repr(obj)) < 30
        with pytest.raises(TypeError):
            pickle.dumps(obj)
