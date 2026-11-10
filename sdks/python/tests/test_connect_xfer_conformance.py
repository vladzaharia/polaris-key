# @pkey-feature connect.transfer connect.local
"""``peer-matrix.json`` ``xfer`` (WIRE-CONTRACT-V5 §15.11) through the Python machine: the codecs, the
partial file's path and the shown name, and every ``window``, ``offer``, ``hash``, ``ending``, ``resume``
and ``limits`` row replayed step by step."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.core import peer_xfer as X
from polaris_key.core.device_label import clean_display_name
from polaris_key.core.peer_payload import caps_intersection

_M = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "peer-matrix.json").read_text()
)
_X: Dict[str, Any] = _M["xfer"]


def _body(r: Dict[str, Any]) -> bytes:
    if "bodyHex" in r:
        return bytes.fromhex(r["bodyHex"])
    if "bodyPad" in r:
        p = r["bodyPad"]
        return (p["prefix"] + p["fill"] * p["count"] + p["suffix"]).encode("utf-8")
    return r["body"].encode("utf-8")


def _content(lo: int, hi: int, flip: bool = False) -> bytes:
    return bytes((((i * 7 + 13) & 0xFF) ^ (0xFF if flip else 0)) for i in range(lo, hi))


def _ids(rows: List[Dict[str, Any]]) -> List[str]:
    return [r["id"] for r in rows]


def test_constants() -> None:
    c = _X["constants"]
    assert [
        X.XFER_MAX_CONTROL_BYTES,
        X.XFER_MAX_SIZE,
        X.XFER_DEFAULT_CHUNK,
        X.XFER_MAX_CHUNK,
        X.XFER_WINDOW,
        X.XFER_ACK_EVERY,
        X.XFER_MAX_TRANSFERS,
        X.XFER_CONSENT_SECONDS,
        X.XFER_IDLE_SECONDS,
        X.XFER_PARTIAL_SECONDS,
        X.XFER_MAX_PARTIALS_PER_PEER,
        X.XFER_ENDED_IDS,
    ] == [
        c["maxControlBytes"],
        c["maxSize"],
        c["defaultChunk"],
        c["maxChunk"],
        c["window"],
        c["ackEvery"],
        c["maxTransfers"],
        c["consentSeconds"],
        c["idleSeconds"],
        c["partialSeconds"],
        c["maxPartialsPerPeer"],
        c["endedIds"],
    ]


def _verdict(v: Any, key: str = "") -> Dict[str, Any]:
    if v is None:
        return {"ok": False}
    return {"ok": True, key: v} if key else {"ok": True, **v}


@pytest.mark.parametrize("r", _X["codecs"]["offer"], ids=_ids(_X["codecs"]["offer"]))
def test_codec_offer(r: Dict[str, Any]) -> None:
    b = _body(r)
    assert len(b) == r["length"]
    assert _verdict(X.parse_xfer_offer(b, r["maxMessage"]), "offer") == r["want"]


@pytest.mark.parametrize("r", _X["codecs"]["offsetBodies"], ids=_ids(_X["codecs"]["offsetBodies"]))
def test_codec_offset(r: Dict[str, Any]) -> None:
    assert _verdict(X.parse_xfer_offset(r["kind"], _body(r), r["size"], r["chunk"])) == r["want"]


@pytest.mark.parametrize("r", _X["codecs"]["done"], ids=_ids(_X["codecs"]["done"]))
def test_codec_done(r: Dict[str, Any]) -> None:
    assert _verdict(X.parse_xfer_done(_body(r), r["toward"])) == r["want"]


@pytest.mark.parametrize("r", _X["codecs"]["cancel"], ids=_ids(_X["codecs"]["cancel"]))
def test_codec_cancel(r: Dict[str, Any]) -> None:
    assert _verdict(X.parse_xfer_cancel(_body(r))) == r["want"]


@pytest.mark.parametrize("r", _X["codecs"]["chunk"], ids=_ids(_X["codecs"]["chunk"]))
def test_codec_chunk(r: Dict[str, Any]) -> None:
    head = bytes.fromhex(r["head"])
    body = head + b"\xab" * r["dataLength"]
    assert _verdict(X.parse_xfer_chunk(body, r["size"], r["chunk"], r["expect"])) == r["want"]


@pytest.mark.parametrize("r", _X["name"]["paths"], ids=_ids(_X["name"]["paths"]))
def test_partial_path(r: Dict[str, Any]) -> None:
    assert X.xfer_partial_path(bytes.fromhex(r["key"]), r["xferId"], r["sha256"]) == r["path"]


@pytest.mark.parametrize("r", _X["name"]["rows"], ids=_ids(_X["name"]["rows"]))
def test_name_is_display_data(r: Dict[str, Any]) -> None:
    offer = X.parse_xfer_offer(r["body"].encode("utf-8"), 1_048_576)
    assert offer is not None
    assert clean_display_name(offer.get("name")) == r["display"]
    assert offer.get("type") == r.get("type")
    assert X.xfer_partial_path(bytes.fromhex(_X["name"]["key"]), offer["id"], offer["sha256"]) == r["path"]


def _merge(want: Dict[str, Any]) -> Dict[str, Any]:
    if "send" not in want:
        return want
    send: List[Dict[str, Any]] = []
    for s in want["send"]:
        last = send[-1] if send else None
        if (
            s["t"] == "CHUNKS"
            and last is not None
            and last["t"] == "CHUNKS"
            and last["id"] == s["id"]
            and last["offset"] + last["bytes"] == s["offset"]
        ):
            last["bytes"] += s["bytes"]
        else:
            send.append(dict(s))
    return {**want, "send": send}


def _want(o: X.XferOut) -> Dict[str, Any]:
    w: Dict[str, Any] = {}
    if o.send:
        w["send"] = [dict(s) for s in o.send]
    if o.close is not None:
        w["close"] = o.close
    if o.ask is not None:
        w["ask"] = o.ask
    if o.withdraw:
        assert len(o.withdraw) == 1
        w["withdraw"] = o.withdraw[0]
    if o.results:
        assert len(o.results) == 1
        w["result"] = o.results[0]
    partial = [e for e in o.partial if "write" not in e]
    if partial:
        w["partial"] = partial
    if o.refused is not None:
        w["refused"] = o.refused
    if o.drop:
        w["drop"] = True
    return w


def _run(row: Dict[str, Any]) -> None:
    c = row["ctx"]
    corrupt = {p["ref"]: p.get("corrupt") is True for p in c["partials"]}
    nxt = [1]

    def new_ref(_i: str, _s: str) -> str:
        n = nxt[0]
        nxt[0] += 1
        return "n%d" % n

    def rehash(ref: str, offset: int) -> Any:
        return hashlib.sha256(_content(0, offset, corrupt.get(ref, False)))

    handler = {
        "none": None,
        "ask": lambda _a: "ask",
        "decline": lambda _a: "decline",
        "accept": lambda _a: "accept",
    }[c["handler"]]
    mach = X.XferMachine(
        mode=c["mode"],
        caps=caps_intersection(c["capsLocal"], c["capsRemote"]),
        max_message=c["maxMessage"],
        host_limit=c["hostLimit"],
        free=lambda: c["free"],
        handler=handler,
        categories=c["cats"],
        peer_key=bytes.fromhex(c["peerKey"]),
        partials=[
            {k: v for k, v in p.items() if k not in ("corrupt", "otherPeer")}
            for p in c["partials"]
            if p.get("otherPeer") is not True
        ],
        rehash=rehash,
        new_ref=new_ref,
        withhold_acks=c.get("withholdAcks") is True,
    )
    got = []
    for st in row["steps"]:
        at = st["at"]
        if "host" in st:
            h = st["host"]
            if h == "tick":
                out = mach.tick(at)
            elif h == "offer":
                out = mach.offer(
                    at,
                    id=st["id"],
                    size=st["size"],
                    chunk=st["chunk"],
                    sha256=st["sha256"],
                    cat=st.get("cat"),
                    seekable=st.get("seekable", True),
                )
            elif h == "consent":
                out = mach.consent(at, st["id"], st["answer"])
            elif h == "cancel":
                out = mach.cancel(at, st["id"])
            elif h == "close":
                out = mach.close(at)
            elif h == "newSession":
                out = mach.new_session(at)
            else:
                raise AssertionError("%s: host %s" % (row["id"], h))
        else:
            more = st.get("more") is True
            rx = st["rx"]
            if rx == "PING":
                out = mach.tick(at)
            elif rx == "OFFER":
                out = mach.receive(at, X.XFER["OFFER"], st["body"].encode("utf-8"), more)
            elif rx in ("ACCEPT", "ACK"):
                out = mach.receive(at, X.XFER[rx], X.xfer_offset_body(st["id"], st["offset"]), more)
            elif rx == "CHUNK":
                data = _content(st["offset"], st["offset"] + st["length"], st.get("data") == "corrupt")
                out = mach.receive(at, X.XFER["CHUNK"], X.xfer_chunk_body(st["id"], st["offset"], data), more)
            elif rx == "DONE":
                out = mach.receive(at, X.XFER["DONE"], X.xfer_done_body(st["id"], st.get("sha256")), more)
            elif rx == "CANCEL":
                out = mach.receive(at, X.XFER["CANCEL"], X.xfer_cancel_body(st["id"], st["reason"]), more)
            else:
                raise AssertionError("%s: rx %s" % (row["id"], rx))
        got.append(_merge(_want(out)))
    assert got == [_merge(w) for w in row["want"]], row["id"]


_ROWS = [(s, r) for s in ("window", "offer", "hash", "ending", "resume", "limits") for r in _X[s]]


def test_every_xfer_row_is_present() -> None:
    assert len(_ROWS) == 39 + 54 + 16 + 38 + 39 + 11


@pytest.mark.parametrize("section,row", _ROWS, ids=["%s/%s" % (s, r["id"]) for s, r in _ROWS])
def test_xfer_row(section: str, row: Dict[str, Any]) -> None:
    _run(row)


# Direct Transfer in mode l (CC-29.8, §15.11 "Where it runs"): allowed, and mode c's category rule applies. The
# rows are the shape and run of the `xfer` machine rows, kept under `local.xfer` so a port that has not adopted
# mode l keeps passing the section above.
_LOCAL_ROWS: List[Dict[str, Any]] = _M["local"]["xfer"]


@pytest.mark.parametrize("row", _LOCAL_ROWS, ids=_ids(_LOCAL_ROWS))
def test_local_xfer_row(row: Dict[str, Any]) -> None:
    assert _LOCAL_ROWS
    _run(row)
