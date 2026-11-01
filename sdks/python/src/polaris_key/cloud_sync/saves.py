"""``client.cloud_sync.saves`` (U-22.5): the saves of the signed-in person on Cloud Sync records and files.

A port of client-core's ``sync/saves.ts`` (the steps), ``sdk-node``'s ``cloudSync/saves.ts`` (the binding)
and nothing else. A save is a record of the ``saves`` collection (its metadata) plus one file (its bytes):

::

    write:  begin -> parts -> finalize          (the file first; the server's version V)
            then the metadata ``set`` at base version V on the record.

* **Records.** :class:`MachineRecords` binds the port to the machine's ``records``, ``put_at`` and
  ``remove_at``. A write waits for its one outcome (ok, conflict with the server copy, rejected, or
  dropped by a sign-out) and is never coalesced or rebased.
* **Files.** ``FileRoutes`` + ``FileJournal`` + ``FileChunkCache`` under one :class:`TransferEngine`
  (``max_retry_after_seconds`` 3600).
* **Codec.** End-to-end: the ring's ``file_codec("saves")``; server mode: :class:`ServerFileCodec`.
* **E2E binding (D-3).** The sealed metadata carries ``$file = {sha256, size, format}``; a read opens the
  revision the binding names and nothing else.
* **Events.** ``transferProgress`` / ``transferDone`` / ``transferFailed`` under the ``cloudSync`` kind. A
  cancelled transfer is a state (``transferDone``), not a failure.
* **Threads.** A write runs on its own thread; ``pause``, ``resume`` and ``cancel`` act on it, ``wait``
  returns its outcome. A read runs on the caller's thread.

Nothing here puts a value, a key or a path in an event, an exception or a log line.
"""

from __future__ import annotations

import os
import re
import threading
from typing import Any, Callable, Dict, Iterable, List, Optional, Union

from ..constants_generated import SYNC_FILE_MAX_BYTES, SYNC_SAVE_SLOTS, Feature, TransferEvent
from ..core import sync_files as sf
from ..core.sync_crypto import is_blinded_name
from .chunk_cache import (
    CLOUD_SYNC_CHUNKS_DIR,
    ChunkCache,
    FileChunkCache,
    chunk_cache_budget,
    chunk_cache_dir,
)
from .files import FileRoutes
from .journal import FileJournal
from .transfer import (
    ChunkedUploadRequest,
    DownloadRequest,
    FileTarget,
    RangedSource,
    TransferEngine,
    TransferError,
    UploadRequest,
    ranged_bytes,
)
from .transfer_codec import FileCodec, ServerFileCodec

__all__ = [
    "SAVES_COLLECTION",
    "SAVE_FILE_BINDING_KEY",
    "SAVES_FILE_INVALID",
    "SaveRecords",
    "SavesApi",
    "SavesClient",
    "SavesError",
    "SaveTransfer",
    "MachineRecords",
    "memory_spool",
]

Obj = Dict[str, Any]

SAVES_COLLECTION = "saves"
#: Retry-After is honoured up to an hour: a save may wait out a long throttle.
SAVES_MAX_RETRY_AFTER_SECONDS = 3600
#: The key of the E2E binding inside a save's sealed metadata (D-3).
SAVE_FILE_BINDING_KEY = "$file"
#: The client code for a downloaded file that fails a check (D-8).
SAVES_FILE_INVALID = "sync-file-invalid"

_KEY = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_DEFAULT_MAX_BYTES = 32 * 1024 * 1024


class SavesError(Exception):
    """A save call that failed. ``code`` is one of ``sync-file-invalid``, ``invalid-save``, ``too-large``,
    ``slots-full``, ``not-found``, ``transfer-failed``, ``rejected``."""

    def __init__(self, code: str, detail: Optional[str] = None) -> None:
        super().__init__("saves: " + code + (" (" + detail + ")" if detail else ""))
        self.code = code
        self.detail = detail


def _as_saves_error(e: BaseException) -> SavesError:
    if isinstance(e, SavesError):
        return e
    if isinstance(e, TransferError):
        if e.reason == "file-invalid":
            return SavesError(SAVES_FILE_INVALID, e.detail)
        return SavesError("transfer-failed", e.code or e.reason)
    return SavesError("transfer-failed")


# ── The records port ────────────────────────────────────────────────────────────────────────────


