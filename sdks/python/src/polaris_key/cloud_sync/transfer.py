"""The Cloud Sync file transfer engine (U-22.10; WIRE-CONTRACT-V5 §13.8): uploads in modes ``single`` and
``multipart`` (:meth:`TransferEngine.upload`) and ``chunks`` (:meth:`TransferEngine.upload_chunked`), and
downloads of both formats (:meth:`TransferEngine.download`).

A port of ``packages/client-core/src/sync/transfer.ts``, synchronous. The engine owns the order of calls
and the recovery rules, and nothing else. The ports keep it pure: a :class:`FileTransport` (the routes of
§13.8, typed; a host maps them to HTTP and never lets a server-chosen path through), a
:class:`~polaris_key.cloud_sync.journal.JournalStore` (what survives a kill), a :class:`RangedSource` (the
bytes to send, read by range, so a part is read when it is sent and never held longer), a
:class:`~polaris_key.cloud_sync.transfer_codec.FileCodec` (whether and how a collection seals its files
and chunks) and a :class:`~polaris_key.cloud_sync.chunk_cache.ChunkCache` (the chunk objects a device
already holds).

::

    begin -> parts, at most 4 at once and in any order -> finalize

resume
    a journal record for the same transfer id, bytes and record is resumed: the server's ``received``
    list is the truth, so a part the journal calls done but the server lost is sent again. A record past
    ``expiresAt``, or one for other bytes, is dropped and the upload begins afresh.
429, 5xx or no answer
    wait and retry. ``Retry-After`` is honoured and holds every part, not just the one that was told;
    without it the wait doubles from 0.5 s to 30 s, with jitter.
410
    the upload expired or is gone: forget it and begin again (a few times, then fail).
409
    surfaced as a :class:`TransferError` (``conflict``): a stale ``baseVersion`` carries the server's
    version. The upload is aborted; nothing is retried.
400
    ``upload_mismatch`` is surfaced (``mismatch``); no retry can fix the bytes.

The ``chunks`` upload (plans D-4 to D-7) cuts the plaintext (CDC), names every chunk, builds the manifest,
and begins with the file's stored ``size`` and the stored manifest's ``sha256``. It asks which chunks the
server lacks (plan calls of at most 1,024 ids), sends only those as raw (codec 0) objects, up to 4 at a
time, then sends the manifest to the ``single`` route and finalizes. A journal record only lets the next
run abort the upload the last one left: a sealed manifest differs every time, and the plan answers what
the server already holds. A chunk is read twice (cutting, sending) and its id is checked again before it
goes, so a file edited while it uploads is refused (``source-mismatch``), never stored under another
file's id.

A download checks, in order, what the server says against what the record said: the status and
``Content-Range`` of each range, the ETag held fixed with ``If-Match``, the stored length and SHA-256,
then the format's own checks (segment tags; for ``chunks`` the manifest, every chunk id, each length, and
last ``plainSize`` and ``plainSha256``). The sink receives plaintext that is only provisional until
:meth:`TransferEngine.download` returns: on a raise the host discards what it wrote. Anything the server
could have altered is ``file-invalid`` (the client's ``sync-file-invalid``).

The bytes must be what ``sha256`` and ``size`` say: the source is hashed before ``begin``, and a source
that disagrees is refused (``source-mismatch``) with nothing sent. In E2E mode the caller seals first, so
these are the ciphertext's.

Threads. Parts and chunks go out up to ``SYNC_UPLOAD_PARALLELISM`` (4) at a time on worker threads, and a
chunked download reads a window of 4 chunks ahead. The journal record is changed under one lock and
``on_progress`` is called under another, so neither sees two threads at once. A ``cancel``
(:class:`threading.Event`) stops the transfer at its next step with ``aborted``; the journal keeps the
progress. A transport is called from several threads and must be thread-safe.

Nothing here puts a key, a plaintext byte or a bearer token in an exception, a ``repr`` or a log line.
"""

from __future__ import annotations

import hashlib
import hmac
import random as _random
import threading
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import partial
from typing import Any, Callable, Deque, Dict, Iterator, List, NamedTuple, Optional, Protocol, Tuple

from ..constants_generated import (
    SYNC_CHUNK_PLAN_MAX_IDS,
    SYNC_FILE_MAX_BYTES,
    SYNC_MAX_CHUNKS_PER_FILE,
    SYNC_MAX_PARTS,
    SYNC_PART_MAX_BYTES,
    SYNC_SINGLE_PUT_MAX_BYTES,
    SYNC_UPLOAD_PARALLELISM,
)
from ..core import sync_files as sf
from .chunk_cache import ChunkCache
from .journal import (
    TRANSFER_JOURNAL_VERSION,
    JournalRecord,
    JournalStore,
    TransferJournalError,
    parse_journal_record,
)
from .transfer_codec import SERVER_CHUNK_MAX_STORED_BYTES, FileCodec

__all__ = [
    "TRANSFER_MAX_PARALLEL_PARTS",
    "DOWNLOAD_RANGE_BYTES",
    "RangedSource",
    "BytesSource",
    "ranged_bytes",
    "FileTarget",
    "FileReply",
    "FileQuery",
    "FileBody",
    "FileTransport",
    "ByteSink",
    "TransferError",
    "UploadRequest",
    "ChunkedUploadRequest",
    "DownloadRequest",
    "TransferEngine",
]

#: §13.8.1: at most 4 parts in flight.
TRANSFER_MAX_PARALLEL_PARTS = SYNC_UPLOAD_PARALLELISM
#: The longest range one request asks for.
DOWNLOAD_RANGE_BYTES = 8 * 1024 * 1024
#: The most a stored manifest can be: 16,384 records and the header, sealed.
_MANIFEST_PLAIN_MAX_BYTES = sf.MANIFEST_HEADER_BYTES + sf.MANIFEST_RECORD_BYTES * SYNC_MAX_CHUNKS_PER_FILE

