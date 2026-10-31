"""WIRE-CONTRACT-V5 §15.11: Direct Transfer (``xfer/1``). The control-body codecs, the partial-file
path and :class:`XferMachine`, one side of one session as a state machine. Mirrors
``packages/client-core/src/peer/xfer.ts``.

A machine does no I/O: it reads records, the host's calls and a clock, and answers each with an
:class:`XferOut` (records to send, questions for the host, effects on the kept partial files).
:mod:`polaris_key.core.peer_xfer_endpoint` runs a machine over a session. ``peer-matrix.json``
``xfer`` is the conformance check.

Sends, effects, results and the host's question are plain dicts shaped as the corpus writes them
(``{"t": "ACCEPT", "id": ..., "offset": ...}``): members that are absent are not in the dict.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Callable, Dict, List, Optional, Sequence

from .b64url import b64url_decode, b64url_encode
from .device_label import clean_display_name
from .peer_payload import parse_strict_object

__all__ = [
    "XFER",
    "XFER_ACK_EVERY",
    "XFER_CAP",
    "XFER_CHUNK_HEAD",
    "XFER_CONSENT_SECONDS",
    "XFER_DEFAULT_CHUNK",
    "XFER_ENDED_IDS",
    "XFER_IDLE_SECONDS",
    "XFER_MAX_CHUNK",
    "XFER_MAX_CONTROL_BYTES",
    "XFER_MAX_PARTIALS_PER_PEER",
    "XFER_MAX_SIZE",
    "XFER_MAX_TRANSFERS",
    "XFER_PARTIAL_SECONDS",
    "XFER_REASONS",
    "XFER_WINDOW",
    "XferMachine",
    "XferOut",
    "is_xfer_id",
    "is_xfer_type",
    "parse_xfer_cancel",
    "parse_xfer_chunk",
    "parse_xfer_done",
    "parse_xfer_offer",
    "parse_xfer_offset",
    "xfer_cancel_body",
    "xfer_chunk_body",
    "xfer_done_body",
    "xfer_offer_body",
    "xfer_offset_body",
    "xfer_partial_path",
]

XFER_MAX_CONTROL_BYTES = 4096
XFER_MAX_SIZE = 2**40
XFER_DEFAULT_CHUNK = 61_440
XFER_MAX_CHUNK = 65_492
XFER_WINDOW = 16
XFER_ACK_EVERY = 8
XFER_MAX_TRANSFERS = 4
XFER_CONSENT_SECONDS = 120
XFER_IDLE_SECONDS = 60
XFER_PARTIAL_SECONDS = 86_400
XFER_MAX_PARTIALS_PER_PEER = 8
XFER_ENDED_IDS = 64
XFER_CHUNK_HEAD = 24
XFER_CAP = "xfer/1"

XFER = {
    "OFFER": 0x0020,
    "ACCEPT": 0x0021,
    "CHUNK": 0x0022,
    "ACK": 0x0023,
    "DONE": 0x0024,
    "CANCEL": 0x0025,
}

XFER_REASONS = ("declined", "cancelled", "hash", "size", "category", "busy", "quota", "timeout")

_SHA = re.compile(r"[0-9a-f]{64}\Z")
_CAT = re.compile(r"[a-z0-9-]{1,32}\Z")
_TYPE = re.compile(r"[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*\Z")
_ID = re.compile(r"[A-Za-z0-9_-]{22}\Z")

Json = Dict[str, Any]


def is_xfer_type(type_: int) -> bool:
    """True for the six xfer record types."""
    return XFER["OFFER"] <= type_ <= XFER["CANCEL"]


def is_xfer_id(v: object) -> bool:
    """A transfer id: 22 canonical base64url characters of 16 bytes."""
    if not isinstance(v, str) or _ID.match(v) is None:
        return False
    try:
        return b64url_encode(b64url_decode(v)) == v
    except ValueError:
        return False


def _utf8_len(s: str) -> int:
    return len(s.encode("utf-8", "surrogatepass"))


def _control(body: bytes) -> Optional[Json]:
    if len(body) > XFER_MAX_CONTROL_BYTES:
        return None
    return parse_strict_object(bytes(body))


def _is_int(v: object) -> bool:
    return type(v) is int


def _int_of(o: Json, name: str, lo: int, hi: int) -> Optional[int]:
    """An integer token in [lo, hi]: a JSON number written without a fraction or an exponent (those
    parse as floats here)."""
    v = o.get(name)
    if type(v) is not int:
        return None
    return v if lo <= v <= hi else None


def parse_xfer_offer(body: bytes, max_message: int) -> Optional[Json]:
    """An ``OFFER`` body; ``max_message`` is the reader's own ``HELLO`` value. None is a ``peer_bad_frame``."""
    o = _control(body)
    if o is None or not is_xfer_id(o.get("id")):
        return None
    out: Json = {"id": o["id"]}
    name, type_, cat = o.get("name"), o.get("type"), o.get("cat")
    if "name" in o:
        if not isinstance(name, str) or _utf8_len(name) > 255:
            return None
        out["name"] = name
    if "type" in o:
        if not isinstance(type_, str) or _utf8_len(type_) > 127 or _TYPE.match(type_) is None:
            return None
        out["type"] = type_
    size = _int_of(o, "size", 0, XFER_MAX_SIZE)
    if size is None:
        return None
    out["size"] = size
    sha = o.get("sha256")
    if not isinstance(sha, str) or _SHA.match(sha) is None:
        return None
    out["sha256"] = sha
    if "cat" in o:
        if not isinstance(cat, str) or _CAT.match(cat) is None:
            return None
        out["cat"] = cat
    chunk = _int_of(o, "chunk", 1, XFER_MAX_CHUNK)
    if chunk is None or chunk + XFER_CHUNK_HEAD > max_message:
        return None
    out["chunk"] = chunk
    return out


