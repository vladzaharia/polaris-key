# @pkey-feature connect.local
"""The ``cpace`` section of ``noise-vectors.json`` (WIRE-CONTRACT-V5 §15.12, "The mode-q handshake") through
``core/peer_cpace.py`` and the Noise engine. Mirrors ``conformance/runners/node/cpaceSuites.ts``: the suite
and the draft's string functions, Elligator 2 and the generators, shares and frames, whole attempts (shares,
K, ISK, PSK), the abort rows, the two mode-q handshakes byte for byte and the failure rows."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

from polaris_key.core.peer_cpace import (
    check_share,
    cpace_generator,
    cpace_isk,
    cpace_prs_code,
    cpace_prs_qr,
    cpace_psk,
    cpace_share,
    elligator2,
    encode_c1,
    encode_c2,
    generator_string,
    lv_cat,
    parse_c1,
    parse_c2,
    prepend_len,
    transcript_ir,
)
from polaris_key.core.peer_noise import NoiseError, NoiseHandshake, NoisePorts, peer_noise_protocol, peer_prologue

_CORPUS = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
C: Dict[str, Any] = json.loads((_CORPUS / "noise-vectors.json").read_text())["cpace"]
PORTS = NoisePorts()


def _b(h: str) -> bytes:
    return bytes.fromhex(h)


def _verdict(v: Dict[str, Any]) -> Dict[str, Any]:
    if not v["ok"]:
        return {"ok": False, "reason": v["reason"]}
    out: Dict[str, Any] = {"ok": True, "share": v["share"].hex()}
    if "kind" in v:
        out["kind"] = v["kind"]
    return out


def _prs(kind: str, secret: str) -> bytes:
    return cpace_prs_code(secret) if kind == "code" else cpace_prs_qr(_b(secret))


def _side(a: Dict[str, Any], side: str) -> Tuple[str, bytes, bytes]:
    slug = a[side + "Slug"]
    sid = _b(a[side + "Sid"])
    g = cpace_generator(_prs(a["kind"], a[side + "Secret"]), peer_prologue(slug, "q"), sid)
    return slug, sid, g


def test_suite_is_pinned() -> None:
    assert C["suite"] == "CPACE-X25519-SHA512"
    assert C["dsi"] == "CPace255"
    assert C["dsiIsk"] == "CPace255_ISK"
    assert C["sInBytes"] == 128


def test_draft_string_functions() -> None:
    for a in C["anchors"]["vectors"]:
        v = a["vector"]
        for k in v.get("cases", []):
            if v["fn"] == "prepend_len":
                assert prepend_len(_b(k["in"])).hex() == k["out"], a["id"]
            elif v["fn"] == "lv_cat":
                assert lv_cat(*[_b(x) for x in k["in"]]).hex() == k["out"], a["id"]
            elif v["fn"] == "transcript_ir":
                ya, ada, yb, adb = [_b(x) for x in k["in"]]
                assert transcript_ir(ya, ada, yb, adb).hex() == k["out"], a["id"]


def test_draft_generator_transcript_and_isk() -> None:
    vec = {a["id"]: a["vector"] for a in C["anchors"]["vectors"]}
    b11, b12 = vec["B.1.1"], vec["B.1.2-B.1.5"]
    gs = generator_string(_b(b11["DSI"]), _b(b11["PRS"]), _b(b11["CI"]), _b(b11["sid"]), C["sInBytes"])
    assert gs.hex() == b11["generatorString"]
    h = hashlib.sha512(gs).digest()[:32]
    assert h.hex() == b11["hashGeneratorString"]
    assert elligator2(h).u.hex() == b11["g"]
    assert cpace_generator(_b(b11["PRS"]), _b(b11["CI"]), _b(b11["sid"])).hex() == b11["g"]
    ir = transcript_ir(_b(b12["Ya"]), _b(b12["ADa"]), _b(b12["Yb"]), _b(b12["ADb"]))
    assert ir.hex() == b12["transcriptIr"]
    inp = lv_cat(_b(b12["dsiIsk"]), _b(b11["sid"]), _b(b12["K"])) + ir
    assert inp.hex() == b12["iskInput"]
    assert hashlib.sha512(inp).hexdigest() == b12["isk"]


def test_elligator_rows() -> None:
    for r in C["elligator"]:
        out = elligator2(_b(r["input"]))
        assert out.r.hex() == r["r"], r["id"]
        assert out.on_curve is r["onCurve"], r["id"]
        assert out.u.hex() == r["u"], r["id"]


def test_generator_rows() -> None:
    for r in C["generators"]:
        prs = _prs(r["kind"], r["secret"])
        assert prs.hex() == r["prs"], r["id"]
        assert peer_prologue(r["slug"], "q").hex() == r["ci"], r["id"]
        gs = generator_string(C["dsi"].encode(), prs, _b(r["ci"]), _b(r["sid"]), C["sInBytes"])
        assert gs.hex() == r["generatorString"], r["id"]
        assert hashlib.sha512(gs).digest()[:32].hex() == r["hash"], r["id"]
        assert cpace_generator(prs, _b(r["ci"]), _b(r["sid"])).hex() == r["g"], r["id"]


def test_share_check_rows() -> None:
    for r in C["shares"]:
        v = check_share(_b(r["share"]))
        assert v["ok"] is r["want"]["ok"], r["id"]
        if not v["ok"]:
            assert v["reason"] == r["want"]["reason"], r["id"]


def test_frame_rows() -> None:
    for r in C["frames"]["c1"]:
        assert _verdict(parse_c1(_b(r["frame"]))) == r["want"], r["id"]
    for r in C["frames"]["c2"]:
        assert _verdict(parse_c2(_b(r["frame"]))) == r["want"], r["id"]


def test_whole_attempts() -> None:
    for a in C["attempts"]:
        js, jsid, jg = _side(a, "joiner")
        ss, ssid, sg = _side(a, "shower")
        assert jg.hex() == a["joinerG"], a["id"]
        assert sg.hex() == a["showerG"], a["id"]
        ya_pub = cpace_share(_b(a["ya"]), jg)
        assert ya_pub is not None
        yb_pub = ya_pub if a.get("reflect") is True else cpace_share(_b(a["yb"]), sg)
        assert yb_pub is not None
        assert ya_pub.hex() == a["Ya"], a["id"]
        assert yb_pub.hex() == a["Yb"], a["id"]
        assert encode_c1(a["kind"], ya_pub).hex() == a["c1"], a["id"]
        assert encode_c2(yb_pub).hex() == a["c2"], a["id"]
        kj = PORTS.dh(_b(a["ya"]), yb_pub)
        ks = PORTS.dh(_b(a["yb"]), ya_pub)
        assert kj is not None and ks is not None
        assert kj.hex() == a["joinerK"], a["id"]
        assert ks.hex() == a["showerK"], a["id"]
        isk_j = cpace_isk(jsid, bytearray(_b(a["ya"])), ya_pub, yb_pub, "initiator")
        isk_s = cpace_isk(ssid, bytearray(_b(a["yb"])), ya_pub, yb_pub, "responder")
        assert isk_j is not None and isk_s is not None
        assert isk_j.hex() == a["joinerIsk"], a["id"]
        assert isk_s.hex() == a["showerIsk"], a["id"]
        assert cpace_psk(isk_j, js).hex() == a["joinerPsk"], a["id"]
        assert cpace_psk(isk_s, ss).hex() == a["showerPsk"], a["id"]
        assert (isk_j == isk_s) is a["agree"], a["id"]


def test_scalar_is_overwritten() -> None:
    a = C["attempts"][0]
    _slug, sid, _g = _side(a, "joiner")
    scalar = bytearray(_b(a["ya"]))
    cpace_isk(sid, scalar, _b(a["Ya"]), _b(a["Yb"]), "initiator")
    assert not any(scalar)


def test_abort_rows() -> None:
    scalar = _b(C["abort"]["scalar"])
    for r in C["abort"]["rows"]:
        out = PORTS.dh(scalar, _b(r["u"]))
        zero = out is None or not any(out)
        if r["kAllZero"]:
            assert zero, r["id"]
        else:
            assert out is not None and out.hex() == r["k"], r["id"]
        assert (not check_share(_b(r["u"]))["ok"]) is r["shareRefused"], r["id"]
        isk = cpace_isk(bytes(10), _b(C["abort"]["scalar"]), bytes(32), _b(r["u"]), "initiator")
        assert (isk is None) is r["kAllZero"], r["id"]


def _relay(first: NoiseHandshake, second: NoiseHandshake, payloads: List[str]) -> List[bytes]:
    wires: List[bytes] = []
    frm, to = first, second
    for p in payloads:
        w = frm.write_message(_b(p))
        wires.append(w)
        assert to.read_message(w).hex() == p
        frm, to = to, frm
    return wires


@pytest.mark.parametrize("h", C["handshakes"], ids=lambda h: h["id"])
def test_handshake_byte_for_byte(h: Dict[str, Any]) -> None:
    assert peer_noise_protocol(h["mode"]) == h["protocol"]
    assert peer_prologue(h["slug"], h["mode"]).hex() == h["prologue"]
    if "attempt" in h:
        a = next(x for x in C["attempts"] if x["id"] == h["attempt"])
        assert a["joinerPsk"] == h["psk"]
        assert a["joinerIsk"] == h["isk"]
    keys = {"initiator": (h["initStatic"], h["initEphemeral"]), "responder": (h["respStatic"], h["respEphemeral"])}

    def mk(role: str) -> NoiseHandshake:
        s, e = keys[role]
        return NoiseHandshake(role, h["protocol"], _b(h["prologue"]), _b(s), psk=_b(h["psk"]), ephemeral_key=_b(e))

    i, r = mk("initiator"), mk("responder")
    msgs = [m for m in h["messages"] if m["kind"] == "handshake"]
    wires = _relay(i, r, [m["payload"] for m in msgs])
    for k, w in enumerate(wires):
        assert w.hex() == msgs[k]["ciphertext"], "%s message %d" % (h["id"], k)
    assert bytes(i.handshake_hash).hex() == h["handshakeHash"]
    assert bytes(r.handshake_hash).hex() == h["handshakeHash"]
    ti, tr = i.transport(), r.transport()
    for m in [x for x in h["messages"] if x["kind"] == "transport"][:1]:
        ct = ti.send.encrypt(b"", _b(m["payload"]))
        assert ct.hex() == m["ciphertext"]
        assert tr.receive.decrypt(b"", ct).hex() == m["payload"]


class _SwapPublic(NoisePorts):
    def __init__(self, priv_hex: str, pub: bytes) -> None:
        self._priv = _b(priv_hex)
        self._pub = pub

    def public_key(self, private_key: bytes) -> bytes:
        return self._pub if bytes(private_key) == self._priv else super().public_key(private_key)


@pytest.mark.parametrize("f", C["failures"], ids=lambda f: f["id"])
def test_failure_rows(f: Dict[str, Any]) -> None:
    def mk(role: str, prologue: str, psk: str, static: str, eph: str) -> NoiseHandshake:
        ports: Optional[NoisePorts] = None
        if role == "initiator" and f.get("initEphemeralPublic") is not None:
            ports = _SwapPublic(eph, _b(f["initEphemeralPublic"]))
        return NoiseHandshake(
            role, f["protocol"], _b(prologue), _b(static), psk=_b(psk), ephemeral_key=_b(eph), ports=ports
        )

    i = mk("initiator", f["prologue"], f["psk"], f["initStatic"], f["initEphemeral"])
    r = mk(
        "responder",
        f.get("responderPrologue", f["prologue"]),
        f.get("responderPsk", f["psk"]),
        f["respStatic"],
        f["respEphemeral"],
    )
    failure: Optional[Tuple[int, str]] = None
    for idx, p in enumerate(f["payloads"]):
        w, d = (i, r) if idx % 2 == 0 else (r, i)
        try:
            msg = w.write_message(_b(p))
            assert d.read_message(msg).hex() == p
        except NoiseError as e:
            failure = (idx, e.code)
            break
    assert failure == (f["failedAt"], f["reason"])
