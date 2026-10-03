"""``apply_chunk``, chunk sync from seeds (plans/P4-10.md §2.5; notes/A7 §3.4; P4-11), over injected
ports: a port of client-core's ``packs/chunkApply.ts``. ``content/cases.json#applyCases``
(``strategy: chunk``) pins every verdict and counter.

 1. The target index is read by its ref and parsed bound to the variant's payload
    (:func:`parse_chunk_index`'s codes).
 2. The seed map S: id → (seed, offset), first occurrence over seeds in order, then over each
    seed's records in order.
 3. The request runs, the planner's rule exactly (:func:`chunk_runs`): the records neither seeded
    nor already fetched, in payload order; a fetched record joins the current run when it is in
    the same bundle at ``offset == prev.offset + prev.clen``. Seeded and duplicate records between
    two contiguous fetched ones do not break a run. Each run is one single-range request.
 4. For each target record in order: copy from a seed (not re-hashed: seeds were verified at
    install), else copy from the output when the id was already written, else take the next
    ``clen`` bytes of its run: fewer than ``clen`` → ``chunk-bundle-truncated {chunk}``; a decode
    error, a wrong length or a wrong SHA-256 → ``chunk-corrupt {chunk}``.
 5. The payload's SHA-256 → ``payload-hash-mismatch``; with ``repair``, A7's repair pass first:
    every seed-sourced record whose bytes no longer hash to its id is refetched (one request per
    record, not counted in ``requests``) and reported in ``repairedChunks``.

Memory: the parsed index, the seed map and one chunk (``clen + len``, at most 2 ×
``MAX_CHUNK_BYTES``); the output goes to the host's positional sink, never a buffer, and a run's
body is read as it arrives. Nothing raises: a port that raises is the step's verdict, and a
transport that fails or refuses is ``network-error`` with ``detail`` (``range-refused`` makes the
engine fall back to the next strategy; ``interrupted`` keeps the run journal for a resume).
"""

from __future__ import annotations

import inspect
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Set, Tuple

from typing import Protocol

from ...constants_generated import MAX_CHUNK_BYTES, MAX_CHUNK_INDEX_BYTES, ErrorCode
from .apply import ApplyResult
from .chunks import parse_chunk_index
from .ports import READ_CHUNK, ByteSource, ObjectPort, Sha256Port, ZstdPort, hashlib_sha256, read_all

__all__ = [
    "ChunkSeed",
    "ChunkRangeResponse",
    "ChunkRun",
    "ChunkOutput",
    "ApplyChunkPorts",
    "apply_chunk",
    "chunk_runs",
    "seed_map",
    "chunk_range_fetch",
    "accepts_range",
    "RANGE_REFUSED",
    "INTERRUPTED",
]

#: ``network-error``'s ``detail`` when the server answered anything but the exact range.
RANGE_REFUSED = "range-refused"
#: ``network-error``'s ``detail`` when a request or its body failed (the run journal is kept).
INTERRUPTED = "interrupted"


@dataclass
class ChunkSeed:
    """One seed: an installed (or embedded) container payload whose chunk index is kept."""

    index: Mapping[str, Any]
    payload: ByteSource


@dataclass
class ChunkRangeResponse:
    """A range request's answer, as the applier reads it. ``ok``: the body's ``chunks`` (shorter
    than asked when the object ends inside the range, or the transfer was cut short; iterating
    may raise, which is an interrupted transfer). ``refused``: the server answered with anything
    but the exact range of the same object (a ``200``, another ``Content-Range``, another
    ``ETag``), so the strategy stops and the host falls back."""

    status: str
    chunks: Optional[Iterable[bytes]] = None


#: One single-range request: ``fetch_range(bundle_sha256_hex, offset, length)``.
ChunkRangeFetch = Callable[[str, int, int], ChunkRangeResponse]


class ChunkOutput(Protocol):
    """The output: a positional sink the applier can read back (duplicate copies, the repair
    pass, a resumed run's re-hash)."""

    def write(self, offset: int, data: bytes) -> None: ...

    def read(self, offset: int, length: int) -> bytes: ...


