# @pkey-feature connect.local
"""The ``local`` section of ``peer-matrix.json`` (WIRE-CONTRACT-V5 §15.12, account-free local pairing) through
``core/peer_local.py`` and the codecs it builds on. Mirrors ``conformance/runners/node/localSuites.ts``: the
constants, the code, the QR, the adverts, the TXT parsers, the ``LOCAL_LINK`` body, the link secret, the
handshake payloads, the window, the join plan and its dial budget (with the nameplate memory, the renewal floor
and the join reasons of CC-29.15), the exchange guard, the pin, the listener's
trial order, the record rules and the gate, and the ``admission`` rows of a listener that holds no account key.
The ``local.xfer`` rows run in ``test_connect_xfer_conformance.py``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest

from polaris_key.core import peer_local as L
from polaris_key.core.peer_advert import base32_lower, parse_txt
from polaris_key.core.peer_frame import RECORD_TYPES, PeerRecord, RecordAssembler
from polaris_key.core.peer_payload import caps_intersection, parse_handshake_payload
from polaris_key.core.peer_session import LOCAL_GROUP_PER_MINUTE, HandshakeLimiter

_CORPUS = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
M: Dict[str, Any] = json.loads((_CORPUS / "peer-matrix.json").read_text())["local"]


def _ids(rows: List[Dict[str, Any]]) -> List[str]:
    return [r["id"] for r in rows]


def _stream(hex_bytes: str) -> Tuple[Callable[[int], Optional[bytes]], Callable[[], int]]:
    data = bytes.fromhex(hex_bytes)
    at = [0]

    def source(n: int) -> Optional[bytes]:
        if at[0] + n > len(data):
            return None
        out = data[at[0] : at[0] + n]
        at[0] += n
        return out

    return source, lambda: at[0]


def _body(r: Dict[str, Any]) -> bytes:
    if "bodyHex" in r:
        return bytes.fromhex(r["bodyHex"])
    if "bodyPad" in r:
        p = r["bodyPad"]
        return (p["prefix"] + p["fill"] * p["count"] + p["suffix"]).encode("utf-8")
    return r["body"].encode("utf-8")


def _reader(c: List[float]) -> Callable[[], float]:
    return lambda: c[0]


def test_admission_rows() -> None:
    c = M["constants"]
    assert c["admissionGroupPerMinute"] == LOCAL_GROUP_PER_MINUTE
    for r in M["admission"]:
        clock = [0.0]
        lim = HandshakeLimiter(
            c["admissionSharedPerMinute"],
            c["admissionWaiting"],
            _reader(clock),
            c["admissionGroupPerMinute"],
        )
        holds: Dict[int, Callable[[], None]] = {}
        verdicts: Dict[int, Any] = {}
        got: List[Dict[str, Any]] = []
        for i, e in enumerate(r["events"]):
            clock[0] = e["t"]
            if "settle" in e:
                a0 = verdicts.pop(e["settle"])
                opens = r["events"][e["settle"]]["opens"]
                if opens:
                    holds[e["settle"]] = a0.hit()
                else:
                    a0.miss()
                got.append({"result": "settled", "hit": opens})
                continue
            if "release" in e:
                f = holds.pop(e["release"], None)
                if f is not None:
                    f()
                got.append({"result": "released"})
                continue
            a = lim.begin_local(e["group"])
            if not a.ok:
                got.append({"result": "refused", "by": a.by})
                continue
            if e.get("later"):
                verdicts[i] = a
                got.append({"result": "tried"})
                continue
            if e["opens"]:
                holds[i] = a.hit()
            else:
                a.miss()
            got.append({"result": "tried", "hit": e["opens"]})
        want = [{k: v for k, v in w.items() if k not in ("group", "failed", "waiting")} for w in r["want"]]
        assert got == want, r["id"]


def test_the_dial_budget_keeps_no_empty_key() -> None:
    b = L.DialBudget()
    b.spend("12", 0.0, 2)
    assert b.check("12", 1.0) == {"allowed": False, "used": 2}
    assert b.check("12", 1.0e6) == {"allowed": True, "used": 0}
    assert b._dialled == {}
    assert b.check("77", 0.0)["used"] == 0 and b._dialled == {}


def test_constants_match() -> None:
    c = M["constants"]
    assert c["pairSeconds"] == L.LOCAL_PAIR_SECONDS
    assert c["codeDigits"] == M["codes"]["digits"] == L.LOCAL_CODE_DIGITS
    assert c["pairFailures"] == L.LOCAL_PAIR_FAILURES
    assert c["qrSecretBytes"] == L.LOCAL_QR_SECRET_BYTES == M["qr"]["secretBytes"]
    assert c["joinCandidates"] == L.LOCAL_JOIN_CANDIDATES
    assert c["joinBrowseSeconds"] == L.LOCAL_JOIN_BROWSE_SECONDS
    assert c["maxLinks"] == L.MAX_LOCAL_LINKS == M["adverts"]["maxLinks"]
    assert c["maxLiveAdverts"] == L.MAX_LIVE_LOCAL_ADVERTS == M["adverts"]["maxLive"]
    assert c["maxLinkSecrets"] == L.MAX_LINK_SECRETS == c["maxContactSecrets"] + c["maxLinks"]
    assert c["bodyMax"] == L.LOCAL_LINK_BODY_MAX
    assert M["adverts"]["epochSeconds"] == 900


def test_codes() -> None:
    for r in M["codes"]["nameplate"]:
        src, consumed = _stream(r["stream"])
        assert L.draw_nameplate(src, r["inUse"]) == r["want"]["nameplate"], r["id"]
        assert consumed() == r["want"]["consumed"], r["id"]
    for r in M["codes"]["password"]:
        src, consumed = _stream(r["stream"])
        assert L.draw_password(src) == r["want"]["password"], r["id"]
        assert consumed() == r["want"]["consumed"], r["id"]
    for r in M["codes"]["display"]:
        assert L.display_code(r["nameplate"], r["password"]) == r["want"], r["id"]
    for r in M["codes"]["parse"]:
        got = L.parse_code(r["text"])
        assert got["ok"] is r["want"]["ok"], r["id"]
        if got["ok"]:
            assert (got["nameplate"], got["password"]) == (r["want"]["nameplate"], r["want"]["password"]), r["id"]


def test_qr() -> None:
    for r in M["qr"]["make"]:
        assert L.pairing_instance(bytes.fromhex(r["sid"])) == r["instance"], r["id"]
        assert L.make_qr(r["slug"], r["instance"], bytes.fromhex(r["secret"])) == r["want"], r["id"]
    for r in M["qr"]["parse"]:
        got = L.parse_qr(r["text"], r["own"])
        assert got["result"] == r["want"]["result"], r["id"]
        if got["result"] == "ok":
            assert got["slug"] == r["want"]["slug"], r["id"]
            assert got["instance"] == r["want"]["instance"], r["id"]
            assert base32_lower(got["secret"]) == r["want"]["secret"], r["id"]


def test_adverts() -> None:
    for r in M["adverts"]["pairing"]:
        assert L.pairing_instance(bytes.fromhex(r["sid"])) == r["instance"], r["id"]
    for r in M["adverts"]["names"]:
        got = L.local_instance(bytes.fromhex(r["secret"]), bytes.fromhex(r["ownLinkKey"]), r["epoch"])
        assert got == r["instance"], r["id"]
    for r in M["adverts"]["browse"]:
        links = [L.LocalLinkKey(bytes.fromhex(k["secret"]), bytes.fromhex(k["peerKey"])) for k in r["links"]]
        assert L.browse_local_instance(r["instance"], links, r["now"]) == r["want"], r["id"]


def test_txt() -> None:
    for r in M["txt"]:
        got = parse_txt(r["entries"]) if r["parser"] == "txt" else L.parse_local_txt(r["entries"])
        assert got == r["want"], r["id"]


def test_body() -> None:
    for r in M["body"]:
        b = _body(r)
        assert len(b) == r["length"], r["id"]
        got = L.parse_local_link(b)
        assert got["ok"] is r["want"]["ok"], r["id"]
        if got["ok"]:
            assert got.get("label") == r["want"].get("label"), r["id"]
            assert got["cats"] == r["want"]["cats"], r["id"]
            # What a side builds, the peer reads back.
            again = L.parse_local_link(L.build_local_link(got["cats"], got.get("label")))
            assert again == got, r["id"]


def test_secrets() -> None:
    for r in M["secrets"]:
        got = L.local_link_secret(
            bytes.fromhex(r["h"]), bytes.fromhex(r["isk"]), bytes.fromhex(r["keyA"]), bytes.fromhex(r["keyB"])
        )
        assert got.hex() == r["secret"], r["id"]


def test_handshake_payloads() -> None:
    for r in M["handshakePayloads"]["payloads"]:
        b = bytes.fromhex(r["payloadHex"]) if "payloadHex" in r else r["payload"].encode("utf-8")
        assert len(b) == r["length"], r["id"]
        got = parse_handshake_payload(r["mode"], r["message"], b)
        assert got.ok is r["want"]["ok"], r["id"]
        if got.ok and "caps" in r["want"]:
            assert got.caps == r["want"]["caps"], r["id"]
    for r in M["handshakePayloads"]["negotiate"]:
        got = L.negotiate_local_caps(r["mode"], r["local"], r["remote"])
        assert got["caps"] == r["want"]["caps"], r["id"]
        assert got.get("close") == r["want"].get("close"), r["id"]
        assert caps_intersection(r["local"], r["remote"]) == got["caps"], r["id"]


@pytest.mark.parametrize("r", M["window"], ids=_ids(M["window"]))
def test_window(r: Dict[str, Any]) -> None:
    w = L.PairingWindow()
    last = 0
    got: List[Dict[str, Any]] = []
    for s in r["steps"]:
        t = s.get("t", 0)
        ident = s.get("id", last)
        out: Dict[str, Any] = {}
        ev = s["event"]
        if ev == "open":
            out = w.open(t)
        elif ev == "c1":
            out = w.c1(t, s["valid"])
            if "id" in out:
                last = out["id"]
        elif ev == "begin-guess":
            out = {"result": "permit" if w.begin_guess(ident, t) else "denied"}
        elif ev == "msg1":
            out = w.msg1(ident, t, s["opens"]) or {"result": "denied"}
        elif ev == "guess-opened":
            out = w.guess_opened(ident, t)
        elif ev == "guess-failed":
            out = w.guess_failed(ident, t)
        elif ev == "abandon":
            out = w.abandon(ident, t)
        elif ev == "rotated":
            w.rotated(t)
        elif ev == "session-end":
            out = w.session_end(t, s["stored"])
        elif ev == "tick":
            w.tick(t)
        elif ev == "close":
            out = w.close(t)
        else:
            raise AssertionError("%s: event %s" % (r["id"], ev))
        row: Dict[str, Any] = {}
        for k in ("result", "id"):
            if k in out:
                row[k] = out[k]
        row.update(w.state)
        if "host" in out:
            row["host"] = out["host"]
        got.append(row)
    assert got == r["want"]


@pytest.mark.parametrize("r", M["joinBudget"], ids=_ids(M["joinBudget"]))
def test_join_budget(r: Dict[str, Any]) -> None:
    budget = L.DialBudget()
    got: List[Dict[str, Any]] = []
    for j in r["joins"]:
        if j["input"]["kind"] == "qr":
            got.append({"allowed": True, "used": 0})
            continue
        verdict = budget.check(j["input"]["nameplate"], j["t"])
        if verdict["allowed"]:
            budget.spend(j["input"]["nameplate"], j["t"], j["dials"])
        got.append(verdict)
    assert got == r["want"]


@pytest.mark.parametrize("r", M["join"], ids=_ids(M["join"]))
def test_join(r: Dict[str, Any]) -> None:
    plan = L.JoinPlan(r["input"])
    for a in r["adverts"]:
        plan.see(a["instance"], a["h"] in ("current", "previous"), a["n"])
    dialled: List[str] = []
    for outcome in r["dials"]:
        nxt = plan.next()
        if nxt is None:
            break
        dialled.append(nxt)
        plan.ended(outcome)
    assert {"browsed": plan.browses, "kept": plan.kept, "dialled": dialled, "result": plan.result()} == r["want"]


@pytest.mark.parametrize("r", M["nameplateMemory"]["rows"], ids=_ids(M["nameplateMemory"]["rows"]))
def test_nameplate_memory(r: Dict[str, Any]) -> None:
    assert M["nameplateMemory"]["seconds"] == L.LOCAL_DIAL_BUDGET_SECONDS
    memory = L.NameplateMemory()
    got: List[Dict[str, Any]] = []
    for e in r["events"]:
        if "shown" in e:
            memory.shown(e["shown"], e["t"])
            continue
        source, consumed = _stream(e["draw"])
        got.append({"nameplate": memory.draw(source, e["t"]), "consumed": consumed()})
    assert got == r["want"]


def test_renew_floor_constants() -> None:
    f = M["renewFloor"]
    assert [f["cooldownSeconds"], f["wrongSeconds"], f["wrongLimit"]] == [
        L.LOCAL_RENEW_COOLDOWN_SECONDS,
        L.LOCAL_RENEW_WRONG_SECONDS,
        L.LOCAL_RENEW_WRONG_LIMIT,
    ]


@pytest.mark.parametrize("r", M["renewFloor"]["rows"], ids=_ids(M["renewFloor"]["rows"]))
def test_renew_floor(r: Dict[str, Any]) -> None:
    floor = L.RenewFloor()
    got: List[Dict[str, Any]] = []
    for e in r["events"]:
        if "ended" in e:
            floor.ended(e["ended"], e["t"])
        else:
            got.append(floor.check(e["t"]))
    assert got == r["want"]


def test_join_reasons_precedence() -> None:
    assert M["joinReasons"]["precedence"] == ["invalid", "other-app", "spent-at-start", "wrong", "spent-mid-join"]


@pytest.mark.parametrize("r", M["joinReasons"]["rows"], ids=_ids(M["joinReasons"]["rows"]))
def test_join_reasons(r: Dict[str, Any]) -> None:
    plan = L.JoinPlan(r["input"])
    if r["input"]["kind"] == "code":
        budget = L.DialBudget()
        budget.spend(r["input"]["nameplate"], 0.0, r["budget"])
        if not budget.check(r["input"]["nameplate"], 1.0)["allowed"]:
            plan.start_spent()
    # Two matching adverts, so a plan that browses has a dial for each outcome.
    for n in ("a", "b"):
        instance = r["input"]["instance"] if r["input"]["kind"] == "qr" else "p1-" + n
        nameplate = r["input"]["nameplate"] if r["input"]["kind"] == "code" else "00"
        plan.see(instance, True, nameplate)
    for outcome in r["dials"]:
        if plan.next() is None:
            break
        plan.ended(outcome)
    assert {"result": plan.result(), "reason": plan.reason()} == r["want"]


def test_dials_left_reads_two_digits_only() -> None:
    b = L.DialBudget()
    assert [L.dials_left(b, t, 0.0) for t in ("", "4", "ab12", "4 -", "４８")] == [None] * 5
    assert L.dials_left(b, " 4-8 12 34", 0.0) == 2
    b.spend("48", 0.0, 1)
    assert [L.dials_left(b, "48", 1.0), L.dials_left(b, "49", 1.0), b.left("48", 1.0)] == [1, 2, 1]
    assert L.dials_left(b, "48", 300.0) == 2


@pytest.mark.parametrize("r", M["exchange"], ids=_ids(M["exchange"]))
def test_exchange(r: Dict[str, Any]) -> None:
    x = L.LocalExchange(r["held"], r["cats"])
    got = []
    for s in r["steps"]:
        e: Dict[str, Any] = {"event": s["event"]}
        if s["event"] == "peer-link":
            e["body"] = s["body"].encode("utf-8")
        got.append(x.step(e))
    assert got == r["want"]


def test_pin() -> None:
    for r in M["pin"]:
        if r["mode"] == "l":
            ok = L.local_pin(bytes.fromhex(r["held"][r["matched"]]), bytes.fromhex(r["remoteStatic"]))
            got: Dict[str, Any] = {"ok": ok} if ok else {"ok": ok, "close": "peer_revoked", "sends": 0}
            assert got == r["want"], r["id"]
        else:
            ok = L.pairing_remote_ok(bytes.fromhex(r["own"]), bytes.fromhex(r["remoteStatic"]))
            got2: Dict[str, Any] = {"ok": ok} if ok else {"ok": ok, "close": "silent", "sends": 0}
            assert got2 == r["want"], r["id"]
        # The initiator asks after message 2, the responder after message 3.
        assert r["checkedAfter"] == (2 if r["role"] == "initiator" else 3), r["id"]


def test_trial_order() -> None:
    for r in M["trialOrder"]:
        plan = L.listener_trial_order(r["account"], len(r["contacts"]), len(r["locals"]))
        tried: List[str] = []
        hit: Optional[str] = None
        close: Optional[str] = None
        asked = False
        for e in plan:
            if e.kind != "a" and not asked:
                # The contact limiter admits the secret trial once; a refusal tries no secret.
                asked = True
                if r["limiter"] == "refuse":
                    close = "peer_busy"
                    break
            name = "%s:%d" % (e.kind, e.at)
            tried.append(name)
            o = r["opens"]
            if o is not None and o["mode"] == e.kind:
                idx = o.get("key") if o["mode"] == "a" else o.get("contact") if o["mode"] == "c" else o.get("link")
                if idx == e.at:
                    hit = name
                    break
        if hit is None and close is None:
            close = "handshake_failed"
        behind = len(r["contacts"]) + len(r["locals"]) > 0
        assert {
            "tried": tried,
            "hit": hit,
            "slot": hit is not None and hit[0] != "a",
            "close": close,
            "dummy": L.trial_padding(len(tried)) if close == "handshake_failed" and behind else 0,
        } == r["want"], r["id"]
    assert M["constants"]["maxLinkSecrets"] == L.MAX_LINK_SECRETS


def test_records() -> None:
    for r in M["records"]:
        t = int(r["type"], 16)
        body = bytes(8 if t in (0x0004, 0x0005) else 0)
        got = RecordAssembler(r["mode"]).push(PeerRecord(t, 0, body))
        w = r["want"]
        if w.get("ignored") is True:
            assert got.kind == "ignored", r["id"]
        elif w.get("allowed") is True:
            assert got.kind == "message", r["id"]
            row = next(x for x in RECORD_TYPES if x.start <= t <= x.end)
            assert row.name == w["name"], r["id"]
            assert row.needs == w.get("needs"), r["id"]
        else:
            assert (got.kind, got.code) == ("close", w["close"]), r["id"]


@pytest.mark.parametrize("r", M["gate"], ids=_ids(M["gate"]))
def test_gate(r: Dict[str, Any]) -> None:
    g = L.LocalPairingGate(r["start"])
    gated = set(L.GATED_CALLS)
    got: List[Dict[str, Any]] = []
    for s in r["steps"]:
        if "call" in s:
            got.append({"cached": g.state, "call": g.check() if s["call"] in gated else "ok"})
            continue
        if s["read"] == "ok":
            effects = g.read_ok(s.get("body"))
        elif s["read"] == "not-found":
            effects = g.read_not_found()
        else:
            effects = g.read_error()
        row: Dict[str, Any] = {"cached": g.state}
        if effects:
            row["effects"] = effects
        got.append(row)
    assert got == r["want"]
