"""``pkey-patch/1``, the descriptor of a ``files``-scope delta set (plans/P4-01.md §2.7), and the
one object-ref opener every applier shares. A port of client-core's ``packs/patch.ts``.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

from ...constants_generated import MAX_FILES_INDEX_BYTES, MAX_INDEX_FILES, PATCH_FORMAT
from ...core.models import _wire_int
from ...core.pack_claims import is_sha256
from .files import strict_parse
from .ports import ByteSource, Sha256Port, ZstdPort, read_all, sha256_of

__all__ = ["open_object", "parse_patch"]


def open_object(
    stored: Optional[ByteSource],
    ref: Mapping[str, Any],
    zstd: ZstdPort,
    sha256: Sha256Port,
    max_size: Optional[int] = None,
) -> Optional[bytes]:
    """A stored object against its ref, then its decoded bytes: the stored length and SHA-256
    must equal the ref's, the codec be ``zstd`` (decoded to exactly ``size``) or ``none``.
    ``None`` on any failure, the caller's code. ``max_size`` refuses a larger ``ref.size``
    before a byte is read."""
    if stored is None:
        return None
    size = ref.get("size")
    if max_size is not None and not (isinstance(size, (int, float)) and size <= max_size):
        return None
    codec = ref.get("codec")
    if codec != "zstd" and codec != "none":
        return None
    if stored.size != ref.get("bytes"):
        return None
    data = read_all(stored)
    if len(data) != ref.get("bytes"):
        return None
    if sha256_of(sha256, data) != ref.get("sha256"):
        return None
    if codec == "none":
        out = data
    else:
        try:
            out = zstd.decode(data, int(size))  # type: ignore[arg-type]
        except Exception:
            return None
    if isinstance(out, (bytes, bytearray)) and len(out) == size:
        return bytes(out)
    return None


def parse_patch(
    stored: Optional[ByteSource],
    delta: Mapping[str, Any],
    target_payload_sha256: str,
    target: Mapping[str, Any],
    zstd: ZstdPort,
    sha256: Sha256Port,
) -> Optional[Dict[str, Any]]:
    """``parsePatch(stored, delta, targetPayloadSha256, targetIndex)`` (§2.7): the descriptor of
    a ``files`` delta set, or ``None`` — the caller's ``delta-artifact-mismatch``. Never
    raises."""
    try:
        pr = delta["patch"]
        data = delta["data"]
        decoded = open_object(stored, pr, zstd, sha256, MAX_FILES_INDEX_BYTES)
        if decoded is None:
            return None
        doc = strict_parse(decoded)
        if not isinstance(doc, dict):
            return None
        if doc.get("format") != PATCH_FORMAT or doc.get("scope") != "files":
            return None
        if doc.get("method") != delta.get("method") or doc.get("from") != delta.get("from"):
            return None
        if doc.get("to") != target_payload_sha256:
            return None
        d = doc.get("data")
        if not isinstance(d, dict) or d.get("sha256") != data["sha256"]:
            return None
        if _wire_int(d.get("bytes"), 0) is None:
            return None
        if d["bytes"] != data["bytes"]:
            return None
        lst = doc.get("entries")
        if not isinstance(lst, list) or len(lst) > MAX_INDEX_FILES:
            return None
        by_path = {f["path"]: i for i, f in enumerate(target["files"])}
        seen = set()
        last_index = -1
        end = 0
        for e in lst:
            if not isinstance(e, dict) or not isinstance(e.get("path"), str) or e["path"] in seen:
                return None
            seen.add(e["path"])
            ti = by_path.get(e["path"])
            if ti is None or ti <= last_index:
                return None
            last_index = ti
            tf = target["files"][ti]
            if e.get("to") != tf["sha256"]:
                return None
            if _wire_int(e.get("size"), 0) is None or e["size"] != tf["size"]:
                return None
            if _wire_int(e.get("offset"), 0) is None:
                return None
            if _wire_int(e.get("length"), 0) is None:
                return None
            if e["offset"] < end:
                return None
            end = e["offset"] + e["length"]
            op = e.get("op")
            if op == "delta":
                if not is_sha256(e.get("from")):
                    return None
            elif op == "blob":
                if e.get("codec") == "none":
                    if e["length"] != e["size"]:
                        return None
                elif e.get("codec") != "zstd":
                    return None
            else:
                return None
        if end > data["bytes"]:
            return None
        return doc
    except Exception:
        return None
