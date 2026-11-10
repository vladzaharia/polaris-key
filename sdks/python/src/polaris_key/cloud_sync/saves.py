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

* **Conflicts** (plans/U-08.md §2.4). A write whose base is stale opens one :class:`MergeRequest` per slot
  (S1) and the device keeps its copy unsent until the person or the app answers with ``request.keep``. A
  write with no base is based on the version this device last listed, read or wrote for the slot this
  session (S2); a slot not seen is create-only; a pulled version is never a base. While a request is open
  a write with no base only replaces its local side (S3). Requests live in memory (S5): a relaunch drops
  them and the next write raises the conflict again through S2.

Nothing here puts a value, a key or a path in an event, an exception or a log line.
"""

from __future__ import annotations

import os
import re
import threading
import time
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
from .merge import SYNC_MERGE_CLOSED, MergeRegistry, merge_choice_name
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
    "SavesSession",
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
# SDK-owned metadata keys written with every save (SAVES-META): when it was saved (epoch ms) and the
# device's display name. A write overwrites an app value under either key. Never a hardware value.
SAVE_SAVED_AT_KEY = "savedAt"
SAVE_DEVICE_KEY = "deviceLabel"

_KEY = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_SHA = re.compile(r"[0-9a-f]{64}")
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

    def pull(self) -> None:
        """Pull the ``saves`` collection from the server and return when the pull ended (a failed or
        impossible pull returns too, with the cache as it was). The default is no pull."""


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

    def pull(self) -> None:
        with self._host.locked() as m:
            m.pull()
        self._host.touch()


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
            and _SHA.fullmatch(sha)
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


class _Slot:
    """One open save request (S1): the device's copy, retained in memory until ``keep``."""

    def __init__(
        self,
        id: str,
        metadata: Obj,
        source: RangedSource,
        base: Optional[int],
        remote: Optional[Obj],
        remote_version: Any,
        slots_free: bool,
        on_progress: Optional[Callable[[int, int], None]],
    ) -> None:
        self.id = id
        #: The stamped metadata of the copy.
        self.metadata = metadata
        self.source = source
        self.on_progress = on_progress
        #: The version the copy was written on; ``None``: create-only.
        self.base = base
        self.remote = remote
        #: The server's version for ``keep("local")``; ``"*"`` when the save is gone.
        self.remote_version = remote_version
        self.slots_free = slots_free
        #: A keep is running: a conflict it meets reopens the request when the keep ends.
        self.keeping = False
        self.reopen = False


class SavesSession:
    """What a client's saves remember while the process runs: the open requests (S1) and the version of
    each slot this device last listed, read or wrote (S2). The api keeps one across :class:`SavesClient`
    instances; a bare client makes its own."""

    def __init__(self, merge: Optional[MergeRegistry] = None) -> None:
        self.merge = merge if merge is not None else MergeRegistry()
        self.lock = threading.RLock()
        self.slots: Dict[str, _Slot] = {}
        self.seen: Dict[str, int] = {}

    def clear(self) -> None:
        """The person and their data are gone: every request closes and nothing is remembered."""
        with self.lock:
            ids = list(self.slots)
            self.slots.clear()
            self.seen.clear()
        for id in ids:
            self.merge.close(request_id(id), "superseded")


def request_id(id: str) -> str:
    return f"w:{SAVES_COLLECTION}/{id}"


