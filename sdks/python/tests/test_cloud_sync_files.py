# @pkey-feature sync.files
"""The Cloud Sync file transfer engine, journal, chunk cache and file codecs (U-22.10), against a fake of
the Worker's file routes behind the ``FileTransport`` port. A port of client-core's
``syncTransfer.test.ts`` and ``syncTransferChunks.test.ts``, plus the on-disk journal and cache that the
Node host (U-22.4) pins, and the security points of plans/U-22-U-23-U-37-U-41-slices.md section 4 that this
layer owns: the zstd declared size is checked before decode, ``Range`` is held with ``If-Match``, cache and
journal files are named only from hashes and hex ids and kept at 0600, nothing but ids and counts is in the
journal, and every download refusal is ``file-invalid`` in order."""

from __future__ import annotations

import hashlib
import json
import os
import random
import stat
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest

from polaris_key.cloud_sync import transfer as tr
from polaris_key.cloud_sync.chunk_cache import (
    CHUNK_CACHE_MIN_BYTES,
    FileChunkCache,
    MemoryChunkCache,
    chunk_cache_budget,
    chunk_cache_dir,
    is_chunk_cache_id,
)
from polaris_key.cloud_sync.journal import (
    FileJournal,
    MemoryJournal,
    TransferJournalError,
    journal_file_name,
    parse_journal_record,
)
from polaris_key.cloud_sync.transfer import (
    DOWNLOAD_RANGE_BYTES,
    FileBody,
    FileQuery,
    FileReply,
    FileTarget,
    TransferEngine,
    TransferError,
    ranged_bytes,
)
from polaris_key.cloud_sync.transfer_codec import (
    SERVER_CHUNK_MAX_STORED_BYTES,
    e2e_file_codec,
    server_file_codec,
)
from polaris_key.core import sync_crypto as sc
from polaris_key.core import sync_files as sf

MIB = 1024 * 1024


def noise(length: int, seed: int = 1) -> bytes:
    return random.Random(seed).randbytes(length)


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def fail(status: int, code: str, **extra: Any) -> FileReply:
    return FileReply.failure(status, code, **extra)


ROOT = bytes(range(1, 33))
SERVER = server_file_codec()


def e2e() -> Any:
    return e2e_file_codec(ROOT, "saves")


class Sink:
    def __init__(self, on_write: Optional[Callable[[], None]] = None) -> None:
        self.parts: List[bytes] = []
        self._on_write = on_write

    def write(self, data: bytes) -> None:
        self.parts.append(bytes(data))
        if self._on_write is not None:
            self._on_write()

    def bytes(self) -> bytes:
        return b"".join(self.parts)