class SaveRecords:
    """What the saves layer needs of the records layer. A record is ``{id, version, value, file}`` where
    ``value`` is the opened metadata and ``file`` the pull's pointer (or ``None``). A set result is
    ``{ok: True, version}``, ``{ok: False, reason: "conflict", server: record | None}`` or
    ``{ok: False, reason: "rejected", code}``."""

    def wire_id(self, id: str) -> str:  # pragma: no cover - interface
        raise NotImplementedError

    def list(self) -> List[Obj]:  # pragma: no cover - interface
        raise NotImplementedError

    def get(self, id: str) -> Optional[Obj]:  # pragma: no cover - interface
        raise NotImplementedError

    def set(
        self,
        id: str,
        value: Obj,
        base_version: Any,
        cancel: Optional[threading.Event] = None,
        file: Optional[Obj] = None,
    ) -> Obj:  # pragma: no cover - interface
        """``cancel`` is set when the caller cancels the write (a pause does not set it): stop waiting and
        raise an ``aborted`` :class:`TransferError`. There is no timeout: cancel, a sign-out drop and the
        host's retries end a wait. ``file`` is the pointer finalize returned; an acknowledged set adopts it."""
        raise NotImplementedError

    def delete(self, id: str, base_version: int) -> Obj:  # pragma: no cover - interface
        raise NotImplementedError


class MachineRecords(SaveRecords):
    """:class:`SaveRecords` over the machine (through the host, which holds its lock and pumps it)."""

    def __init__(self, host: Any, codec: Any, e2e: Callable[[], bool]) -> None:
        self._host = host
        self._codec = codec
        self._e2e = e2e
        self._lock = threading.Lock()
        self._waiting: Dict[int, "_Waiter"] = {}
        host.on_outcome(self._outcome)

    def _outcome(self, o: Obj) -> None:
        with self._lock:
            w = self._waiting.pop(o["mutationId"], None)
        if w is not None:
            w.settle(o)

    def drop_all(self) -> None:
        """Settle every write still waiting as dropped (the person and their data are gone)."""
        with self._lock:
            waiting, self._waiting = self._waiting, {}
        for mutation_id, w in waiting.items():
            w.settle({"mutationId": mutation_id, "status": "dropped"})

    def wire_id(self, id: str) -> str:
        return self._codec.blind("record", SAVES_COLLECTION, id) if self._e2e() else id

    @staticmethod
    def _meta(v: Any) -> Obj:
        return v if isinstance(v, dict) else {}

    def _record(self, row: Obj, id: Optional[str] = None) -> Obj:
        return {
            "id": row["id"] if id is None else id,
            "version": row["version"],
            "value": self._meta(row["value"]),
            "file": row["file"],
        }

    def list(self) -> List[Obj]:
        e2e = self._e2e()
        with self._host.locked() as m:
            rows = m.records(SAVES_COLLECTION)
        return [self._record(r) for r in rows if not (e2e and is_blinded_name(r["id"]))]

    def get(self, id: str) -> Optional[Obj]:
        with self._host.locked() as m:
            rows = m.records(SAVES_COLLECTION)
        row = next((r for r in rows if r["id"] == id), None)
        # A record with a file and no value comes back under its wire id (the host cannot place its
        # blinded id without a value).
        if row is None and self._e2e():
            wire = self.wire_id(id)
            row = next((r for r in rows if r["id"] == wire), None)
        return None if row is None else self._record(row, id)

    def _wait(self, call: Callable[[Any], Obj], id: str, cancel: Optional[threading.Event] = None) -> Obj:
        self._host.catch_up()
        waiter = _Waiter()
        with self._host.locked() as m:
            started = call(m)
            if not started.get("ok"):
                return {"ok": False, "reason": "rejected", "code": started.get("error", "rejected")}
            with self._lock:
                self._waiting[started["mutationId"]] = waiter
        # The pump may block on the network; the cancel check below must not wait for it.
        pump = threading.Thread(target=self._host.touch, daemon=True)
        pump.start()
        while not waiter.done(0.1):
            if cancel is not None and cancel.is_set():
                with self._lock:
                    self._waiting.pop(started["mutationId"], None)
                raise TransferError("aborted")
        o = waiter.wait()
        status = o["status"]
        if status == "ok":
            return {"ok": True, "version": o["version"]}
        if status == "conflict":
            s = o["server"]
            server = (
                None
                if s is None
                else {"id": id, "version": s["version"], "value": self._meta(s["value"]), "file": s["file"]}
            )
            return {"ok": False, "reason": "conflict", "server": server}
        if status == "rejected":
            return {"ok": False, "reason": "rejected", "code": o["code"]}
        return {"ok": False, "reason": "rejected", "code": "signed-out"}

    def set(
        self,
        id: str,
        value: Obj,
        base_version: Any,
        cancel: Optional[threading.Event] = None,
        file: Optional[Obj] = None,
    ) -> Obj:
        return self._wait(lambda m: m.put_at(SAVES_COLLECTION, id, value, base_version, file), id, cancel)

    def delete(self, id: str, base_version: int) -> Obj:
        return self._wait(lambda m: m.remove_at(SAVES_COLLECTION, id, base_version), id)


