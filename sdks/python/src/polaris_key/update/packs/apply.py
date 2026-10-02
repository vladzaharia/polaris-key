"""The appliers (plans/P4-01.md §2.9; notes/A7 §3.4): :func:`apply_full`, :func:`apply_delta` and
:func:`apply_file`, over injected ports. A port of client-core's ``packs/apply.ts``;
``content/cases.json#applyCases`` pins every verdict and counter. The first failure is the
verdict and nothing raises: a port that raises is the failing step's code.

Verify before use: a stored object's length and SHA-256 are checked against its ref before a byte
is decoded, an installed base's SHA-256 against the delta's ``from`` before it is used, and the
output's SHA-256 before it is reported. Every ``zstd-patch-from`` frame passes §2.7 rule 3's
window check (:func:`window_allowed`, with the decoder's own P) before it is decoded, whichever
decoder the host injected, and a base that starts with the zstd dictionary magic is refused
(rule 5).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional

from ...constants_generated import MAX_FILES_INDEX_BYTES, ErrorCode
from .files import parse_files_index, tree_digest
from .patch import open_object, parse_patch
from .ports import (
    READ_CHUNK,
    ByteSink,
    ByteSource,
    InstalledFile,
    ObjectPort,
    Sha256Port,
    TreeSink,
    ZstdPort,
    hash_source,
    hashlib_sha256,
    memory_source,
    read_all,
    sha256_of,
    slice_source,
)
from .select import usable_codec
from .window import window_allowed, window_log_max

__all__ = ["ApplyPorts", "ApplyResult", "apply_full", "apply_delta", "apply_file"]

_DICTIONARY_MAGIC = b"\x37\xa4\x30\xec"


@dataclass
class ApplyPorts:
    """The stored objects the strategy fetched (by stored SHA-256), the decoder, SHA-256, and
    where a container payload (``sink``) or a tree's files (``tree``) are written."""

    objects: ObjectPort
    zstd: ZstdPort
    sha256: Sha256Port = hashlib_sha256
    sink: Optional[ByteSink] = None
    tree: Optional[TreeSink] = None


@dataclass
class ApplyResult:
    """An applier's answer: the verdict, and the target index when one was read."""

    verdict: Dict[str, Any]
    index: Optional[Dict[str, Any]] = None


def _fail(error: str, path: Optional[str] = None) -> ApplyResult:
    v: Dict[str, Any] = {"ok": False, "error": error}
    if path is not None:
        v["path"] = path
    return ApplyResult(verdict=v)


def _objects(ports: ApplyPorts, sha: str) -> Optional[ByteSource]:
    try:
        return ports.objects(sha)
    except Exception:
        return None


def _prefix_decode(
    zstd: ZstdPort, frame: bytes, base: bytes, size: int, mem_bytes: Any
) -> Optional[bytes]:
    """One raw-prefix decode behind the window check (§2.7 rules 3 and 5). ``None`` on refusal."""
    if base[:4] == _DICTIONARY_MAGIC:
        return None
    p = zstd.pointer_bits
    wlm = window_log_max(mem_bytes, p)
    if wlm is None or not window_allowed(frame, mem_bytes, p):
        return None
    try:
        out = zstd.decode_with_prefix(frame, base, size, wlm)
    except Exception:
        return None
    return bytes(out) if isinstance(out, (bytes, bytearray)) else None


def _read_index(variant: Mapping[str, Any], ports: ApplyPorts) -> Any:
    """Read and parse the target index, refusing an oversized one before reading it."""
    files = variant["files"]
    stored = b""
    size, nbytes = files.get("size"), files.get("bytes")
    if (
        isinstance(size, (int, float))
        and size <= MAX_FILES_INDEX_BYTES
        and isinstance(nbytes, (int, float))
        and nbytes <= MAX_FILES_INDEX_BYTES
    ):
        src = _objects(ports, files["sha256"])
        if src is not None and src.size == nbytes:
            stored = read_all(src)
    return parse_files_index(stored, files, variant, decode=lambda f, n: ports.zstd.decode(f, n))


def _index_failure(r: Any) -> ApplyResult:
    return ApplyResult(verdict=r.verdict())