@dataclass
class ApplyChunkPorts:
    """The stored target index (by the SHA-256 of its stored bytes), the decoder, the range
    fetch, the output and SHA-256."""

    objects: ObjectPort
    zstd: ZstdPort
    fetch_range: ChunkRangeFetch
    output: ChunkOutput
    sha256: Sha256Port = hashlib_sha256


@dataclass
class ChunkRun:
    """One request run: its bundle index, byte range and the target records it carries."""

    bundle: int
    offset: int
    length: int
    records: List[int]


def chunk_runs(records: Sequence[Sequence[Any]], seeded: Any) -> List[ChunkRun]:
    """The request runs over a target index given the seeded ids (``id in seeded``;
    plans/P4-10.md §2.5, the planner's rule in ``plan``): the records neither seeded nor already
    fetched, grouped while the bundle stays the same and ``offset == prev.offset + prev.clen``."""
    runs: List[ChunkRun] = []
    seen: Set[str] = set()
    prev: Optional[Sequence[Any]] = None
    for i, r in enumerate(records):
        cid, _len, clen, bundle, offset = r[0], r[1], r[2], r[3], r[4]
        if cid in seeded or cid in seen:
            continue
        seen.add(cid)
        if prev is None or bundle != prev[3] or offset != prev[4] + prev[2]:
            runs.append(ChunkRun(bundle=bundle, offset=offset, length=0, records=[]))
        run = runs[-1]
        run.length = offset + clen - run.offset
        run.records.append(i)
        prev = r
    return runs


def seed_map(seeds: Sequence[ChunkSeed]) -> Dict[str, Tuple[int, int]]:
    """The seed map: id → (seed, offset), first occurrence over seeds in order, then records."""
    s: Dict[str, Tuple[int, int]] = {}
    for si, seed in enumerate(seeds):
        off = 0
        for r in seed.index["records"]:
            if r[0] not in s:
                s[r[0]] = (si, off)
            off += r[1]
    return s


def _fail(error: str, **extra: Any) -> Dict[str, Any]:
    v: Dict[str, Any] = {"ok": False, "error": error}
    v.update(extra)
    return v


class _Interrupted(Exception):
    pass


