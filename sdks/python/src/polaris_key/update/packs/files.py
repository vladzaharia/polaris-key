"""The files index, ``pkey-files/1``, its path rules and ``tree_digest`` (plans/P4-01.md §2.7;
WIRE-CONTRACT-V4 §2.6). A port of client-core's ``packs/files.ts``. Pure over bytes; the zstd
decoder is the caller's.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

from ...constants_generated import (
    FILES_FORMAT,
    MAX_FILES_INDEX_BYTES,
    MAX_INDEX_FILES,
    MAX_PACK_PATH_BYTES,
    ErrorCode,
)
from ...core.jws import _parse_strict_json
from ...core.models import _wire_int
from ...core.pack_claims import compare_bytes, is_sha256, utf8_length

__all__ = [
    "CheckPathsResult",
    "ParseFilesIndexResult",
    "ZstdDecode",
    "check_paths",
    "parse_files_index",
    "strict_parse",
    "tree_digest",
    "sha256_hex",
]

_BAD_CHARS = frozenset('\\:*?"<>|')
_DEVICES = frozenset(
    ["con", "prn", "aux", "nul"]
    + [f"com{d}" for d in "123456789"]
    + [f"lpt{d}" for d in "123456789"]
)


def _ascii_lower(s: str) -> str:
    """ASCII-only lowercase: paths are ASCII by rule 2, so nothing else needs folding."""
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def _path_safe(path: str) -> bool:
    """Path rules 1–3 (A7 §3.3) and the ``.pkey`` addition (plans/P4-01.md §2.7)."""
    n = utf8_length(path)
    if n < 1 or n > MAX_PACK_PATH_BYTES:
        return False
    for c in path:
        o = ord(c)
        if o < 0x20 or o > 0x7E or c in _BAD_CHARS:
            return False
    segments = path.split("/")
    if _ascii_lower(segments[0]) == ".pkey":
        return False
    for s in segments:
        if s in ("", ".", ".."):
            return False
        if s.endswith(" ") or s.endswith("."):
            return False
        if _ascii_lower(s.split(".")[0]) in _DEVICES:
            return False
    return True


@dataclass(frozen=True)
class CheckPathsResult:
    ok: bool
    error: Optional[str] = None
    path: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        if self.ok:
            return {"ok": True}
        return {"ok": False, "error": self.error, "path": self.path}


def check_paths(paths: Sequence[Any]) -> CheckPathsResult:
    """The path rules, in order (plans/P4-01.md §2.7): rules 1–3 or a first segment ``.pkey``
    (any case) → ``files-unsafe-path``; an exact duplicate → ``files-duplicate-path``; an
    ASCII-case-insensitive duplicate → ``files-case-collision``; a path that is a directory
    prefix of another, or has one as its prefix (case-insensitively) → ``files-path-conflict``.
    The later path is reported."""
    seen: set = set()
    lower: set = set()
    dirs: set = set()
    for path in paths:
        if not isinstance(path, str) or not _path_safe(path):
            return CheckPathsResult(False, ErrorCode.FILES_UNSAFE_PATH, _js_string(path))
        if path in seen:
            return CheckPathsResult(False, ErrorCode.FILES_DUPLICATE_PATH, path)
        lp = _ascii_lower(path)
        if lp in lower:
            return CheckPathsResult(False, ErrorCode.FILES_CASE_COLLISION, path)
        parts = lp.split("/")
        prefixes = ["/".join(parts[:k]) for k in range(1, len(parts))]
        if lp in dirs or any(x in lower for x in prefixes):
            return CheckPathsResult(False, ErrorCode.FILES_PATH_CONFLICT, path)
        seen.add(path)
        lower.add(lp)
        dirs.update(prefixes)
    return CheckPathsResult(True)


def _js_string(v: Any) -> str:
    """JavaScript's ``String(v)`` for the JSON values a path list can hold."""
    if isinstance(v, str):
        return v
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        return ",".join("" if x is None else _js_string(x) for x in v)
    return "[object Object]"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def tree_digest(files: Iterable[Mapping[str, Any]]) -> str:
    """``treeDigest`` (plans/P4-01.md §2.7): the SHA-256 of one line ``<sha256> <size> <path>\\n``
    per file, sorted by path bytes. An empty tree hashes the empty string. Entries are mappings
    (or objects) with ``path``, ``size`` and ``sha256``."""
    rows = [_entry(f) for f in files]
    rows.sort(key=lambda r: r[0].encode("utf-8", "surrogatepass"))
    text = "".join(f"{sha} {size} {path}\n" for path, size, sha in rows)
    return sha256_hex(text.encode("utf-8", "surrogatepass"))


def _entry(f: Any) -> tuple:
    if isinstance(f, Mapping):
        return (f["path"], int(f["size"]), f["sha256"])
    return (f.path, int(f.size), f.sha256)


#: A zstd decoder for one frame with its content size. It may raise; any failure is
#: ``files-index-invalid``.
ZstdDecode = Callable[[bytes, int], bytes]