def apply_full(variant: Mapping[str, Any], ports: ApplyPorts) -> ApplyResult:
    """``applyFull`` (§2.9): a tree first validates its index (§2.7's codes). Then the ``full``
    ref must be usable with ``full.size == payload.size`` and the stored length and SHA-256 equal
    the ref → else ``full-corrupt``; the decode must give exactly ``full.size`` bytes. A
    container's bytes must hash to ``payload.sha256``; a tree's are split by entry sizes in index
    order and every file's SHA-256 checked → ``full-corrupt``."""
    try:
        sha256 = ports.sha256
        payload = variant["payload"]
        full = variant["full"]
        index: Optional[Dict[str, Any]] = None
        if variant["files"].get("layout") == "tree":
            r = _read_index(variant, ports)
            if not r.ok:
                return _index_failure(r)
            index = r.index
        if not usable_codec(full.get("codec")) or full.get("size") != payload["size"]:
            return _fail(ErrorCode.FULL_CORRUPT)
        stored = _objects(ports, full["sha256"])
        if stored is None or stored.size != full["bytes"]:
            return _fail(ErrorCode.FULL_CORRUPT)

        stream = getattr(ports.zstd, "decode_stream", None)
        if full["codec"] == "zstd" and stream is not None:
            if hash_source(sha256, stored) != full["sha256"]:
                return _fail(ErrorCode.FULL_CORRUPT)
            return _stream_full(variant, index, stored, ports, stream)

        out = open_object(stored, full, ports.zstd, sha256)
        if out is None:
            return _fail(ErrorCode.FULL_CORRUPT)
        if index is None:
            if sha256_of(sha256, out) != payload["sha256"]:
                return _fail(ErrorCode.FULL_CORRUPT)
            if ports.sink is not None:
                ports.sink.write(0, out)
            return ApplyResult(verdict={"ok": True, "sha256": payload["sha256"], "size": len(out)})
        pos = 0
        for f in index["files"]:
            part = out[pos : pos + f["size"]]
            pos += f["size"]
            if len(part) != f["size"] or sha256_of(sha256, part) != f["sha256"]:
                return _fail(ErrorCode.FULL_CORRUPT)
            if ports.tree is not None:
                ports.tree.write_file(f["path"], part)
        return ApplyResult(
            verdict={
                "ok": True,
                "files": len(index["files"]),
                "bytes": len(out),
                "treeDigest": tree_digest(index["files"]),
            },
            index=index,
        )
    except Exception:
        return _fail(ErrorCode.FULL_CORRUPT)


class _Overrun(Exception):
    pass


def _stream_full(
    variant: Mapping[str, Any],
    index: Optional[Dict[str, Any]],
    stored: ByteSource,
    ports: ApplyPorts,
    stream: Callable[[ByteSource, int, Callable[[bytes], None]], None],
) -> ApplyResult:
    """``apply_full``'s streaming path: the frame's output arrives in order and is hashed (a
    container) or split into files (a tree) as it comes."""
    payload = variant["payload"]
    size = variant["full"]["size"]
    sha256 = ports.sha256
    state = {"total": 0}
    if index is None:
        hasher = sha256()

        def on_chunk(chunk: bytes) -> None:
            if state["total"] + len(chunk) > size:
                raise _Overrun()
            hasher.update(chunk)
            if ports.sink is not None:
                ports.sink.write(state["total"], chunk)
            state["total"] += len(chunk)

        try:
            stream(stored, size, on_chunk)
        except Exception:
            return _fail(ErrorCode.FULL_CORRUPT)
        if state["total"] != size or hasher.hexdigest() != payload["sha256"]:
            return _fail(ErrorCode.FULL_CORRUPT)
        return ApplyResult(verdict={"ok": True, "sha256": payload["sha256"], "size": size})

    files: List[Dict[str, Any]] = index["files"]
    buf = bytearray()
    cursor = {"i": 0}

    def flush() -> None:
        while cursor["i"] < len(files) and len(buf) >= files[cursor["i"]]["size"]:
            f = files[cursor["i"]]
            n = f["size"]
            part = bytes(buf[:n])
            del buf[:n]
            if sha256_of(sha256, part) != f["sha256"]:
                raise _Overrun()
            if ports.tree is not None:
                ports.tree.write_file(f["path"], part)
            cursor["i"] += 1

    def on_tree_chunk(chunk: bytes) -> None:
        if state["total"] + len(chunk) > size:
            raise _Overrun()
        state["total"] += len(chunk)
        buf.extend(chunk)
        flush()

    try:
        flush()  # zero-size files at the start
        stream(stored, size, on_tree_chunk)
    except Exception:
        return _fail(ErrorCode.FULL_CORRUPT)
    if state["total"] != size or cursor["i"] != len(files):
        return _fail(ErrorCode.FULL_CORRUPT)
    return ApplyResult(
        verdict={
            "ok": True,
            "files": len(files),
            "bytes": state["total"],
            "treeDigest": tree_digest(files),
        },
        index=index,
    )


