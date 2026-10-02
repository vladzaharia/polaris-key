# @pkey-feature packs.index.files packs.apply.full packs.apply.file packs.apply.delta packs.state packs.record
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
=====================  ===================================================  =====================

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
        else:
            raise AssertionError(f"unknown mutation {m!r}")
    return data


def test_content_corpus_has_every_section() -> None:
    assert _CONTENT["contentCorpusVersion"] == 1
    assert len(_CONTENT["pathCases"]) == 18
    assert len(_CONTENT["filesIndexCases"]) == 15
    assert len(_CONTENT["packSetIdCases"]) == 7
    assert len(_CONTENT["stampCases"]) == 10
    assert len(_CONTENT["frameWindowCases"]) == 13
    assert len(_CONTENT["applyCases"]) == 19
    assert _BACKENDS, "no zstd backend"


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


_AP = [(b, c) for b in _BACKENDS for c in _CONTENT["applyCases"]]


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