_HASH_SLICE = 1_048_576
_BACKOFF_BASE = 0.5
_BACKOFF_CAP = 30.0


# ── Ports ───────────────────────────────────────────────────────────────────────────────────────


class RangedSource(Protocol):
    """The stored bytes of one file, read by half-open range. ``size`` is fixed for the life of the source."""

    size: int

    def read(self, start: int, end: int) -> bytes: ...


class BytesSource:
    """A source over bytes already in memory."""

    def __init__(self, data: bytes) -> None:
        self._data = bytes(data)
        self.size = len(self._data)

    def read(self, start: int, end: int) -> bytes:
        return self._data[start:end]


def ranged_bytes(data: bytes) -> BytesSource:
    return BytesSource(data)


class FileTarget(NamedTuple):
    """Which file a call is about: ``record`` is the wire id (blinded in E2E mode)."""

    collection: str
    record: str


@dataclass(frozen=True)
class FileReply:
    """The answer to a route call. A refusal is a value; a call that gets no answer at all (the network, a
    timeout) raises, and the engine retries it.

    ``code`` is the server's ``error.code``. ``body`` is the error body's extra members: ``{"missing": …}``
    on ``upload_incomplete``, ``{"server": {"version": …}}`` on ``revision_conflict``."""

    ok: bool
    value: Any = None
    status: int = 0
    code: str = ""
    retry_after_seconds: Optional[float] = None
    body: Any = None

    @staticmethod
    def success(value: Any = None) -> "FileReply":
        return FileReply(ok=True, value=value)

    @staticmethod
    def failure(
        status: int,
        code: str,
        retry_after_seconds: Optional[float] = None,
        body: Any = None,
    ) -> "FileReply":
        return FileReply(ok=False, status=status, code=code, retry_after_seconds=retry_after_seconds, body=body)


@dataclass(frozen=True)
class FileQuery:
    version: Optional[int] = None
    #: Half-open byte range of the stored file, ``(start, end)``.
    range: Optional[Tuple[int, int]] = None
    #: An ETag from an earlier answer; a changed file is then ``412``.
    if_match: Optional[str] = None


@dataclass(frozen=True)
class FileBody:
    """A file answer, headers parsed. ``bytes`` is left out of the ``repr``."""

    status: int
    data: bytes = field(default=b"", repr=False)
    #: The ``ETag``, verbatim.
    etag: Optional[str] = None
    #: A 206's ``Content-Range``: bytes ``start`` up to ``end`` (exclusive) of ``total``.
    content_range: Optional[Tuple[int, int, int]] = None


class FileTransport(Protocol):
    """The upload and download routes of §13.8 under ``/<p>/sync/files/{collection}/{id}``. ``sha256`` is
    the lowercase hex of the body; a host sends it as ``Content-Digest``. Requests and answers are the JSON
    objects of the wire (``protocol/sync.ts``). ``cancel`` is the transfer's :class:`threading.Event`."""

    def begin(
        self, target: FileTarget, request: Dict[str, Any], cancel: Optional[threading.Event] = None
    ) -> FileReply: ...

    def status(self, target: FileTarget, upload_id: str, cancel: Optional[threading.Event] = None) -> FileReply:
        """``GET …/upload/{uploadId}``."""
        ...

    def put_single(
        self, target: FileTarget, upload_id: str, body: bytes, sha256: str, cancel: Optional[threading.Event] = None
    ) -> FileReply:
        """``PUT …/upload/{uploadId}``: the whole body of a ``single`` upload."""
        ...

    def put_part(
        self,
        target: FileTarget,
        upload_id: str,
        n: int,
        body: bytes,
        sha256: str,
        cancel: Optional[threading.Event] = None,
    ) -> FileReply:
        """``PUT …/upload/{uploadId}/parts/{n}``, n from 1."""
        ...

    def abort(self, target: FileTarget, upload_id: str, cancel: Optional[threading.Event] = None) -> FileReply:
        """``DELETE …/upload/{uploadId}``."""
        ...

    def finalize(
        self, target: FileTarget, request: Dict[str, Any], cancel: Optional[threading.Event] = None
    ) -> FileReply:
        """``POST …/finalize``."""
        ...

    def plan_chunks(
        self, target: FileTarget, upload_id: str, request: Dict[str, Any], cancel: Optional[threading.Event] = None
    ) -> FileReply:
        """``POST …/upload/{uploadId}/chunks``: at most ``SYNC_CHUNK_PLAN_MAX_IDS`` ids."""
        ...

    def put_chunk(
        self,
        target: FileTarget,
        upload_id: str,
        chunk_id: str,
        body: bytes,
        sha256: str,
        cancel: Optional[threading.Event] = None,
    ) -> FileReply:
        """``PUT …/upload/{uploadId}/chunks/{chunkId}``: one chunk object."""
        ...

    def get_file(self, target: FileTarget, query: FileQuery, cancel: Optional[threading.Event] = None) -> FileReply:
        """``GET …/{id}[?version=]``, with ``Range`` and ``If-Match`` when asked; the value is a
        :class:`FileBody`. A host bounds the body to the range it asked for."""
        ...

    def revisions(self, target: FileTarget, cancel: Optional[threading.Event] = None) -> FileReply:
        """``GET …/{id}/revisions``: the kept revisions of the record's file, newest first."""
        ...

    def get_chunk(self, collection: str, chunk_id: str, cancel: Optional[threading.Event] = None) -> FileReply:
        """``GET /<p>/sync/files/{collection}/chunks/{chunkId}``; the value is the object's bytes. A host
        bounds the body to ``SERVER_CHUNK_MAX_STORED_BYTES``."""
        ...


class ByteSink(Protocol):
    """Where a download's plaintext goes: appended in order, provisional until ``download`` returns."""

    def write(self, data: bytes) -> None: ...


