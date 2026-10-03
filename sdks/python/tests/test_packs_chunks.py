# @pkey-feature packs.apply.chunk packs.index.chunks packs.plan packs.state packs.delegation
"""P4-11's chunk sync through the pack engine (plans/P4-10.md §2.5; the lead's cross-SDK design
§4–§5): the content corpus (``content/`` chunk sections, ``test_content_conformance``) pins the
parser and the applier; these pin what no corpus row can — the seed-index store, the fetch rule,
the planner's chunk candidate going live, one bounded range request per run, the fallback on a
refused range, the run journal and resume, cross-pack seeds, garbage collection of seed indexes,
the exact ``Content-Range`` adapter and the delegated data-only rule.

Fixtures: 64 KiB chunks of deterministic pseudo-random bytes, stored raw (``clen == len``), so
the chunk candidate is cheaper than ``full`` at the planner's request weight.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict, Iterator, List, Optional

import httpx
import pytest

from helpers import BASE_URL, TOKEN, make_client
from pack_fixtures import (
    PRODUCT,
    PRODUCT_TRUST,
    RELEASE_KEYS,
    ChunkServer,
    ContainerPack,
    container_pack,
    content_key_pair,
    delegation_for,
    marker_for,
    sha,
    tree_pack,
)
from polaris_key.constants_generated import ErrorCode
from polaris_key.devices.store import InMemoryStore
from polaris_key.update import UpdateClientOptions
from polaris_key.update.packs import (
    EmbeddedBaseline,
    ObjectResponse,
    PackEngine,
    PackError,
    PackHandler,
    memory_pack_state_store,
    memory_pack_storage,
)
from polaris_key.update.packs.chunk_apply import chunk_range_fetch, chunk_runs, seed_map
from polaris_key.update.packs.client import PacksOptions
from polaris_key.update.packs.storage import DirPackStorage
from polaris_key.update.packs.zstd import select_python_zstd

_ZSTD, _ = select_python_zstd()
_K = 65536
BLOB = PackHandler(type="custom.blob", layout="container", activation="restart", supports=lambda fv: fv == 1)
_plans = [0]


def _plan_id() -> str:
    _plans[0] += 1
    return f"chunk-plan-{_plans[0]}"


def engine(server: ChunkServer, **kw: Any) -> PackEngine:
    opts: Dict[str, Any] = dict(
        product=PRODUCT,
        release_keys=RELEASE_KEYS,
        product_trust=lambda: PRODUCT_TRUST,
        stamp={"contentApi": 1, "pins": [], "expects": []},
        prefs={"engine": None, "axes": {}},
        zstd=_ZSTD,
        mem_budget=1 << 30,
        storage=memory_pack_storage(),
        state=memory_pack_state_store(),
        fetch_record=server.fetch_record,
        fetch_object=server.fetch_object,
        now=lambda: 1759400000,
        new_plan_id=_plan_id,
        handlers=[BLOB],
    )
    opts.update(kw)
    return PackEngine(**opts)


def target(p: Any) -> Dict[str, Any]:
    return {"pack": p.pack_id, "release": {"sha256": p.record_sha256, "seq": p.seq, "version": p.version}}


def release(p: Any) -> Dict[str, Any]:
    return {"sha256": p.record_sha256, "seq": p.seq, "version": p.version}


def stored_payload(e: PackEngine, pack_id: str) -> bytes:
    got = e.open(pack_id)
    if got is None:
        # A restart pack runs at the next boot: read the active install's bytes.
        got = e._storage.installed(e.state().active[pack_id])
    assert got is not None and got.payload is not None
    return got.payload.read(0, got.payload.size)


def v1_v2() -> Dict[str, ContainerPack]:
    v1 = container_pack("djdl.levels", "1.0.0", 1, list("abcdef"), [list("abcdef")])
    # v2 = a g c h i f j: a, c, f stay in v1's bundle B1; the new bundle B2 holds g x h i y j
    # (x, y unused filler), so the runs are [g], [h i], [j].
    v2 = container_pack(
        "djdl.levels",
        "2.0.0",
        2,
        ["a", "g", "c", "h", "i", "f", "j"],
        [list("abcdef"), ["g", "x", "h", "i", "y", "j"]],
    )
    return {"v1": v1, "v2": v2}


def installed_v1(server: ChunkServer, **kw: Any) -> PackEngine:
    p = v1_v2()
    server.add(p["v1"])
    server.add(p["v2"])
    e = engine(server, **kw)
    e.load()
    e.ensure_releases([target(p["v1"])])
    return e


# ── 1. a first install stays full and keeps its index as a seed ──────────────────────────────


def test_v1_installs_by_full_then_its_seed_index_is_stored() -> None:
    p = v1_v2()
    server = ChunkServer.of(p["v1"])
    e = engine(server)
    e.load()
    (install,) = e.ensure_releases([target(p["v1"])])
    assert install["payloadSha256"] == p["v1"].payload_sha256
    assert stored_payload(e, "djdl.levels") == p["v1"].payload
    # No seed existed, so nothing was ranged and the target index was never staged first.
    assert server.range_calls() == []
    fetched = [c["sha256"] for c in server.calls]
    assert fetched == [p["v1"].full_sha256, p["v1"].index_sha256]
    # The backfill after the install: index/<chunks.sha256>, as fetched.
    store = e._storage.chunk_indexes
    assert store.list() == [p["v1"].index_sha256]
    assert store.get(p["v1"].index_sha256) == p["v1"].objects[p["v1"].index_sha256]


# ── 2. v2 installs by chunk with one bounded range request per run ───────────────────────────


def test_v2_installs_by_chunk_with_range_requests_equal_to_plan_requests_minus_one() -> None:
    server = ChunkServer()
    e = installed_v1(server)
    p = v1_v2()
    v2 = p["v2"]
    pre = e._preflight("djdl.levels", release(v2))
    assert pre.plan["strategy"] == "chunk"
    assert pre.plan["requests"] == 4  # the index and three runs
    assert pre.plan["bytes"] == v2.index_bytes + 4 * _K
    server.calls.clear()
    (install,) = e.ensure_releases([target(v2)])
    assert install["version"] == "2.0.0"
    assert stored_payload(e, "djdl.levels") == v2.payload
    ranged = server.range_calls()
    assert len(ranged) == pre.plan["requests"] - 1 == 3
    b2 = v2.bundles[1]
    assert [(c["sha256"], c["offset"], c["length"]) for c in ranged] == [
        (b2, 0, _K),  # [g]
        (b2, 2 * _K, 2 * _K),  # [h i]
        (b2, 5 * _K, _K),  # [j]
    ]
    assert all(c["ifRange"] == f'"{b2}"' for c in ranged)
    # The full payload was never fetched; the chunk index was kept as a seed.
    assert not any(c["sha256"] == v2.full_sha256 for c in server.calls)
    assert e._storage.chunk_indexes.list() == sorted([p["v1"].index_sha256, v2.index_sha256])
    assert e._storage.staging == {}


# ── 3. a 200 to a range request falls back ───────────────────────────────────────────────────


def test_a_200_to_a_range_request_falls_back_and_installs() -> None:
    server = ChunkServer()
    e = installed_v1(server)
    v2 = v1_v2()["v2"]
    assert e._preflight("djdl.levels", release(v2)).plan["strategy"] == "chunk"
    server.range_200 = True
    server.calls.clear()
    (install,) = e.ensure_releases([target(v2)])
    assert install["payloadSha256"] == v2.payload_sha256
    assert stored_payload(e, "djdl.levels") == v2.payload
    # One refused range request (its body never read), then another strategy: full.
    assert len(server.range_calls()) == 1
    assert any(c["sha256"] == v2.full_sha256 and c["length"] is None for c in server.calls)
    assert e.state().inflight == {}


def test_a_206_carrying_another_etag_falls_back_the_same_way() -> None:
    server = ChunkServer()
    e = installed_v1(server)
    v2 = v1_v2()["v2"]
    server.range_etag = '"' + "0" * 64 + '"'
    server.calls.clear()
    e.ensure_releases([target(v2)])
    assert stored_payload(e, "djdl.levels") == v2.payload
    assert len(server.range_calls()) == 1
    assert any(c["sha256"] == v2.full_sha256 for c in server.calls)


# ── 4. an interrupted install resumes and reuses completed runs ──────────────────────────────


def test_an_interrupted_chunk_install_resumes_reusing_completed_runs() -> None:
    server = ChunkServer()
    e = installed_v1(server)
    v2 = v1_v2()["v2"]
    b2 = v2.bundles[1]
    server.calls.clear()
    server.ranged = 0
    server.cut_range = 2  # the [h i] run's body stops after 1,000 bytes
    with pytest.raises(PackError) as ex:
        e.ensure_releases([target(v2)])
    assert ex.value.code == ErrorCode.NETWORK_ERROR
    assert ex.value.detail == "chunk"
    inflight = e.state().inflight["djdl.levels"]
    assert inflight["strategy"] == "chunk"
    journal = json.loads(e._storage.run_journal.read(inflight["planId"]))
    assert journal == {"v": 1, "index": v2.index_sha256, "runs": 3, "bitmap": "01"}

    server.calls.clear()
    server.cut_range = None
    (install,) = e.ensure_releases([target(v2)])
    assert install["version"] == "2.0.0"
    assert stored_payload(e, "djdl.levels") == v2.payload
    # Run 1 ([g]) came from the journal after a re-hash; only runs 2 and 3 were requested.
    assert [(c["offset"], c["length"]) for c in server.range_calls()] == [(2 * _K, 2 * _K), (5 * _K, _K)]
    assert all(c["sha256"] == b2 for c in server.range_calls())
    assert e.state().inflight == {}


def test_a_journalled_run_that_no_longer_hashes_is_refetched() -> None:
    server = ChunkServer()
    e = installed_v1(server)
    v2 = v1_v2()["v2"]
    server.ranged = 0
    server.cut_range = 2
    with pytest.raises(PackError):
        e.ensure_releases([target(v2)])
    plan_id = e.state().inflight["djdl.levels"]["planId"]
    # Damage run 1's bytes in the kept output: the resume must not trust the journal.
    out = e._storage._outputs[plan_id]
    out.container[_K + 5] ^= 0xFF
    server.calls.clear()
    server.cut_range = None
    e.ensure_releases([target(v2)])
    assert stored_payload(e, "djdl.levels") == v2.payload
    assert [(c["offset"], c["length"]) for c in server.range_calls()] == [
        (0, _K),
        (2 * _K, 2 * _K),
        (5 * _K, _K),
    ]


# ── 5. cross-pack seeds ──────────────────────────────────────────────────────────────────────


def test_a_chunk_moved_from_pack_a_to_pack_b_is_copied_from_a() -> None:
    a = container_pack("djdl.music", "1.0.0", 1, ["y", "k", "l"], [["y", "k", "l"]])
    b1 = container_pack("djdl.levels", "1.0.0", 1, list("abcdef"), [list("abcdef")])
    b2 = container_pack(
        "djdl.levels", "2.0.0", 2, ["a", "b", "c", "d", "e", "y", "g"], [["a", "b", "c", "d", "e", "y", "g"]]
    )
    server = ChunkServer.of(a, b1, b2)
    e = engine(server)
    e.load()
    e.ensure_releases([target(a)])
    e.ensure_releases([target(b1)])
    assert sorted(e._storage.chunk_indexes.list()) == sorted([a.index_sha256, b1.index_sha256])
    pre = e._preflight("djdl.levels", release(b2))
    assert pre.plan["strategy"] == "chunk"
    assert [s["packId"] for s in e._chunk_seeds("djdl.levels", pre.installs, pre.seeds)] == [
        "djdl.levels",
        "djdl.music",
    ]
    server.calls.clear()
    e.ensure_releases([target(b2)])
    assert stored_payload(e, "djdl.levels") == b2.payload
    # y came from djdl.music's payload: the only range request is g's.
    bundle, at = b2.located["g"]
    assert [(c["sha256"], c["offset"], c["length"]) for c in server.range_calls()] == [(bundle, at, _K)]
    # GC keeps the seed indexes of root installs only: b1 is previous, a is active.
    assert sorted(e._storage.chunk_indexes.list()) == sorted(
        [a.index_sha256, b1.index_sha256, b2.index_sha256]
    )


def test_an_embedded_baseline_is_a_seed_read_at_offsets(tmp_path: Any) -> None:
    a = container_pack("djdl.music", "1.0.0", 1, ["y", "k", "l"], [["y", "k", "l"]])
    b1 = container_pack("djdl.levels", "1.0.0", 1, list("abcdef"), [list("abcdef")])
    b2 = container_pack(
        "djdl.levels", "2.0.0", 2, ["a", "b", "c", "d", "e", "y", "g"], [["a", "b", "c", "d", "e", "y", "g"]]
    )
    shipped = tmp_path / "music.pck"
    shipped.write_bytes(a.payload)
    server = ChunkServer.of(a, b1, b2)
    storage = DirPackStorage(str(tmp_path / "packs"))
    e = engine(server, storage=storage, state=storage.state_store())
    assert e.load(
        [
            EmbeddedBaseline(
                marker=marker_for(a),  # type: ignore[arg-type]
                payload={"kind": "file", "sha256": a.payload_sha256, "size": len(a.payload)},
                location=str(shipped),
            )
        ]
    ) == {"refused": []}
    e.ensure_releases([target(b1)])
    # The backfill keeps the embedded baseline's index too (fetched by hash, verified).
    assert sorted(storage.chunk_indexes.list()) == sorted([a.index_sha256, b1.index_sha256])
    server.calls.clear()
    e.ensure_releases([target(b2)])
    with open(f"{e.state().active['djdl.levels']['location']}/payload.bin", "rb") as f:
        assert f.read() == b2.payload
    bundle, at = b2.located["g"]
    assert [(c["sha256"], c["offset"], c["length"]) for c in server.range_calls()] == [(bundle, at, _K)]
    assert not (tmp_path / "packs" / "staging").exists() or list((tmp_path / "packs" / "staging").iterdir()) == []


def test_seed_indexes_of_installs_no_longer_rooted_are_collected() -> None:
    v1 = container_pack("djdl.levels", "1.0.0", 1, list("abcdef"), [list("abcdef")])
    v2 = container_pack("djdl.levels", "2.0.0", 2, list("abcdeg"), [list("abcdeg")])
    v3 = container_pack("djdl.levels", "3.0.0", 3, list("abcdeh"), [list("abcdeh")])
    server = ChunkServer.of(v1, v2, v3)
    e = engine(server)
    e.load()
    for p in (v1, v2, v3):
        e.ensure_releases([target(p)])
    # v1 is neither active nor previous any more: its index went with its payload.
    assert sorted(e._storage.chunk_indexes.list()) == sorted([v2.index_sha256, v3.index_sha256])


def test_a_stored_seed_index_that_does_not_verify_is_never_a_seed() -> None:
    server = ChunkServer()
    e = installed_v1(server)
    v1, v2 = v1_v2()["v1"], v1_v2()["v2"]
    bad = bytearray(e._storage.chunk_indexes.get(v1.index_sha256))
    bad[-1] ^= 1
    e._storage.chunk_indexes.put(v1.index_sha256, bytes(bad))
    assert e._preflight("djdl.levels", release(v2)).plan["strategy"] == "full"


def test_without_chunk_in_strategies_nothing_is_staged_or_kept() -> None:
    p = v1_v2()
    server = ChunkServer.of(p["v1"], p["v2"])
    e = engine(server, strategies=["delta", "file", "full"])
    e.load()
    e.ensure_releases([target(p["v1"])])
    e.ensure_releases([target(p["v2"])])
    assert e._storage.chunk_indexes.list() == []
    assert server.range_calls() == []


# ── 6. delegated releases never take the chunk strategy ──────────────────────────────────────


def test_a_delegated_tree_with_chunks_never_plans_chunk_and_keeps_the_data_only_rule() -> None:
    ck = content_key_pair()
    d = delegation_for("djdl.events", ck["pub"])
    pack = tree_pack(
        "djdl.events.halloween",
        "1.0.0",
        1,
        {"a.json": "{}", "b.json": "[gd_resource]"},
        issued_at=1759250000,
        signer={"pem": ck["pem"], "kid": d["kid"]},
        variant_extra={
            "chunks": {
                "format": "pkey-chunks/1",
                "sha256": sha("chunk index"),
                "bytes": 64,
                "size": 64,
                "codec": "none",
            }
        },
    )
    # A container seed with a stored index exists, so only the delegated rule keeps chunk out.
    seed = v1_v2()["v1"]
    server = ChunkServer.of(seed, pack)
    records = dict(server.records)
    records[d["sha256"]] = d["jws"]
    e = engine(server, fetch_record=lambda h: {"ok": True, "body": records[h]} if h in records else {"ok": False, "code": "not_found"})
    e.load()
    e.ensure_releases([target(seed)])
    assert e._storage.chunk_indexes.list() == [seed.index_sha256]
    server.calls.clear()
    with pytest.raises(PackError) as ex:
        e.ensure_releases([target(pack)])
    assert ex.value.code == ErrorCode.PACK_NOT_DATA_ONLY
    assert ex.value.detail == "content" and ex.value.path == "b.json"
    assert server.range_calls() == []
    assert not any(c["sha256"] == sha("chunk index") for c in server.calls)


# ── the exact Content-Range adapter ──────────────────────────────────────────────────────────


class _Body:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.read = False
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        self.read = True
        yield self.data

    def close(self) -> None:
        self.closed = True


_B = "ab" * 32


def _answer(status: int, cr: Optional[str], etag: Optional[str] = f'"{_B}"', data: bytes = b"0123456789") -> Any:
    seen: Dict[str, Any] = {}
    body = _Body(data)

    def fetch(sha256: str, offset: int, if_range: Optional[str], length: Optional[int] = None) -> ObjectResponse:
        seen.update(sha256=sha256, offset=offset, ifRange=if_range, length=length)
        return ObjectResponse(status=status, content_range=cr, chunks=body, etag=etag)

    return fetch, seen, body


@pytest.mark.parametrize(
    "status,cr,etag,want",
    [
        (206, "bytes 10-19/100", f'"{_B}"', b"0123456789"),  # exact
        (206, "bytes 10-19/100", None, b"0123456789"),  # no ETag reported
        (206, "bytes 10-14/15", f'"{_B}"', b"01234"),  # clipped at the object's end
        (206, " bytes 10-19/100 ", f'"{_B}"', b"0123456789"),  # surrounding blanks trimmed
    ],
)
def test_chunk_range_fetch_accepts_only_the_exact_range(status: int, cr: str, etag: Any, want: bytes) -> None:
    fetch, seen, _ = _answer(status, cr, etag, data=b"0123456789extra")
    r = chunk_range_fetch(fetch)(_B, 10, 10)
    assert seen == {"sha256": _B, "offset": 10, "ifRange": f'"{_B}"', "length": 10}
    assert r.status == "ok"
    assert b"".join(r.chunks) == want  # cut at the accepted length


@pytest.mark.parametrize(
    "status,cr,etag",
    [
        (200, None, f'"{_B}"'),  # Range ignored
        (206, None, f'"{_B}"'),  # no Content-Range
        (206, "bytes 11-19/100", f'"{_B}"'),  # another start
        (206, "bytes 10-18/100", f'"{_B}"'),  # short of the end without being the object's end
        (206, "bytes 10-25/100", f'"{_B}"'),  # longer than asked
        (206, "bytes 10-19/19", f'"{_B}"'),  # end not inside the object
        (206, "bytes 10-19/*", f'"{_B}"'),  # unknown size
        (206, "bytes 10-19/100", '"other"'),  # another ETag
        (206, "bytes 10-19/100", f'W/"{_B}"'),  # a weak tag
        (206, "bytes 0-4/100, 10-19/100", f'"{_B}"'),  # multipart-ish
        (206, "bytes 10-19/12345678901234567", f'"{_B}"'),  # over 16 digits
    ],
)
def test_chunk_range_fetch_refuses_anything_else_without_reading_the_body(status: int, cr: Any, etag: Any) -> None:
    fetch, _, body = _answer(status, cr, etag)
    r = chunk_range_fetch(fetch)(_B, 10, 10)
    assert r.status == "refused"
    assert body.read is False and body.closed is True


def test_chunk_runs_and_seed_map_follow_the_planner_rule() -> None:
    # a seeded record between two contiguous fetched ones does not break the run; a duplicate is
    # fetched once.
    recs = [["s", 4, 4, 0, 0], ["f1", 4, 4, 0, 0], ["s", 4, 4, 0, 99], ["f2", 4, 4, 0, 4], ["f1", 4, 4, 0, 0], ["f3", 4, 4, 0, 12]]
    runs = chunk_runs(recs, {"s"})
    assert [(r.bundle, r.offset, r.length, r.records) for r in runs] == [(0, 0, 8, [1, 3]), (0, 12, 4, [5])]
    from polaris_key.update.packs.chunk_apply import ChunkSeed
    from polaris_key.update.packs.ports import memory_source

    seeds = [
        ChunkSeed(index={"records": [["x", 3], ["y", 5]]}, payload=memory_source(b"")),
        ChunkSeed(index={"records": [["y", 2], ["z", 1]]}, payload=memory_source(b"")),
    ]
    assert seed_map(seeds) == {"x": (0, 0), "y": (0, 3), "z": (1, 2)}


# ── through the Python client: httpx, DirPackStorage, the bounded Range request ──────────────


class BlobServer:
    """A Worker stand-in for container packs: discovery, records and blobs by hash with bounded
    ``Range`` (``bytes=o-e``), ``If-Range`` and ``ETag``."""

    def __init__(self, packs: List[ContainerPack]) -> None:
        self.packs = packs
        self.seen: List[Dict[str, Any]] = []
        self.drop_range: Optional[int] = None
        self.ranged = 0

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        b = BASE_URL
        if path == f"/{PRODUCT}/.well-known/polaris.json":
            return httpx.Response(
                200,
                json={
                    "version": 2,
                    "protocolVersion": 4,
                    "product": PRODUCT,
                    "baseUrl": b,
                    "services": {
                        "license": {"enabled": False},
                        "config": {"enabled": False},
                        "release": {"enabled": True, "endpoints": {"record": f"{b}/{PRODUCT}/release/records/{{sha256}}"}},
                        "distribution": {"enabled": True, "endpoints": {"blobs": f"{b}/{PRODUCT}/distribution/blobs/sha256/{{sha256}}"}},
                        "update": {"enabled": True, "endpoints": {"feed": f"{b}/{PRODUCT}/update/{{channel}}/feed.jws"}},
                        "identity": {"enabled": False},
                    },
                },
            )
        m = re.fullmatch(r"/djdl/release/records/([0-9a-f]{64})", path)
        if m:
            p = next((x for x in self.packs if x.record_sha256 == m.group(1)), None)
            if p is None:
                return httpx.Response(404)
            return httpx.Response(200, content=p.jws.encode(), headers={"content-type": "application/jose"})
        m = re.fullmatch(r"/djdl/distribution/blobs/sha256/([0-9a-f]{64})", path)
        if not m:
            return httpx.Response(404)
        h = m.group(1)
        rng = req.headers.get("range")
        self.seen.append(
            {
                "sha256": h,
                "range": rng,
                "ifRange": req.headers.get("if-range"),
                "acceptEncoding": req.headers.get("accept-encoding"),
                "auth": req.headers.get("authorization"),
            }
        )
        data = next((p.objects[h] for p in self.packs if h in p.objects), None)
        if data is None:
            return httpx.Response(404)
        etag = f'"{h}"'
        headers = {"etag": etag, "accept-ranges": "bytes"}
        bounded = re.fullmatch(r"bytes=(\d+)-(\d+)", rng or "")
        if bounded and req.headers.get("if-range") in (None, etag):
            self.ranged += 1
            o, e = int(bounded.group(1)), min(int(bounded.group(2)), len(data) - 1)
            headers["content-range"] = f"bytes {o}-{e}/{len(data)}"
            return httpx.Response(206, headers=headers, content=data[o : e + 1])
        return httpx.Response(200, headers=headers, content=data)

    def ranged_requests(self) -> List[Dict[str, Any]]:
        return [s for s in self.seen if s["range"] is not None and re.fullmatch(r"bytes=\d+-\d+", s["range"])]


def _client(srv: BlobServer, work: Any, pin: ContainerPack) -> Any:
    stamp_path = work / f"stamp-{pin.version}.json"
    stamp_path.write_text(
        json.dumps(
            {
                "format": "pkey-content/1",
                "contentApi": 1,
                "pins": [{"pack": pin.pack_id, "release": release(pin)}],
                "expects": [{"pack": pin.pack_id, "required": True, "delivery": "essential"}],
            }
        )
    )
    store = InMemoryStore(PRODUCT)
    store.set_token(TOKEN)
    c = make_client(
        srv,
        store=store,
        trust=PRODUCT_TRUST,
        data_dir=str(work / "data"),
        expected_services=["release", "distribution", "update"],
        update=UpdateClientOptions(
            pinned_release_keys=RELEASE_KEYS,
            outlet="direct",
            packs=PacksOptions(content_stamp=str(stamp_path), handlers=[BLOB], exclude_from_backup=False),
        ),
    )
    c.discover()
    return c


def test_the_python_client_syncs_chunks_with_bounded_ranges_into_the_directory_store(tmp_path: Any) -> None:
    p = v1_v2()
    v1, v2 = p["v1"], p["v2"]
    srv = BlobServer([v1, v2])
    c = _client(srv, tmp_path, v1)
    c.update.packs.ensure(["djdl.levels"])
    root = str(tmp_path / "data" / PRODUCT / "packs")
    with open(f"{root}/index/{v1.index_sha256}", "rb") as f:
        assert f.read() == v1.objects[v1.index_sha256]
    c.close()

    srv.seen.clear()
    c = _client(srv, tmp_path, v2)
    (install,) = c.update.packs.ensure(["djdl.levels"])
    assert install["version"] == "2.0.0"
    with open(f"{install['location']}/payload.bin", "rb") as f:
        assert hashlib.sha256(f.read()).hexdigest() == v2.payload_sha256
    ranged = srv.ranged_requests()
    b2 = v2.bundles[1]
    assert [(s["sha256"], s["range"]) for s in ranged] == [
        (b2, f"bytes=0-{_K - 1}"),
        (b2, f"bytes={2 * _K}-{4 * _K - 1}"),
        (b2, f"bytes={5 * _K}-{6 * _K - 1}"),
    ]
    for s in ranged:
        assert s["ifRange"] == f'"{b2}"'
        assert s["acceptEncoding"] == "identity"
        assert s["auth"] == f"Bearer {TOKEN}"
    assert not any(s["sha256"] == v2.full_sha256 for s in srv.seen)
    assert sorted(DirPackStorage(root).chunk_indexes.list()) == sorted([v1.index_sha256, v2.index_sha256])
    c.close()