class _Waiter:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._outcome: Optional[Obj] = None

    def settle(self, o: Obj) -> None:
        self._outcome = o
        self._event.set()

    def done(self, timeout: float) -> bool:
        return self._event.wait(timeout)

    def wait(self) -> Obj:
        self._event.wait()
        assert self._outcome is not None
        return self._outcome


# ── Sealing a whole file ────────────────────────────────────────────────────────────────────────


def memory_spool(stored: Iterable[bytes], cancel: Optional[threading.Event] = None) -> Obj:
    """Collect a sealed stream in memory so ``upload`` can read it again by range after a pause."""
    import hashlib

    h = hashlib.sha256()
    parts: List[bytes] = []
    size = 0
    for piece in stored:
        if cancel is not None and cancel.is_set():
            raise TransferError("aborted")
        b = bytes(piece)
        h.update(b)
        parts.append(b)
        size += len(b)
    data = b"".join(parts)
    return {"source": ranged_bytes(data), "size": size, "sha256": h.hexdigest()}


def _split_binding(value: Obj) -> "tuple[Obj, Optional[Obj]]":
    metadata = {k: v for k, v in value.items() if k != SAVE_FILE_BINDING_KEY}
    raw = value.get(SAVE_FILE_BINDING_KEY)
    binding: Optional[Obj] = None
    if isinstance(raw, dict):
        sha, size, fmt = raw.get("sha256"), raw.get("size"), raw.get("format")
        if (
            isinstance(sha, str)
            and _SHA.match(sha)
            and isinstance(size, int)
            and not isinstance(size, bool)
            and size > 0
            and fmt in ("whole", "chunks")
        ):
            binding = {"sha256": sha, "size": size, "format": fmt}
    return metadata, binding


def _format_of(metadata: Obj) -> Optional[int]:
    v = metadata.get("formatVersion")
    return v if isinstance(v, int) and not isinstance(v, bool) else None


# ── The write handle ────────────────────────────────────────────────────────────────────────────