# ── Errors ──────────────────────────────────────────────────────────────────────────────────────

#: The reasons of :class:`TransferError`.
#:
#: ``source-mismatch``    the source's size or hash is not what the caller declared. Nothing was sent.
#: ``journal-version``    the journal record has a ``v`` this build does not know. It is left as found.
#: ``journal-malformed``  the journal record is malformed. It is left as found.
#: ``conflict``           a 409: ``revision_conflict`` (``server_version`` set) or another.
#: ``mismatch``           ``400 upload_mismatch``: the server holds other bytes than were declared.
#: ``rejected``           any other refusal (401, 403, 413, 429 on ``begin`` with no retries left, …):
#:                        ``status`` and ``code`` say which.
#: ``bad-reply``          the server answered with a mode or part size this engine cannot use.
#: ``retries-exhausted``  retries ran out; the journal keeps the progress for a later ``upload``.
#: ``restarts-exhausted`` the upload kept expiring or vanishing.
#: ``aborted``            ``cancel`` was set; the journal keeps the progress.
#: ``file-invalid``       a download failed a check the server could have caused (a tag, the manifest, a
#:                        chunk id, ``plainSha256``, a length, a hash): ``detail`` says which. The
#:                        client's ``sync-file-invalid``.


class TransferError(Exception):
    def __init__(
        self,
        reason: str,
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
        server_version: Optional[int] = None,
        detail: Optional[str] = None,
    ) -> None:
        text = "file transfer: " + reason
        if code:
            text += " (" + code + ")"
        if detail:
            text += " [" + detail + "]"
        super().__init__(text)
        self.reason = reason
        self.status = status
        self.code = code
        #: On a ``revision_conflict``: the server's current version.
        self.server_version = server_version
        #: On ``file-invalid``: the first check that failed.
        self.detail = detail


def _invalid(detail: str) -> TransferError:
    return TransferError("file-invalid", detail=detail)


class _Restart(Exception):
    """Raised inside a run to start the upload over."""


# ── Requests ────────────────────────────────────────────────────────────────────────────────────


@dataclass
class UploadRequest:
    #: Stable per intended write; the journal key. A rerun with the same id resumes.
    id: str
    collection: str
    #: The wire record id.
    record: str
    source: RangedSource
    #: The stored size, ``source.size``.
    size: int
    #: Lowercase hex SHA-256 of the stored bytes.
    sha256: str
    enc: str
    base_version: Any = None  # a number, ``"*"`` or ``None``
    on_progress: Optional[Callable[[int, int], None]] = None
    cancel: Optional[threading.Event] = None


@dataclass
class ChunkedUploadRequest:
    id: str
    collection: str
    record: str
    #: The plaintext of the file.
    source: RangedSource
    codec: FileCodec
    base_version: Any = None
    #: Plaintext bytes accounted for so far (a chunk the server already holds counts at once) and the file's size.
    on_progress: Optional[Callable[[int, int], None]] = None
    cancel: Optional[threading.Event] = None


@dataclass
class DownloadRequest:
    collection: str
    record: str
    #: What the record's ``file`` says.
    format: str  # "whole" or "chunks"
    #: The stored size and SHA-256 (lowercase hex) of that file: for ``chunks``, the file's stored size and
    #: the stored manifest's hash.
    size: int
    sha256: str
    codec: FileCodec
    sink: ByteSink
    #: The revision to read (``?version=``); ``None`` is the current one.
    version: Optional[int] = None
    #: Needed for ``chunks``; the engine reads through it and fills it.
    cache: Optional[ChunkCache] = None
    #: Plaintext bytes written and the file's plaintext size.
    on_progress: Optional[Callable[[int, int], None]] = None
    cancel: Optional[threading.Event] = None


# ── The engine ──────────────────────────────────────────────────────────────────────────────────


def _hex(b: bytes) -> str:
    return b.hex()


def _sha_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _aborted() -> TransferError:
    return TransferError("aborted")


def _is_cancelled(cancel: Optional[threading.Event]) -> bool:
    return cancel is not None and cancel.is_set()


class _Hold:
    """A time before which no request is sent: a ``Retry-After`` holds every part, not just the one told."""

    def __init__(self) -> None:
        self.until = 0.0
        self._lock = threading.Lock()

    def raise_to(self, t: float) -> None:
        with self._lock:
            self.until = max(self.until, t)


