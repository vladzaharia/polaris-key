"""Variant selection and target mapping (plans/P4-01.md §2.9; WIRE-CONTRACT-V4 §11.4), a port
of client-core's ``packs/select.ts``. ``plan-matrix.json#variantCases`` pins
:func:`select_variant` and ``#targetCases`` pins :func:`plan_target`. Records are the verified
JSON objects (``dict``); a target is the plan-matrix shape (``dict``).
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence

from ...constants_generated import FILES_FORMAT, MAX_FILES_INDEX_BYTES, ErrorCode

__all__ = [
    "usable_codec",
    "index_readable",
    "index_rebuildable",
    "variant_usable",
    "select_variant",
    "plan_target",
]


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def usable_codec(codec: Any) -> bool:
    """An object ref is usable when its codec is ``zstd`` or ``none``."""
    return codec == "zstd" or codec == "none"


def index_readable(files: Any) -> bool:
    """``files.format`` is ``pkey-files/1``, its ref usable and ``files.size`` ≤
    ``MAX_FILES_INDEX_BYTES``."""
    return (
        isinstance(files, dict)
        and files.get("format") == FILES_FORMAT
        and usable_codec(files.get("codec"))
        and _num(files.get("size"))
        and files["size"] <= MAX_FILES_INDEX_BYTES
    )


def index_rebuildable(files: Any) -> bool:
    """A readable index and, for a container, a usable gaps ref."""
    if not index_readable(files):
        return False
    if files.get("layout") != "container":
        return True
    gaps = files.get("gaps")
    return isinstance(gaps, dict) and usable_codec(gaps.get("codec"))


def variant_usable(variant: Any) -> bool:
    """``container``, or ``tree`` with a readable index."""
    if not isinstance(variant, dict) or not isinstance(variant.get("files"), dict):
        return False
    layout = variant["files"].get("layout")
    if layout == "container":
        return True
    return layout == "tree" and index_readable(variant["files"])


def _bkey(s: str) -> bytes:
    return s.encode("utf-8", "surrogatepass")


def select_variant(variants: Sequence[Any], prefs: Mapping[str, Any]) -> Dict[str, Any]:
    """``selectVariant(variants, {engine, axes})``: a variant is eligible when usable, its
    ``requires.engine`` is absent or equals the host's ``engine``, and every axis it declares
    has a host preference list containing its value. The lowest tuple of preference indexes
    over the axis names in byte order wins; ties keep the earlier variant. Returns
    ``{"index": i}`` or ``{"error": "pack-no-variant"}``."""
    engine = prefs.get("engine")
    axes = prefs.get("axes") or {}
    best: Optional[List[Any]] = None
    for i, v in enumerate(variants):
        if not variant_usable(v):
            continue
        req = v.get("requires")
        if isinstance(req, dict) and "engine" in req and req["engine"] != engine:
            continue
        sel = v.get("variant") if isinstance(v.get("variant"), dict) else {}
        key: List[int] = []
        eligible = True
        for axis in sorted(sel.keys(), key=_bkey):
            lst = axes.get(axis) if isinstance(axes, Mapping) else None
            k = -1
            if isinstance(lst, (list, tuple)):
                for j, value in enumerate(lst):
                    if value == sel[axis]:
                        k = j
                        break
            if k < 0:
                eligible = False
                break
            key.append(k)
        if not eligible:
            continue
        if best is None or _lex_less(key, best[1]):
            best = [i, key]
    if best is None:
        return {"error": ErrorCode.PACK_NO_VARIANT}
    return {"index": best[0]}


def _lex_less(x: List[int], y: List[int]) -> bool:
    for j in range(len(x)):
        a = x[j]
        b = y[j] if j < len(y) else None
        if a != b:
            return b is not None and a < b
    return False


def plan_target(
    variant: Mapping[str, Any], record_sha256: str, files_index: Optional[Mapping[str, Any]]
) -> Dict[str, Any]:
    """``planTarget(variant, recordSha256, filesIndex | None)``: a variant onto the planner's
    input. An unusable variant maps to no candidate at all. ``full`` needs a usable ref whose
    size is the payload's (a tree's costs its index too, in two requests); ``files`` needs a
    readable (container: rebuildable) index; a ``payload`` delta is kept on a container, a
    ``files`` delta when ``files`` is kept and its ``patch`` ref is usable."""
    payload = variant["payload"]
    if not variant_usable(variant):
        return {
            "release": record_sha256,
            "payload": payload,
            "full": None,
            "platform": None,
            "chunks": None,
            "files": None,
            "deltas": [],
        }
    files = variant["files"]
    container = files["layout"] == "container"
    full = variant.get("full")
    full_t: Optional[Dict[str, Any]] = None
    if isinstance(full, dict) and usable_codec(full.get("codec")) and full.get("size") == payload["size"]:
        full_t = (
            {"bytes": full["bytes"], "requests": 1}
            if container
            else {"bytes": full["bytes"] + files["bytes"], "requests": 2}
        )
    files_t: Optional[Dict[str, Any]] = None
    if files_index is not None and index_rebuildable(files):
        files_t = {
            "indexBytes": files["bytes"],
            "gapsBytes": files["gaps"]["bytes"] if container else 0,
            "files": [
                {"sha256": f["sha256"], "blobBytes": f["blob"]["bytes"]}
                for f in files_index["files"]
            ],
        }
    deltas: List[Dict[str, Any]] = []
    for d in variant.get("deltas") or []:
        if d.get("scope") == "payload" and container:
            deltas.append(
                {
                    "id": d["artifact"]["sha256"],
                    "method": d["method"],
                    "from": d["from"],
                    "memBytes": d["memBytes"],
                    "artifacts": [
                        {"sha256": d["artifact"]["sha256"], "bytes": d["artifact"]["bytes"]}
                    ],
                }
            )
        elif (
            d.get("scope") == "files"
            and files_t is not None
            and isinstance(d.get("patch"), dict)
            and usable_codec(d["patch"].get("codec"))
        ):
            artifacts = [{"sha256": files["sha256"], "bytes": files["bytes"]}]
            if container:
                artifacts.append({"sha256": files["gaps"]["sha256"], "bytes": files["gaps"]["bytes"]})
            artifacts.append({"sha256": d["patch"]["sha256"], "bytes": d["patch"]["bytes"]})
            artifacts.append({"sha256": d["data"]["sha256"], "bytes": d["data"]["bytes"]})
            deltas.append(
                {
                    "id": d["patch"]["sha256"],
                    "method": d["method"],
                    "from": d["from"],
                    "memBytes": d["memBytes"],
                    "artifacts": artifacts,
                }
            )
    return {
        "release": record_sha256,
        "payload": payload,
        "full": full_t,
        "platform": None,
        "chunks": None,
        "files": files_t,
        "deltas": deltas,
    }