class SaveTransfer:
    """A write in flight. A cancelled transfer is a state, not an error. ``wait`` settles on done,
    cancelled, failed or conflict and never raises."""

    def __init__(
        self,
        id: str,
        progress: Obj,
        attempt: Callable[[threading.Event], Obj],
        release: Callable[[], None],
        *,
        settled: Optional[Obj] = None,
        hard_cancel: Optional[threading.Event] = None,
    ) -> None:
        self.id = id
        self._hard_cancel = hard_cancel
        self.progress = progress
        self._attempt = attempt
        self._release = release
        self._cond = threading.Condition()
        self._wanted = "run"
        self._cancel = threading.Event()
        self._finished = threading.Event()
        self._outcome: Optional[Obj] = None
        self._hooks: List[Callable[[Obj], None]] = []
        self.state = "running"
        if settled is not None:
            self._settle(settled)
        else:
            threading.Thread(target=self._drive, daemon=True).start()

    def _settle(self, outcome: Obj) -> None:
        self._outcome = outcome
        self.state = outcome["state"]
        with self._cond:
            hooks, self._hooks = self._hooks, []
        for hook in hooks:
            try:
                hook(outcome)
            except Exception:  # noqa: BLE001 - a hook's failure never reaches the transfer
                pass
        self._finished.set()

    def on_settled(self, fn: Callable[[Obj], None]) -> None:
        """Call ``fn(outcome)`` once, on the transfer's thread, just before ``wait`` returns (at once if it
        has settled)."""
        with self._cond:
            if self._outcome is None:
                self._hooks.append(fn)
                return
        fn(self._outcome)

    def pause(self) -> None:
        with self._cond:
            if self.state != "running":
                return
            self._wanted = "pause"
            self._cancel.set()

    def resume(self) -> None:
        with self._cond:
            if self.state != "paused" and self._wanted != "pause":
                return
            self._wanted = "run"
            self._cond.notify_all()

    def cancel(self) -> None:
        with self._cond:
            if self.state in ("done", "failed"):
                return
            self._wanted = "cancel"
            self._cancel.set()
            if self._hard_cancel is not None:
                self._hard_cancel.set()
            self._cond.notify_all()
        self.wait()

    def wait(self, timeout: Optional[float] = None) -> Obj:
        """The outcome: ``{state: "done", ...}``, ``{state: "cancelled"}``, ``{state: "failed", error}`` or
        ``{state: "conflict", conflict}``. Blocks until the transfer settles (or ``timeout`` seconds, then
        raises :class:`TimeoutError`)."""
        if not self._finished.wait(timeout):
            raise TimeoutError("the transfer has not settled")
        assert self._outcome is not None
        return self._outcome

    def _want(self) -> str:
        with self._cond:
            return self._wanted

    def _drive(self) -> None:
        while True:
            with self._cond:
                self._cancel = threading.Event()
                if self._wanted == "pause":
                    self._cancel.set()
                cancel = self._cancel
            self.state = "running"
            try:
                outcome = self._attempt(cancel)
                if self._want() == "cancel":
                    return self._cancelled()
                return self._settle(outcome)
            except TransferError as e:
                if self._want() == "cancel":
                    return self._cancelled()
                if e.reason != "aborted":
                    return self._settle({"state": "failed", "error": _as_saves_error(e)})
            except Exception as e:  # noqa: BLE001 - a failed write is an outcome, not a raise
                if self._want() == "cancel":
                    return self._cancelled()
                return self._settle({"state": "failed", "error": _as_saves_error(e)})
            # Paused: wait for resume (or cancel).
            self.state = "paused"
            with self._cond:
                while self._wanted == "pause":
                    self._cond.wait()
            if self._want() == "cancel":
                return self._cancelled()
            with self._cond:
                self._wanted = "run"

    def _cancelled(self) -> None:
        try:
            self._release()
        except Exception:  # noqa: BLE001 - the server expires the upload within the day
            pass
        self._settle({"state": "cancelled"})


# ── The client ──────────────────────────────────────────────────────────────────────────────────