class TransferEngine:
    def __init__(
        self,
        transport: FileTransport,
        journal: JournalStore,
        *,
        now: Optional[Callable[[], float]] = None,
        sleep: Optional[Callable[[float, Optional[threading.Event]], None]] = None,
        random: Optional[Callable[[], float]] = None,
        max_attempts: int = 8,
        max_restarts: int = 3,
        max_retry_after_seconds: float = 900,
        parallelism: int = TRANSFER_MAX_PARALLEL_PARTS,
    ) -> None:
        """``now`` is seconds since the epoch; ``sleep(seconds, cancel)`` waits and raises ``aborted`` when
        ``cancel`` is set; ``random`` is in [0, 1) for backoff jitter. ``max_attempts`` is the attempts per
        request before ``retries-exhausted``; ``max_restarts`` the times it begins afresh after a 410."""
        self.transport = transport
        self.journal = journal
        self._now = now or time.time
        self._sleep = sleep or self._default_sleep
        self._random = random or _random.random
        self.max_attempts = max_attempts
        self.max_restarts = max_restarts
        self.max_retry_after = float(max_retry_after_seconds)
        self.parallelism = max(1, min(parallelism, TRANSFER_MAX_PARALLEL_PARTS))

    @staticmethod
    def _default_sleep(seconds: float, cancel: Optional[threading.Event]) -> None:
        if cancel is None:
            time.sleep(seconds)
        elif cancel.wait(seconds):
            raise _aborted()

    # Public ----------------------------------------------------------------------------------------

    def upload(self, req: UploadRequest) -> Dict[str, Any]:
        """Upload one file and finalize it. Returns the ``finalize`` answer; the journal record is gone by
        then."""
        if req.source.size != req.size:
            raise TransferError("source-mismatch")
        self._verify_source(req)
        # Read before anything is sent: an unreadable record stops the transfer untouched.
        resume = self._load_record(req)
        return self._restarting(req.id, lambda first: _Run(self, req, resume if first else None).go())

    def upload_chunked(self, req: ChunkedUploadRequest) -> Dict[str, Any]:
        """Upload one file as a manifest over content-defined chunks and finalize it. ``req.source`` is the
        plaintext. Returns the ``finalize`` answer; the journal record is gone by then."""
        if req.source.size > SYNC_FILE_MAX_BYTES:
            raise TransferError("rejected", code="file_too_large")
        # Read before anything is sent: an unreadable record stops the transfer untouched. A record of an
        # earlier run only tells which server upload to release.
        self._release_prior(req.id)
        cut = self._cut(req)
        return self._restarting(req.id, lambda _first: _ChunkedRun(self, req, cut).go())

    def download(self, req: DownloadRequest) -> None:
        """Fetch one file and write its plaintext to ``req.sink``. Returns when every check has passed; a
        raise (``file-invalid`` for anything the server could have altered) leaves the sink's contents
        unusable, and the host discards them."""
        _Download(self, req).go()

    def cancel(self, id: str) -> None:
        """Drop a transfer: abort the server's upload (best effort) and forget the record."""
        raw = self.journal.get(id)
        if raw is None:
            return
        try:
            rec = parse_journal_record(raw)
        except TransferJournalError:
            # A record this build cannot read stays for the build that wrote it.
            return
        self._abort_quietly(FileTarget(rec["collection"], rec["record"]), rec["uploadId"])
        self.journal.delete(id)

    # Internals -------------------------------------------------------------------------------------

    def _restarting(self, id: str, run: Callable[[bool], Dict[str, Any]]) -> Dict[str, Any]:
        """Run a pass; when the server forgot the upload (410), drop the record and begin again, a few times."""
        restarts = 0
        while True:
            try:
                return run(restarts == 0)
            except _Restart:
                if restarts >= self.max_restarts:
                    raise TransferError("restarts-exhausted", status=410) from None
                self.journal.delete(id)
                restarts += 1

    def _abort_quietly(self, target: FileTarget, upload_id: str) -> None:
        try:
            self.transport.abort(target, upload_id)
        except Exception:  # noqa: BLE001 - the server expires it within the day
            pass

    def _read_record(self, id: str) -> Optional[JournalRecord]:
        raw = self.journal.get(id)
        if raw is None:
            return None
        try:
            return parse_journal_record(raw)
        except TransferJournalError as e:
            raise TransferError("journal-version" if e.reason == "version" else "journal-malformed") from None

    def _release_prior(self, id: str) -> None:
        """Abort the server upload a journal record names, and forget the record."""
        rec = self._read_record(id)
        if rec is None:
            return
        self._abort_quietly(FileTarget(rec["collection"], rec["record"]), rec["uploadId"])
        self.journal.delete(id)

    def _load_record(self, req: UploadRequest) -> Optional[JournalRecord]:
        """The matching journal record, or ``None`` (and the stale one dropped). A record that cannot be
        read is an error and stays."""
        rec = self._read_record(req.id)
        if rec is None:
            return None
        same = (
            rec["collection"] == req.collection
            and rec["record"] == req.record
            and rec["sha256"] == req.sha256
            and rec["size"] == req.size
        )
        # ``expiresAt`` is Unix seconds. Read as milliseconds by a server that sends them, it is never in
        # the past here, and the server's 410 still ends the upload.
        live = rec["expiresAt"] > self._now()
        if same and live:
            return rec
        if not same:
            self._abort_quietly(FileTarget(rec["collection"], rec["record"]), rec["uploadId"])
        self.journal.delete(req.id)
        return None

    def _verify_source(self, req: UploadRequest) -> None:
        h = hashlib.sha256()
        for at in range(0, req.size, _HASH_SLICE):
            end = min(req.size, at + _HASH_SLICE)
            piece = req.source.read(at, end)
            if len(piece) != end - at:
                raise TransferError("source-mismatch")
            h.update(piece)
        if h.hexdigest() != req.sha256:
            raise TransferError("source-mismatch")

    def _cut(self, req: ChunkedUploadRequest) -> "_Cut":
        """Pass one over the plaintext: cut it, name the chunks, hash it, and write the manifest."""
        source, codec = req.source, req.codec
        chunker = sf.CdcChunker()
        whole = hashlib.sha256()
        records: List[sf.ManifestRecord] = []
        offsets: List[int] = []
        at = 0

        def take(chunks: List[bytes]) -> None:
            nonlocal at
            for c in chunks:
                if len(records) >= SYNC_MAX_CHUNKS_PER_FILE:
                    raise TransferError("rejected", code="file_too_large")
                records.append(sf.ManifestRecord(id=codec.chunk_id(c), plain_len=len(c)))
                offsets.append(at)
                at += len(c)

        for frm in range(0, source.size, _HASH_SLICE):
            if _is_cancelled(req.cancel):
                raise _aborted()
            end = min(source.size, frm + _HASH_SLICE)
            piece = source.read(frm, end)
            if len(piece) != end - frm:
                raise TransferError("source-mismatch")
            whole.update(piece)
            take(chunker.push(piece))
        take(chunker.finish())
        manifest = sf.encode_manifest(
            sf.ChunkManifest(plain_size=source.size, plain_sha256=whole.digest(), records=records)
        )
        return _Cut(records=records, offsets=offsets, manifest=manifest, plain_size=source.size)

    def _call(
        self,
        hold: _Hold,
        cancel: Optional[threading.Event],
        fn: Callable[[], FileReply],
    ) -> FileReply:
        """One request with the recovery rules: a refusal is returned, a retryable failure is waited out."""
        attempt = 0
        while True:
            if _is_cancelled(cancel):
                raise _aborted()
            wait = hold.until - self._now()
            if wait > 0:
                self._sleep(wait, cancel)
            reply: Optional[FileReply] = None
            try:
                reply = fn()
            except TransferError:
                raise
            except Exception:  # noqa: BLE001 - no answer: the network, a timeout
                if _is_cancelled(cancel):
                    raise _aborted() from None
            if reply is not None and reply.ok:
                return reply
            status = 0 if reply is None else reply.status
            retryable = reply is None or status in (408, 429) or status >= 500
            if not retryable:
                assert reply is not None
                return reply
            if attempt + 1 >= self.max_attempts:
                if reply is None:
                    raise TransferError("retries-exhausted")
                raise TransferError("retries-exhausted", status=status, code=reply.code)
            told = reply.retry_after_seconds if reply is not None else None
            if told is not None and told >= 0:
                delay = min(float(told), self.max_retry_after)
            else:
                delay = min(_BACKOFF_CAP, _BACKOFF_BASE * (2**attempt)) * (0.5 + self._random() / 2)
            hold.raise_to(self._now() + delay)
            attempt += 1