def xfer_offer_body(o: Json) -> bytes:
    """The sender's ``OFFER`` body."""
    d: Json = {"id": o["id"]}
    for k in ("name", "type"):
        if o.get(k) is not None:
            d[k] = o[k]
    d["size"] = o["size"]
    d["sha256"] = o["sha256"]
    if o.get("cat") is not None:
        d["cat"] = o["cat"]
    d["chunk"] = o["chunk"]
    return _dump(d)


def _dump(d: Json) -> bytes:
    return json.dumps(d, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def xfer_offset_body(id_: str, offset: int) -> bytes:
    return _dump({"id": id_, "offset": offset})


def xfer_done_body(id_: str, sha256: Optional[str] = None) -> bytes:
    return _dump({"id": id_} if sha256 is None else {"id": id_, "sha256": sha256})


def xfer_cancel_body(id_: str, reason: str) -> bytes:
    return _dump({"id": id_, "reason": reason})


def xfer_chunk_body(id_: str, offset: int, data: bytes) -> bytes:
    """A ``CHUNK`` body: ``id(16) || u64be offset || data``."""
    return b64url_decode(id_) + offset.to_bytes(8, "big") + bytes(data)


def _parse_id(o: Optional[Json]) -> Optional[str]:
    return o["id"] if o is not None and is_xfer_id(o.get("id")) else None


def _offset_ok(v: int, size: int, chunk: int, ack: bool) -> bool:
    return 0 <= v <= size and (v % chunk == 0 or (ack and v == size))


def parse_xfer_offset(kind: str, body: bytes, size: int, chunk: int) -> Optional[Json]:
    """An ``ACCEPT`` or ``ACK`` body, ``{id, offset}``, judged against its ``OFFER``. None is a fault."""
    o = _control(body)
    id_ = _parse_id(o)
    if o is None or id_ is None:
        return None
    off = _int_of(o, "offset", 0, XFER_MAX_SIZE)
    if off is not None and _offset_ok(off, size, chunk, kind == "ACK"):
        return {"id": id_, "offset": off}
    return None


def parse_xfer_done(body: bytes, toward: str) -> Optional[Json]:
    """A ``DONE`` body: ``{id, sha256}`` toward the receiver, ``{id}`` toward the sender."""
    o = _control(body)
    id_ = _parse_id(o)
    if o is None or id_ is None:
        return None
    if toward == "sender":
        return {"id": id_} if "sha256" not in o else None
    sha = o.get("sha256")
    return {"id": id_, "sha256": sha} if isinstance(sha, str) and _SHA.match(sha) else None


def _reason_of(r: str) -> str:
    return r if r in XFER_REASONS else "cancelled"


def parse_xfer_cancel(body: bytes) -> Optional[Json]:
    """A ``CANCEL`` body. A string outside the eight reasons reads as ``cancelled``."""
    o = _control(body)
    id_ = _parse_id(o)
    if o is None or id_ is None or not isinstance(o.get("reason"), str):
        return None
    return {"id": id_, "reason": _reason_of(o["reason"])}


def parse_xfer_chunk(body: bytes, size: int, chunk: int, expect: int) -> Optional[Json]:
    """A ``CHUNK`` body judged against its offer and the next offset the receiver expects."""
    if len(body) < XFER_CHUNK_HEAD:
        return None
    id_ = b64url_encode(bytes(body[:16]))
    at = int.from_bytes(body[16:24], "big")
    length = len(body) - XFER_CHUNK_HEAD
    if length == 0 or length > chunk or at != expect:
        return None
    if expect + length > size:
        return None
    if length < chunk and expect + length != size:
        return None
    return {"id": id_, "offset": expect, "length": length}


def xfer_partial_path(key: bytes, id_: str, sha256: str) -> str:
    """The partial file's name (§15.11 "The name is display data"): derived from the resume key only."""
    h = hashlib.sha256()
    h.update(b"pkey-xfer/1 partial")
    h.update(b"\x00")
    h.update(bytes(key))
    h.update(b64url_decode(id_))
    h.update(bytes.fromhex(sha256))
    return h.hexdigest()


# -- The machine ----------------------------------------------------------------------------------


class XferOut:
    """What one machine call asks for. ``send`` records, ``close`` a peer_* code, ``ask`` the host's
    question, ``withdraw`` ids whose question is withdrawn, ``results``, ``partial`` effects on the kept
    files (``write`` ones carry the bytes), ``refused`` (``busy``: the host's own send) and ``drop``."""

    __slots__ = ("send", "close", "ask", "withdraw", "results", "partial", "refused", "drop")

    def __init__(self) -> None:
        self.send: List[Json] = []
        self.close: Optional[str] = None
        self.ask: Optional[Json] = None
        self.withdraw: List[str] = []
        self.results: List[Json] = []
        self.partial: List[Json] = []
        self.refused: Optional[str] = None
        self.drop = False


class _Tr:
    __slots__ = (
        "id",
        "dir",
        "st",
        "size",
        "chunk",
        "sha",
        "since",
        "recv",
        "since_ack",
        "acked_end",
        "hash",
        "partial",
        "accepted",
        "sent_end",
        "ack_end",
        "seekable",
        "full",
    )

    def __init__(self, id_: str, dir_: str, size: int, chunk: int, sha: str, since: float) -> None:
        self.id = id_
        self.dir = dir_
        self.st = "asking"
        self.size = size
        self.chunk = chunk
        self.sha = sha
        self.since = since
        self.recv = 0
        self.since_ack = 0
        self.acked_end = 0
        self.hash: Any = None
        self.partial: Optional[str] = None
        self.accepted = False
        self.sent_end = 0
        self.ack_end = 0
        self.seekable = True
        self.full = False


class _Ended:
    __slots__ = ("id", "dir", "cancelled_here")

    def __init__(self, id_: str, dir_: str, cancelled_here: bool) -> None:
        self.id = id_
        self.dir = dir_
        self.cancelled_here = cancelled_here


Handler = Callable[[Json], str]


class XferMachine:
    """One side of one session. ``mode`` is the session's mode (transfers run in ``a`` and ``c``),
    ``caps`` its capabilities (the intersection of both payloads), ``max_message`` this side's own
    ``HELLO`` value. ``handler`` answers an offer ``"accept"``, ``"decline"`` or ``"ask"`` (None
    declines every offer). ``partials`` are the kept partial files of this peer key (dicts: ``ref``,
    ``id``, ``sha256``, ``size``, ``chunk``, ``bytes``, ``writtenAt`` and optionally ``held`` and
    ``reread``). ``rehash(ref, offset)`` returns a hash object fed with the first ``offset`` bytes of
    a kept partial, which the store re-read; without it a resume starts at 0."""

    def __init__(
        self,
        *,
        mode: str,
        caps: Sequence[str],
        max_message: int,
        peer_key: bytes,
        handler: Optional[Handler],
        host_limit: Optional[int] = None,
        free: Optional[Callable[[], Optional[int]]] = None,
        categories: Sequence[str] = (),
        partials: Sequence[Json] = (),
        rehash: Optional[Callable[[str, int], Any]] = None,
        new_ref: Optional[Callable[[str, str], str]] = None,
        withhold_acks: bool = False,
    ) -> None:
        if len(peer_key) != 32:
            raise ValueError("peer_key")
        self._mode = mode
        self._caps = list(caps)
        self._max_message = max_message
        self._peer_key = bytes(peer_key)
        self._handler = handler
        self._host_limit = host_limit
        self._free = free
        self._cats = list(categories)
        self._rehash = rehash
        self._new_ref = new_ref
        self._withhold = withhold_acks
        self._tr: Dict[str, _Tr] = {}
        self._ended: List[_Ended] = []
        self._closed = False
        self._parts: List[Json] = [dict(p) for p in partials]
        self._clock: float = 0
        self._out = XferOut()

    # -- views --------------------------------------------------------------------------------------

    def partials(self) -> List[Json]:
        """The kept partials now."""
        return [dict(p) for p in self._parts]

    @property
    def live(self) -> int:
        return len(self._tr)

    def next_deadline(self) -> Optional[float]:
        """The clock value at which the next wait runs out, or None when none is running."""
        best: Optional[float] = None
        for t in self._tr.values():
            lim = self._limit(t)
            if lim is None:
                continue
            at = t.since + lim
            if best is None or at < best:
                best = at
        return best

    # -- events -------------------------------------------------------------------------------------

    def tick(self, at: float) -> XferOut:
        return self._begin(at, lambda: None)

    def receive(self, at: float, type_: int, body: bytes, more: bool = False) -> XferOut:
        return self._begin(at, lambda: self._on_record(type_, bytes(body), more))

    def offer(
        self,
        at: float,
        *,
        id: str,  # noqa: A002 - the corpus' member name
        size: int,
        chunk: int,
        sha256: str,
        cat: Optional[str] = None,
        name: Optional[str] = None,
        type: Optional[str] = None,  # noqa: A002
        seekable: bool = True,
    ) -> XferOut:
        """The host sends: ``OFFER``."""
        if (
            not is_xfer_id(id)
            or not _is_int(size)
            or size < 0
            or size > XFER_MAX_SIZE
            or not _is_int(chunk)
            or chunk < 1
            or chunk > XFER_MAX_CHUNK
            or _SHA.match(sha256) is None
        ):
            raise ValueError("offer")
        if id in self._tr or any(e.id == id for e in self._ended):
            raise ValueError("transfer id already used")

        def go() -> None:
            if len(self._tr) >= XFER_MAX_TRANSFERS:
                self._out.refused = "busy"
                return
            t = _Tr(id, "out", size, chunk, sha256, self._clock)
            t.st = "offered"
            t.seekable = seekable is not False
            self._tr[id] = t
            s: Json = {"t": "OFFER", "id": id, "size": size, "chunk": chunk, "sha256": sha256}
            for k, v in (("cat", cat), ("name", name), ("type", type)):
                if v is not None:
                    s[k] = v
            self._out.send.append(s)

        return self._begin(at, go)

    def consent(self, at: float, id: str, answer: str) -> XferOut:  # noqa: A002
        """The host's answer to an ``ask``."""

        def go() -> None:
            t = self._tr.get(id)
            if t is None or t.st != "asking":
                return
            if answer == "decline":
                self._out.send.append({"t": "CANCEL", "id": id, "reason": "declined"})
                self._end(t, True)
                return
            self._accept(t)

        return self._begin(at, go)

    def cancel(self, at: float, id: str) -> XferOut:  # noqa: A002
        """The host cancels a transfer."""

        def go() -> None:
            t = self._tr.get(id)
            if t is None:
                return
            # After its DONE a sender sends no CANCEL other than timeout.
            if t.dir == "out" and t.st == "doneSent":
                return
            self._out.send.append({"t": "CANCEL", "id": id, "reason": "cancelled"})
            if t.st == "asking":
                self._out.withdraw.append(id)
            elif t.dir == "in" and t.partial is not None:
                self._eff({"delete": t.partial})
            self._result(t, {"id": id, "outcome": "cancelled", "reason": "cancelled"})
            self._end(t, True)

        return self._begin(at, go)

    def fail(self, at: float, id: str) -> XferOut:  # noqa: A002
        """The host's source failed before the transfer's ``DONE`` went out: cancel an outgoing
        transfer in any state."""

        def go() -> None:
            t = self._tr.get(id)
            if t is None or t.dir != "out":
                return
            self._out.send.append({"t": "CANCEL", "id": id, "reason": "cancelled"})
            self._result(t, {"id": id, "outcome": "cancelled", "reason": "cancelled"})
            self._end(t, True)

        return self._begin(at, go)

    def close(self, at: float) -> XferOut:
        """The session ended. Does nothing when a fault already ended it; see :meth:`abandon`."""
        if self._closed:
            return XferOut()
        return self._begin(at, self._shutdown)

    def abandon(self, at: float) -> XferOut:
        """The session closed for any reason: report every live transfer ``closed`` and keep the
        partials. Idempotent, and it also answers after a fault the machine itself raised."""
        self._out = XferOut()
        self._clock = at
        self._shutdown()
        self._closed = True
        return self._out

    def new_session(self, at: float) -> XferOut:
        """A new session on the same machine keeps the partials, none held and none re-read."""
        self._out = XferOut()
        self._clock = at
        self._tr.clear()
        self._ended = []
        self._closed = False
        self._parts = [{**{k: v for k, v in p.items() if k != "reread"}, "held": False} for p in self._parts]
        return self._out

    # -- internals ----------------------------------------------------------------------------------

    def _begin(self, at: float, fn: Callable[[], None]) -> XferOut:
        self._out = XferOut()
        if self._closed:
            return self._out
        self._clock = at
        self._expire(at)
        fn()
        return self._out

    def _shutdown(self) -> None:
        for t in list(self._tr.values()):
            if t.st == "asking":
                self._out.withdraw.append(t.id)
            elif t.dir == "in" and t.partial is not None:
                self._eff({"keep": t.partial})
            self._result(t, {"id": t.id, "outcome": "closed"})
        self._tr.clear()
        self._closed = True

    def _eff(self, e: Json) -> None:
        self._out.partial.append(e)
        gone = e.get("delete", e.get("finalize"))
        if gone is not None:
            self._parts = [p for p in self._parts if p["ref"] != gone]

    def _fault(self) -> None:
        self._out.close = "peer_bad_frame"
        self._closed = True

    def _result(self, t: _Tr, r: Json) -> None:
        # A transfer the host was never told about (still asking) reports no result.
        if t.st == "asking":
            return
        self._out.results.append(r)

    def _remember(self, id_: str, dir_: str, cancelled_here: bool) -> None:
        self._ended.append(_Ended(id_, dir_, cancelled_here))
        while len(self._ended) > XFER_ENDED_IDS:
            self._ended.pop(0)

    def _end(self, t: _Tr, cancelled_here: bool) -> None:
        self._tr.pop(t.id, None)
        self._remember(t.id, t.dir, cancelled_here)

    # -- the clock ----------------------------------------------------------------------------------

    def _limit(self, t: _Tr) -> Optional[float]:
        """Seconds this transfer may wait in its current state; None while nothing is awaited."""
        if t.dir == "in":
            return XFER_CONSENT_SECONDS if t.st == "asking" else XFER_IDLE_SECONDS
        if t.st == "offered":
            return XFER_CONSENT_SECONDS + XFER_IDLE_SECONDS
        if t.st == "doneSent":
            return XFER_IDLE_SECONDS
        return XFER_IDLE_SECONDS if t.full else None

    def _expire(self, at: float) -> None:
        """Every wait that ran out by ``at`` ends with ``CANCEL timeout``; the partial is kept."""
        for t in list(self._tr.values()):
            lim = self._limit(t)
            if lim is None or at - t.since < lim:
                continue
            self._out.send.append({"t": "CANCEL", "id": t.id, "reason": "timeout"})
            if t.st == "asking":
                self._out.withdraw.append(t.id)
            elif t.dir == "in" and t.partial is not None:
                self._eff({"keep": t.partial})
            self._result(t, {"id": t.id, "outcome": "cancelled", "reason": "timeout"})
            self._end(t, True)

    # -- records ------------------------------------------------------------------------------------

    def _on_record(self, type_: int, body: bytes, more: bool) -> None:
        # Step 1: the mode and the capability.
        if self._mode not in ("a", "c") or XFER_CAP not in self._caps:
            self._out.close = "peer_not_allowed"
            self._closed = True
            return
        if more or not is_xfer_type(type_):
            return self._fault()
        if type_ == XFER["OFFER"]:
            return self._on_offer(body)
        if type_ == XFER["CHUNK"]:
            return self._on_chunk(body)
        c = _control(body)
        id_ = _parse_id(c)
        if c is None or id_ is None:
            return self._fault()
        # The generic member checks, before the id is looked up.
        offset = 0
        sha: Optional[str] = None
        reason = "cancelled"
        if type_ in (XFER["ACCEPT"], XFER["ACK"]):
            v = _int_of(c, "offset", 0, XFER_MAX_SIZE)
            if v is None:
                return self._fault()
            offset = v
        elif type_ == XFER["DONE"]:
            if "sha256" in c:
                s = c["sha256"]
                if not isinstance(s, str) or _SHA.match(s) is None:
                    return self._fault()
                sha = s
        else:
            if not isinstance(c.get("reason"), str):
                return self._fault()
            reason = _reason_of(c["reason"])
        t = self._tr.get(id_)
        if t is None:
            return self._late(id_, type_, sha)
        if type_ == XFER["ACCEPT"]:
            return self._on_accept(t, offset)
        if type_ == XFER["ACK"]:
            return self._on_ack(t, offset)
        if type_ == XFER["DONE"]:
            return self._on_done(t, sha)
        self._on_cancel(t, reason)

    def _late(self, id_: str, type_: int, sha: Optional[str]) -> None:
        """A record for an id that is not live: dropped when remembered, else a fault."""
        e = next((x for x in self._ended if x.id == id_), None)
        if e is None:
            return self._fault()
        if type_ == XFER["DONE"] and e.dir == "out" and e.cancelled_here and sha is None:
            self._out.results.append({"id": id_, "outcome": "delivered"})
            e.cancelled_here = False
            return
        self._out.drop = True

    def _on_offer(self, body: bytes) -> None:
        f = parse_xfer_offer(body, self._max_message)
        if f is None:
            return self._fault()
        if f["id"] in self._tr or any(e.id == f["id"] for e in self._ended):
            return self._fault()
        t = _Tr(f["id"], "in", f["size"], f["chunk"], f["sha256"], self._clock)

        def refuse(reason: str) -> None:
            self._out.send.append({"t": "CANCEL", "id": f["id"], "reason": reason})
            self._remember(f["id"], "in", True)

        # Step 4: busy.
        kept = next((p for p in self._parts if p["id"] == f["id"] and p["sha256"] == f["sha256"]), None)
        if (
            len(self._tr) >= XFER_MAX_TRANSFERS
            or any(x.st == "asking" for x in self._tr.values())
            or (kept is not None and kept.get("held") is True)
        ):
            return refuse("busy")
        # Step 5: the category, before the person is asked.
        if self._mode == "c" and ("cat" not in f or f["cat"] not in self._cats):
            return refuse("category")
        # Step 6: size and quota; a resume counts only the bytes still to come.
        if self._host_limit is not None and f["size"] > self._host_limit:
            return refuse("size")
        free = self._free() if self._free is not None else None
        need = f["size"] - (kept["bytes"] if kept is not None and self._resumable(f, kept) else 0)
        if free is not None and need > free:
            return refuse("quota")
        # Step 7: consent.
        ask: Json = {"id": f["id"], "size": f["size"]}
        shown = clean_display_name(f["name"]) if "name" in f else None
        if shown is not None:
            ask["name"] = shown
        if "type" in f:
            ask["type"] = f["type"]
        if "cat" in f:
            ask["cat"] = f["cat"]
        answer = "decline" if self._handler is None else self._handler(ask)
        if answer == "decline":
            return refuse("declined")
        self._tr[t.id] = t
        if answer == "ask":
            self._out.ask = ask
            return
        self._accept(t)

    def _resumable(self, f: Json, p: Json) -> bool:
        return (
            p["size"] == f["size"]
            and p["chunk"] == f["chunk"]
            and self._clock - p["writtenAt"] <= XFER_PARTIAL_SECONDS
        )

    def _accept(self, t: _Tr) -> None:
        """Step 8: the resume lookup, then ``ACCEPT``."""
        m = next((p for p in self._parts if p["id"] == t.id and p["sha256"] == t.sha), None)
        offset = 0
        h = hashlib.sha256()
        if m is not None and self._resumable({"size": t.size, "chunk": t.chunk}, m):
            read = min(m.get("reread", m["bytes"]), m["bytes"])
            want = min((read // t.chunk) * t.chunk, t.size)
            if self._rehash is not None and want > 0:
                offset = want
                h = self._rehash(m["ref"], offset)
            t.partial = m["ref"]
            self._eff({"truncate": m["ref"], "to": offset})
            m["bytes"] = offset
            m["writtenAt"] = self._clock
            m.pop("reread", None)
        else:
            if m is not None:
                self._eff({"discard": m["ref"]})
                self._parts = [p for p in self._parts if p is not m]
            if t.size > 0:
                if len(self._parts) >= XFER_MAX_PARTIALS_PER_PEER:
                    oldest = self._parts[0]
                    for p in self._parts:
                        if p["writtenAt"] < oldest["writtenAt"]:
                            oldest = p
                    self._eff({"evict": oldest["ref"]})
                    self._parts = [p for p in self._parts if p is not oldest]
                ref = (self._new_ref or (lambda i, s: xfer_partial_path(self._peer_key, i, s)))(t.id, t.sha)
                self._eff({"create": ref})
                self._parts.append(
                    {
                        "ref": ref,
                        "id": t.id,
                        "sha256": t.sha,
                        "size": t.size,
                        "chunk": t.chunk,
                        "bytes": 0,
                        "writtenAt": self._clock,
                    }
                )
                t.partial = ref
        t.hash = h
        t.recv = offset
        t.acked_end = offset
        t.st = "active"
        t.accepted = True
        t.since = self._clock
        self._out.send.append({"t": "ACCEPT", "id": t.id, "offset": offset})

    def _on_accept(self, t: _Tr, offset: int) -> None:
        if t.dir != "out" or t.accepted or t.st != "offered":
            return self._fault()
        if not _offset_ok(offset, t.size, t.chunk, False):
            return self._fault()
        t.accepted = True
        if offset > 0 and not t.seekable:
            self._out.send.append({"t": "CANCEL", "id": t.id, "reason": "cancelled"})
            self._result(t, {"id": t.id, "outcome": "cancelled", "reason": "cancelled"})
            self._end(t, True)
            return
        t.st = "active"
        t.sent_end = offset
        t.ack_end = offset
        t.since = self._clock
        self._pump(t, True)

    def _pump(self, t: _Tr, first: bool) -> None:
        """The sender sends what the window allows, then ``DONE`` once the last byte is out."""
        start = t.sent_end
        room = XFER_WINDOW * t.chunk - (t.sent_end - t.ack_end)
        up_to = min(t.size, t.sent_end + max(0, room))
        end = t.sent_end
        while end < up_to:
            end = min(t.size, end + t.chunk)
        if end > start:
            self._out.send.append({"t": "CHUNKS", "id": t.id, "offset": start, "bytes": end - start})
            t.sent_end = end
        if t.sent_end == t.size:
            self._out.send.append({"t": "DONE", "id": t.id, "sha256": t.sha})
            t.st = "doneSent"
            t.full = False
            t.since = self._clock
            return
        # The idle wait for an ACK starts when the window fills, and again on progress.
        full = t.sent_end - t.ack_end >= XFER_WINDOW * t.chunk
        if full and (not t.full or end > start or first):
            t.since = self._clock
        t.full = full

    def _on_ack(self, t: _Tr, offset: int) -> None:
        if t.dir != "out" or not t.accepted:
            return self._fault()
        if offset < t.ack_end or offset > t.sent_end or not _offset_ok(offset, t.size, t.chunk, True):
            return self._fault()
        t.ack_end = offset
        if t.st == "active":
            self._pump(t, False)

    def _on_chunk(self, body: bytes) -> None:
        if len(body) < XFER_CHUNK_HEAD:
            return self._fault()
        id_ = b64url_encode(bytes(body[:16]))
        t = self._tr.get(id_)
        if t is None:
            return self._late(id_, XFER["CHUNK"], None)
        if t.dir != "in" or t.st != "active":
            return self._fault()
        v = parse_xfer_chunk(body, t.size, t.chunk, t.recv)
        if v is None:
            return self._fault()
        # The window: more than XFER_WINDOW chunks past the last ACK this side sent.
        if v["offset"] + v["length"] - t.acked_end > XFER_WINDOW * t.chunk:
            return self._fault()
        data = bytes(body[XFER_CHUNK_HEAD:])
        end = v["offset"] + v["length"]
        t.hash.update(data)
        offset = t.recv
        t.recv = end
        t.since_ack += 1
        t.since = self._clock
        p = next((x for x in self._parts if x["ref"] == t.partial), None)
        if p is not None:
            p["bytes"] = end
            p["writtenAt"] = self._clock
            self._out.partial.append({"write": p["ref"], "offset": offset, "data": data})
        if t.since_ack >= XFER_ACK_EVERY or end == t.size:
            t.since_ack = 0
            if not self._withhold:
                self._out.send.append({"t": "ACK", "id": t.id, "offset": end})
                t.acked_end = end

    def _on_done(self, t: _Tr, sha: Optional[str]) -> None:
        if t.dir == "out":
            # A DONE toward the sender carries no hash, and only follows its own DONE.
            if sha is not None or t.st != "doneSent":
                return self._fault()
            self._result(t, {"id": t.id, "outcome": "delivered"})
            self._end(t, False)
            return
        if sha is None or t.st != "active":
            return self._fault()

        def cancel(reason: str) -> None:
            self._out.send.append({"t": "CANCEL", "id": t.id, "reason": reason})
            if t.partial is not None:
                self._eff({"delete": t.partial})
            self._result(t, {"id": t.id, "outcome": "cancelled", "reason": reason})
            self._end(t, True)

        if t.recv < t.size:
            return cancel("size")
        if sha != t.sha or t.hash.hexdigest() != t.sha:
            return cancel("hash")
        self._out.send.append({"t": "DONE", "id": t.id})
        if t.partial is not None:
            self._eff({"finalize": t.partial})
        self._result(t, {"id": t.id, "outcome": "delivered"})
        self._end(t, False)

    def _on_cancel(self, t: _Tr, reason: str) -> None:
        if t.st == "asking":
            self._out.withdraw.append(t.id)
        elif t.dir == "in" and t.partial is not None:
            self._eff({"keep": t.partial} if reason == "timeout" else {"delete": t.partial})
        self._result(t, {"id": t.id, "outcome": "cancelled", "reason": reason})
        self._end(t, False)
