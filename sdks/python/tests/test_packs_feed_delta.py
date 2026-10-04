# @pkey-feature packs.delta.feed
"""The feed's delta menu in the pack engine (plans/P4-29.md §2.4), a port of client-core's
``test/packsFeedDelta.test.ts``: a lazy delta the committed feed offers joins the record's deltas
as one more candidate, is checked like any delta (artifact, base, output against the CI-signed
record), falls back on any failure, and at most one feed-offered delta is tried per install. A
journal keeps the entry, so a resume plans it again.

The Python engine emits no ``fallback`` progress event (P4-18 is Node and React only), so a
fallback is read from the objects the server was asked for.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Set

from pack_fixtures import (
    PRODUCT,
    PRODUCT_TRUST,
    PROBE_BASE,
    PROBE_FRAME,
    PROBE_TARGET,
    RELEASE_KEYS,
    sha,
    sign_release_doc,
)
from polaris_key.update.packs import (
    ObjectResponse,
    PackEngine,
    PackHandler,
    memory_pack_state_store,
    memory_pack_storage,
    memory_source,
    parse_pack_state,
    serialize_pack_state,
)
from polaris_key.update.packs.zstd import select_python_zstd

_ZSTD, _ = select_python_zstd()
PACK = "djdl.levels"
BLOB = PackHandler(type="custom.blob", layout="container", activation="hot", supports=lambda fv: fv == 1)


def _j(v: Any) -> bytes:
    return json.dumps(v, separators=(",", ":")).encode("utf-8")


@dataclass
class Release:
    version: str
    seq: int
    jws: str
    record_sha256: str
    payload: bytes
    objects: Dict[str, bytes]


def release(version: str, seq: int, payload: bytes, delta: Optional[Dict[str, bytes]] = None) -> Release:
    """A container release over ``payload`` (one file), ``full`` stored raw; ``delta`` adds a
    record payload delta from ``delta["from"]`` whose artifact is ``delta["frame"]``."""
    index = _j(
        {
            "format": "pkey-files/1",
            "layout": "container",
            "payload": {"size": len(payload), "sha256": sha(payload)},
            "files": [
                {
                    "path": "data.bin",
                    "offset": 0,
                    "size": len(payload),
                    "sha256": sha(payload),
                    "blob": {"sha256": sha(payload), "bytes": len(payload), "codec": "none"},
                }
            ],
        }
    )
    gaps = b""
    objects = {sha(payload): payload, sha(index): index, sha(gaps): gaps}
    variant: Dict[str, Any] = {
        "variant": {},
        "payload": {"size": len(payload), "sha256": sha(payload)},
        "full": {"sha256": sha(payload), "bytes": len(payload), "size": len(payload), "codec": "none"},
        "files": {
            "format": "pkey-files/1",
            "layout": "container",
            "sha256": sha(index),
            "bytes": len(index),
            "size": len(index),
            "codec": "none",
            "gaps": {"sha256": sha(gaps), "bytes": 0, "size": 0, "codec": "none"},
        },
    }
    if delta is not None:
        objects[sha(delta["frame"])] = delta["frame"]
        variant["deltas"] = [
            {
                "method": "zstd-patch-from",
                "scope": "payload",
                "from": sha(delta["from"]),
                "memBytes": len(delta["from"]) + len(payload),
                "artifact": {"sha256": sha(delta["frame"]), "bytes": len(delta["frame"])},
            }
        ]
    jws = sign_release_doc(
        {
            "schemaVersion": 1,
            "aud": PRODUCT,
            "deliverable": PACK,
            "kind": "pack",
            "version": version,
            "seq": seq,
            "issuedAt": 1759300000 + seq,
            "type": "custom.blob",
            "formatVersion": 1,
            "handler": {"activation": "hot"},
            "variants": [variant],
        }
    )
    return Release(version, seq, jws, sha(jws), payload, objects)


@dataclass
class Server:
    """A blob server over the releases; ``corrupt`` answers that object with one byte flipped."""

    records: Dict[str, str] = field(default_factory=dict)
    objects: Dict[str, bytes] = field(default_factory=dict)
    fetched: List[str] = field(default_factory=list)
    corrupt: Set[str] = field(default_factory=set)

    @classmethod
    def of(cls, *releases: Release) -> "Server":
        s = cls()
        for r in releases:
            s.records[r.record_sha256] = r.jws
            s.objects.update(r.objects)
        return s

    def fetch_record(self, h: str) -> Dict[str, Any]:
        body = self.records.get(h)
        return {"ok": False, "code": "not_found"} if body is None else {"ok": True, "body": body}

    def fetch_object(self, sha256: str, offset: int, if_range: Optional[str]) -> ObjectResponse:
        self.fetched.append(sha256)
        b = self.objects.get(sha256)
        if b is None:
            return ObjectResponse(status=404, content_range=None, chunks=iter(()))
        if sha256 in self.corrupt:
            b = bytes([b[0] ^ 0xFF]) + b[1:]

        def chunks() -> Iterator[bytes]:
            yield b

        return ObjectResponse(status=200, content_range=None, chunks=chunks())


_plans = [0]


def _plan_id() -> str:
    _plans[0] += 1
    return f"feed-plan-{_plans[0]}"


def stamp_of(r: Release) -> Dict[str, Any]:
    return {
        "contentApi": 1,
        "pins": [{"pack": PACK, "release": {"sha256": r.record_sha256, "seq": r.seq, "version": r.version}}],
        "expects": [{"pack": PACK, "required": True, "delivery": "essential"}],
    }


def engine(srv: Server, first: Release, **kw: Any) -> PackEngine:
    opts: Dict[str, Any] = dict(
        product=PRODUCT,
        release_keys=RELEASE_KEYS,
        product_trust=lambda: PRODUCT_TRUST,
        stamp=stamp_of(first),
        prefs={"engine": None, "axes": {}},
        zstd=_ZSTD,
        patch_methods=["zstd-patch-from"],
        mem_budget=1 << 30,
        storage=memory_pack_storage(),
        state=memory_pack_state_store(),
        fetch_record=srv.fetch_record,
        fetch_object=srv.fetch_object,
        now=lambda: 1759400000,
        new_plan_id=_plan_id,
        handlers=[BLOB],
    )
    opts.update(kw)
    return PackEngine(**opts)


def target(r: Release) -> Dict[str, Any]:
    return {"pack": PACK, "release": {"sha256": r.record_sha256, "seq": r.seq, "version": r.version}}


def raw_frame(content: bytes) -> bytes:
    """One zstd frame of raw blocks (RFC 8878 §3.1.1.2), with its content size."""
    n = len(content)
    h = (n << 3) | 1
    return bytes(
        [0x28, 0xB5, 0x2F, 0xFD, 0xA0, n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]
        + [h & 0xFF, (h >> 8) & 0xFF, (h >> 16) & 0xFF]
    ) + content


def payload_of(e: PackEngine) -> Optional[str]:
    a = e.state().active.get(PACK)
    return None if a is None else a["payloadSha256"]


def entry(base: bytes, frame: bytes) -> Dict[str, Any]:
    """A feed menu entry to ``PROBE_TARGET`` from ``base``, whose artifact is ``frame``."""
    return {
        "from": sha(base),
        "method": "zstd-patch-from",
        "scope": "payload",
        "memBytes": len(base) + len(PROBE_TARGET),
        "artifact": {"sha256": sha(frame), "bytes": len(frame)},
    }


def menu_of(*entries: Dict[str, Any]) -> Dict[str, Any]:
    return {sha(PROBE_TARGET): list(entries)}


def pair(*extra: bytes) -> Dict[str, Release]:
    """v1 (``PROBE_BASE``) and v2 (``PROBE_TARGET``) with NO record delta; ``extra`` objects are
    on the server beside them (feed-offered frames)."""
    v1 = release("1.0.0", 1, PROBE_BASE)
    v2 = release("1.1.0", 2, PROBE_TARGET)
    for b in extra:
        v2.objects[sha(b)] = b
    return {"v1": v1, "v2": v2}


def test_plans_the_feeds_delta_for_a_record_that_carries_none_and_installs_it() -> None:
    p = pair(PROBE_FRAME)
    srv = Server.of(p["v1"], p["v2"])
    e = engine(srv, p["v1"], feed_deltas=lambda: menu_of(entry(PROBE_BASE, PROBE_FRAME)))
    e.load()
    e.ensure_releases([target(p["v1"])])
    srv.fetched.clear()
    e.ensure_releases([target(p["v2"])])
    assert payload_of(e) == sha(PROBE_TARGET)
    assert srv.fetched == [sha(PROBE_FRAME)]


def test_falls_back_when_the_feeds_delta_404s_and_installs_by_the_next_candidate() -> None:
    p = pair()
    srv = Server.of(p["v1"], p["v2"])
    e = engine(srv, p["v1"], feed_deltas=lambda: menu_of(entry(PROBE_BASE, PROBE_FRAME)))
    e.load()
    e.ensure_releases([target(p["v1"])])
    srv.fetched.clear()
    e.ensure_releases([target(p["v2"])])
    assert payload_of(e) == sha(PROBE_TARGET)
    assert srv.fetched[0] == sha(PROBE_FRAME)
    assert sha(PROBE_TARGET) in srv.fetched[1:]
    assert PACK not in e.state().inflight


def test_falls_back_when_the_stored_artifact_does_not_match_the_menu_entry() -> None:
    p = pair(PROBE_FRAME)
    srv = Server.of(p["v1"], p["v2"])
    srv.corrupt.add(sha(PROBE_FRAME))
    e = engine(srv, p["v1"], feed_deltas=lambda: menu_of(entry(PROBE_BASE, PROBE_FRAME)))
    e.load()
    e.ensure_releases([target(p["v1"])])
    srv.fetched.clear()
    e.ensure_releases([target(p["v2"])])
    assert payload_of(e) == sha(PROBE_TARGET)
    assert srv.fetched[0] == sha(PROBE_FRAME)
    assert sha(PROBE_TARGET) in srv.fetched[1:]


def test_checks_the_output_against_the_record_and_falls_back() -> None:
    # A frame that decodes to other bytes is refused (delta-apply-failed).
    frame = raw_frame(b"not the payload the record pins, but a valid frame all the same\n")
    p = pair(frame)
    srv = Server.of(p["v1"], p["v2"])
    e = engine(
        srv,
        p["v1"],
        feed_deltas=lambda: menu_of({**entry(PROBE_BASE, frame), "memBytes": len(PROBE_BASE) + 4096}),
    )
    e.load()
    e.ensure_releases([target(p["v1"])])
    srv.fetched.clear()
    e.ensure_releases([target(p["v2"])])
    assert payload_of(e) == sha(PROBE_TARGET)
    assert srv.fetched[0] == sha(frame)
    assert sha(PROBE_TARGET) in srv.fetched[1:]


def test_checks_the_base_against_from_and_falls_back() -> None:
    # An entry naming an installed payload whose bytes differ is refused (delta-base-mismatch).
    p = pair(PROBE_FRAME)
    srv = Server.of(p["v1"], p["v2"])
    storage = memory_pack_storage()
    e = engine(
        srv, p["v1"], storage=storage, feed_deltas=lambda: menu_of(entry(PROBE_BASE, PROBE_FRAME))
    )
    e.load()
    e.ensure_releases([target(p["v1"])])
    # The installed base's bytes change under the engine (a disk fault): its hash no longer
    # equals the entry's `from`.
    real = storage.installed

    def installed(i: Dict[str, Any]) -> Any:
        got = real(i)
        if got is None or got.payload is None:
            return got
        flipped = bytes([PROBE_BASE[0] ^ 1]) + PROBE_BASE[1:]
        got.payload = memory_source(flipped)
        return got

    storage.installed = installed  # type: ignore[method-assign]
    srv.fetched.clear()
    e.ensure_releases([target(p["v2"])])
    assert payload_of(e) == sha(PROBE_TARGET)
    assert srv.fetched[0] == sha(PROBE_FRAME)
    assert sha(PROBE_TARGET) in srv.fetched[1:]


def test_tries_at_most_one_feed_offered_delta_per_install() -> None:
    # Two installed bases (A previous, PROBE_BASE active) and two feed entries: the cheap one
    # from PROBE_BASE 404s; the other, from A, is on the server but is never fetched.
    a = b"an older payload of the same pack\n"
    second = raw_frame(PROBE_TARGET)
    v0 = release("0.9.0", 1, a)
    v1 = release("1.0.0", 2, PROBE_BASE)
    v2 = release("1.1.0", 3, PROBE_TARGET)
    v2.objects[sha(second)] = second
    srv = Server.of(v0, v1, v2)
    e = engine(
        srv, v0, feed_deltas=lambda: menu_of(entry(PROBE_BASE, PROBE_FRAME), entry(a, second))
    )
    e.load()
    e.ensure_releases([target(v0)])
    e.ensure_releases([target(v1)])
    srv.fetched.clear()
    e.ensure_releases([target(v2)])
    assert payload_of(e) == sha(PROBE_TARGET)
    assert sha(PROBE_FRAME) in srv.fetched
    assert sha(second) not in srv.fetched


def test_a_record_delta_wins_and_a_menu_entry_naming_its_id_is_not_added_twice() -> None:
    v1 = release("1.0.0", 1, PROBE_BASE)
    v2 = release("1.1.0", 2, PROBE_TARGET, {"from": PROBE_BASE, "frame": PROBE_FRAME})
    srv = Server.of(v1, v2)
    e = engine(srv, v1, feed_deltas=lambda: menu_of(entry(PROBE_BASE, PROBE_FRAME)))
    e.load()
    e.ensure_releases([target(v1)])
    srv.fetched.clear()
    e.ensure_releases([target(v2)])
    assert payload_of(e) == sha(PROBE_TARGET)
    assert srv.fetched == [sha(PROBE_FRAME)]


def test_reads_the_menu_at_each_plan_and_a_source_that_raises_is_no_menu() -> None:
    p = pair(PROBE_FRAME)
    srv = Server.of(p["v1"], p["v2"])
    calls = [0]

    def menu() -> Any:
        calls[0] += 1
        raise RuntimeError("no committed feed")

    e = engine(srv, p["v1"], feed_deltas=menu)
    e.load()
    e.ensure_releases([target(p["v1"])])
    srv.fetched.clear()
    e.ensure_releases([target(p["v2"])])
    assert calls[0] > 0
    assert payload_of(e) == sha(PROBE_TARGET)
    assert sha(PROBE_FRAME) not in srv.fetched


def _crash_journal(state: Any, v2: Release, plan_id: str, feed_delta: Optional[Dict[str, Any]]) -> None:
    doc = parse_pack_state(state.text)
    j: Dict[str, Any] = {
        "planId": plan_id,
        "packId": PACK,
        "record": v2.jws,
        "recordSha256": v2.record_sha256,
        "variant": "",
        "strategy": "delta",
        "delta": sha(PROBE_FRAME),
        "objects": [{"sha256": sha(PROBE_FRAME), "bytes": len(PROBE_FRAME), "done": 0}],
        "startedAt": 1759400000,
    }
    if feed_delta is not None:
        j["feedDelta"] = feed_delta
    doc["inflight"][PACK] = j
    state.replace(serialize_pack_state(doc))


def test_a_resumed_journal_plans_its_own_feed_delta_again() -> None:
    # Even when the feed no longer lists it.
    p = pair(PROBE_FRAME)
    srv = Server.of(p["v1"], p["v2"])
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    first = engine(srv, p["v1"], storage=storage, state=state)
    first.load()
    first.ensure_releases([target(p["v1"])])
    # A crash after the journal of a feed-delta install was written.
    _crash_journal(state, p["v2"], "resumed-plan", entry(PROBE_BASE, PROBE_FRAME))
    ids: List[str] = []

    def fresh() -> str:
        ids.append("fresh")
        return "fresh-plan"

    second = engine(
        srv, p["v1"], storage=storage, state=state, feed_deltas=lambda: None, new_plan_id=fresh
    )
    second.load()
    assert second.state().inflight[PACK]["planId"] == "resumed-plan"
    assert parse_pack_state(state.text)["inflight"][PACK]["feedDelta"] == entry(PROBE_BASE, PROBE_FRAME)
    srv.fetched.clear()
    second.ensure_releases([target(p["v2"])])
    assert payload_of(second) == sha(PROBE_TARGET)
    assert srv.fetched == [sha(PROBE_FRAME)]
    assert ids == []


def test_abandons_a_journal_whose_delta_neither_the_record_nor_its_feed_delta_names() -> None:
    p = pair(PROBE_FRAME)
    srv = Server.of(p["v1"], p["v2"])
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    first = engine(srv, p["v1"], storage=storage, state=state)
    first.load()
    first.ensure_releases([target(p["v1"])])
    _crash_journal(state, p["v2"], "stale-plan", None)
    ids: List[str] = []

    def fresh() -> str:
        ids.append("fresh")
        return "fresh-plan"

    second = engine(srv, p["v1"], storage=storage, state=state, new_plan_id=fresh)
    second.load()
    srv.fetched.clear()
    second.ensure_releases([target(p["v2"])])
    assert payload_of(second) == sha(PROBE_TARGET)
    assert len(ids) > 0
    # No menu and no journalled entry: the frame is never planned.
    assert sha(PROBE_FRAME) not in srv.fetched


def test_a_journal_with_a_malformed_feed_delta_is_not_read_back() -> None:
    p = pair(PROBE_FRAME)
    srv = Server.of(p["v1"], p["v2"])
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    first = engine(srv, p["v1"], storage=storage, state=state)
    first.load()
    first.ensure_releases([target(p["v1"])])
    _crash_journal(state, p["v2"], "bad-plan", {**entry(PROBE_BASE, PROBE_FRAME), "scope": "files"})
    assert PACK not in parse_pack_state(state.text)["inflight"]