def _refuse_upload(reply: FileReply) -> "None":
    """A refusal that no retry mends, as the error it is. A 410 or 404 starts the upload over."""
    if reply.status in (410, 404):
        raise _Restart()
    server = reply.body.get("server") if isinstance(reply.body, dict) else None
    v = server.get("version") if isinstance(server, dict) else None
    if reply.status == 409:
        raise TransferError(
            "conflict",
            status=409,
            code=reply.code,
            server_version=v if isinstance(v, int) and not isinstance(v, bool) else None,
        )
    if reply.status == 400 and reply.code == "upload_mismatch":
        raise TransferError("mismatch", status=400, code=reply.code)
    raise TransferError("rejected", status=reply.status, code=reply.code)


def _refuse_download(reply: FileReply) -> "None":
    """A refusal on a download. Nothing here restarts: a 404 or 410 means the revision is gone."""
    raise TransferError("rejected", status=reply.status, code=reply.code)


class _Pass:
    """What one pass at one transfer shares: the target, a hold on retries and the calls through the engine."""

    def __init__(self, engine: TransferEngine, collection: str, record: str, cancel: Optional[threading.Event]) -> None:
        self.engine = engine
        self.target = FileTarget(collection, record)
        self.cancel = cancel
        self.hold = _Hold()

    @property
    def transport(self) -> FileTransport:
        return self.engine.transport

    def send(self, fn: Callable[[], FileReply]) -> FileReply:
        return self.engine._call(self.hold, self.cancel, fn)