class FakeServer:
    """A fake U-10 and U-37 server behind the port: parts in any order, chunks per collection, files by version."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.uploads: Dict[str, Dict[str, Any]] = {}
        self.chunks: Dict[str, bytes] = {}
        self.files: List[Dict[str, Any]] = []
        self.calls: List[str] = []
        self.begins = 0
        self.part_puts: List[int] = []
        self.stored: List[int] = []
        self.chunk_puts: List[str] = []
        self.chunk_gets: List[str] = []
        self.file_gets: List[FileQuery] = []
        self.aborted: List[str] = []
        self.in_flight = 0
        self.max_in_flight = 0
        self.seq = 0
        self.part_bytes = 8 * MIB
        self.expires_at = int(time.time()) + 86400
        self.etag = '"e1"'
        #: Breaks one kind of call; return a reply to override, or raise.
        self.hook: Callable[..., Optional[FileReply]] = lambda kind, arg=None: None
        self.delay: Callable[[int], float] = lambda n: 0.0
        self.tamper_file: Callable[[FileQuery, FileBody], FileBody] = lambda q, b: b
        self.tamper_chunk: Callable[[str, bytes], bytes] = lambda i, o: o
        self.plan_override: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None
        self.begin_override: Optional[Callable[[Dict[str, Any]], FileReply]] = None
        self.plan_sizes: List[int] = []
        self.begin_requests: List[Dict[str, Any]] = []
        self.finalize_gate: Optional[Callable[[Dict[str, Any]], None]] = None

    def log(self, call: str) -> None:
        with self.lock:
            self.calls.append(call)

    # begin / status ---------------------------------------------------------------------------------
    def begin(self, target: FileTarget, r: Dict[str, Any], cancel: Any = None) -> FileReply:
        self.log("begin")
        self.begin_requests.append(dict(r))
        h = self.hook("begin")
        if h:
            return h
        if self.begin_override is not None:
            return self.begin_override(r)
        with self.lock:
            self.begins += 1
            self.seq += 1
            upload_id = "up%d" % self.seq
            if r["format"] == "chunks":
                mode = "chunks"
            else:
                mode = "single" if r["size"] <= 16 * MIB else "multipart"
            self.uploads[upload_id] = {
                "size": r["size"],
                "sha256": r["sha256"],
                "format": r["format"],
                "mode": mode,
                "partBytes": self.part_bytes if mode == "multipart" else None,
                "parts": {},
                "planned": set(),
                "manifest": None,
                "expiresAt": self.expires_at,
                "done": None,
            }
        out: Dict[str, Any] = {"uploadId": upload_id, "mode": mode, "expiresAt": self.expires_at}
        if mode == "multipart":
            out["partBytes"] = self.part_bytes
        return FileReply.success(out)

    def status(self, target: FileTarget, upload_id: str, cancel: Any = None) -> FileReply:
        self.log("status")
        h = self.hook("status")
        if h:
            return h
        u = self.uploads.get(upload_id)
        if not u:
            return fail(410, "upload_expired")
        out: Dict[str, Any] = {
            "mode": u["mode"],
            "size": u["size"],
            "received": sorted(u["parts"]),
            "expiresAt": u["expiresAt"],
        }
        if u["partBytes"]:
            out["partBytes"] = u["partBytes"]
        return FileReply.success(out)

    # bytes in ---------------------------------------------------------------------------------------
    def _store(self, upload_id: str, n: int, body: bytes, digest: str) -> FileReply:
        u = self.uploads.get(upload_id)
        if not u:
            return fail(410, "upload_expired")
        if sha(body) != digest:
            return fail(400, "upload_mismatch")
        with self.lock:
            u["parts"][n] = bytes(body)
            self.stored.append(n)
        return FileReply.success(None)

    def put_single(self, target: FileTarget, upload_id: str, body: bytes, digest: str, cancel: Any = None) -> FileReply:
        self.log("putSingle")
        h = self.hook("putSingle")
        if h:
            return h
        u = self.uploads.get(upload_id)
        if not u:
            return fail(410, "upload_expired")
        if sha(body) != digest:
            return fail(400, "upload_mismatch")
        if u["mode"] == "chunks":
            u["manifest"] = bytes(body)
            return FileReply.success(None)
        return self._store(upload_id, 1, body, digest)

    def put_part(
        self, target: FileTarget, upload_id: str, n: int, body: bytes, digest: str, cancel: Any = None
    ) -> FileReply:
        self.log("part%d" % n)
        with self.lock:
            self.part_puts.append(n)
        h = self.hook("putPart", n)
        if h:
            return h
        with self.lock:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            time.sleep(self.delay(n))
            return self._store(upload_id, n, body, digest)
        finally:
            with self.lock:
                self.in_flight -= 1

    def abort(self, target: FileTarget, upload_id: str, cancel: Any = None) -> FileReply:
        self.log("abort")
        with self.lock:
            self.aborted.append(upload_id)
            self.uploads.pop(upload_id, None)
        return FileReply.success(None)

    def plan_chunks(self, target: FileTarget, upload_id: str, r: Dict[str, Any], cancel: Any = None) -> FileReply:
        self.log("plan")
        h = self.hook("plan")
        if h:
            return h
        u = self.uploads.get(upload_id)
        if not u:
            return fail(410, "upload_expired")
        self.plan_sizes.append(len(r["chunks"]))
        if self.plan_override is not None:
            return FileReply.success(self.plan_override(r))
        missing, present = [], []
        for cid, n in r["chunks"]:
            u["planned"].add(cid)
            (present if cid in self.chunks else missing).append([cid, n] if cid in self.chunks else cid)
        return FileReply.success({"missing": missing, "present": present})

    def put_chunk(
        self, target: FileTarget, upload_id: str, cid: str, body: bytes, digest: str, cancel: Any = None
    ) -> FileReply:
        self.log("putChunk")
        h = self.hook("putChunk", cid)
        if h:
            return h
        if upload_id not in self.uploads:
            return fail(410, "upload_expired")
        if sha(body) != digest:
            return fail(400, "upload_mismatch")
        with self.lock:
            self.chunk_puts.append(cid)
            self.chunks[cid] = bytes(body)
        return FileReply.success(None)

    def finalize(self, target: FileTarget, r: Dict[str, Any], cancel: Any = None) -> FileReply:
        self.log("finalize")
        if self.finalize_gate is not None:
            self.finalize_gate(r)
        h = self.hook("finalize")
        if h:
            return h
        u = self.uploads.get(r["uploadId"])
        if not u:
            return fail(410, "upload_expired")
        if u["done"]:
            return FileReply.success(u["done"])
        if u["mode"] == "chunks":
            missing = [c for c in u["planned"] if c not in self.chunks]
            if missing or u["manifest"] is None:
                return fail(409, "upload_incomplete", body={"missing": missing})
            data = u["manifest"]
        else:
            want = 1 if u["mode"] == "single" else -(-u["size"] // u["partBytes"])
            missing_parts = [n for n in range(1, want + 1) if n not in u["parts"]]
            if missing_parts:
                return fail(409, "upload_incomplete", body={"missing": missing_parts})
            data = b"".join(u["parts"][k] for k in sorted(u["parts"]))
            if sha(data) != u["sha256"]:
                return fail(400, "upload_mismatch")
        version = len(self.files) + 1
        self.files.append(
            {"version": version, "format": u["format"], "size": u["size"], "sha256": u["sha256"], "bytes": data}
        )
        u["done"] = {"version": version, "size": u["size"], "sha256": u["sha256"], "format": u["format"]}
        return FileReply.success(u["done"])

    # bytes out --------------------------------------------------------------------------------------
    def get_file(self, target: FileTarget, q: FileQuery, cancel: Any = None) -> FileReply:
        self.log("getFile")
        with self.lock:
            self.file_gets.append(q)
        h = self.hook("getFile")
        if h:
            return h
        f = (
            self.files[-1]
            if q.version is None and self.files
            else next((x for x in self.files if x["version"] == q.version), None)
        )
        if f is None:
            return fail(404, "not_found")
        if f["format"] == "chunks" or q.range is None:
            return FileReply.success(self.tamper_file(q, FileBody(status=200, data=f["bytes"], etag=self.etag)))
        a, b = q.range
        return FileReply.success(
            self.tamper_file(
                q, FileBody(status=206, data=f["bytes"][a:b], etag=self.etag, content_range=(a, b, len(f["bytes"])))
            )
        )

    def revisions(self, target: FileTarget, cancel: Any = None) -> FileReply:
        return FileReply.success({"revisions": []})

    def get_chunk(self, collection: str, cid: str, cancel: Any = None) -> FileReply:
        self.log("getChunk")
        with self.lock:
            self.chunk_gets.append(cid)
        h = self.hook("getChunk", cid)
        if h:
            return h
        o = self.chunks.get(cid)
        return FileReply.success(self.tamper_chunk(cid, o)) if o is not None else fail(404, "not_found")


def make_engine(server: Any, journal: Any = None, **over: Any) -> Tuple[TransferEngine, List[float]]:
    sleeps: List[float] = []

    def sleep(seconds: float, cancel: Any = None) -> None:
        sleeps.append(seconds)

    kw: Dict[str, Any] = {"sleep": sleep, "random": lambda: 0.5}
    kw.update(over)
    return TransferEngine(server, journal if journal is not None else MemoryJournal(), **kw), sleeps


def request(data: bytes, **over: Any) -> tr.UploadRequest:
    r = tr.UploadRequest(
        id="t1",
        collection="saves",
        record="rec1",
        source=ranged_bytes(data),
        size=len(data),
        sha256=sha(data),
        enc="none",
    )
    for k, v in over.items():
        setattr(r, k, v)
    return r


BIG = noise(40 * MIB, 3)  # 5 parts of 8 MiB
SMALL = noise(300_000, 9)
DATA = noise(3 * MIB, 5)


# ── single and multipart uploads ──────────────────────────────────────────────────────────────────


def test_uploads_a_single_mode_file_and_clears_the_journal() -> None:
    s, j = FakeServer(), MemoryJournal()
    e, _ = make_engine(s, j)
    out = e.upload(request(SMALL))
    assert out["size"] == len(SMALL)
    assert s.calls == ["begin", "putSingle", "finalize"]
    assert j.list() == []


def test_uploads_multipart_at_most_four_parts_at_once_in_any_order() -> None:
    s, j = FakeServer(), MemoryJournal()
    s.part_bytes = 4 * MIB  # 10 parts
    s.delay = lambda n: 0.001 if n % 2 == 0 else 0.03 - n * 0.002  # later parts can finish first
    e, _ = make_engine(s, j)
    sent: List[int] = []
    out = e.upload(request(BIG, on_progress=lambda n, total: sent.append(n)))
    assert 2 <= s.max_in_flight <= 4
    assert len(s.part_puts) == 10
    assert sorted(s.stored) == list(range(1, 11))
    up = next(iter(s.uploads.values()))
    assert sha(b"".join(up["parts"][k] for k in sorted(up["parts"]))) == out["sha256"]
    assert max(sent) == len(BIG) and sent[-1] == len(BIG)
    assert j.list() == []


def test_journals_parts_in_ascending_order_whichever_finishes_first() -> None:
    s, j = FakeServer(), MemoryJournal()
    s.delay = lambda n: max(0.0, 0.03 - n * 0.005)
    seen: List[List[int]] = []
    put = j.put

    def spy(id: str, rec: Dict[str, Any]) -> None:
        seen.append(list(rec["done"]))
        put(id, rec)

    j.put = spy  # type: ignore[method-assign]
    e, _ = make_engine(s, j)
    e.upload(request(BIG))
    assert all(d == sorted(d) for d in seen)
    assert any(len(d) == 5 for d in seen)


def test_resumes_from_the_journal_after_a_crash_sending_only_the_missing_parts() -> None:
    s, j = FakeServer(), MemoryJournal()

    def kill(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putPart" and (n or 0) >= 3:
            raise RuntimeError("killed")
        return None

    s.hook = kill
    first, _ = make_engine(s, j, max_attempts=1)
    with pytest.raises(TransferError) as ei:
        first.upload(request(BIG))
    assert ei.value.reason == "retries-exhausted"
    rec = j.get("t1")
    assert rec["v"] == 1 and rec["state"] == "uploading" and 1 <= len(rec["done"]) < 5
    s.hook = lambda kind, arg=None: None
    s.calls.clear()
    s.part_puts.clear()
    second, _ = make_engine(s, j)
    out = second.upload(request(BIG))
    assert s.begins == 1 and s.calls[0] == "status"
    assert all(n not in s.part_puts for n in rec["done"])
    assert len(s.part_puts) == 5 - len(rec["done"])
    assert out["size"] == len(BIG) and j.list() == []


def test_resends_a_part_the_journal_calls_done_but_the_server_lost() -> None:
    s, j = FakeServer(), MemoryJournal()
    s.delay = lambda n: 0.0

    def kill(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putPart" and n == 5:
            raise RuntimeError("killed")
        return None

    s.hook = kill
    first, _ = make_engine(s, j, max_attempts=1)
    with pytest.raises(TransferError):
        first.upload(request(BIG))
    rec = j.get("t1")
    assert 2 in rec["done"]
    del s.uploads[rec["uploadId"]]["parts"][2]
    s.hook = lambda kind, arg=None: None
    s.part_puts.clear()
    make_engine(s, j)[0].upload(request(BIG))
    assert 2 in s.part_puts and 1 not in s.part_puts


def test_finalize_upload_incomplete_resends_the_named_parts() -> None:
    s, j = FakeServer(), MemoryJournal()
    state = {"dropped": False}

    def gate(r: Dict[str, Any]) -> None:
        if not state["dropped"]:
            state["dropped"] = True
            del s.uploads[r["uploadId"]]["parts"][3]

    s.finalize_gate = gate
    make_engine(s, j)[0].upload(request(BIG))
    assert s.part_puts.count(3) == 2
    assert s.calls.count("finalize") == 2


def test_restarts_on_a_410_at_status_and_mid_parts_then_succeeds() -> None:
    s, j = FakeServer(), MemoryJournal()

    def kill(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putPart" and (n or 0) >= 3:
            raise RuntimeError("killed")
        return None

    s.hook = kill
    with pytest.raises(TransferError):
        make_engine(s, j, max_attempts=1)[0].upload(request(BIG))
    s.uploads.clear()  # the upload expired on the server while the app was away
    s.hook = lambda kind, arg=None: None
    s.begins = 0
    out = make_engine(s, j)[0].upload(request(BIG))
    assert s.begins == 1 and out["size"] == len(BIG)

    s2, j2 = FakeServer(), MemoryJournal()
    hit = {"done": False}

    def expire(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putPart" and n == 2 and not hit["done"]:
            hit["done"] = True
            return fail(410, "upload_expired")
        return None

    s2.hook = expire
    out2 = make_engine(s2, j2)[0].upload(request(BIG))
    assert s2.begins == 2 and out2["size"] == len(BIG) and j2.list() == []


def test_gives_up_with_restarts_exhausted_when_the_upload_keeps_vanishing() -> None:
    s = FakeServer()
    s.hook = lambda kind, arg=None: fail(410, "upload_expired") if kind == "putSingle" else None
    with pytest.raises(TransferError) as ei:
        make_engine(s, max_restarts=2)[0].upload(request(SMALL))
    assert ei.value.reason == "restarts-exhausted" and s.begins == 3


def test_begins_afresh_when_the_journal_record_is_past_expires_at() -> None:
    s, j = FakeServer(), MemoryJournal()
    req = request(BIG)
    j.put(
        "t1",
        {
            "v": 1,
            "id": "t1",
            "kind": "upload",
            "collection": "saves",
            "record": "rec1",
            "uploadId": "old",
            "mode": "multipart",
            "partBytes": 8 * MIB,
            "done": [1, 2],
            "sha256": req.sha256,
            "size": req.size,
            "expiresAt": int(time.time()) - 5,
            "state": "uploading",
        },
    )
    make_engine(s, j)[0].upload(req)
    assert "status" not in s.calls and s.begins == 1 and len(s.part_puts) == 5


def test_surfaces_a_409_revision_conflict_from_begin_with_the_server_version() -> None:
    s, j = FakeServer(), MemoryJournal()
    s.hook = lambda kind, arg=None: (
        fail(409, "revision_conflict", body={"server": {"version": 7}}) if kind == "begin" else None
    )
    with pytest.raises(TransferError) as ei:
        make_engine(s, j)[0].upload(request(SMALL, base_version=3))
    assert (ei.value.reason, ei.value.status, ei.value.server_version) == ("conflict", 409, 7)
    assert s.calls == ["begin"] and j.list() == []
    assert s.begin_requests[0]["baseVersion"] == 3


def test_surfaces_a_409_at_finalize_aborts_the_upload_and_drops_the_journal() -> None:
    s, j = FakeServer(), MemoryJournal()
    s.hook = lambda kind, arg=None: (
        fail(409, "revision_conflict", body={"server": {"version": 9}}) if kind == "finalize" else None
    )
    with pytest.raises(TransferError) as ei:
        make_engine(s, j)[0].upload(request(SMALL))
    assert ei.value.reason == "conflict" and ei.value.server_version == 9
    assert s.calls[-1] == "abort" and j.list() == []


def test_honours_retry_after_holding_every_part_and_backs_off_without_it() -> None:
    s = FakeServer()
    state = {"first": True}

    def limited(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putPart" and n == 1 and state["first"]:
            state["first"] = False
            return fail(429, "rate_limited", retry_after_seconds=7)
        return None

    s.hook = limited
    e, sleeps = make_engine(s, now=lambda: 1_000_000.0)
    out = e.upload(request(BIG))
    assert out["size"] == len(BIG)
    # The clock does not move, so every part sent after the 429 waits the full hold.
    assert sleeps and all(x == 7.0 for x in sleeps)
    assert s.part_puts.count(1) == 2

    s2 = FakeServer()
    failures = {"n": 3}

    def flaky(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putSingle" and failures["n"] > 0:
            failures["n"] -= 1
            return fail(503, "unavailable")
        return None

    s2.hook = flaky
    t = {"now": 0.0}
    waits: List[float] = []

    def sleep(seconds: float, cancel: Any = None) -> None:
        waits.append(seconds)
        t["now"] += seconds

    TransferEngine(s2, MemoryJournal(), now=lambda: t["now"], sleep=sleep, random=lambda: 0.5).upload(request(SMALL))
    assert waits == [0.375, 0.75, 1.5]  # exponential, jittered by random() = 0.5


def test_retries_a_call_that_gets_no_answer_then_gives_up_leaving_the_journal() -> None:
    s, j = FakeServer(), MemoryJournal()

    def down(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putSingle":
            raise OSError("network")
        return None

    s.hook = down
    with pytest.raises(TransferError) as ei:
        make_engine(s, j, max_attempts=3)[0].upload(request(SMALL))
    assert ei.value.reason == "retries-exhausted"
    assert s.calls.count("putSingle") == 3
    assert j.get("t1")["state"] == "uploading"


def test_surfaces_an_upload_mismatch_without_a_retry() -> None:
    s = FakeServer()
    s.hook = lambda kind, arg=None: fail(400, "upload_mismatch") if kind == "putSingle" else None
    with pytest.raises(TransferError) as ei:
        make_engine(s)[0].upload(request(SMALL))
    assert ei.value.reason == "mismatch" and s.calls.count("putSingle") == 1


def test_refuses_a_source_whose_hash_is_not_the_declared_sha256_sending_nothing() -> None:
    s = FakeServer()
    req = request(SMALL)
    req.source = ranged_bytes(noise(len(SMALL), 77))
    with pytest.raises(TransferError) as ei:
        make_engine(s)[0].upload(req)
    assert ei.value.reason == "source-mismatch"
    req2 = request(SMALL)
    req2.size += 1
    with pytest.raises(TransferError) as ei:
        make_engine(s)[0].upload(req2)
    assert ei.value.reason == "source-mismatch" and s.calls == []


def test_refuses_a_journal_record_with_an_unknown_version_and_leaves_it_alone() -> None:
    s, j = FakeServer(), MemoryJournal()
    future = {"v": 2, "id": "t1", "whatever": True}
    j.put("t1", future)
    with pytest.raises(TransferError) as ei:
        make_engine(s, j)[0].upload(request(SMALL))
    assert ei.value.reason == "journal-version" and s.calls == [] and j.get("t1") == future
    j.put("t1", {"v": 1, "id": "t1"})
    with pytest.raises(TransferError) as ei:
        make_engine(s, j)[0].upload(request(SMALL))
    assert ei.value.reason == "journal-malformed" and s.calls == []


def test_drops_a_record_for_other_bytes_aborting_its_upload_and_begins_anew() -> None:
    s, j = FakeServer(), MemoryJournal()

    def kill(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putSingle":
            raise RuntimeError("killed")
        return None

    s.hook = kill
    with pytest.raises(TransferError):
        make_engine(s, j, max_attempts=1)[0].upload(request(SMALL))
    s.hook = lambda kind, arg=None: None
    make_engine(s, j)[0].upload(request(noise(1000, 5)))
    assert "abort" in s.calls and s.begins == 2


def test_stops_on_cancel_and_keeps_the_journal_for_a_resume() -> None:
    s, j = FakeServer(), MemoryJournal()
    stop = threading.Event()
    s.delay = lambda n: 0.005

    def trip(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putPart" and n == 3:
            stop.set()
        return None

    s.hook = trip
    e = TransferEngine(s, j, random=lambda: 0.5)  # the default sleep, which honours the event
    with pytest.raises(TransferError) as ei:
        e.upload(request(BIG, cancel=stop))
    assert ei.value.reason == "aborted"
    assert j.get("t1")["state"] == "uploading"


def test_a_cancel_wakes_a_backoff_wait() -> None:
    s = FakeServer()
    s.hook = lambda kind, arg=None: fail(503, "unavailable") if kind == "putSingle" else None
    stop = threading.Event()
    threading.Timer(0.05, stop.set).start()
    e = TransferEngine(s, MemoryJournal(), random=lambda: 0.5)
    started = time.time()
    with pytest.raises(TransferError) as ei:
        e.upload(request(SMALL, cancel=stop))
    assert ei.value.reason == "aborted" and time.time() - started < 5


def test_engine_cancel_aborts_the_servers_upload_and_forgets_the_record() -> None:
    s, j = FakeServer(), MemoryJournal()
    s.hook = lambda kind, arg=None: (_ for _ in ()).throw(RuntimeError("killed")) if kind == "putSingle" else None
    e, _ = make_engine(s, j, max_attempts=1)
    with pytest.raises(TransferError):
        e.upload(request(SMALL))
    assert j.list() == ["t1"]
    e.cancel("t1")
    assert s.calls[-1] == "abort" and j.list() == []
    e.cancel("t1")  # nothing left: no error
    j.put("t2", {"v": 9})
    e.cancel("t2")  # a record this build cannot read is left for the build that wrote it
    assert j.get("t2") == {"v": 9}


def test_resumes_a_record_in_the_finalizing_state_straight_at_finalize() -> None:
    s, j = FakeServer(), MemoryJournal()
    state = {"drop": True}
    real = s.finalize

    def lossy(target: FileTarget, r: Dict[str, Any], cancel: Any = None) -> FileReply:
        if state["drop"]:
            state["drop"] = False
            real(target, r)  # the server finished, the answer was lost
            raise RuntimeError("killed")
        return real(target, r)

    s.finalize = lossy  # type: ignore[method-assign]
    with pytest.raises(TransferError):
        make_engine(s, j, max_attempts=1)[0].upload(request(SMALL))
    assert j.get("t1")["state"] == "finalizing"
    s.calls.clear()
    out = make_engine(s, j)[0].upload(request(SMALL))
    assert s.calls == ["finalize"] and out["size"] == len(SMALL)


def test_refuses_a_begin_that_answers_a_part_size_it_cannot_use() -> None:
    s = FakeServer()
    for bad in (0, SYNC_BAD, True, "8"):
        s.begin_override = lambda r, bad=bad: FileReply.success(  # type: ignore[misc]
            {"uploadId": "x", "mode": "multipart", "partBytes": bad, "expiresAt": 1}
        )
        s.aborted.clear()
        with pytest.raises(TransferError) as ei:
            make_engine(s)[0].upload(request(BIG))
        assert ei.value.reason == "bad-reply" and s.aborted == ["x"]
    # A single answer for a file over 16 MiB is refused too.
    s.begin_override = lambda r: FileReply.success({"uploadId": "y", "mode": "single", "expiresAt": 1})
    with pytest.raises(TransferError) as ei:
        make_engine(s)[0].upload(request(BIG))
    assert ei.value.reason == "bad-reply"


SYNC_BAD = 64 * MIB + 1


def test_parse_journal_record_rejects_out_of_range_lists_and_odd_shapes() -> None:
    base = {
        "v": 1,
        "id": "t",
        "kind": "upload",
        "collection": "c",
        "record": "r",
        "uploadId": "u",
        "mode": "multipart",
        "partBytes": 8 * MIB,
        "done": [1, 2],
        "sha256": "a" * 64,
        "size": 40 * MIB,
        "expiresAt": 1,
        "state": "uploading",
    }
    assert parse_journal_record(base)["done"] == [1, 2]
    for bad in (
        {**base, "done": [2, 1]},
        {**base, "done": [6]},
        {**base, "done": [0]},
        {**base, "done": [True]},
        {**base, "mode": "single"},
        {**base, "mode": "chunks", "partBytes": None, "done": [1]},
        {**base, "sha256": "x"},
        {**base, "sha256": "A" * 64},
        {**base, "state": "done"},
        {**base, "size": True},
        {**base, "size": 2**31 * 1024},
        {**base, "expiresAt": float("nan")},
        {**base, "partBytes": 0},
        {**base, "kind": "download"},
        [],
        None,
    ):
        with pytest.raises(TransferJournalError):
            parse_journal_record(bad)
    with pytest.raises(TransferJournalError) as ei:
        parse_journal_record({**base, "v": 9})
    assert ei.value.reason == "version" and ei.value.found == 9
    # The result is a copy: changing it leaves the input alone.
    out = parse_journal_record(base)
    out["done"].append(3)
    assert base["done"] == [1, 2]


# ── chunks upload ─────────────────────────────────────────────────────────────────────────────────


def chunk_up(data: Any, codec: Any = SERVER, **over: Any) -> tr.ChunkedUploadRequest:
    r = tr.ChunkedUploadRequest(
        id="t1",
        collection="saves",
        record="rec1",
        source=data if hasattr(data, "read") else ranged_bytes(data),
        codec=codec,
    )
    for k, v in over.items():
        setattr(r, k, v)
    return r


def lens(data: bytes) -> List[int]:
    return sf.cdc_lengths(data)


def test_cuts_plans_sends_every_chunk_and_the_manifest_and_finalizes() -> None:
    s, j = FakeServer(), MemoryJournal()
    e, _ = make_engine(s, j)
    progress: List[Tuple[int, int]] = []
    out = e.upload_chunked(chunk_up(DATA, on_progress=lambda a, b: progress.append((a, b))))
    assert out["format"] == "chunks" and out["size"] == len(DATA)
    assert s.calls[0] == "begin" and s.calls[-1] == "finalize" and s.calls[-2] == "putSingle"
    assert len(s.chunk_puts) == len(set(s.chunk_puts)) == len(lens(DATA))
    assert j.list() == []
    assert progress[-1] == (len(DATA), len(DATA))
    m = sf.parse_manifest(s.files[0]["bytes"])
    assert m.ok and m.manifest is not None and [r.plain_len for r in m.manifest.records] == lens(DATA)
    assert out["sha256"] == sha(s.files[0]["bytes"])
    assert all(o[0] == 0 and o[1] == 0 for o in s.chunks.values())  # the raw layout of D-5


def test_a_second_version_sends_only_the_chunks_that_changed() -> None:
    s = FakeServer()
    e, _ = make_engine(s)
    e.upload_chunked(chunk_up(DATA))
    total = len(s.chunk_puts)
    edited = bytearray(DATA)
    for i in range(40):
        edited[1_500_000 + i] ^= 0xFF
    s.chunk_puts.clear()
    out = e.upload_chunked(chunk_up(bytes(edited)))
    assert out["version"] == 2
    assert 0 < len(s.chunk_puts) <= 3 and len(s.chunk_puts) < total
    sink = Sink()
    e.download(dl(out, SERVER, sink, cache=MemoryChunkCache()))
    assert sink.bytes() == bytes(edited)


def test_an_identical_reupload_sends_no_chunk_at_all() -> None:
    s = FakeServer()
    e, _ = make_engine(s)
    e.upload_chunked(chunk_up(DATA))
    s.chunk_puts.clear()
    e.upload_chunked(chunk_up(DATA))
    assert s.chunk_puts == []


def test_plans_at_most_1024_ids_a_call_and_each_id_once() -> None:
    zeros = bytes(4 * MIB)
    s = FakeServer()
    e, _ = make_engine(s)
    out = e.upload_chunked(chunk_up(zeros))
    assert all(n <= 1024 for n in s.plan_sizes)
    assert len(s.chunk_puts) < len(lens(zeros))  # equal chunks share an id: sent once
    sink = Sink()
    e.download(dl(out, SERVER, sink))
    assert len(sink.bytes()) == len(zeros)


def test_is_end_to_end_the_server_holds_sealed_chunks_and_a_sealed_manifest() -> None:
    s = FakeServer()
    e, _ = make_engine(s)
    codec = e2e()
    out = e.upload_chunked(chunk_up(DATA, codec, base_version="*"))
    assert out["size"] == codec.stored_size(len(DATA))
    probe = DATA[1_000_000:1_000_064]
    for o in s.chunks.values():
        assert o[0] == 1 and probe not in o
    assert s.files[0]["bytes"][:8] == b"PKSYNCF1"
    sink = Sink()
    e.download(dl(out, codec, sink, cache=MemoryChunkCache()))
    assert sink.bytes() == DATA


def test_sends_the_begin_the_way_the_plan_says() -> None:
    s = FakeServer()
    codec = e2e()
    out = make_engine(s)[0].upload_chunked(chunk_up(DATA, codec, base_version=3))
    seen = s.begin_requests[0]
    assert seen["format"] == "chunks" and seen["enc"] == "e2e" and seen["baseVersion"] == 3
    assert seen["size"] == codec.stored_size(len(DATA)) and seen["sha256"] == out["sha256"]


def test_refuses_a_begin_that_does_not_answer_chunks() -> None:
    s = FakeServer()
    s.begin_override = lambda r: FileReply.success({"uploadId": "x", "mode": "single", "expiresAt": 1})
    with pytest.raises(TransferError) as ei:
        make_engine(s)[0].upload_chunked(chunk_up(DATA))
    assert ei.value.reason == "bad-reply" and s.aborted == ["x"]


def test_refuses_a_plan_that_names_an_id_it_was_not_asked_or_leaves_one_unanswered() -> None:
    s = FakeServer()
    s.plan_override = lambda r: {"missing": [c[0] for c in r["chunks"]] + ["f" * 64], "present": []}
    with pytest.raises(TransferError) as ei:
        make_engine(s)[0].upload_chunked(chunk_up(DATA))
    assert ei.value.reason == "bad-reply" and s.chunk_puts == [] and len(s.aborted) == 1
    s2 = FakeServer()
    s2.plan_override = lambda r: {"missing": [c[0] for c in r["chunks"][1:]], "present": []}
    with pytest.raises(TransferError) as ei:
        make_engine(s2)[0].upload_chunked(chunk_up(DATA))
    assert ei.value.reason == "bad-reply"
    s3 = FakeServer()
    s3.plan_override = lambda r: {"missing": [r["chunks"][0][0]] * 2 + [c[0] for c in r["chunks"][1:]], "present": []}
    with pytest.raises(TransferError) as ei:
        make_engine(s3)[0].upload_chunked(chunk_up(DATA))
    assert ei.value.reason == "bad-reply"


def test_refuses_to_send_a_chunk_when_the_file_changed_after_it_was_cut() -> None:
    s = FakeServer()
    reads = {"n": 0}

    class Changing:
        size = len(DATA)

        def read(self, a: int, b: int) -> bytes:
            out = bytearray(DATA[a:b])
            reads["n"] += 1
            if reads["n"] > 3:  # the first pass reads in 1 MiB slices; later reads are the sends
                out[0] ^= 1
            return bytes(out)

    with pytest.raises(TransferError) as ei:
        make_engine(s)[0].upload_chunked(chunk_up(Changing()))
    assert ei.value.reason == "source-mismatch" and s.chunk_puts == []


def test_starts_again_when_the_upload_expires_midway() -> None:
    s, j = FakeServer(), MemoryJournal()
    hits = {"n": 0}

    def expire(kind: str, arg: Any = None) -> Optional[FileReply]:
        if kind == "putChunk":
            hits["n"] += 1
            if hits["n"] == 3:
                return fail(410, "upload_expired")
        return None

    s.hook = expire
    out = make_engine(s, j)[0].upload_chunked(chunk_up(DATA))
    assert out["format"] == "chunks" and s.calls.count("begin") == 2
    assert len(s.chunk_puts) == len(set(s.chunk_puts))  # what the first pass stored is not sent again
    assert j.list() == []


def test_sends_again_the_chunks_finalize_says_are_missing() -> None:
    s = FakeServer()
    state = {"dropped": False}

    def gate(r: Dict[str, Any]) -> None:
        if not state["dropped"]:
            state["dropped"] = True
            del s.chunks[s.chunk_puts[0]]

    s.finalize_gate = gate
    out = make_engine(s)[0].upload_chunked(chunk_up(DATA))
    assert out["version"] == 1 and len(s.chunk_puts) == len(lens(DATA)) + 1


def test_a_finalize_that_names_ids_it_was_never_given_releases_the_upload() -> None:
    s, j = FakeServer(), MemoryJournal()
    s.hook = lambda kind, arg=None: (
        fail(409, "upload_incomplete", body={"missing": ["e" * 64]}) if kind == "finalize" else None
    )
    with pytest.raises(TransferError) as ei:
        make_engine(s, j)[0].upload_chunked(chunk_up(DATA))
    assert ei.value.reason == "conflict" and ei.value.code == "upload_incomplete"
    assert len(s.aborted) == 1 and j.list() == []


def test_surfaces_a_stale_base_version_with_the_servers_version() -> None:
    s = FakeServer()
    s.hook = lambda kind, arg=None: (
        fail(409, "revision_conflict", body={"server": {"version": 7}}) if kind == "begin" else None
    )
    with pytest.raises(TransferError) as ei:
        make_engine(s)[0].upload_chunked(chunk_up(DATA, base_version=2))
    assert ei.value.reason == "conflict" and ei.value.server_version == 7


def test_a_kill_leaves_a_chunks_record_the_next_run_releases_that_upload_and_reuses_the_chunks() -> None:
    s, j = FakeServer(), MemoryJournal()
    n = {"n": 0}

    def flaky(kind: str, arg: Any = None) -> Optional[FileReply]:
        if kind == "putChunk":
            n["n"] += 1
            if n["n"] > 4:
                return fail(503, "unavailable")
        return None

    s.hook = flaky
    with pytest.raises(TransferError) as ei:
        make_engine(s, j, max_attempts=2, parallelism=1)[0].upload_chunked(chunk_up(DATA))
    assert ei.value.reason == "retries-exhausted"
    (rid,) = j.list()
    rec = j.get(rid)
    assert rec["mode"] == "chunks"
    assert len(s.chunk_puts) > 0
    s.hook = lambda kind, arg=None: None
    s.aborted.clear()
    out = make_engine(s, j)[0].upload_chunked(chunk_up(DATA))
    assert s.aborted == [rec["uploadId"]]
    assert len(s.chunk_puts) == len(lens(DATA))  # each chunk stored exactly once over both runs
    assert out["version"] == 1 and j.list() == []


def test_a_chunks_upload_leaves_a_journal_record_of_an_unknown_version_alone() -> None:
    s, j = FakeServer(), MemoryJournal()
    j.put("t1", {"v": 9})
    with pytest.raises(TransferError) as ei:
        make_engine(s, j)[0].upload_chunked(chunk_up(DATA))
    assert ei.value.reason == "journal-version" and s.calls == [] and j.get("t1") == {"v": 9}


def test_an_empty_file_is_a_manifest_with_no_chunks() -> None:
    s = FakeServer()
    out = make_engine(s)[0].upload_chunked(chunk_up(b""))
    assert out["size"] == 0 and s.chunk_puts == [] and "plan" not in s.calls


def test_a_file_over_the_limit_is_refused_before_anything_is_read() -> None:
    class Huge:
        size = 2**30 + 1

        def read(self, a: int, b: int) -> bytes:
            raise AssertionError("read")

    with pytest.raises(TransferError) as ei:
        make_engine(FakeServer())[0].upload_chunked(chunk_up(Huge()))
    assert ei.value.reason == "rejected" and ei.value.code == "file_too_large"


# ── downloads ─────────────────────────────────────────────────────────────────────────────────────


def dl(file: Dict[str, Any], codec: Any, sink: Any, **over: Any) -> tr.DownloadRequest:
    r = tr.DownloadRequest(
        collection="saves",
        record="rec1",
        format=file["format"],
        size=file["size"],
        sha256=file["sha256"],
        codec=codec,
        sink=sink,
    )
    for k, v in over.items():
        setattr(r, k, v)
    return r


def stage(plain: bytes, seal: Callable[[bytes], bytes] = lambda p: p) -> Tuple[FakeServer, Dict[str, Any]]:
    s = FakeServer()
    stored = seal(plain)
    s.files.append({"version": 1, "format": "whole", "size": len(stored), "sha256": sha(stored), "bytes": stored})
    return s, s.files[0]


def reply_of(f: Dict[str, Any]) -> Dict[str, Any]:
    return {"version": f["version"], "size": f["size"], "sha256": f["sha256"], "format": "whole"}


def read_whole(s: FakeServer, codec: Any, f: Dict[str, Any], **over: Any) -> bytes:
    sink = Sink()
    make_engine(s)[0].download(dl(reply_of(f), codec, sink, **over))
    return sink.bytes()


def test_reads_a_large_file_in_ranges_holding_the_etag_with_if_match() -> None:
    plain = noise(20 * MIB, 11)
    s, f = stage(plain)
    assert read_whole(s, SERVER, f) == plain
    assert len(s.file_gets) == -(-len(plain) // DOWNLOAD_RANGE_BYTES)
    assert s.file_gets[0].if_match is None
    assert all(q.if_match == '"e1"' for q in s.file_gets[1:])
    assert all(q.range is not None for q in s.file_gets)


def test_takes_a_200_for_a_server_that_ignores_range_from_the_start_only() -> None:
    plain = noise(300_000, 2)
    s, f = stage(plain)
    s.tamper_file = lambda q, b: FileBody(status=200, data=f["bytes"], etag=b.etag)
    assert len(read_whole(s, SERVER, f)) == len(plain)
    big_s, big_f = stage(noise(12 * MIB, 4))
    calls = {"n": 0}

    def ignore_second(q: FileQuery, b: FileBody) -> FileBody:
        calls["n"] += 1
        return b if calls["n"] == 1 else FileBody(status=200, data=big_f["bytes"], etag=b.etag)

    big_s.tamper_file = ignore_second
    with pytest.raises(TransferError) as ei:
        read_whole(big_s, SERVER, big_f)
    assert (ei.value.reason, ei.value.detail) == ("bad-reply", "status")


def test_refuses_a_short_206_and_a_content_range_that_does_not_match() -> None:
    plain = noise(300_000, 2)
    s, f = stage(plain)

    def with_range(b: FileBody, **kw: int) -> FileBody:
        a, e, t = b.content_range  # type: ignore[misc]
        cr = (kw.get("start", a), kw.get("end", e), kw.get("total", t))
        return FileBody(status=b.status, data=b.data, etag=b.etag, content_range=cr)

    cases: List[Callable[[FileBody], FileBody]] = [
        lambda b: FileBody(status=206, data=b.data[:100], etag=b.etag, content_range=b.content_range),
        lambda b: with_range(b, start=1),
        lambda b: with_range(b, total=7),
        lambda b: FileBody(status=206, data=b.data, etag=b.etag, content_range=None),
        lambda b: with_range(b, end=b.content_range[1] + 1),  # type: ignore[index]
        lambda b: FileBody(status=204, data=b.data, etag=b.etag, content_range=b.content_range),
    ]
    for case in cases:
        s.tamper_file = lambda q, b, case=case: case(b)  # type: ignore[misc]
        with pytest.raises(TransferError) as ei:
            read_whole(s, SERVER, f)
        assert ei.value.reason == "bad-reply"


def test_accepts_a_self_consistent_206_shorter_than_asked_and_carries_on() -> None:
    plain = noise(300_000, 2)
    s, f = stage(plain)

    def short(q: FileQuery, b: FileBody) -> FileBody:
        a, e = q.range  # type: ignore[misc]
        end = min(a + 100_000, e)
        return FileBody(status=206, data=f["bytes"][a:end], etag=b.etag, content_range=(a, end, len(f["bytes"])))

    s.tamper_file = short
    assert read_whole(s, SERVER, f) == plain
    assert len(s.file_gets) == 3


def test_refuses_when_the_etag_changes_between_ranges() -> None:
    s, f = stage(noise(12 * MIB, 6))
    n = {"n": 0}

    def flip(q: FileQuery, b: FileBody) -> FileBody:
        n["n"] += 1
        return FileBody(
            status=b.status, data=b.data, etag='"a"' if n["n"] == 1 else '"b"', content_range=b.content_range
        )

    s.tamper_file = flip
    with pytest.raises(TransferError) as ei:
        read_whole(s, SERVER, f)
    assert (ei.value.reason, ei.value.detail) == ("bad-reply", "etag")


def test_surfaces_a_412_as_a_rejection() -> None:
    s, f = stage(noise(12 * MIB, 6))
    n = {"n": 0}

    def changed(kind: str, arg: Any = None) -> Optional[FileReply]:
        if kind == "getFile":
            n["n"] += 1
            if n["n"] == 2:
                return fail(412, "precondition_failed")
        return None

    s.hook = changed
    with pytest.raises(TransferError) as ei:
        read_whole(s, SERVER, f)
    assert (ei.value.reason, ei.value.status) == ("rejected", 412)


def test_refuses_stored_bytes_that_do_not_hash_to_what_the_record_says() -> None:
    s, f = stage(noise(300_000, 2))

    def flip(q: FileQuery, b: FileBody) -> FileBody:
        x = bytearray(b.data)
        x[5] ^= 1
        return FileBody(status=b.status, data=bytes(x), etag=b.etag, content_range=b.content_range)

    s.tamper_file = flip
    with pytest.raises(TransferError) as ei:
        read_whole(s, SERVER, f)
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "sha256")


def test_whole_download_end_to_end_a_flipped_byte_is_refused_by_its_tag() -> None:
    codec = e2e()
    plain = noise(2_500_000, 8)
    ck, kid = sc.derive_coll_key(ROOT, "saves"), sc.derive_kid(ROOT)
    s, f = stage(plain, lambda p: sf.seal_file(ck, kid, p))
    assert read_whole(s, codec, f) == plain
    # The record's hash is right for the tampered bytes, so only the tag can catch it.
    x = bytearray(f["bytes"])
    x[1_200_000] ^= 1
    t = FakeServer()
    t.files.append({**f, "bytes": bytes(x), "sha256": sha(bytes(x))})
    with pytest.raises(TransferError) as ei:
        read_whole(t, codec, t.files[0])
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "auth")


def test_refuses_a_record_whose_size_no_stream_has_or_whose_hash_is_not_hex() -> None:
    s = FakeServer()
    with pytest.raises(TransferError) as ei:
        read_whole(s, e2e(), {"version": 1, "size": 70, "sha256": "0" * 64, "format": "whole"})
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "size")
    for bad in ("X" * 64, "0" * 63, 5):
        with pytest.raises(TransferError) as ei:
            read_whole(s, SERVER, {"version": 1, "size": 10, "sha256": bad, "format": "whole"})
        assert (ei.value.reason, ei.value.detail) == ("file-invalid", "sha256")
    assert s.calls == []


# ── chunks download ───────────────────────────────────────────────────────────────────────────────


def uploaded(codec: Any = SERVER, data: bytes = DATA) -> Tuple[FakeServer, Dict[str, Any]]:
    s = FakeServer()
    out = make_engine(s)[0].upload_chunked(chunk_up(data, codec))
    s.calls.clear()
    s.chunk_gets.clear()
    return s, out


def fetch(s: FakeServer, out: Dict[str, Any], codec: Any = SERVER, **over: Any) -> bytes:
    sink = over.pop("sink", None) or Sink()
    make_engine(s)[0].download(dl(out, codec, sink, **over))
    return sink.bytes()


def test_fetches_each_chunk_once_and_fills_the_cache_a_second_read_needs_no_chunk() -> None:
    s, out = uploaded()
    cache = MemoryChunkCache()
    assert fetch(s, out, cache=cache) == DATA
    assert sorted(s.chunk_gets) == sorted(s.chunks)
    s.chunk_gets.clear()
    assert fetch(s, out, cache=cache) == DATA
    assert s.chunk_gets == []


def test_fetches_only_the_chunks_the_cache_lacks_after_a_new_version() -> None:
    s, v1 = uploaded()
    cache = MemoryChunkCache()
    fetch(s, v1, cache=cache)
    edited = bytearray(DATA)
    for i in range(40):
        edited[2_000_000 + i] ^= 0x55
    v2 = make_engine(s)[0].upload_chunked(chunk_up(bytes(edited)))
    s.chunk_gets.clear()
    assert fetch(s, v2, cache=cache) == bytes(edited)
    assert 0 < len(s.chunk_gets) <= 3


def test_throws_away_a_cached_object_that_no_longer_opens_and_fetches_it_again() -> None:
    s, out = uploaded()
    cache = MemoryChunkCache()
    fetch(s, out, cache=cache)
    cid = next(iter(s.chunks))
    bad = bytearray(s.chunks[cid])
    bad[10] ^= 1
    cache.put(cid, bytes(bad))
    s.chunk_gets.clear()
    assert fetch(s, out, cache=cache) == DATA
    assert s.chunk_gets == [cid]


def test_works_with_a_cache_that_throws() -> None:
    class Boom:
        def get(self, id: str) -> Optional[bytes]:
            raise OSError("disk")

        put = delete = clear = get  # type: ignore[assignment]

    s, out = uploaded()
    assert fetch(s, out, cache=Boom()) == DATA


def test_refuses_a_tampered_chunk_server_mode_the_id_of_the_plaintext() -> None:
    s, out = uploaded()
    s.tamper_chunk = lambda i, o: o[:-1] + bytes([o[-1] ^ 1])
    with pytest.raises(TransferError) as ei:
        fetch(s, out)
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "chunk-id")


def test_refuses_a_tampered_chunk_end_to_end_the_tag() -> None:
    codec = e2e()
    s, out = uploaded(codec)

    def flip(i: str, o: bytes) -> bytes:
        x = bytearray(o)
        x[20] ^= 1
        return bytes(x)

    s.tamper_chunk = flip
    with pytest.raises(TransferError) as ei:
        fetch(s, out, codec)
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "chunk-auth")


def test_refuses_a_chunk_swapped_for_another_chunk_of_the_same_file() -> None:
    codec = e2e()
    s, out = uploaded(codec)
    a, b = list(s.chunks)[:2]
    s.tamper_chunk = lambda i, o: s.chunks[b] if i == a else o
    with pytest.raises(TransferError) as ei:
        fetch(s, out, codec)
    assert ei.value.reason == "file-invalid"


def test_refuses_an_object_over_the_stored_chunk_cap_before_opening_it() -> None:
    s, out = uploaded()
    s.tamper_chunk = lambda i, o: bytes(SERVER_CHUNK_MAX_STORED_BYTES + 1)
    with pytest.raises(TransferError) as ei:
        fetch(s, out)
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "chunk-size")


def test_refuses_a_manifest_that_does_not_hash_or_whose_size_disagrees() -> None:
    s, out = uploaded()
    with pytest.raises(TransferError) as ei:
        fetch(s, {**out, "sha256": "0" * 64})
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "sha256")
    with pytest.raises(TransferError) as ei:
        fetch(s, {**out, "size": out["size"] + 1})
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "size")


def test_refuses_a_manifest_the_format_rejects_with_the_formats_reason() -> None:
    s, out = uploaded()
    bad = bytearray(s.files[0]["bytes"])
    bad[0] ^= 1  # the magic
    s.files[0]["bytes"] = bytes(bad)
    with pytest.raises(TransferError) as ei:
        fetch(s, {**out, "sha256": sha(bytes(bad))})
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "manifest-magic")


def test_refuses_a_manifest_that_is_not_a_stream_end_to_end() -> None:
    codec = e2e()
    s, out = uploaded(codec)
    bad = bytearray(s.files[0]["bytes"])
    bad[0] ^= 1
    s.files[0]["bytes"] = bytes(bad)
    with pytest.raises(TransferError) as ei:
        fetch(s, {**out, "sha256": sha(bytes(bad))}, codec)
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "manifest-magic")


def test_refuses_a_file_whose_reassembled_hash_is_not_the_manifests() -> None:
    s, out = uploaded()
    m = sf.parse_manifest(s.files[0]["bytes"]).manifest
    assert m is not None
    forged = sf.encode_manifest(sf.ChunkManifest(m.plain_size, bytes(32), m.records))
    s.files[0]["bytes"] = forged
    with pytest.raises(TransferError) as ei:
        fetch(s, {**out, "sha256": sha(forged)})
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "plainSha256")


def test_refuses_a_manifest_whose_chunk_length_differs_from_the_chunk() -> None:
    s, out = uploaded()
    m = sf.parse_manifest(s.files[0]["bytes"]).manifest
    assert m is not None
    records = [sf.ManifestRecord(r.id, r.plain_len - 1) if i == 0 else r for i, r in enumerate(m.records)]
    forged = sf.encode_manifest(sf.ChunkManifest(m.plain_size - 1, m.plain_sha256, records))
    s.files[0]["bytes"] = forged
    with pytest.raises(TransferError) as ei:
        fetch(s, {**out, "size": out["size"] - 1, "sha256": sha(forged)})
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "chunk-length")


def test_surfaces_a_missing_chunk_as_a_rejection_and_reports_progress() -> None:
    s, out = uploaded()
    seen: List[float] = []
    fetch(s, out, on_progress=lambda n, total: seen.append(n / total))
    assert seen[-1] == 1
    s.chunks.clear()
    with pytest.raises(TransferError) as ei:
        fetch(s, out)
    assert (ei.value.reason, ei.value.status) == ("rejected", 404)


def test_stops_at_a_cancel_during_a_chunked_download() -> None:
    s, out = uploaded()
    stop = threading.Event()
    n = {"n": 0}

    def trip() -> None:
        n["n"] += 1
        if n["n"] == 2:
            stop.set()

    with pytest.raises(TransferError) as ei:
        fetch(s, out, cancel=stop, sink=Sink(trip))
    assert ei.value.reason == "aborted"


def test_a_chunked_download_with_a_bad_manifest_status_or_oversize_is_refused() -> None:
    s, out = uploaded()
    s.tamper_file = lambda q, b: FileBody(status=206, data=b.data, etag=b.etag)
    with pytest.raises(TransferError) as ei:
        fetch(s, out)
    assert (ei.value.reason, ei.value.detail) == ("bad-reply", "status")
    s.tamper_file = lambda q, b: FileBody(status=200, data=bytes(786_496 + 64 + 1), etag=b.etag)
    with pytest.raises(TransferError) as ei:
        fetch(s, out)
    assert (ei.value.reason, ei.value.detail) == ("file-invalid", "manifest-size")


# ── file codecs ───────────────────────────────────────────────────────────────────────────────────


def test_server_chunk_objects_open_codec_0_and_refuse_what_the_format_forbids_in_order() -> None:
    plain = bytes(range(200))
    cid = SERVER.chunk_id(plain)
    obj = SERVER.seal_chunk(cid, plain)
    assert obj[:2] == bytes([0, 0]) and len(obj) == SERVER.chunk_object_bytes(len(plain))
    assert SERVER.open_chunk(cid, obj).plain == plain
    assert SERVER.open_chunk(cid, b"\x00").reason == "shape"
    assert SERVER.open_chunk(cid, bytes(SERVER_CHUNK_MAX_STORED_BYTES + 1)).reason == "size"
    assert SERVER.open_chunk(cid, bytes([1, 0]) + plain).reason == "version"
    assert SERVER.open_chunk(cid, bytes([0, 2]) + plain).reason == "codec"
    assert SERVER.open_chunk(cid, bytes([0, 0]) + plain[:-1] + b"x").reason == "id"
    assert SERVER.open_chunk(cid, bytes([0, 1]) + plain).reason == "decode"  # no decoder
    with pytest.raises(ValueError):
        SERVER.seal_chunk(cid[:5], plain)


def test_a_zstd_frames_declared_size_is_checked_before_it_decodes_anything() -> None:
    called: List[int] = []

    def decoder(f: bytes, n: int) -> bytes:
        called.append(n)
        return b"A" * n

    codec = server_file_codec(decoder)
    one = bytes([0x28, 0xB5, 0x2F, 0xFD, 0x20, 1, 0x09, 0, 0, 0x41])
    cid = codec.chunk_id(b"A")
    ok = codec.open_chunk(cid, bytes([0, 1]) + one)
    assert ok.ok and ok.plain == b"A" and ok.codec == 1 and called == [1]
    called.clear()
    bomb = bytes([0x28, 0xB5, 0x2F, 0xFD, 0xA0]) + (2 * MIB).to_bytes(4, "little") + bytes(8)
    assert codec.open_chunk(cid, bytes([0, 1]) + bomb).reason == "size" and called == []
    liar = server_file_codec(lambda f, n: b"AA")
    assert liar.open_chunk(cid, bytes([0, 1]) + one).reason == "decode"
    boom = server_file_codec(lambda f, n: (_ for _ in ()).throw(ValueError("bad")))
    assert boom.open_chunk(cid, bytes([0, 1]) + one).reason == "decode"


def test_the_e2e_codec_seals_and_opens_and_hides_its_root() -> None:
    codec = e2e()
    plain = noise(1000, 4)
    cid = codec.chunk_id(plain)
    assert cid == sf.chunk_id(ROOT, "saves", plain) and cid != SERVER.chunk_id(plain)
    obj = codec.seal_chunk(cid, plain)
    assert len(obj) == codec.chunk_object_bytes(len(plain)) and codec.open_chunk(cid, obj).plain == plain
    stored = codec.seal_manifest(b"abc")
    assert len(stored) == codec.stored_size(3) and codec.plain_size(len(stored)) == 3
    assert codec.open_manifest(stored).plain == b"abc"
    assert b"".join(codec.open_stream(codec.seal_stream([b"ab", b"cd"]))) == b"abcd"
    assert ROOT.hex() not in repr(codec) and str(ROOT) not in repr(codec)


# ── the chunk cache ───────────────────────────────────────────────────────────────────────────────


def cid(n: int) -> str:
    return "%064x" % n


def test_a_memory_cache_is_an_lru_bounded_in_bytes_and_returns_copies() -> None:
    c = MemoryChunkCache(30)
    for i in (1, 2, 3):
        c.put(cid(i), bytes(10))
    c.get(cid(1))  # 1 is now the newest
    c.put(cid(4), bytes(10))  # over the budget: 2 goes
    assert c.get(cid(2)) is None
    assert all(c.get(cid(i)) is not None for i in (1, 3, 4))
    c.put(cid(5), bytes(31))  # bigger than the budget: not kept
    assert c.get(cid(5)) is None
    c.put(cid(6), b"abc")
    first = c.get(cid(6))
    assert first == b"abc"
    c.delete(cid(6))
    assert c.get(cid(6)) is None
    c.clear()
    assert c.get(cid(1)) is None


def test_cache_names_come_from_hex_ids_only() -> None:
    for c in (MemoryChunkCache(), FileChunkCache(os.path.join(_tmp(), "c"))):
        for bad in ("../x", "a", "A" * 64, "a" * 63 + "/", "", "a" * 64 + "\n"):
            for op in (lambda b, c=c: c.put(b, b"x"), c.get, c.delete):
                with pytest.raises(ValueError):
                    op(bad)  # type: ignore[arg-type]
    assert is_chunk_cache_id("a" * 64) and not is_chunk_cache_id("a" * 65)


def test_the_cache_budget_is_the_larger_of_256_mib_and_twice_the_largest_save() -> None:
    assert chunk_cache_budget(0) == CHUNK_CACHE_MIN_BYTES == 256 * MIB
    assert chunk_cache_budget(100 * MIB) == 256 * MIB
    assert chunk_cache_budget(200 * MIB) == 400 * MIB
    for bad in (-1, True, 1.5):
        with pytest.raises(ValueError):
            chunk_cache_budget(bad)  # type: ignore[arg-type]


_TMPS: List[str] = []


def _tmp() -> str:
    import tempfile

    d = tempfile.mkdtemp(prefix="pkey-files-")
    _TMPS.append(d)
    return d


@pytest.fixture(autouse=True)
def _cleanup() -> Any:
    yield
    import shutil

    while _TMPS:
        shutil.rmtree(_TMPS.pop(), ignore_errors=True)


def mode(path: str) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


def test_a_file_cache_keeps_objects_named_by_chunk_id_at_0600() -> None:
    d = os.path.join(_tmp(), "c")
    c = FileChunkCache(d)
    c.put(cid(1), bytes([9, 8, 7]))
    assert os.listdir(d) == [cid(1)]
    assert mode(os.path.join(d, cid(1))) == 0o600 and mode(d) == 0o700
    assert c.get(cid(1)) == bytes([9, 8, 7]) and c.get(cid(2)) is None
    c.delete(cid(1))
    assert c.get(cid(1)) is None


def test_a_file_cache_keeps_the_newest_within_its_budget() -> None:
    c = FileChunkCache(os.path.join(_tmp(), "c"), 30)
    for i in (1, 2, 3):
        c.put(cid(i), bytes(10))
    c.get(cid(1))
    c.put(cid(4), bytes(10))
    assert c.get(cid(2)) is None
    assert all(c.get(cid(i)) is not None for i in (1, 3, 4))
    c.put(cid(5), bytes(31))
    assert c.get(cid(5)) is None
    c.put(cid(1), bytes(5))  # replacing an entry does not double count it
    assert all(c.get(cid(i)) is not None for i in (1, 3, 4))


def test_a_file_cache_rebuilds_its_order_and_size_after_a_restart() -> None:
    d = os.path.join(_tmp(), "c")
    a = FileChunkCache(d, 20)
    a.put(cid(1), bytes(10))
    os.utime(os.path.join(d, cid(1)), (1, 1))  # older
    a.put(cid(2), bytes(10))
    b = FileChunkCache(d, 20)
    b.put(cid(3), bytes(10))
    assert b.get(cid(1)) is None
    assert b.get(cid(2)) is not None and b.get(cid(3)) is not None


def test_a_file_cache_treats_a_damaged_entry_as_a_miss_and_ignores_strangers() -> None:
    d = os.path.join(_tmp(), "c")
    c = FileChunkCache(d)
    c.put(cid(1), bytes(10))
    with open(os.path.join(d, cid(1)), "wb") as f:
        f.write(bytes(4))  # truncated behind our back
    assert c.get(cid(1)) is None and not os.path.exists(os.path.join(d, cid(1)))
    for name in ("README", "dead.tmp"):
        with open(os.path.join(d, name), "w") as f:
            f.write("x")
    fresh = FileChunkCache(d)
    assert fresh.get(cid(2)) is None
    assert os.path.exists(os.path.join(d, "README")) and not os.path.exists(os.path.join(d, "dead.tmp"))
    # A symlink named like an id is never followed.
    target = os.path.join(_tmp(), "secret")
    with open(target, "wb") as f:
        f.write(b"secret")
    os.symlink(target, os.path.join(d, cid(3)))
    assert FileChunkCache(d).get(cid(3)) is None and os.path.exists(target)


def test_a_file_cache_is_scoped_by_hashes_of_the_subject_and_the_collection_and_clear_purges_it() -> None:
    root = _tmp()
    d1 = chunk_cache_dir(root, "ps_a", "saves")
    assert d1 != chunk_cache_dir(root, "ps_b", "saves") and d1 != chunk_cache_dir(root, "ps_a", "notes")
    evil = chunk_cache_dir(root, "ps_a", "../../x")
    assert evil.startswith(root) and ".." not in evil[len(root) :]
    c = FileChunkCache(d1)
    c.put(cid(1), bytes(3))
    c.clear()
    assert not os.path.exists(d1) and c.get(cid(1)) is None
    c.put(cid(1), bytes(3))
    assert c.get(cid(1)) is not None


# ── the journal on disk ───────────────────────────────────────────────────────────────────────────


def jrec(id: str, **over: Any) -> Dict[str, Any]:
    r: Dict[str, Any] = {
        "v": 1,
        "id": id,
        "kind": "upload",
        "collection": "saves",
        "record": "slot-1",
        "uploadId": "up1",
        "mode": "single",
        "partBytes": None,
        "done": [],
        "sha256": "a" * 64,
        "size": 10,
        "expiresAt": 2_000_000_000,
        "state": "uploading",
    }
    r.update(over)
    return r


def test_a_file_journal_keeps_a_record_in_a_file_named_by_the_hash_of_its_id_at_0600() -> None:
    d = _tmp()
    j = FileJournal(d)
    jid = "../../escape"
    j.put(jid, jrec(jid))
    names = os.listdir(j.dir)
    assert names == [journal_file_name(jid)] and len(names[0]) == 64 + 5
    assert mode(os.path.join(j.dir, names[0])) == 0o600 and mode(j.dir) == 0o700
    assert not os.path.exists(os.path.join(d, "escape"))
    assert j.get(jid) == jrec(jid) and j.list() == [jid]
    j.delete(jid)
    j.delete(jid)  # twice is fine
    assert j.get(jid) is None and j.list() == []


def test_a_journal_record_holds_ids_counts_and_hashes_only() -> None:
    j = FileJournal(_tmp())
    j.put("t1", jrec("t1"))
    with open(os.path.join(j.dir, journal_file_name("t1")), encoding="utf-8") as f:
        text = f.read()
    assert sorted(json.loads(text)) == sorted(
        [
            "collection",
            "done",
            "expiresAt",
            "id",
            "kind",
            "mode",
            "partBytes",
            "record",
            "sha256",
            "size",
            "state",
            "uploadId",
            "v",
        ]
    )
    assert "pkeyt_" not in text


def test_a_file_journal_reads_garbled_as_none_and_returns_a_foreign_version_as_found() -> None:
    j = FileJournal(_tmp())
    assert j.get("none") is None
    j.put("t1", jrec("t1"))
    with open(os.path.join(j.dir, journal_file_name("t1")), "w") as f:
        f.write("{not json")
    assert j.get("t1") is None
    future = {**jrec("t2"), "v": 2}
    with open(os.path.join(j.dir, journal_file_name("t2")), "w") as f:
        json.dump(future, f)
    assert j.get("t2") == future


def test_a_file_journal_lists_only_records_in_the_file_their_own_id_names_and_clear_removes_all() -> None:
    j = FileJournal(_tmp())
    j.put("t1", jrec("t1"))
    with open(os.path.join(j.dir, journal_file_name("t2")), "w") as f:
        json.dump(jrec("t1"), f)  # a copy under another name is not t2's record
    with open(os.path.join(j.dir, "notes.txt"), "w") as f:
        f.write("x")
    assert j.list() == ["t1"]
    j.clear()
    assert not os.path.exists(j.dir) and j.list() == []


def test_the_engine_resumes_over_a_file_journal_in_a_fresh_process_like_run() -> None:
    d = _tmp()
    s = FakeServer()
    s.part_bytes = MIB

    def kill(kind: str, n: Any = None) -> Optional[FileReply]:
        if kind == "putPart" and n == 3:
            raise RuntimeError("down")
        return None

    s.hook = kill
    data = noise(3 * MIB - 100, 12)
    # 3 MiB declares multipart via the fake only above 16 MiB, so force it.
    s.begin_override = None
    real_begin = s.begin

    def multipart_begin(target: FileTarget, r: Dict[str, Any], cancel: Any = None) -> FileReply:
        rep = real_begin(target, r, cancel)
        s.uploads[rep.value["uploadId"]].update({"mode": "multipart", "partBytes": MIB})
        return FileReply.success({**rep.value, "mode": "multipart", "partBytes": MIB})

    s.begin = multipart_begin  # type: ignore[method-assign]
    with pytest.raises(TransferError):
        make_engine(s, FileJournal(d), max_attempts=1, parallelism=1)[0].upload(request(data))
    assert FileJournal(d).list() == ["t1"]
    assert FileJournal(d).get("t1")["done"] == [1, 2]
    s.hook = lambda kind, arg=None: None
    s.part_puts.clear()
    out = make_engine(s, FileJournal(d))[0].upload(request(data))
    assert s.part_puts == [3] and out["size"] == len(data) and FileJournal(d).list() == []