class SavesClient:
    """The saves of one person. ``records`` is a :class:`SaveRecords`; ``engine`` a :class:`TransferEngine`;
    ``codec`` a :class:`FileCodec` (``enc`` ``"e2e"`` or ``"none"``); ``delta`` the collection's
    ``files.delta``."""

    def __init__(
        self,
        *,
        records: SaveRecords,
        engine: TransferEngine,
        codec: FileCodec,
        delta: bool,
        cache: Optional[ChunkCache] = None,
        max_bytes: Optional[int] = None,
        save_format_version: Optional[int] = None,
        new_transfer_id: Optional[Callable[[str], str]] = None,
        spool: Callable[..., Obj] = memory_spool,
    ) -> None:
        self._records = records
        self._engine = engine
        self._codec = codec
        self._delta = delta
        self._cache = cache
        self._max_bytes = _DEFAULT_MAX_BYTES if max_bytes is None else max_bytes
        self._format = save_format_version
        self._new_transfer_id = new_transfer_id or (lambda s: "saves:" + s)
        self._spool = spool

    @property
    def _e2e(self) -> bool:
        return self._codec.enc == "e2e"

    def _summary(self, rec: Obj) -> Obj:
        metadata, binding = _split_binding(rec["value"])
        fv = _format_of(metadata)
        return {
            "id": rec["id"],
            "version": rec["version"],
            "metadata": metadata,
            "file": self._bound_file(rec, binding) if self._e2e else rec["file"],
            "newerFormat": self._format is not None and fv is not None and fv > self._format,
        }

    @staticmethod
    def _bound_file(rec: Obj, binding: Optional[Obj]) -> Optional[Obj]:
        """In E2E mode the file is the one the binding names, and only when the record's current file is it."""
        if binding is None or rec["file"] is None:
            return None
        return rec["file"] if rec["file"]["sha256"] == binding["sha256"] else None

    def list(self) -> List[Obj]:
        """The saves of this person, by id."""
        return sorted((self._summary(r) for r in self._records.list()), key=lambda s: s["id"])

    def revisions(self, id: str) -> List[Obj]:
        """The kept revisions of a save's file, newest first."""
        self._check_id(id)
        reply = self._engine.transport.revisions(self._target(id))
        if not reply.ok:
            raise SavesError("not-found" if reply.status == 404 else "rejected", reply.code)
        return list(reply.value["revisions"])

    def read(
        self,
        id: str,
        *,
        sink: Any = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
        cancel: Optional[threading.Event] = None,
    ) -> Obj:
        """Read a save: its metadata and bytes. ``{ok: True, id, version, metadata, file, bytes}``,
        ``{ok: False, reason: "not-found"}`` or ``{ok: False, reason: "newer-format", formatVersion,
        supported}``. With a ``sink`` (anything with ``write(bytes)``) the bytes go there and ``bytes`` is
        ``None``; the sink's contents are provisional until ``read`` returns (discard them on a raise)."""
        self._check_id(id)
        rec = self._records.get(id)
        if rec is None:
            return {"ok": False, "reason": "not-found"}
        metadata, binding = _split_binding(rec["value"])
        fv = _format_of(metadata)
        if self._format is not None and fv is not None and fv > self._format:
            return {"ok": False, "reason": "newer-format", "formatVersion": fv, "supported": self._format}
        ref: Optional[Obj]
        if self._e2e:
            if binding is None:
                # A malformed binding is not an absent one: the writer meant a file.
                if SAVE_FILE_BINDING_KEY in rec["value"]:
                    raise SavesError(SAVES_FILE_INVALID, "binding")
                ref = None
            else:
                ref = self._revision_for(id, rec, binding)
        else:
            ref = rec["file"]
        if ref is None:
            return {
                "ok": True,
                "id": id,
                "version": rec["version"],
                "metadata": metadata,
                "file": None,
                "bytes": None,
            }
        parts: List[bytes] = []

        class _Collect:
            def write(self, data: bytes) -> None:
                parts.append(bytes(data))

        target = sink if sink is not None else _Collect()
        try:
            self._engine.download(
                DownloadRequest(
                    collection=SAVES_COLLECTION,
                    record=self._records.wire_id(id),
                    version=ref["version"],
                    format=ref["format"],
                    size=ref["size"],
                    sha256=ref["sha256"],
                    codec=self._codec,
                    sink=target,
                    cache=self._cache,
                    on_progress=on_progress,
                    cancel=cancel,
                )
            )
        except Exception as e:  # noqa: BLE001
            raise _as_saves_error(e) from None
        return {
            "ok": True,
            "id": id,
            "version": rec["version"],
            "metadata": metadata,
            "file": ref,
            "bytes": None if sink is not None else b"".join(parts),
        }

    def _revision_for(self, id: str, rec: Obj, binding: Obj) -> Obj:
        """D-3: the revision the binding names, else a failure."""

        def fits(r: Obj) -> bool:
            return (
                r["sha256"] == binding["sha256"] and r["size"] == binding["size"] and r["format"] == binding["format"]
            )

        if rec["file"] is not None and fits(rec["file"]):
            return rec["file"]
        found = next((r for r in self.revisions(id) if fits(r)), None)
        if found is None:
            raise SavesError(SAVES_FILE_INVALID, "binding")
        return {k: found[k] for k in ("version", "size", "sha256", "format")}

    def write(
        self,
        id: str,
        data: Union[bytes, RangedSource],
        metadata: Obj,
        *,
        base_version: Any = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> SaveTransfer:
        """Write a save. Returns a handle at once; ``wait()`` settles when the file is stored and the
        metadata is pushed, or on a conflict, a failure or a cancel."""
        return self._run(id, data, metadata, base_version, on_progress, None)

    def resolve(
        self,
        conflict: Obj,
        keep: str,
        data: Union[bytes, RangedSource],
        *,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> SaveTransfer:
        """Settle a conflict. ``"remote"`` keeps the server's copy and writes nothing; ``"local"`` writes this
        device's save on top of the server's version; ``"both"`` writes it as a new save in a free slot."""
        cid = conflict["id"]
        if keep == "remote":
            return SaveTransfer(
                cid,
                {"done": 0, "total": 0},
                lambda _c: {},
                lambda: None,
                settled={"state": "done", "id": cid, "kept": "remote", "version": conflict["serverVersion"]},
            )
        if keep == "both" and not conflict["bothAvailable"]:
            return SaveTransfer(
                cid,
                {"done": 0, "total": 0},
                lambda _c: {},
                lambda: None,
                settled={"state": "failed", "error": SavesError("slots-full")},
            )
        mode: Obj = (
            {"copy": True}
            if keep == "both"
            else {"baseVersion": "*" if conflict["serverVersion"] is None else conflict["serverVersion"]}
        )
        return self._run(cid, data, conflict["local"]["metadata"], None, on_progress, mode)

    def delete(self, id: str, base_version: Optional[int] = None) -> Obj:
        """Delete a save; its file is collected with the record."""
        self._check_id(id)
        base = base_version
        if base is None:
            rec = self._records.get(id)
            if rec is None:
                return {"ok": False, "reason": "rejected", "code": "not_found"}
            base = rec["version"]
        return self._records.delete(id, base)

    # ── internals ───────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _check_id(id: str) -> None:
        if not isinstance(id, str) or not _KEY.match(id):
            raise SavesError("invalid-save", "id")

    def _target(self, id: str) -> FileTarget:
        return FileTarget(SAVES_COLLECTION, self._records.wire_id(id))

    def _run(
        self,
        id: str,
        data: Union[bytes, RangedSource],
        metadata: Obj,
        base_version: Any,
        on_progress: Optional[Callable[[int, int], None]],
        mode: Optional[Obj],
    ) -> SaveTransfer:
        source: RangedSource = ranged_bytes(bytes(data)) if isinstance(data, (bytes, bytearray)) else data
        transfer_id = self._new_transfer_id(id)
        progress: Obj = {"done": 0, "total": source.size}
        sealed: List[Obj] = []
        hard = threading.Event()

        def attempt(cancel: threading.Event) -> Obj:
            check = self._precheck(id, source, metadata)
            if check is not None:
                return {"state": "failed", "error": check}
            target_id = id
            base: Any = None
            if mode is not None and "copy" in mode:
                free = self._free_id(id)
                if free is None:
                    return {"state": "failed", "error": SavesError("slots-full")}
                target_id, base = free, "*"
            elif mode is not None:
                base = mode["baseVersion"]
            elif base_version is not None:
                base = base_version
            else:
                existing = self._records.get(id)
                if existing is None:
                    if len(self._records.list()) >= SYNC_SAVE_SLOTS:
                        return {"state": "failed", "error": SavesError("slots-full")}
                    base = "*"
                else:
                    base = existing["version"]
            wire = self._records.wire_id(target_id)

            def report(done: int, total: int) -> None:
                progress["done"], progress["total"] = done, total
                if on_progress is not None:
                    on_progress(done, total)

            try:
                stored = self._codec.stored_size(source.size)
                plan = sf.plan_transfer(stored, self._delta)
                if plan.mode == "too_large":
                    return {"state": "failed", "error": SavesError("too-large")}
                if plan.mode == "chunks":
                    file = self._engine.upload_chunked(
                        ChunkedUploadRequest(
                            id=transfer_id,
                            collection=SAVES_COLLECTION,
                            record=wire,
                            source=source,
                            codec=self._codec,
                            base_version=base,
                            on_progress=report,
                            cancel=cancel,
                        )
                    )
                else:
                    if not sealed:
                        sealed.append(self._seal(source, cancel))
                    s = sealed[0]
                    file = self._engine.upload(
                        UploadRequest(
                            id=transfer_id,
                            collection=SAVES_COLLECTION,
                            record=wire,
                            source=s["source"],
                            size=s["size"],
                            sha256=s["sha256"],
                            enc=self._codec.enc,
                            base_version=base,
                            on_progress=report,
                            cancel=cancel,
                        )
                    )
            except TransferError as e:
                if e.reason == "conflict":
                    return self._conflict_outcome(id, metadata, source, e.server_version)
                if e.reason == "aborted":
                    raise
                return {"state": "failed", "error": _as_saves_error(e)}
            value: Obj = dict(metadata)
            if self._e2e:
                value[SAVE_FILE_BINDING_KEY] = {
                    "sha256": file["sha256"],
                    "size": file["size"],
                    "format": file["format"],
                }
            pointer = {k: file[k] for k in ("version", "size", "sha256", "format")}
            pointer = {k: file[k] for k in ("version", "size", "sha256", "format")}
            result = self._records.set(target_id, value, file["version"], hard, pointer)
            if result["ok"]:
                out: Obj = {"state": "done", "id": id, "version": result["version"], "file": file}
                if target_id != id:
                    out["copyId"] = target_id
                return out
            if result["reason"] == "conflict":
                server = result["server"]
                return self._conflict_outcome(
                    id, metadata, source, server["version"] if server is not None else None, server, True
                )
            return {"state": "failed", "error": SavesError("rejected", result["code"])}

        return SaveTransfer(
            transfer_id, progress, attempt, lambda: self._engine.cancel(transfer_id), hard_cancel=hard
        )

    def _precheck(self, id: str, source: RangedSource, metadata: Obj) -> Optional[SavesError]:
        if not isinstance(id, str) or not _KEY.match(id):
            return SavesError("invalid-save", "id")
        if SAVE_FILE_BINDING_KEY in metadata:
            return SavesError("invalid-save", "reserved-key")
        if source.size > self._max_bytes or source.size > SYNC_FILE_MAX_BYTES:
            return SavesError("too-large")
        return None

    def _seal(self, source: RangedSource, cancel: threading.Event) -> Obj:
        def plain() -> Iterable[bytes]:
            at = 0
            while at < source.size:
                end = min(source.size, at + 1_048_576)
                yield source.read(at, end)
                at = end

        return self._spool(self._codec.seal_stream(plain()), cancel)

    def _free_id(self, id: str) -> Optional[str]:
        """The first ``<id>.copy``, ``<id>.copy2``, ... that is not a save; ``None`` when all 16 slots are in use."""
        all_ = self._records.list()
        if len(all_) >= SYNC_SAVE_SLOTS:
            return None
        taken = {r["id"] for r in all_}
        for n in range(1, 1000):
            cand = id[:120] + ".copy" + ("" if n == 1 else str(n))
            if cand not in taken:
                return cand
        return None

    def _conflict_outcome(
        self,
        id: str,
        metadata: Obj,
        source: RangedSource,
        server_version: Optional[int],
        known: Any = None,
        has_known: bool = False,
    ) -> Obj:
        rec = known if has_known else self._records.get(id)
        slots = len(self._records.list())
        return {
            "state": "conflict",
            "conflict": {
                "id": id,
                "local": {"metadata": metadata, "size": source.size},
                "remote": self._summary(rec) if rec else None,
                "serverVersion": rec["version"] if rec else server_version,
                "bothAvailable": slots < SYNC_SAVE_SLOTS,
            },
        }



# ── client.cloud_sync.saves ─────────────────────────────────────────────────────────────────────


class SavesApi:
    """``client.cloud_sync.saves``. A product without the Sync service gets the typed N/A. Transfer events
    go to ``emit`` as ``{"type": "transferProgress" | "transferDone" | "transferFailed", "id", ...}``."""

    def __init__(
        self,
        *,
        ctx: Any,
        host: Any,
        keyring: Any,
        tokens: Any,
        subject: Callable[[], Optional[str]],
        attach: Callable[[], None],
        emit: Callable[[Obj], None],
    ) -> None:
        self._ctx = ctx
        self._host = host
        self._keyring = keyring
        self._subject = subject
        self._attach = attach
        self._emit = emit
        self._records = MachineRecords(host, keyring.codec, lambda: host.machine.encryption_mode() == "e2e")
        self._journal = FileJournal(ctx.dirs.state)
        self._transport = FileRoutes(ctx, lambda: tokens.current)
        self._engine = TransferEngine(
            self._transport, self._journal, max_retry_after_seconds=SAVES_MAX_RETRY_AFTER_SECONDS
        )
        self._active: Dict[str, SaveTransfer] = {}
        self._lock = threading.Lock()

    # ── What app code calls ──────────────────────────────────────────────────────────────────

    def list(self) -> List[Obj]:
        """The saves of this person (at most 16), by id."""
        return self._client().list()

    def revisions(self, id: str) -> List[Obj]:
        """The kept revisions of a save's file, newest first."""
        return self._client().revisions(id)

    def read(
        self,
        id: str,
        *,
        sink: Any = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
        cancel: Optional[threading.Event] = None,
    ) -> Obj:
        """Read a save: its metadata and bytes (see :meth:`SavesClient.read`)."""
        client = self._client()
        tid = "saves:read:" + id

        def progress(done: int, total: int) -> None:
            if on_progress is not None:
                on_progress(done, total)
            self._emit({"type": TransferEvent.TRANSFERPROGRESS, "id": tid, "done": done, "total": total})

        try:
            result = client.read(id, sink=sink, on_progress=progress, cancel=cancel)
        except SavesError as e:
            self._emit({"type": TransferEvent.TRANSFERFAILED, "id": tid, "code": e.code})
            raise
        self._emit({"type": TransferEvent.TRANSFERDONE, "id": tid, "state": "done"})
        return result

    def write(
        self,
        id: str,
        data: Union[bytes, RangedSource],
        metadata: Obj,
        *,
        base_version: Any = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> SaveTransfer:
        """Write a save. Returns a handle at once; ``handle.wait()`` settles on done, cancelled, failed or
        conflict. The handle is in :meth:`transfers` until then. The wait for the metadata write has no
        timeout: ``cancel()``, a sign-out (the write is dropped) and the host's retries end it."""
        client = self._client()
        return self._track(
            client.write(
                id, data, metadata, base_version=base_version, on_progress=self._progress("saves:" + id, on_progress)
            )
        )

    def resolve(
        self,
        conflict: Obj,
        keep: str,
        data: Union[bytes, RangedSource],
        *,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> SaveTransfer:
        """Settle a conflict: keep ``"remote"``, write ``"local"`` on top, or keep ``"both"``."""
        client = self._client()
        return self._track(
            client.resolve(conflict, keep, data, on_progress=self._progress("saves:" + conflict["id"], on_progress))
        )

    def delete(self, id: str, base_version: Optional[int] = None) -> Obj:
        """Delete a save; its file is collected with the record."""
        return self._client().delete(id, base_version)

    def transfers(self) -> List[SaveTransfer]:
        """The writes in flight (running, paused or waiting on the network)."""
        with self._lock:
            return list(self._active.values())

    # ── What the client calls ────────────────────────────────────────────────────────────────

    def purge(self) -> None:
        """The person's data is gone: cancel what runs, settle waiting writes, delete the journal and the
        chunk cache. Each step is tried whatever the other did."""
        with self._lock:
            running = list(self._active.values())
            self._active.clear()
        self._records.drop_all()
        for t in running:
            try:
                t.cancel()
            except Exception:  # noqa: BLE001
                pass
        try:
            self._journal.clear()
        except Exception:  # noqa: BLE001
            pass
        import shutil

        shutil.rmtree(os.path.join(self._ctx.dirs.state, CLOUD_SYNC_CHUNKS_DIR), ignore_errors=True)

    # ── internals ────────────────────────────────────────────────────────────────────────────

    def _progress(
        self, id: str, on_progress: Optional[Callable[[int, int], None]]
    ) -> Callable[[int, int], None]:
        def report(done: int, total: int) -> None:
            if on_progress is not None:
                on_progress(done, total)
            self._emit({"type": TransferEvent.TRANSFERPROGRESS, "id": id, "done": done, "total": total})

        return report

    def _client(self) -> SavesClient:
        self._ctx.require_service("sync", Feature.SYNC_SAVES)
        self._attach()
        if not self._host.started:
            raise SavesError("rejected", "sync-not-started")
        e2e = self._host.machine.encryption_mode() == "e2e"
        codec: FileCodec = self._keyring.file_codec(SAVES_COLLECTION) if e2e else ServerFileCodec()
        o = self._host.saves_options
        subject = self._subject()
        cache: Optional[ChunkCache] = None
        if o["delta"] and subject is not None:
            cache = FileChunkCache(
                chunk_cache_dir(self._ctx.dirs.state, subject, SAVES_COLLECTION),
                chunk_cache_budget(o["max_bytes"] or 0),
            )
        return SavesClient(
            records=self._records,
            engine=self._engine,
            codec=codec,
            delta=o["delta"],
            cache=cache,
            max_bytes=o["max_bytes"],
            save_format_version=o["save_format_version"],
        )

    def _track(self, t: SaveTransfer) -> SaveTransfer:
        with self._lock:
            self._active[t.id] = t

        def settle(o: Obj) -> None:
            with self._lock:
                if self._active.get(t.id) is t:
                    del self._active[t.id]
            if o["state"] == "failed":
                self._emit({"type": TransferEvent.TRANSFERFAILED, "id": t.id, "code": o["error"].code})
            else:
                self._emit({"type": TransferEvent.TRANSFERDONE, "id": t.id, "state": o["state"]})

        t.on_settled(settle)
        return t
