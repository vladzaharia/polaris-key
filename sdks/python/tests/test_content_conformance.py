# @pkey-feature packs.index.files packs.apply.full packs.apply.file packs.apply.delta packs.state packs.record update.content packs.index.chunks packs.apply.chunk
"""The content corpus (plans/P4-01.md §4.4, §5; P4-07): ``conformance/corpus/v2/content/``
through the production pack core, as the Node runner (``conformance/runners/node/suites.ts``,
``defineContentSuites``) drives it. ``content/`` is not mirrored: this runner reads it from the
checkout.

=====================  ===================================================  =====================
``blobs``              every file under ``content/blobs/`` against the table harness check
``pathCases``          §2.7's path rules                                    ``check_paths``
``filesIndexCases``    §2.7's ``parseFilesIndex``, steps 1–5                ``parse_files_index``
``packSetIdCases``     §2.9's ``packSetId``                                 ``pack_set_id``
``stampCases``         §2.8's content stamp; P4-13's ``expect.holds``        ``parse_content_stamp``,
                                                                            ``holds_of``
``frameWindowCases``   §2.7 rule 3's header window                          ``frame_window``
``applyCases``         §2.9's appliers, verdicts and counters               ``apply_*``
``chunkIndexCases``    plans/P4-10.md §2.3's ``parseChunkIndex``            ``parse_chunk_index``
=====================  ===================================================  =====================

Content corpus v2 (plans/P4-10.md §4.3) adds ``chunkIndexCases`` and eight ``strategy: chunk``
apply cases, run through P4-11's ``parse_chunk_index`` and ``apply_chunk``: the seeds' indexes
are parsed unbound (``parse_chunk_index_bytes``), each single-range request is answered from the
stored bundle clipped at its end, and the output is an in-memory buffer.

``filesIndexCases``, ``chunkIndexCases`` and ``applyCases`` run once per zstd backend this
interpreter has (``compression.zstd`` on 3.14+, ``zstandard`` where installed).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.core.pack_claims import holds_of

from polaris_key.update.packs import (
    ApplyPorts,
    InstalledFile,
    apply_delta,
    apply_file,
    apply_full,
    check_paths,
    frame_window,
    memory_source,
    pack_set_id,
    parse_content_stamp,
    stamp_holds,
    parse_files_index,
    slice_source,
)
from polaris_key.update.packs.chunk_apply import (
    ApplyChunkPorts,
    ChunkRangeResponse,
    ChunkSeed,
    apply_chunk,
)
from polaris_key.update.packs.chunks import parse_chunk_index, parse_chunk_index_bytes
from polaris_key.update.packs.zstd import PythonZstd, _backends

_CONTENT_DIR = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "content"
_CONTENT: Dict[str, Any] = json.loads((_CONTENT_DIR / "cases.json").read_text(encoding="utf-8"))
_BLOBS_DIR = _CONTENT_DIR / "blobs"

_BACKENDS = [(b.name, PythonZstd(b)) for b in _backends("auto")]
_BLOB_CACHE: Dict[str, bytes] = {}


def _blob(name: str) -> bytes:
    if name not in _BLOB_CACHE:
        _BLOB_CACHE[name] = (_BLOBS_DIR / name).read_bytes()
    return _BLOB_CACHE[name]


def _canonical(v: Any) -> Any:
    """Canonical JSON with integral floats normalised (an ``int`` and ``7.0`` compare equal)."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, dict):
        return {k: _canonical(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_canonical(x) for x in v]
    return v


def _materialise(ref: Dict[str, Any]) -> bytes:
    """A ``<ref>``: a named blob (decoded when ``codec`` is ``zstd``) or ``{text}``, mutated."""
    if "text" in ref:
        data = ref["text"].encode("utf-8")
    else:
        raw = _blob(ref["blob"])
        data = _BACKENDS[0][1].decode(raw, ref["size"]) if ref.get("codec") == "zstd" else raw
    for m in ref.get("mutate", []):
        if m["op"] == "truncate":
            data = data[: m["length"]]
        elif m["op"] == "xor":
            b = bytearray(data)
            b[m["offset"]] ^= m["value"]
            data = bytes(b)
        elif m["op"] in ("putU16", "putU32", "putU64"):
            # plans/P4-10.md §4.2: little-endian; a putU64 value is below 2^53.
            b = bytearray(data)
            width = {"putU16": 2, "putU32": 4, "putU64": 8}[m["op"]]
            b[m["offset"] : m["offset"] + width] = int(m["value"]).to_bytes(width, "little")
            data = bytes(b)
        else:
            raise AssertionError(f"unknown mutation {m!r}")
    return data


#: plans/P4-10.md §4.3: the eight chunk apply cases, every one run through ``apply_chunk`` (P4-11).
_CHUNK_APPLY_CASES = [
    "chunk-v1-to-v2",
    "chunk-no-seed",
    "chunk-tampered-zstd",
    "chunk-tampered-raw",
    "chunk-bundle-truncated",
    "chunk-seed-tampered",
    "chunk-seed-tampered-repair",
    "chunk-index-for-other-payload",
]


def test_content_corpus_has_every_section() -> None:
    assert _CONTENT["contentCorpusVersion"] == 2
    assert len(_CONTENT["pathCases"]) == 18
    assert len(_CONTENT["filesIndexCases"]) == 15
    assert len(_CONTENT["chunkIndexCases"]) == 22
    assert len(_CONTENT["packSetIdCases"]) == 7
    assert len(_CONTENT["stampCases"]) == 10
    assert len(_CONTENT["frameWindowCases"]) == 13
    assert len(_CONTENT["applyCases"]) == 27
    assert _BACKENDS, "no zstd backend"


def test_every_chunk_apply_case_runs() -> None:
    """No silent skip: the chunk apply cases are exactly the corpus's, and ``parity.json``
    declares both chunk features implemented (P4-11)."""
    assert [c["id"] for c in _CONTENT["applyCases"] if c["strategy"] == "chunk"] == _CHUNK_APPLY_CASES
    parity = json.loads((Path(__file__).resolve().parents[1] / "parity.json").read_text(encoding="utf-8"))
    for fid in ("packs.index.chunks", "packs.apply.chunk"):
        assert parity["features"][fid]["status"] == "implemented", fid


@pytest.mark.parametrize(
    "case", _CONTENT["chunkIndexCases"], ids=[c["id"] for c in _CONTENT["chunkIndexCases"]]
)
def test_chunk_index_case_inputs(case: Dict[str, Any]) -> None:
    """The ``<ref>`` (``put*`` included) materialises to the bytes its ``chunks`` ref names,
    except in ``chunks-ref-tampered`` (whose stored frame is the mutated one)."""
    stored = _materialise(case["stored"])
    ref = case["chunks"]
    matches = len(stored) == ref["bytes"] and hashlib.sha256(stored).hexdigest() == ref["sha256"]
    assert matches == (case["id"] != "chunks-ref-tampered"), case["id"]


_CI = [(b, c) for b in _BACKENDS for c in _CONTENT["chunkIndexCases"]]


# @pkey-feature packs.index.chunks
@pytest.mark.parametrize("backend,case", _CI, ids=[f"{b[0]}:{c['id']}" for b, c in _CI])
def test_chunk_index_case(backend: Any, case: Dict[str, Any]) -> None:
    """plans/P4-10.md §2.3: ``parse_chunk_index`` over every chunkIndexCases vector."""
    zstd = backend[1]
    stored = _materialise(case["stored"])
    r = parse_chunk_index(stored, case["chunks"], case["payload"], decode=zstd.decode)
    assert _canonical(r.verdict()) == _canonical(case["expect"]), case["description"]


class _BufferOutput:
    """The chunk applier's output over one in-memory buffer of ``payload.size``."""

    def __init__(self, size: int) -> None:
        self.buf = bytearray(size)

    def write(self, offset: int, data: bytes) -> None:
        self.buf[offset : offset + len(data)] = data

    def read(self, offset: int, length: int) -> bytes:
        return bytes(self.buf[offset : offset + length])


_CA = [(b, c) for b in _BACKENDS for c in _CONTENT["applyCases"] if c["strategy"] == "chunk"]


# @pkey-feature packs.apply.chunk
@pytest.mark.parametrize("backend,case", _CA, ids=[f"{b[0]}:{c['id']}" for b, c in _CA])
def test_chunk_apply_case(backend: Any, case: Dict[str, Any]) -> None:
    """plans/P4-10.md §2.5: ``apply_chunk`` with the case's seeds (each index parsed unbound),
    a fetcher that answers each single-range request from the stored bundle (clipped at its end)
    and an in-memory output. The verdict, counters included, is compared whole."""
    zstd = backend[1]
    store = {h: _materialise(src) for h, src in case["objects"].items()}
    seeds: List[ChunkSeed] = []
    for sd in case.get("seeds") or []:
        p = parse_chunk_index_bytes(_materialise(sd["index"]), None)
        if p.ok:
            seeds.append(ChunkSeed(index=p.index, payload=memory_source(_materialise(sd["payload"]))))

    def objects(h: str) -> Any:
        b = store.get(h)
        return None if b is None else memory_source(b)

    def fetch_range(bundle: str, offset: int, length: int) -> ChunkRangeResponse:
        b = store.get(bundle, b"")
        part = b[min(offset, len(b)) : min(offset + length, len(b))]
        return ChunkRangeResponse(status="ok", chunks=iter([part]))

    out = _BufferOutput(case["variant"]["payload"]["size"])
    r = apply_chunk(
        case["variant"],
        seeds,
        ApplyChunkPorts(objects=objects, zstd=zstd, fetch_range=fetch_range, output=out),
        repair=case.get("repair") is True,
    )
    assert _canonical(r.verdict) == _canonical(case["expect"]), case["description"]
    if r.verdict["ok"]:
        assert hashlib.sha256(bytes(out.buf)).hexdigest() == case["variant"]["payload"]["sha256"]


def test_blobs_match_the_table_and_nothing_else_is_there() -> None:
    found = sorted(
        p.relative_to(_BLOBS_DIR).as_posix() for p in _BLOBS_DIR.rglob("*") if p.is_file()
    )
    assert found == sorted(_CONTENT["blobs"].keys())
    for name, want in _CONTENT["blobs"].items():
        got = _blob(name)
        assert len(got) == want["size"], name
        assert hashlib.sha256(got).hexdigest() == want["sha256"], name


@pytest.mark.parametrize("case", _CONTENT["pathCases"], ids=[c["id"] for c in _CONTENT["pathCases"]])
def test_path_case(case: Dict[str, Any]) -> None:
    got = check_paths(case["paths"]).to_dict()
    assert got == case["expect"], case["description"]


_FI = [(b, c) for b in _BACKENDS for c in _CONTENT["filesIndexCases"]]


@pytest.mark.parametrize("backend,case", _FI, ids=[f"{b[0]}:{c['id']}" for b, c in _FI])
def test_files_index_case(backend: Any, case: Dict[str, Any]) -> None:
    zstd = backend[1]
    stored = _materialise(case["stored"])
    r = parse_files_index(stored, case["files"], {"payload": case["payload"]}, decode=zstd.decode)
    assert _canonical(r.verdict()) == _canonical(case["expect"]), case["description"]


_AP = [(b, c) for b in _BACKENDS for c in _CONTENT["applyCases"] if c["strategy"] != "chunk"]


@pytest.mark.parametrize("backend,case", _AP, ids=[f"{b[0]}:{c['id']}" for b, c in _AP])
def test_apply_case(backend: Any, case: Dict[str, Any]) -> None:
    zstd = backend[1]
    store = {h: _materialise(src) for h, src in case["objects"].items()}

    def objects(h: str) -> Any:
        b = store.get(h)
        return None if b is None else memory_source(b)

    base = b""
    installed: List[InstalledFile] = []
    if "installed" in case:
        base = _materialise(case["installed"]["payload"])
        idx = json.loads(_materialise(case["installed"]["files"]).decode("utf-8"))
        whole = memory_source(base)
        installed = [
            InstalledFile(f["path"], f["sha256"], f["size"], slice_source(whole, f["offset"], f["size"]))
            for f in idx["files"]
        ]
    ports = ApplyPorts(objects=objects, zstd=zstd)
    strategy = case["strategy"]
    if strategy == "full":
        r = apply_full(case["variant"], ports)
    elif strategy == "delta":
        r = apply_delta(
            case["variant"],
            case["delta"],
            memory_source(base),
            ports,
            skip_base_check=case.get("skipBaseCheck") is True,
        )
    elif strategy == "file":
        r = apply_file(case["variant"], case.get("delta"), installed, ports)
    else:
        raise AssertionError(f"unknown strategy {strategy!r} in {case['id']}")
    assert _canonical(r.verdict) == _canonical(case["expect"]), case["description"]


@pytest.mark.parametrize(
    "case", _CONTENT["packSetIdCases"], ids=[c["id"] for c in _CONTENT["packSetIdCases"]]
)
def test_pack_set_id_case(case: Dict[str, Any]) -> None:
    assert {"packSetId": pack_set_id(case["entries"])} == case["expect"], case["description"]


@pytest.mark.parametrize("case", _CONTENT["stampCases"], ids=[c["id"] for c in _CONTENT["stampCases"]])
def test_stamp_case(case: Dict[str, Any]) -> None:
    got = parse_content_stamp(case["stamp"]).to_dict()
    # `parse_content_stamp`'s result is unchanged by P4-13: holds are read beside it
    # (`holds_of`, plans/P4-13.md §2.4), and only checked where `expect.holds` is present.
    want = {k: v for k, v in case["expect"].items() if k != "holds"}
    assert _canonical(got) == _canonical(want), case["description"]
    if "holds" not in case["expect"]:
        return
    doc = json.loads(case["stamp"])
    assert holds_of(doc) == case["expect"]["holds"], case["description"]
    assert stamp_holds(case["stamp"]) == case["expect"]["holds"], case["description"]


@pytest.mark.parametrize(
    "case", _CONTENT["frameWindowCases"], ids=[c["id"] for c in _CONTENT["frameWindowCases"]]
)
def test_frame_window_case(case: Dict[str, Any]) -> None:
    got = {"window": frame_window(bytes.fromhex(case["header"]))}
    assert got == case["expect"], case["description"]