@dataclass(frozen=True)
class ParseFilesIndexResult:
    ok: bool
    index: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    path: Optional[str] = None

    def verdict(self) -> Dict[str, Any]:
        if self.ok:
            assert self.index is not None
            return {"ok": True, "files": len(self.index["files"])}
        out: Dict[str, Any] = {"ok": False, "error": self.error}
        if self.path is not None:
            out["path"] = self.path
        return out


_INVALID = ParseFilesIndexResult(ok=False, error=ErrorCode.FILES_INDEX_INVALID)


def strict_parse(data: bytes) -> Optional[Any]:
    """V4 §1.2's strict JSON over UTF-8 bytes (no BOM); ``None`` on any failure. Python needs no
    pointer set: ``json.loads`` gives a ``float`` for every token that is not a plain integer."""
    try:
        return _parse_strict_json(bytes(data))
    except Exception:
        return None


def _entry_ok(e: Any, container: bool) -> bool:
    """The member rules of one entry (plans/P4-01.md §2.7), integer rule included."""
    if not isinstance(e, dict):
        return False
    if not isinstance(e.get("path"), str):
        return False
    if _wire_int(e.get("size"), 0) is None:
        return False
    if not is_sha256(e.get("sha256")):
        return False
    b = e.get("blob")
    if not isinstance(b, dict):
        return False
    if not is_sha256(b.get("sha256")):
        return False
    if _wire_int(b.get("bytes"), 0) is None:
        return False
    if b.get("codec") == "none":
        if b["bytes"] != e["size"] or b["sha256"] != e["sha256"]:
            return False
    elif b.get("codec") != "zstd":
        return False
    if container and _wire_int(e.get("offset"), 0) is None:
        return False
    return True


def parse_files_index(
    stored: bytes,
    ref: Mapping[str, Any],
    variant: Mapping[str, Any],
    *,
    decode: Optional[ZstdDecode] = None,
    max_bytes: Optional[int] = None,
) -> ParseFilesIndexResult:
    """``parseFilesIndex(stored, ref, variant)`` (plans/P4-01.md §2.7): the first failure, in
    order — the stored object against its ref and the decode; strict JSON; the member rules; the
    path rules (with ``path``); the layout. ``variant`` needs only ``payload``. Never raises."""
    try:
        limit = MAX_FILES_INDEX_BYTES if max_bytes is None else max_bytes
        size = ref.get("size")
        if not isinstance(size, (int, float)) or isinstance(size, bool) or size > limit:
            return _INVALID
        if len(stored) != ref.get("bytes"):
            return _INVALID
        if sha256_hex(stored) != ref.get("sha256"):
            return _INVALID
        codec = ref.get("codec")
        if codec == "none":
            decoded = bytes(stored)
        elif codec == "zstd" and decode is not None:
            try:
                decoded = decode(bytes(stored), int(size))
            except Exception:
                return _INVALID
        else:
            return _INVALID
        if not isinstance(decoded, (bytes, bytearray)) or len(decoded) != size:
            return _INVALID

        doc = strict_parse(bytes(decoded))
        if not isinstance(doc, dict):
            return _INVALID
        if doc.get("format") != FILES_FORMAT or doc.get("layout") != ref.get("layout"):
            return _INVALID
        p = doc.get("payload")
        if not isinstance(p, dict):
            return _INVALID
        if _wire_int(p.get("size"), 0) is None:
            return _INVALID
        if not is_sha256(p.get("sha256")):
            return _INVALID
        want = variant["payload"]
        if p["size"] != want["size"] or p["sha256"] != want["sha256"]:
            return _INVALID
        files = doc.get("files")
        if not isinstance(files, list) or len(files) > MAX_INDEX_FILES:
            return _INVALID
        container = doc["layout"] == "container"
        for e in files:
            if not _entry_ok(e, container):
                return _INVALID
        entries: List[Dict[str, Any]] = files

        paths = check_paths([e["path"] for e in entries])
        if not paths.ok:
            return ParseFilesIndexResult(ok=False, error=paths.error, path=paths.path)

        total = sum(e["size"] for e in entries)
        if container:
            end = 0
            for e in entries:
                if e["offset"] < end:
                    return ParseFilesIndexResult(ok=False, error=ErrorCode.FILES_LAYOUT_MISMATCH)
                end = e["offset"] + e["size"]
            if end > p["size"]:
                return ParseFilesIndexResult(ok=False, error=ErrorCode.FILES_LAYOUT_MISMATCH)
            gaps = ref.get("gaps")
            if not isinstance(gaps, Mapping) or "size" not in gaps:
                return ParseFilesIndexResult(ok=False, error=ErrorCode.FILES_LAYOUT_MISMATCH)
            if p["size"] - total != gaps["size"]:
                return ParseFilesIndexResult(ok=False, error=ErrorCode.FILES_LAYOUT_MISMATCH)
        elif doc["layout"] == "tree":
            for i in range(1, len(entries)):
                if compare_bytes(entries[i - 1]["path"], entries[i]["path"]) >= 0:
                    return _INVALID
            if total != p["size"]:
                return _INVALID
            if tree_digest(entries) != p["sha256"]:
                return _INVALID
        return ParseFilesIndexResult(ok=True, index=doc)
    except Exception:
        return _INVALID