def _number_of(v: Any) -> Optional[Union[int, float]]:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _string_of(v: Any) -> Optional[str]:
    return v if isinstance(v, str) else None


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
        device_label: Optional[Callable[[], Optional[str]]] = None,
        now: Optional[Callable[[], int]] = None,
        session: Optional[SavesSession] = None,
    ) -> None:
        self._session = session if session is not None else SavesSession()
        self._records = records
        self._engine = engine
        self._codec = codec
        self._delta = delta
        self._cache = cache
        self._max_bytes = _DEFAULT_MAX_BYTES if max_bytes is None else max_bytes
        self._format = save_format_version
        self._new_transfer_id = new_transfer_id or (lambda s: "saves:" + s)
        self._spool = spool
        self._device_label = device_label
        self._now = now or (lambda: int(time.time() * 1000))

    @property
    def merge(self) -> MergeRegistry:
        """The requests of this client's host: the saves layer's are ``w:saves/<id>``."""
        return self._session.merge

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
        all_ = self._records.list()
        with self._session.lock:
            for r in all_:
                self._session.seen[r["id"]] = r["version"]
        return sorted((self._summary(r) for r in all_), key=lambda s: s["id"])

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
        with self._session.lock:
            self._session.seen[id] = rec["version"]
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
        metadata is pushed, or on a conflict (``{"state": "conflict", "request": MergeRequest}``), a failure
        or a cancel. While a request is open for the slot, a write with no base only replaces the request's
        local copy and settles ``conflict``; a write with a base supersedes the request (S3)."""
        with self._session.lock:
            slot = self._session.slots.get(id)
        if slot is not None:
            if base_version is not None:
                self._close_slot(id, "superseded")
            else:
                source: RangedSource = ranged_bytes(bytes(data)) if isinstance(data, (bytes, bytearray)) else data
                stamped = self._stamped(metadata)
                check = self._precheck(id, source, stamped)
                if check is not None:
                    return self._settled(id, {"state": "failed", "error": check})
                with self._session.lock:
                    slot.metadata = stamped
                    slot.source = source
                    slot.on_progress = on_progress
                self.merge.update(request_id(id), {"local": self._local_side(slot)})
                return self._settled(id, {"state": "conflict", "request": self.merge.find(request_id(id))})
        return self._run(id, data, metadata, base_version, on_progress, None)

    def delete(self, id: str, base_version: Optional[int] = None) -> Obj:
        """Delete a save; its file is collected with the record. With a request open for the slot the
        default base is the request's, so a delete that conflicts keeps the other copy (S3)."""
        self._check_id(id)
        with self._session.lock:
            slot = self._session.slots.get(id)
        base = base_version
        if base is None:
            if slot is not None:
                if slot.base is None:
                    server = self._records.get(id)
                    self._close_slot(id, "superseded")
                    return {"ok": False, "reason": "conflict", "server": server}
                base = slot.base
            else:
                rec = self._records.get(id)
                if rec is None:
                    return {"ok": False, "reason": "rejected", "code": "not_found"}
                base = rec["version"]
        r = self._records.delete(id, base)
        if slot is not None and (r["ok"] or r["reason"] == "conflict"):
            with self._session.lock:
                current = self._session.slots.get(id) is slot
            if current:
                self._close_slot(id, "superseded")
        if r["ok"]:
            with self._session.lock:
                self._session.seen.pop(id, None)
        return r

    @staticmethod
    def _settled(id: str, outcome: Obj) -> SaveTransfer:
        return SaveTransfer(id, {"done": 0, "total": 0}, lambda _c: {}, lambda: None, settled=outcome)

    # ── internals ───────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _check_id(id: str) -> None:
        if not isinstance(id, str) or not _KEY.fullmatch(id):
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
        stamp: bool = True,
    ) -> SaveTransfer:
        # The SDK's own keys: when and where this save was written. A keep re-runs the write with the
        # stamps of the copy it holds (``stamp`` false).
        if stamp:
            metadata = self._stamped(metadata)
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
                # S2: the version this device saw this session; else create-only. A pulled version is
                # never a base, so another device's newer save is a conflict, not an overwrite.
                with self._session.lock:
                    seen = self._session.seen.get(id)
                if seen is not None:
                    base = seen
                else:
                    if self._records.get(id) is None and len(self._records.list()) >= SYNC_SAVE_SLOTS:
                        return {"state": "failed", "error": SavesError("slots-full")}
                    base = "*"
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
                    return self._conflict_outcome(id, metadata, source, on_progress, base, e.server_version)
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
            result = self._records.set(target_id, value, file["version"], hard, pointer)
            if result["ok"]:
                with self._session.lock:
                    self._session.seen[target_id] = result["version"]
                out: Obj = {"state": "done", "id": id, "version": result["version"], "file": file}
                if target_id != id:
                    out["copyId"] = target_id
                return out
            if result["reason"] == "conflict":
                server = result["server"]
                return self._conflict_outcome(
                    id,
                    metadata,
                    source,
                    on_progress,
                    base,
                    server["version"] if server is not None else None,
                    server,
                    True,
                )
            return {"state": "failed", "error": SavesError("rejected", result["code"])}

        return SaveTransfer(
            transfer_id, progress, attempt, lambda: self._engine.cancel(transfer_id), hard_cancel=hard
        )

    def _stamped(self, metadata: Obj) -> Obj:
        out = {k: v for k, v in metadata.items() if k not in (SAVE_SAVED_AT_KEY, SAVE_DEVICE_KEY)}
        out[SAVE_SAVED_AT_KEY] = self._now()
        label = self._device_label() if self._device_label else None
        if label:
            out[SAVE_DEVICE_KEY] = label
        return out

    def _pull(self) -> bool:
        """Pull the collection; never raises. True when the records layer pulled."""
        try:
            self._records.pull()
            return True
        except Exception:  # noqa: BLE001
            return False

    def _precheck(self, id: str, source: RangedSource, metadata: Obj) -> Optional[SavesError]:
        if not isinstance(id, str) or not _KEY.fullmatch(id):
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
        on_progress: Optional[Callable[[int, int], None]],
        base: Any,
        server_version: Optional[int],
        known: Any = None,
        has_known: bool = False,
    ) -> Obj:
        # The cache may be behind the conflict: pull before reading it, so the screen shows what the
        # server holds (and a save deleted elsewhere reads as deleted).
        pulled = self._pull()
        slots = len(self._records.list())
        # The server's answer wins. ``known`` is the copy a rejected set carried (None: deleted). A
        # file begin answers only a version; the cached row stands in for it only while it is that
        # very version, and a stale row is never presented as the server's copy.
        if has_known:
            remote = self._summary(known) if known else None
            version = known["version"] if known else server_version
        elif server_version is None:
            rec = self._records.get(id)
            remote = self._summary(rec) if rec else None
            version = rec["version"] if rec else None
        elif server_version == 0:
            remote, version = None, 0
        else:
            rec = self._records.get(id)
            if rec and rec["version"] >= server_version:
                remote, version = self._summary(rec), rec["version"]
            elif pulled and rec is None:
                # Pulled and gone: a tombstone's version, not a copy.
                remote, version = None, None
            else:
                remote = {"id": id, "version": server_version, "metadata": {}, "file": None, "newerFormat": False}
                version = server_version
        request = self._open_slot(
            _Slot(
                id,
                metadata,
                source,
                base if isinstance(base, int) and not isinstance(base, bool) else None,
                remote,
                "*" if remote is None or not version else version,
                slots < SYNC_SAVE_SLOTS,
                on_progress,
            ),
            version,
        )
        return {"state": "conflict", "request": request}

    # ── requests (S1, S3, S4) ───────────────────────────────────────────────────────────────

    def _local_side(self, slot: _Slot) -> Obj:
        plan = sf.plan_transfer(self._codec.stored_size(slot.source.size), self._delta)
        return {
            "value": dict(slot.metadata),
            "version": slot.base,
            "savedAt": _number_of(slot.metadata.get(SAVE_SAVED_AT_KEY)),
            "device": _string_of(slot.metadata.get(SAVE_DEVICE_KEY)),
            "file": {"size": slot.source.size, "format": "chunks" if plan.mode == "chunks" else "whole"},
        }

    @staticmethod
    def _remote_side(slot: _Slot, version: Optional[int]) -> Optional[Obj]:
        r = slot.remote
        if r is None:
            return None
        return {
            "value": dict(r["metadata"]),
            "version": version if version is not None else r["version"],
            "savedAt": _number_of(r["metadata"].get(SAVE_SAVED_AT_KEY)),
            "device": _string_of(r["metadata"].get(SAVE_DEVICE_KEY)),
            "file": {"size": r["file"]["size"], "format": r["file"]["format"]} if r["file"] else None,
        }

    def _view(self, slot: _Slot, version: Optional[int], state: str, error: Optional[str]) -> Obj:
        choices = ["local", "remote"]
        if slot.remote is not None and slot.slots_free:
            choices.append("both")
        return {
            "id": request_id(slot.id),
            "cause": "write",
            "collection": SAVES_COLLECTION,
            "record": slot.id,
            "local": self._local_side(slot),
            "remote": self._remote_side(slot, version),
            "choices": choices,
            "state": state,
            "error": error,
        }

    def _open_slot(self, init: _Slot, version: Optional[int]) -> Any:
        """S1: open the slot's request, or (a keep conflicted again) bring the open one up to date."""
        with self._session.lock:
            have = self._session.slots.get(init.id)
            if have is not None:
                have.metadata, have.source, have.on_progress = init.metadata, init.source, init.on_progress
                have.base, have.remote = init.base, init.remote
                have.remote_version, have.slots_free = init.remote_version, init.slots_free
                have.reopen = have.keeping
                slot = have
            else:
                slot = init
            self._session.slots[init.id] = slot
            keeping = slot.keeping
        view = self._view(slot, version, "applying" if keeping else "open", None)
        if keeping:
            # The keep ends first; ``_keep_slot`` reopens the request for the person.
            self.merge.update(view["id"], view)
            return self.merge.find(view["id"])
        return self.merge.open(view, lambda choice: self._keep_slot(init.id, choice))

    def _close_slot(self, id: str, how: str) -> None:
        with self._session.lock:
            self._session.slots.pop(id, None)
        self.merge.close(request_id(id), how)

    def _keep_slot(self, id: str, choice: Any) -> Obj:
        """S4: answer the slot's request; the transfer's outcome settles the result."""
        with self._session.lock:
            slot = self._session.slots.get(id)
        rid = request_id(id)
        if slot is None:
            return {"ok": False, "code": SYNC_MERGE_CLOSED, "reopened": False}
        name = merge_choice_name(choice)
        with self._session.lock:
            slot.keeping = True
            slot.reopen = False
        self.merge.update(rid, {"state": "applying", "error": None})

        def reopen(code: str) -> Obj:
            with self._session.lock:
                slot.keeping = False
                again = slot.reopen
                slot.reopen = False
            self.merge.update(
                rid, self._view(slot, slot.remote["version"] if slot.remote else None, "open", None if again else code)
            )
            if again:
                self.merge.reannounce(rid)
            return {"ok": False, "code": "conflict" if again else code, "reopened": True}

        if name == "remote":
            # Pull first, so the cache holds the copy the person chose (not this device's old one).
            self._pull()
            rec = self._records.get(id)
            if rec is not None:
                with self._session.lock:
                    self._session.seen[id] = rec["version"]
            self._close_slot(id, "remote")
            return {"ok": True, "kept": "remote", "version": rec["version"] if rec else None}
        if name == "both" and not slot.slots_free:
            return reopen("slots-full")
        mode: Obj = {"copy": True} if name == "both" else {"baseVersion": slot.remote_version}
        out = self._run(id, slot.source, slot.metadata, None, slot.on_progress, mode, stamp=False).wait()
        if out["state"] == "done" and "kept" not in out:
            self._close_slot(id, name)
            res: Obj = {"ok": True, "kept": name, "version": out["version"]}
            if "copyId" in out:
                res["copyId"] = out["copyId"]
            return res
        if out["state"] == "conflict":
            return reopen("conflict")
        return reopen(out["error"].code if out["state"] == "failed" else "cancelled")


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
        merge: Optional[MergeRegistry] = None,
    ) -> None:
        self._ctx = ctx
        self._host = host
        self._keyring = keyring
        self._subject = subject
        self._attach = attach
        self._emit = emit
        self._records = MachineRecords(host, keyring.codec, lambda: host.machine.encryption_mode() == "e2e")
        self._journal = FileJournal(ctx.dirs.state)
        self._transport = FileRoutes(ctx, lambda: tokens.current, self._account_required, subject)
        self._engine = TransferEngine(
            self._transport, self._journal, max_retry_after_seconds=SAVES_MAX_RETRY_AFTER_SECONDS
        )
        self._active: Dict[str, SaveTransfer] = {}
        self._lock = threading.Lock()
        #: The requests and the seen versions outlive each :class:`SavesClient` the api builds.
        self._session = SavesSession(merge)

    @property
    def merge(self) -> MergeRegistry:
        """The client's requests: the saves layer's are ``w:saves/<id>``."""
        return self._session.merge

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

    def delete(self, id: str, base_version: Optional[int] = None) -> Obj:
        """Delete a save; its file is collected with the record."""
        return self._client().delete(id, base_version)

    def transfers(self) -> List[SaveTransfer]:
        """The writes in flight (running, paused or waiting on the network)."""
        with self._lock:
            return list(self._active.values())

    def _account_required(self, sign_in_url: Optional[str], for_subject: Optional[str]) -> None:
        """A file route answered ``account_required`` (V5 §11.5): the machine takes the same transition as
        for a ``/sync`` 403 (its ``signedOut`` event makes the Cloud Sync API forget), unless the person
        signed in now is not the one the call started for. On its own thread, so the transfer that saw it
        never waits on a pump."""
        if for_subject != self._subject():
            return
        threading.Thread(
            target=lambda: self._host.account_required(sign_in_url), name="polaris-sync-account", daemon=True
        ).start()

    # ── What the client calls ────────────────────────────────────────────────────────────────

    def purge(self) -> None:
        """The person's data is gone: cancel what runs, settle waiting writes, delete the journal and the
        chunk cache. Each step is tried whatever the other did."""
        with self._lock:
            running = list(self._active.values())
            self._active.clear()
        self._records.drop_all()
        self._session.clear()
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
            device_label=lambda: self._ctx.device_label(),
            session=self._session,
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