class _RunReader:
    """Reads a run's body record by record, holding only the record being read."""

    def __init__(self, chunks: Iterable[bytes]) -> None:
        self._source = chunks
        self._it: Iterator[bytes] = iter(chunks)
        self._pending = memoryview(b"")
        self._ended = False

    def take(self, n: int) -> bytes:
        """Exactly ``n`` bytes, or fewer when the body ends first. Raises when the transfer
        fails."""
        out = bytearray()
        while len(out) < n:
            if len(self._pending) == 0:
                if self._ended:
                    break
                try:
                    nxt = next(self._it)
                except StopIteration:
                    self._ended = True
                    break
                if not isinstance(nxt, (bytes, bytearray, memoryview)):
                    raise _Interrupted()
                self._pending = memoryview(bytes(nxt))
                continue
            k = min(n - len(out), len(self._pending))
            out += self._pending[:k]
            self._pending = self._pending[k:]
        return bytes(out)

    def close(self) -> None:
        """Stop reading (releases the body)."""
        if self._ended:
            return
        self._ended = True
        for target in (self._it, self._source):
            close = getattr(target, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass  # Closing a body that already failed is not an error.


def apply_chunk(
    variant: Mapping[str, Any],
    seeds: Sequence[ChunkSeed],
    ports: ApplyChunkPorts,
    *,
    repair: bool = False,
    completed_runs: Optional[Set[int]] = None,
    on_run_done: Optional[Callable[[int], None]] = None,
    on_progress: Optional[Callable[[int], None]] = None,
) -> ApplyResult:
    """``applyChunk(variant, seeds, ports, opts)`` (plans/P4-10.md §2.5): the payload rebuilt
    into ``ports.output``, or the first failure. ``completed_runs`` are runs an earlier attempt
    completed (the run journal): each record of such a run is read back from the output and
    re-hashed before reuse, and one that differs refetches the whole run. ``on_run_done(k)`` is
    called after every record of run ``k`` has been written; ``on_progress(fetched_bytes)``
    after every run. Never raises."""
    sha256 = ports.sha256
    payload = variant["payload"] if isinstance(variant, Mapping) else None
    ref = variant.get("chunks") if isinstance(variant, Mapping) else None
    current: Dict[str, Any] = {"error": ErrorCode.CHUNKS_REF_MISMATCH}
    reader: List[Optional[_RunReader]] = [None]
    try:
        if not isinstance(ref, Mapping) or not isinstance(payload, Mapping):
            return ApplyResult(verdict=_fail(ErrorCode.CHUNKS_REF_MISMATCH))
        # 1. The target index, bounded before a byte is read (parse_chunk_index step 0 again).
        stored = b""
        nbytes, size = ref.get("bytes"), ref.get("size")
        if (
            isinstance(nbytes, (int, float))
            and not isinstance(nbytes, bool)
            and isinstance(size, (int, float))
            and not isinstance(size, bool)
            and nbytes <= MAX_CHUNK_INDEX_BYTES
            and size <= MAX_CHUNK_INDEX_BYTES
        ):
            try:
                src = ports.objects(ref["sha256"])
            except Exception:
                src = None
            if src is not None and src.size == nbytes:
                stored = read_all(src)
        parsed = parse_chunk_index(
            stored, ref, payload, decode=lambda f, n: ports.zstd.decode(f, n)
        )
        if not parsed.ok:
            return ApplyResult(verdict=parsed.failure())
        T = parsed.index
        assert T is not None
        records: List[List[Any]] = T["records"]
        # A chunk longer than MAX_CHUNK_BYTES makes the strategy unusable (plan_target); refuse
        # it before anything is fetched or allocated.
        for i, r in enumerate(records):
            if r[1] > MAX_CHUNK_BYTES:
                return ApplyResult(verdict=_fail(ErrorCode.CHUNK_CORRUPT, chunk=i), index=T)

        # 2–3. The seed map and the runs.
        S = seed_map(seeds)
        runs = chunk_runs(records, S)
        run_of: Dict[int, int] = {}
        for k, run in enumerate(runs):
            for i in run.records:
                run_of[i] = k
        pos_of: List[int] = []
        p = 0
        for r in records:
            pos_of.append(p)
            p += r[1]
        last_of_run: Dict[int, int] = {run.records[-1]: k for k, run in enumerate(runs)}

        def digest(data: bytes) -> str:
            h = sha256()
            h.update(data)
            return h.hexdigest()

        def verify(i: int, raw: bytes) -> Any:
            """Decode and verify one fetched record's stored bytes: the data or a verdict."""
            cid, length, clen = records[i][0], records[i][1], records[i][2]
            if len(raw) < clen:
                return _fail(ErrorCode.CHUNK_BUNDLE_TRUNCATED, chunk=i)
            if clen == length:
                data = raw
            else:
                try:
                    d = ports.zstd.decode(raw, length)
                except Exception:
                    return _fail(ErrorCode.CHUNK_CORRUPT, chunk=i)
                if not isinstance(d, (bytes, bytearray)):
                    return _fail(ErrorCode.CHUNK_CORRUPT, chunk=i)
                data = bytes(d)
            if len(data) != length or digest(data) != cid:
                return _fail(ErrorCode.CHUNK_CORRUPT, chunk=i)
            return data

        def open_run(bundle: int, offset: int, length: int) -> Any:
            """One single-range request: a reader, or the verdict for a refusal or a raise."""
            try:
                res = ports.fetch_range(T["bundles"][bundle][0], offset, length)
            except Exception:
                return _fail(ErrorCode.NETWORK_ERROR, detail=INTERRUPTED)
            if res is None or res.status != "ok" or res.chunks is None:
                return _fail(ErrorCode.NETWORK_ERROR, detail=RANGE_REFUSED)
            return _RunReader(res.chunks)

        def run_intact(k: int) -> bool:
            """Whether every record of a journalled run still hashes to its id in the output."""
            for i in runs[k].records:
                cid, length = records[i][0], records[i][1]
                got = ports.output.read(pos_of[i], length)
                if len(got) != length or digest(got) != cid:
                    return False
            return True

        def take(r: _RunReader, n: int) -> Optional[bytes]:
            try:
                return r.take(n)
            except Exception:
                return None

        # 4. Every record, in payload order.
        hasher = sha256()
        kinds: List[str] = []
        first: Dict[str, int] = {}
        fetched_chunks = fetched_bytes = seed_chunks = self_chunks = 0
        requests = 0
        open_k = -1
        resumed_k = -1
        for i, r in enumerate(records):
            cid, length, clen = r[0], r[1], r[2]
            pos = pos_of[i]
            current = {"error": ErrorCode.CHUNK_CORRUPT, "chunk": i}
            seeded = S.get(cid)
            if seeded is not None:
                si, so = seeded
                got = seeds[si].payload.read(so, length)
                if len(got) == length:
                    data = bytes(got)
                else:
                    # A short seed keeps its place; the payload hash (or the repair pass) catches it.
                    data = bytes(got[:length]) + b"\0" * (length - min(length, len(got)))
                kinds.append("seed")
                seed_chunks += 1
            elif cid in first:
                data = bytes(ports.output.read(first[cid], length))
                kinds.append("self")
                self_chunks += 1
            else:
                k = run_of[i]
                if k != open_k and k != resumed_k:
                    if reader[0] is not None:
                        reader[0].close()
                    reader[0] = None
                    if completed_runs is not None and k in completed_runs and run_intact(k):
                        resumed_k = k
                    else:
                        run = runs[k]
                        opened = open_run(run.bundle, run.offset, run.length)
                        if not isinstance(opened, _RunReader):
                            return ApplyResult(verdict=opened, index=T)
                        reader[0] = opened
                        open_k = k
                        requests += 1
                if k == resumed_k:
                    data = bytes(ports.output.read(pos, length))
                else:
                    assert reader[0] is not None
                    raw = take(reader[0], clen)
                    if raw is None:
                        return ApplyResult(
                            verdict=_fail(ErrorCode.NETWORK_ERROR, detail=INTERRUPTED), index=T
                        )
                    got2 = verify(i, raw)
                    if not isinstance(got2, bytes):
                        return ApplyResult(verdict=got2, index=T)
                    data = got2
                kinds.append("fetch")
                fetched_chunks += 1
                fetched_bytes += clen
            if cid not in first:
                first[cid] = pos
            if kinds[i] != "fetch" or run_of.get(i) != resumed_k:
                ports.output.write(pos, data)
            hasher.update(data)
            done = last_of_run.get(i)
            if done is not None:
                if reader[0] is not None and open_k == done:
                    reader[0].close()
                    reader[0] = None
                if on_run_done is not None:
                    on_run_done(done)
                if on_progress is not None:
                    on_progress(fetched_bytes)

        # 5. The payload hash, with the repair pass.
        repaired: List[int] = []
        if hasher.hexdigest() != payload["sha256"]:
            if repair is not True:
                return ApplyResult(verdict=_fail(ErrorCode.PAYLOAD_HASH_MISMATCH), index=T)
            for i, r in enumerate(records):
                if kinds[i] != "seed":
                    continue
                cid, length, clen, bundle, offset = r[0], r[1], r[2], r[3], r[4]
                current = {"error": ErrorCode.CHUNK_CORRUPT, "chunk": i}
                back = ports.output.read(pos_of[i], length)
                if len(back) == length and digest(back) == cid:
                    continue
                opened = open_run(bundle, offset, clen)
                if not isinstance(opened, _RunReader):
                    return ApplyResult(verdict=opened, index=T)
                try:
                    raw = take(opened, clen)
                finally:
                    opened.close()
                if raw is None:
                    return ApplyResult(
                        verdict=_fail(ErrorCode.NETWORK_ERROR, detail=INTERRUPTED), index=T
                    )
                got3 = verify(i, raw)
                if not isinstance(got3, bytes):
                    return ApplyResult(verdict=got3, index=T)
                ports.output.write(pos_of[i], got3)
                repaired.append(i)
            current = {"error": ErrorCode.PAYLOAD_HASH_MISMATCH}
            again = sha256()
            at = 0
            total = T["payloadSize"]
            while at < total:
                part = ports.output.read(at, min(READ_CHUNK, total - at))
                if not part:
                    break
                again.update(part)
                at += len(part)
            if again.hexdigest() != payload["sha256"]:
                return ApplyResult(verdict=_fail(ErrorCode.PAYLOAD_HASH_MISMATCH), index=T)
        return ApplyResult(
            verdict={
                "ok": True,
                "sha256": payload["sha256"],
                "size": T["payloadSize"],
                "fetchedChunks": fetched_chunks,
                "fetchedBytes": fetched_bytes,
                "requests": requests,
                "seedChunks": seed_chunks,
                "selfChunks": self_chunks,
                "repairedChunks": repaired,
            },
            index=T,
        )
    except Exception:
        if current.get("chunk") is None:
            return ApplyResult(verdict=_fail(current["error"]))
        return ApplyResult(verdict=_fail(current["error"], chunk=current["chunk"]))
    finally:
        if reader[0] is not None:
            reader[0].close()


# ── The exact Content-Range adapter ─────────────────────────────────────────────────────────

#: ASCII digits only (``[0-9]``, never ``\d``): a non-ASCII digit never reads as a number.
_CONTENT_RANGE_RE = re.compile(r"bytes ([0-9]{1,16})-([0-9]{1,16})/([0-9]{1,16})")


def accepts_range(fetch_object: Callable[..., Any]) -> bool:
    """Whether ``fetch_object`` can be called with the fourth ``length`` argument a chunk run
    needs. A transport with the older three-argument shape cannot send a bounded range, so the
    chunk strategy treats every run as refused (and the engine falls back) instead of calling it.
    A callable whose signature cannot be read is assumed to accept it."""
    try:
        sig = inspect.signature(fetch_object)
    except (TypeError, ValueError):
        return True
    try:
        sig.bind("0" * 64, 0, None, 1)
    except TypeError:
        return False
    return True


def _release(chunks: Any) -> None:
    close = getattr(chunks, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass  # Releasing a refused body is best effort.


def _capped(chunks: Iterable[bytes], n: int) -> Iterator[bytes]:
    """At most ``n`` bytes of a body, then the body is released."""
    left = n
    try:
        if left <= 0:
            return
        for c in chunks:
            if len(c) >= left:
                yield bytes(c[:left])
                return
            left -= len(c)
            yield c
    finally:
        _release(chunks)


def chunk_range_fetch(fetch_object: Callable[..., Any]) -> ChunkRangeFetch:
    """The chunk strategy's ``fetch_range`` over the host's object fetch (plans/P4-10.md §2.5),
    ``fetch_object(sha256, offset, if_range, length)`` answering an ``ObjectResponse`` (``status``,
    ``content_range``, ``etag``, ``chunks``): one single-range request per run, ``Range:
    bytes=<o>-<o+len-1>`` with ``If-Range: "<bundle sha256>"`` (the host also sends
    ``Accept-Encoding: identity``). Only a ``206`` whose ``Content-Range`` is exactly
    ``bytes o-e/<size>`` for the request is read, or one that starts at ``o`` and ends at
    ``<size> - 1 < e`` (clipped at the object's end: the records past it are then
    ``chunk-bundle-truncated``); an ``ETag``, when present, must be exactly the quoted bundle
    hash. Anything else (a ``200``, another range, another tag) is ``refused`` and the body is
    never read. The body is cut at the range's length. Never multi-range."""

    ranged = accepts_range(fetch_object)

    def fetch_range(bundle: str, offset: int, length: int) -> ChunkRangeResponse:
        if not ranged:
            # A transport without bounded ranges: refused (fall back), never interrupted.
            return ChunkRangeResponse(status="refused")
        tag = f'"{bundle}"'
        res = fetch_object(bundle, offset, tag, length)
        end = offset + length - 1
        cr = getattr(res, "content_range", None)
        etag = getattr(res, "etag", None)
        m = (
            _CONTENT_RANGE_RE.fullmatch(cr.strip())
            if getattr(res, "status", None) == 206 and isinstance(cr, str)
            else None
        )
        take = -1
        if m is not None and (etag is None or etag == tag):
            o, e, size = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if o == offset and e == end and end < size:
                take = length
            elif o == offset and e < end and e == size - 1 and e >= o:
                take = e - o + 1
        if take < 0:
            # Never read a refused body; release it.
            _release(getattr(res, "chunks", None))
            return ChunkRangeResponse(status="refused")
        return ChunkRangeResponse(status="ok", chunks=_capped(res.chunks, take))

    return fetch_range