def _pool(items: List[Any], width: int, fn: Callable[[Any], None]) -> None:
    """Run ``fn`` over ``items`` with at most ``width`` in flight; the first failure stops new work and is
    raised once the rest settle."""
    queue: Deque[Any] = deque(items)
    lock = threading.Lock()
    failure: List[BaseException] = []

    def worker() -> None:
        while True:
            with lock:
                if failure or not queue:
                    return
                item = queue.popleft()
            try:
                fn(item)
            except BaseException as e:  # noqa: BLE001 - re-raised below, on the caller's thread
                with lock:
                    if not failure:
                        failure.append(e)

    n = min(width, len(queue))
    if n <= 1:
        worker()
    else:
        threads = [threading.Thread(target=worker, daemon=True) for _ in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    if failure:
        raise failure[0]


class _UploadPass(_Pass):
    """A pass that journals: the record, kept in step with what the server holds."""

    rec: JournalRecord

    def __init__(self, engine: TransferEngine, collection: str, record: str, cancel: Optional[threading.Event]) -> None:
        super().__init__(engine, collection, record, cancel)
        self._rec_lock = threading.Lock()
        self._progress_lock = threading.Lock()

    def update(self, change: Dict[str, Any]) -> None:
        """Persist a change to the record. Changes are applied and written under one lock, so a late write
        never overtakes an early one."""
        with self._rec_lock:
            self.rec = {**self.rec, **change}
            self.engine.journal.put(self.rec["id"], {**self.rec, "done": list(self.rec["done"])})

    def add_done(self, n: int) -> None:
        with self._rec_lock:
            done = sorted(set(self.rec["done"]) | {n})
            self.rec = {**self.rec, "done": done}
            self.engine.journal.put(self.rec["id"], {**self.rec, "done": list(done)})

    def discard(self) -> None:
        """The upload cannot become the file: release it on the server and forget the record."""
        self.engine._abort_quietly(self.target, self.rec["uploadId"])
        self.engine.journal.delete(self.rec["id"])

    def refuse_begin(self, reply: FileReply) -> None:
        """A refusal of ``begin``: a 410 or 404 is not a stale upload, so it surfaces."""
        if reply.status in (410, 404):
            raise TransferError("rejected", status=reply.status, code=reply.code)
        _refuse_upload(reply)

    def begun(self, id: str, b: Dict[str, Any], mode: str, part_bytes: Optional[int], sha256: str, size: int) -> None:
        """Journal a begun upload."""
        self.rec = {
            "v": TRANSFER_JOURNAL_VERSION,
            "id": id,
            "kind": "upload",
            "collection": self.target.collection,
            "record": self.target.record,
            "uploadId": b["uploadId"],
            "mode": mode,
            "partBytes": part_bytes,
            "done": [],
            "sha256": sha256,
            "size": size,
            "expiresAt": b["expiresAt"],
            "state": "uploading",
        }
        self.update({})

    def begin_call(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """``begin``; a refusal is raised."""
        reply = self.send(lambda: self.transport.begin(self.target, request, self.cancel))
        if not reply.ok:
            self.refuse_begin(reply)
        return reply.value

    def finalize_call(self, resend: Callable[[Any], bool]) -> Dict[str, Any]:
        """``finalize``. On ``409 upload_incomplete`` (at most twice) ``resend`` gets the ``missing`` list
        and sends those again, answering False when the list is not one this upload could have; a 409 or a
        mismatch otherwise releases the upload."""
        again = 0
        while True:
            reply = self.send(
                lambda: self.transport.finalize(self.target, {"uploadId": self.rec["uploadId"]}, self.cancel)
            )
            if reply.ok:
                self.finish()
                return reply.value
            missing = reply.body.get("missing") if isinstance(reply.body, dict) else None
            if reply.status == 409 and reply.code == "upload_incomplete" and again < 2 and resend(missing):
                again += 1
                continue
            if reply.status == 409 or (reply.status == 400 and reply.code == "upload_mismatch"):
                self.discard()
            _refuse_upload(reply)

    def finish(self) -> None:
        """The upload finished: the record goes."""
        self.engine.journal.delete(self.rec["id"])


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


class _Run(_UploadPass):
    """One pass at one ``single`` or ``multipart`` upload: begin or resume, send what is missing, finalize."""

    def __init__(self, engine: TransferEngine, req: UploadRequest, resume: Optional[JournalRecord]) -> None:
        super().__init__(engine, req.collection, req.record, req.cancel)
        self.req = req
        self.resume = resume

    def go(self) -> Dict[str, Any]:
        if self.resume is None:
            self._begin()
        else:
            self.rec = self.resume
            if self.rec["state"] == "uploading":
                self._reconcile()
        if self.rec["state"] == "uploading":
            self._send_missing()
            self.update({"state": "finalizing"})
        return self._finalize()

    def _begin(self) -> None:
        r = self.req
        request: Dict[str, Any] = {"size": r.size, "sha256": r.sha256, "format": "whole", "enc": r.enc}
        if r.base_version is not None:
            request["baseVersion"] = r.base_version
        b = self.begin_call(request)
        part_bytes: Optional[int] = None
        mode = b.get("mode")
        if mode == "multipart":
            part_bytes = b.get("partBytes")
            ok = (
                _is_int(part_bytes)
                and 1 <= part_bytes <= SYNC_PART_MAX_BYTES  # type: ignore[operator]
                and -(-r.size // part_bytes) <= SYNC_MAX_PARTS  # type: ignore[operator]
            )
            if not ok:
                self.engine._abort_quietly(self.target, b["uploadId"])
                raise TransferError("bad-reply")
        elif mode != "single" or r.size > SYNC_SINGLE_PUT_MAX_BYTES:
            # ``chunks`` is the other upload; a file this big is never one PUT.
            self.engine._abort_quietly(self.target, b["uploadId"])
            raise TransferError("bad-reply")
        self.begun(r.id, b, mode, part_bytes, r.sha256, r.size)

    def _reconcile(self) -> None:
        """The server's list of received parts replaces the journal's ``done``."""
        reply = self.send(lambda: self.transport.status(self.target, self.rec["uploadId"], self.cancel))
        if not reply.ok:
            _refuse_upload(reply)
        if self.rec["mode"] != "multipart":
            return
        got = reply.value.get("received") or []
        parts = self._part_count()
        done = sorted({n for n in got if _is_int(n) and 1 <= n <= parts})
        self.update({"done": done})

    def _part_count(self) -> int:
        if self.rec["mode"] == "multipart":
            return -(-self.rec["size"] // self.rec["partBytes"])
        return 1

    def _plan(self) -> sf.TransferPlan:
        return sf.TransferPlan("multipart", self.rec["partBytes"], self._part_count())

    def _progress(self) -> None:
        rec = self.rec
        if rec["mode"] == "single":
            sent = rec["size"] if rec["done"] else 0
        else:
            plan = self._plan()
            sent = 0
            for p in rec["done"]:
                a, b = sf.part_range(plan, rec["size"], p)
                sent += b - a
        if self.req.on_progress is not None:
            with self._progress_lock:
                self.req.on_progress(sent, rec["size"])

    def _send_missing(self) -> None:
        parts = self._part_count()
        done = set(self.rec["done"])
        queue = [n for n in range(1, parts + 1) if n not in done]
        _pool(queue, self.engine.parallelism, self._send_part)

    def _send_part(self, n: int) -> None:
        rec = self.rec
        size, upload_id, mode = rec["size"], rec["uploadId"], rec["mode"]
        start, end = (0, size) if mode == "single" else sf.part_range(self._plan(), size, n)
        body = self.req.source.read(start, end)
        if len(body) != end - start:
            raise TransferError("source-mismatch")
        digest = _sha_hex(body)
        if mode == "single":
            reply = self.send(lambda: self.transport.put_single(self.target, upload_id, body, digest, self.cancel))
        else:
            reply = self.send(lambda: self.transport.put_part(self.target, upload_id, n, body, digest, self.cancel))
        if not reply.ok:
            _refuse_upload(reply)
        self.add_done(n)
        self._progress()

    def _finalize(self) -> Dict[str, Any]:
        def resend(missing: Any) -> bool:
            parts = self._part_count()
            if not isinstance(missing, list) or not all(_is_int(n) and 1 <= n <= parts for n in missing):
                return False
            lost = set(missing)
            self.update({"state": "uploading", "done": [n for n in self.rec["done"] if n not in lost]})
            self._send_missing()
            self.update({"state": "finalizing"})
            return True

        return self.finalize_call(resend)


@dataclass
class _Cut:
    """What pass one over a file leaves: the chunks in file order and the manifest that lists them."""

    records: List[sf.ManifestRecord]
    #: Where each record starts in the plaintext.
    offsets: List[int]
    #: The plain ``pkey-sync-chunks/1`` manifest.
    manifest: bytes
    plain_size: int


class _ChunkedRun(_UploadPass):
    """One pass at one ``chunks`` upload: begin, plan, send the missing chunks, the manifest, finalize."""

    def __init__(self, engine: TransferEngine, req: ChunkedUploadRequest, cut: _Cut) -> None:
        super().__init__(engine, req.collection, req.record, req.cancel)
        self.req = req
        self.cut = cut
        self.stored = b""
        self.stored_sha = ""
        #: hex id -> the first record that has it.
        self.unique: Dict[str, int] = {}
        for i, r in enumerate(cut.records):
            self.unique.setdefault(_hex(r.id), i)
        self.done = 0

    def go(self) -> Dict[str, Any]:
        self._begin()
        self._progress(0)
        missing = self._plan()
        self._send_chunks(missing)
        self._send_manifest()
        return self._finalize()

    def _progress(self, add: int) -> None:
        with self._progress_lock:
            self.done += add
            if self.req.on_progress is not None:
                self.req.on_progress(self.done, self.cut.plain_size)

    def _bad(self) -> "None":
        self.discard()
        raise TransferError("bad-reply")

    def _begin(self) -> None:
        r = self.req
        # A sealed manifest is different on every run, so it is sealed per begin.
        self.stored = r.codec.seal_manifest(self.cut.manifest)
        self.stored_sha = _sha_hex(self.stored)
        size = r.codec.stored_size(self.cut.plain_size)
        request: Dict[str, Any] = {"size": size, "sha256": self.stored_sha, "format": "chunks", "enc": r.codec.enc}
        if r.base_version is not None:
            request["baseVersion"] = r.base_version
        b = self.begin_call(request)
        if b.get("mode") != "chunks":
            self.engine._abort_quietly(self.target, b["uploadId"])
            raise TransferError("bad-reply")
        self.begun(r.id, b, "chunks", None, self.stored_sha, size)

    def _plan(self) -> List[str]:
        """The ids the server lacks, in file order. Every id sent is answered exactly once or the reply is refused."""
        records = self.cut.records
        ids = list(self.unique)
        missing = set()
        for at in range(0, len(ids), SYNC_CHUNK_PLAN_MAX_IDS):
            batch = ids[at : at + SYNC_CHUNK_PLAN_MAX_IDS]
            asked = set(batch)
            request = {
                "chunks": [[i, self.req.codec.chunk_object_bytes(records[self.unique[i]].plain_len)] for i in batch]
            }
            reply = self.send(
                partial(self.transport.plan_chunks, self.target, self.rec["uploadId"], request, self.cancel)
            )
            if not reply.ok:
                _refuse_upload(reply)
            lists = reply.value
            if (
                not isinstance(lists, dict)
                or not isinstance(lists.get("missing"), list)
                or not isinstance(lists.get("present"), list)
            ):
                self._bad()
            said = set()
            for i in lists["missing"]:
                if not isinstance(i, str) or i not in asked or i in said:
                    self._bad()
                said.add(i)
                missing.add(i)
            for entry in lists["present"]:
                i = entry[0] if isinstance(entry, list) and entry else None
                if not isinstance(i, str) or i not in asked or i in said:
                    self._bad()
                said.add(i)
                self._progress(records[self.unique[i]].plain_len)
            if len(said) != len(asked):
                self._bad()
        return [i for i in ids if i in missing]

    def _send_chunks(self, ids: List[str]) -> None:
        _pool(ids, self.engine.parallelism, self._send_chunk)

    def _send_chunk(self, id: str) -> None:
        i = self.unique.get(id)
        if i is None:
            raise TransferError("bad-reply")
        rec = self.cut.records[i]
        start = self.cut.offsets[i]
        codec = self.req.codec
        plain = self.req.source.read(start, start + rec.plain_len)
        # The file may have changed since it was cut: what is sent must still be the chunk named.
        if len(plain) != rec.plain_len or not hmac.compare_digest(codec.chunk_id(plain), rec.id):
            raise TransferError("source-mismatch")
        obj = codec.seal_chunk(rec.id, plain)
        digest = _sha_hex(obj)
        reply = self.send(
            lambda: self.transport.put_chunk(self.target, self.rec["uploadId"], id, obj, digest, self.cancel)
        )
        if not reply.ok:
            _refuse_upload(reply)
        self._progress(rec.plain_len)

    def _send_manifest(self) -> None:
        reply = self.send(
            lambda: self.transport.put_single(
                self.target, self.rec["uploadId"], self.stored, self.stored_sha, self.cancel
            )
        )
        if not reply.ok:
            _refuse_upload(reply)
        self.update({"state": "finalizing"})

    def _finalize(self) -> Dict[str, Any]:
        def resend(lost: Any) -> bool:
            if not isinstance(lost, list) or not all(isinstance(i, str) and i in self.unique for i in lost):
                return False
            self._send_chunks(lost)
            return True

        return self.finalize_call(resend)


class _Download(_Pass):
    """One download: fetch the stored bytes, check them, and write the plaintext."""

    def __init__(self, engine: TransferEngine, req: DownloadRequest) -> None:
        super().__init__(engine, req.collection, req.record, req.cancel)
        self.req = req
        self.written = 0
        self.total = 0

    def go(self) -> None:
        size, sha256 = self.req.size, self.req.sha256
        if not _is_int(size) or size <= 0 or size > self.req.codec.stored_size(SYNC_FILE_MAX_BYTES):
            raise _invalid("size")
        if not isinstance(sha256, str) or len(sha256) != 64 or any(c not in "0123456789abcdef" for c in sha256):
            raise _invalid("sha256")
        try:
            if self.req.format == "whole":
                self._whole()
            else:
                self._chunked()
        except sf.FileStreamError as e:
            raise _invalid(e.reason) from None

    def _emit(self, piece: bytes) -> None:
        self.req.sink.write(piece)
        self.written += len(piece)
        if self.req.on_progress is not None:
            self.req.on_progress(self.written, self.total)

    def _whole(self) -> None:
        """A whole file: ranges of the stored bytes, opened as they arrive."""
        plain_size = self.req.codec.plain_size(self.req.size)
        if plain_size is None:
            raise _invalid("size")
        self.total = plain_size
        for piece in self.req.codec.open_stream(self._stored()):
            if _is_cancelled(self.cancel):
                raise _aborted()
            self._emit(piece)
        if self.written != plain_size:
            raise _invalid("size")

    def _stored(self) -> Iterator[bytes]:
        """The stored bytes of the file in ranges. Every range is asked with the ETag the first answer gave
        (``If-Match``), its status and ``Content-Range`` are checked against what was asked, and the length
        and SHA-256 are checked after the last one: until this iterator ends, what it yielded is
        provisional."""
        size, sha256 = self.req.size, self.req.sha256
        digest = hashlib.sha256()
        etag: Optional[str] = None
        at = 0
        while at < size:
            end = min(size, at + DOWNLOAD_RANGE_BYTES)
            ask = at
            query = FileQuery(version=self.req.version, range=(ask, end), if_match=etag)
            reply = self.send(partial(self.transport.get_file, self.target, query, self.cancel))
            if not reply.ok:
                _refuse_download(reply)
            body: FileBody = reply.value
            if etag is not None and body.etag is not None and body.etag != etag:
                raise TransferError("bad-reply", detail="etag")
            if etag is None:
                etag = body.etag
            if body.status == 206:
                cr = body.content_range
                if (
                    cr is None
                    or cr[0] != ask
                    or cr[2] != size
                    or cr[1] <= cr[0]
                    or cr[1] > end
                    or len(body.data) != cr[1] - cr[0]
                ):
                    raise TransferError("bad-reply", detail="content-range")
                piece = body.data
            elif body.status == 200:
                # A server that ignores ``Range`` sends the whole file, which only fits from the start.
                if ask != 0 or len(body.data) != size:
                    raise TransferError("bad-reply", detail="status")
                piece = body.data
            else:
                raise TransferError("bad-reply", detail="status")
            digest.update(piece)
            at += len(piece)
            yield piece
        if digest.hexdigest() != sha256:
            raise _invalid("sha256")

    def _chunked(self) -> None:
        """A chunked file: the manifest, then each chunk from the cache or the server."""
        codec, cache = self.req.codec, self.req.cache
        manifest_max = codec.stored_size(_MANIFEST_PLAIN_MAX_BYTES)
        query = FileQuery(version=self.req.version)
        reply = self.send(lambda: self.transport.get_file(self.target, query, self.cancel))
        if not reply.ok:
            _refuse_download(reply)
        body: FileBody = reply.value
        stored = body.data
        if body.status != 200:
            raise TransferError("bad-reply", detail="status")
        if len(stored) > manifest_max:
            raise _invalid("manifest-size")
        if _sha_hex(stored) != self.req.sha256:
            raise _invalid("sha256")
        opened = codec.open_manifest(stored)
        if not opened.ok:
            raise _invalid("manifest-" + str(opened.reason))
        parsed = sf.parse_manifest(opened.plain)
        if not parsed.ok or parsed.manifest is None:
            raise _invalid("manifest-" + str(parsed.reason))
        manifest = parsed.manifest
        # The record's size and the manifest's must agree.
        if codec.stored_size(manifest.plain_size) != self.req.size:
            raise _invalid("size")
        self.total = manifest.plain_size

        def fetch_one(rec: sf.ManifestRecord) -> bytes:
            if _is_cancelled(self.cancel):
                raise _aborted()
            id = _hex(rec.id)
            if cache is not None:
                held: Optional[bytes] = None
                try:
                    held = cache.get(id)
                except Exception:  # noqa: BLE001 - a cache that fails is a miss
                    held = None
                if held is not None:
                    o = codec.open_chunk(rec.id, held)
                    if o.ok and len(o.plain) == rec.plain_len:
                        return o.plain
                    try:
                        cache.delete(id)
                    except Exception:  # noqa: BLE001 - best effort
                        pass
            got = self.send(lambda: self.transport.get_chunk(self.req.collection, id, self.cancel))
            if not got.ok:
                _refuse_download(got)
            obj = got.value
            if len(obj) > SERVER_CHUNK_MAX_STORED_BYTES:
                raise _invalid("chunk-size")
            o = codec.open_chunk(rec.id, obj)
            if not o.ok:
                raise _invalid("chunk-" + str(o.reason))
            if len(o.plain) != rec.plain_len:
                raise _invalid("chunk-length")
            if cache is not None:
                try:
                    cache.put(id, obj)
                except Exception:  # noqa: BLE001 - best effort
                    pass
            return o.plain

        def pieces() -> Iterator[bytes]:
            # A short window of chunks in flight, delivered in file order.
            window: Deque[Future] = deque()  # type: ignore[type-arg]
            pool = ThreadPoolExecutor(max_workers=self.engine.parallelism)
            nxt = 0
            try:
                while True:
                    while len(window) < self.engine.parallelism and nxt < len(manifest.records):
                        window.append(pool.submit(fetch_one, manifest.records[nxt]))
                        nxt += 1
                    if not window:
                        return
                    yield window.popleft().result()
            finally:
                pool.shutdown(wait=True, cancel_futures=True)

        for piece in sf.verify_reassembly(pieces(), manifest.plain_size, manifest.plain_sha256):
            if _is_cancelled(self.cancel):
                raise _aborted()
            self._emit(piece)