def apply_delta(
    variant: Mapping[str, Any],
    delta_index: int,
    base: ByteSource,
    ports: ApplyPorts,
    *,
    skip_base_check: bool = False,
) -> ApplyResult:
    """``applyDelta`` (``payload`` scope, §2.9): the artifact against its ref →
    ``delta-artifact-mismatch``; the base's SHA-256 equals ``from`` → ``delta-base-mismatch``;
    §2.7 rule 3's window check, then the raw-prefix decode, its length and its SHA-256 against
    ``payload`` → ``delta-apply-failed``. ``skip_base_check`` is the corpus's test-only
    switch."""
    try:
        sha256 = ports.sha256
        payload = variant["payload"]
        deltas = variant.get("deltas") or []
        d = deltas[delta_index] if 0 <= delta_index < len(deltas) else None
        if not isinstance(d, dict) or d.get("scope") != "payload":
            return _fail(ErrorCode.DELTA_ARTIFACT_MISMATCH)
        a = d["artifact"]
        src = _objects(ports, a["sha256"])
        if src is None or src.size != a["bytes"]:
            return _fail(ErrorCode.DELTA_ARTIFACT_MISMATCH)
        frame = read_all(src)
        if len(frame) != a["bytes"] or sha256_of(sha256, frame) != a["sha256"]:
            return _fail(ErrorCode.DELTA_ARTIFACT_MISMATCH)
        base_bytes = read_all(base)
        if not skip_base_check and sha256_of(sha256, base_bytes) != d["from"]:
            return _fail(ErrorCode.DELTA_BASE_MISMATCH)
        out = _prefix_decode(ports.zstd, frame, base_bytes, payload["size"], d["memBytes"])
        if out is None or len(out) != payload["size"] or sha256_of(sha256, out) != payload["sha256"]:
            return _fail(ErrorCode.DELTA_APPLY_FAILED)
        if ports.sink is not None:
            ports.sink.write(0, out)
        return ApplyResult(verdict={"ok": True, "sha256": payload["sha256"], "size": len(out)})
    except Exception:
        return _fail(ErrorCode.DELTA_APPLY_FAILED)


def _copy_through(
    source: ByteSource, sink: Optional[ByteSink], at: int, hasher: Any
) -> int:
    n = 0
    while n < source.size:
        chunk = source.read(n, min(READ_CHUNK, source.size - n))
        if not chunk:
            break
        hasher.update(chunk)
        if sink is not None:
            sink.write(at + n, chunk)
        n += len(chunk)
    return n


