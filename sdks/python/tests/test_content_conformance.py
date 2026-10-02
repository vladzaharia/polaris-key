# @pkey-feature packs.index.files packs.apply.full packs.apply.file packs.apply.delta packs.state packs.record packs.index.chunks packs.apply.chunk
"""The content corpus (plans/P4-01.md §4.4, §5; P4-07): ``conformance/corpus/v2/content/``
through the production pack core, as the Node runner (``conformance/runners/node/suites.ts``,
``defineContentSuites``) drives it. ``content/`` is not mirrored: this runner reads it from the
checkout.

=====================  ===================================================  =====================
``blobs``              every file under ``content/blobs/`` against the table harness check
``pathCases``          §2.7's path rules                                    ``check_paths``
``filesIndexCases``    §2.7's ``parseFilesIndex``, steps 1–5                ``parse_files_index``
``packSetIdCases``     §2.9's ``packSetId``                                 ``pack_set_id``
``stampCases``         §2.8's content stamp                                 ``parse_content_stamp``
``frameWindowCases``   §2.7 rule 3's header window                          ``frame_window``
``applyCases``         §2.9's appliers, verdicts and counters               ``apply_*``
``chunkIndexCases``    plans/P4-10.md §2.3 (planned: P4-11)                 materialised only
=====================  ===================================================  =====================

Content corpus v2 (plans/P4-10.md §4.3) adds ``chunkIndexCases`` and eight ``strategy: chunk``
apply cases. Python's parser and applier are P4-11's: both are declared planned by exact id (and
in ``parity.json``), never skipped silently; their ``<ref>`` inputs (the ``put*`` mutations
included) are materialised and checked against their refs here.

``filesIndexCases`` and ``applyCases`` run once per zstd backend this interpreter has
(``compression.zstd`` on 3.14+, ``zstandard`` where installed).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

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
    parse_files_index,
    slice_source,
)
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


#: plans/P4-10.md §4.3: the sections Python declares planned until P4-11, by exact id.
_CHUNK_INDEX_PLANNED = [
    "chunks-v1-valid",
    "chunks-v2-valid",
    "chunks-short-header",
    "chunks-bad-magic",
    "chunks-bad-version",
    "chunks-bad-record-size",
    "chunks-bad-flags",
    "chunks-bad-length",
    "chunks-bad-length-count",
    "chunks-zero-length",
    "chunks-bad-clen",
    "chunks-bad-bundle-ref",
    "chunks-bad-bundle-range",
    "chunks-reserved-nonzero",
    "chunks-size-mismatch",
    "chunks-zero-clen",
    "chunks-bad-length-wrap",
    "chunks-size-high-word",
    "chunks-ref-tampered",
    "chunks-ref-over-max",
    "chunks-payload-mismatch",
    "chunks-bundle-size-saturated",
]
_CHUNK_APPLY_PLANNED = [
    "chunk-v1-to-v2",
    "chunk-no-seed",
    "chunk-tampered-zstd",
    "chunk-tampered-raw",
    "chunk-bundle-truncated",
    "chunk-seed-tampered",
    "chunk-seed-tampered-repair",
    "chunk-index-for-other-payload",
]
_PLANNED = "planned: P4-11 (packs.index.chunks, packs.apply.chunk)"


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


def test_chunk_sections_are_declared_planned_by_exact_id() -> None:
    """No silent skip: the planned lists are exactly the corpus's chunk cases, and
    ``parity.json`` declares both features planned in P4-11."""
    assert [c["id"] for c in _CONTENT["chunkIndexCases"]] == _CHUNK_INDEX_PLANNED
    assert [c["id"] for c in _CONTENT["applyCases"] if c["strategy"] == "chunk"] == _CHUNK_APPLY_PLANNED
    parity = json.loads((Path(__file__).resolve().parents[1] / "parity.json").read_text(encoding="utf-8"))
    for fid in ("packs.index.chunks", "packs.apply.chunk"):
        assert parity["features"][fid] == {"status": "planned", "wp": "P4-11"}, fid


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


@pytest.mark.skip(reason=_PLANNED)
@pytest.mark.parametrize("case_id", _CHUNK_INDEX_PLANNED)
def test_chunk_index_case(case_id: str) -> None:  # pragma: no cover - P4-11
    raise AssertionError(case_id)


@pytest.mark.skip(reason=_PLANNED)
@pytest.mark.parametrize("case_id", _CHUNK_APPLY_PLANNED)
def test_chunk_apply_case(case_id: str) -> None:  # pragma: no cover - P4-11
    raise AssertionError(case_id)


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
    # `parse_content_stamp`'s result is unchanged by P4-13: `expect.holds`, where present, is
    # `holdsOf` over the parsed stamp (plans/P4-13.md §2.4), which P4-23 ports and checks.
    want = {k: v for k, v in case["expect"].items() if k != "holds"}
    assert _canonical(got) == _canonical(want), case["description"]


@pytest.mark.parametrize(
    "case", _CONTENT["frameWindowCases"], ids=[c["id"] for c in _CONTENT["frameWindowCases"]]
)
def test_frame_window_case(case: Dict[str, Any]) -> None:
    got = {"window": frame_window(bytes.fromhex(case["header"]))}
    assert got == case["expect"], case["description"]