def apply_file(
    variant: Mapping[str, Any],
    delta_index: Optional[int],
    installed: Iterable[InstalledFile],
    ports: ApplyPorts,
) -> ApplyResult:
    """``applyFile`` (§2.9), for the ``file`` strategy (``delta_index`` ``None``) and for a
    ``files``-scope set: the target index (§2.7's codes), the gaps ref of a container
    (``files-layout-mismatch``), the descriptor and data of a set (``delta-artifact-mismatch``).
    Then for each target file in index order: reuse an installed file with the same SHA-256;
    else the set's ``delta`` entry (``delta-base-mismatch``/``delta-apply-failed`` with
    ``path``); else its ``blob`` entry, or the file's own blob (``file-corrupt``); else
    ``file-source-missing``. A container's payload SHA-256 → ``payload-hash-mismatch``; a tree
    checks every file, reused ones included, and reports its ``treeDigest``."""
    sha256 = ports.sha256
    current: Dict[str, Any] = {"error": ErrorCode.FILE_CORRUPT, "path": None}
    try:
        payload = variant["payload"]
        r = _read_index(variant, ports)
        if not r.ok:
            return _index_failure(r)
        index = r.index
        container = index["layout"] == "container"

        gaps: Optional[bytes] = None
        if container:
            g = variant["files"]["gaps"]
            gaps = open_object(_objects(ports, g["sha256"]), g, ports.zstd, sha256)
            if gaps is None:
                return _fail(ErrorCode.FILES_LAYOUT_MISMATCH)

        entries: Dict[str, Dict[str, Any]] = {}
        data: Optional[ByteSource] = None
        mem_bytes: Any = 0
        downloaded = 0
        using_set = False
        if delta_index is not None:
            deltas = variant.get("deltas") or []
            d = deltas[delta_index] if 0 <= delta_index < len(deltas) else None
            if not isinstance(d, dict) or d.get("scope") != "files":
                return _fail(ErrorCode.DELTA_ARTIFACT_MISMATCH)
            using_set = True
            mem_bytes = d["memBytes"]
            patch = parse_patch(
                _objects(ports, d["patch"]["sha256"]),
                d,
                payload["sha256"],
                index,
                ports.zstd,
                sha256,
            )
            if patch is None:
                return _fail(ErrorCode.DELTA_ARTIFACT_MISMATCH)
            data = _objects(ports, d["data"]["sha256"])
            if (
                data is None
                or data.size != d["data"]["bytes"]
                or hash_source(sha256, data) != d["data"]["sha256"]
            ):
                return _fail(ErrorCode.DELTA_ARTIFACT_MISMATCH)
            downloaded = d["patch"]["bytes"] + d["data"]["bytes"]
            entries = {e["path"]: e for e in patch["entries"]}

        have: Dict[str, InstalledFile] = {}
        for f in installed:
            if f.sha256 not in have:
                have[f.sha256] = f
        counters = {"reusedFiles": 0, "deltaFiles": 0, "blobFiles": 0}

        hasher = sha256()
        pos = 0
        gp = 0
        written = 0
        reused: List[Optional[InstalledFile]] = []

        for f in index["files"]:
            current = {"error": ErrorCode.FILE_CORRUPT, "path": f["path"]}
            reuse = have.get(f["sha256"])
            out_bytes: Optional[bytes] = None
            if reuse is not None:
                counters["reusedFiles"] += 1
            elif using_set:
                e = entries.get(f["path"])
                if e is None:
                    return _fail(ErrorCode.FILE_SOURCE_MISSING, f["path"])
                assert data is not None
                piece = data.read(e["offset"], e["length"])
                if e["op"] == "delta":
                    current = {"error": ErrorCode.DELTA_APPLY_FAILED, "path": f["path"]}
                    b = have.get(e["from"])
                    if b is None:
                        return _fail(ErrorCode.DELTA_BASE_MISMATCH, f["path"])
                    base_bytes = read_all(b.source)
                    if sha256_of(sha256, base_bytes) != e["from"]:
                        return _fail(ErrorCode.DELTA_BASE_MISMATCH, f["path"])
                    out = _prefix_decode(ports.zstd, piece, base_bytes, f["size"], mem_bytes)
                    if out is None or len(out) != f["size"] or sha256_of(sha256, out) != f["sha256"]:
                        return _fail(ErrorCode.DELTA_APPLY_FAILED, f["path"])
                    out_bytes = out
                    counters["deltaFiles"] += 1
                else:
                    blob: Optional[bytes] = piece
                    if e.get("codec") == "zstd":
                        try:
                            blob = ports.zstd.decode(piece, f["size"])
                        except Exception:
                            blob = None
                    if (
                        not isinstance(blob, (bytes, bytearray))
                        or len(blob) != f["size"]
                        or sha256_of(sha256, bytes(blob)) != f["sha256"]
                    ):
                        return _fail(ErrorCode.FILE_CORRUPT, f["path"])
                    out_bytes = bytes(blob)
                    counters["blobFiles"] += 1
            else:
                stored = _objects(ports, f["blob"]["sha256"])
                if stored is None:
                    return _fail(ErrorCode.FILE_SOURCE_MISSING, f["path"])
                ref = dict(f["blob"])
                ref["size"] = f["size"]
                out = open_object(stored, ref, ports.zstd, sha256)
                if out is None or sha256_of(sha256, out) != f["sha256"]:
                    return _fail(ErrorCode.FILE_CORRUPT, f["path"])
                out_bytes = out
                counters["blobFiles"] += 1
                downloaded += stored.size

            if container:
                assert gaps is not None
                g_len = f["offset"] - pos
                gap = gaps[gp : gp + g_len]
                hasher.update(gap)
                if ports.sink is not None:
                    ports.sink.write(written, gap)
                written += len(gap)
                gp += g_len
                src: ByteSource = (
                    memory_source(out_bytes) if out_bytes is not None else reuse.source  # type: ignore[union-attr]
                )
                written += _copy_through(slice_source(src, 0, f["size"]), ports.sink, written, hasher)
                pos = f["offset"] + f["size"]
            else:
                if out_bytes is not None and ports.tree is not None:
                    ports.tree.write_file(f["path"], out_bytes)
                reused.append(reuse if out_bytes is None else None)

        tail = dict(counters)
        tail["downloadedBytes"] = downloaded
        if not container:
            for i, f in enumerate(index["files"]):
                rf = reused[i]
                if rf is None:
                    continue
                got = read_all(slice_source(rf.source, 0, f["size"]))
                if len(got) != f["size"] or sha256_of(sha256, got) != f["sha256"]:
                    return _fail(ErrorCode.FILE_CORRUPT, f["path"])
                if ports.tree is not None:
                    ports.tree.write_file(f["path"], got)
            verdict: Dict[str, Any] = {
                "ok": True,
                "files": len(index["files"]),
                "bytes": sum(f["size"] for f in index["files"]),
                "treeDigest": tree_digest(index["files"]),
            }
            verdict.update(tail)
            return ApplyResult(verdict=verdict, index=index)
        assert gaps is not None
        trailing = gaps[gp:]
        hasher.update(trailing)
        if ports.sink is not None:
            ports.sink.write(written, trailing)
        written += len(trailing)
        if hasher.hexdigest() != payload["sha256"]:
            return _fail(ErrorCode.PAYLOAD_HASH_MISMATCH)
        verdict = {"ok": True, "sha256": payload["sha256"], "size": written}
        verdict.update(tail)
        return ApplyResult(verdict=verdict, index=index)
    except Exception:
        return _fail(current["error"], current["path"])
