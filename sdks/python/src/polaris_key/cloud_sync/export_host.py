"""``client.cloud_sync.export()`` (U-51.5; WIRE-CONTRACT-V5 §13.12): everything around the export core
(``export.py``). It checks the preconditions, flushes the machine, pulls the rows as the Worker serves them,
gives the core a file source over the SDK's transfer engine and a destination, and commits the archive.

* **Preconditions.** Sync on (the typed ``product`` N/A), one export per client (``sync-export-failed``,
  reason ``busy``), a signed-in person (``account_required``), the pin (``sync-encryption-pinned``) and the
  unlocked root in end-to-end mode (``sync-locked``). Nothing is read before they hold.
* **Pulls.** ``flush()`` (bounded by the sign-out flush window), then the host's own pulls from cursor 0 until
  ``more`` is false: at most ``SYNC_EXPORT_MAX_PULLS``. Waits (a ``Retry-After``, a retry's backoff) add up to
  at most ``SYNC_EXPORT_MAX_WAIT_MS`` and one is cut to ``SYNC_EXPORT_RETRY_AFTER_MAX_MS``; past either bound
  the export fails with reason ``network``; a cancel ends a wait at once. The rows are the Worker's, so the
  core opens each as the host codec opens a pull.
* **Files.** Whole files by ``Range`` of the stored bytes (the engine's resume and its ``If-Match``), a chunked
  file by its manifest and its chunks, through the same :class:`TransferEngine` that ``saves.read`` uses (its
  retries, ``Retry-After`` and backoff), so they spend the device's hourly file allowance. A file the Worker no
  longer has, or serves inconsistently, ends short and the core flags it partial.
* **Destination.** A path. ``<destination>.partial`` is created exclusively (``O_CREAT | O_EXCL | O_NOFOLLOW``)
  at ``0600``, written, flushed to disk and renamed over the destination atomically. A stale ``.partial`` an
  earlier crash left is removed first; a destination or partial that is not a regular file is refused (reason
  ``destination``). An error or a cancel removes the partial and leaves the old destination as it was. No other
  plaintext copy exists.

Nothing here logs, or puts in an error, a value, an id or a path.
"""

from __future__ import annotations

import json
import os
import stat
import threading
import time
from functools import partial
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence

from ..constants_generated import (
    SYNC_EXPORT_MAX_PULLS,
    SYNC_EXPORT_MAX_WAIT_MS,
    SYNC_EXPORT_RETRY_AFTER_MAX_MS,
    ErrorCode,
    Feature,
)
from ..core.bounded_body import MAX_BODY_BYTES, read_capped_text
from ..core.errors import PolarisError
from .export import ExportFileRef, ExportInput, export_to_sink
from .files import FileRoutes, retry_after_seconds
from .transfer import (
    DOWNLOAD_RANGE_BYTES,
    FileBody,
    FileQuery,
    FileReply,
    FileTarget,
    TransferEngine,
    TransferError,
    _Hold,
)
from .transport import is_sync_path

__all__ = ["CloudSyncExporter", "SyncExportError"]

Obj = Dict[str, Any]

#: Attempts at one request before the export gives up (reason ``network``).
_MAX_ATTEMPTS = 8
_BACKOFF_BASE = 0.5
_BACKOFF_CAP = 30.0


class SyncExportError(PolarisError):
    """``sync-export-failed``. ``reason`` is ``destination`` (the destination cannot be written, a disk
    that is full, a path that is not a regular file), ``network`` (offline, retries spent, or a wait past
    its bound) or ``busy`` (another export of this client is running). The message names no path."""

    def __init__(self, reason: str) -> None:
        super().__init__(ErrorCode.SYNC_EXPORT_FAILED, "The export failed: " + reason)
        self.reason = reason


def _cancelled() -> PolarisError:
    return PolarisError(ErrorCode.CANCELLED, "The export was cancelled")


def _no_constant(_: str) -> Any:
    raise ValueError("not JSON")


class _NoJournal:
    """The engine's journal port; an export never uploads, so nothing is read or written."""

    def get(self, id: str) -> Optional[Any]:
        return None

    def put(self, id: str, record: Any) -> None:
        raise RuntimeError("an export keeps no journal")

    def delete(self, id: str) -> None:
        return None

    def list(self) -> List[str]:
        return []


# ── waiting, bounded ─────────────────────────────────────────────────────────────────────────────


class _Budget:
    """Everything the export waits for, added up: past ``SYNC_EXPORT_MAX_WAIT_MS`` it fails (reason
    ``network``). A cancel ends a wait at once."""

    def __init__(
        self,
        cancel: threading.Event,
        sleep: Callable[[float, threading.Event], None],
        on_wait: Callable[[bool], None],
    ) -> None:
        self._cancel = cancel
        self._sleep = sleep
        self._on_wait = on_wait
        self.waited_ms = 0.0

    def check(self) -> None:
        if self._cancel.is_set():
            raise _cancelled()

    def sleep(self, seconds: float, cancel: Optional[threading.Event] = None) -> None:
        """The engine's ``sleep`` port as well as the pull loop's."""
        self.check()
        seconds = max(0.0, min(seconds, SYNC_EXPORT_RETRY_AFTER_MAX_MS / 1000))
        if self.waited_ms + seconds * 1000 > SYNC_EXPORT_MAX_WAIT_MS:
            raise SyncExportError("network")
        self.waited_ms += seconds * 1000
        self._on_wait(True)
        try:
            self._sleep(seconds, self._cancel)
        finally:
            self._on_wait(False)
        self.check()


def _wait(seconds: float, cancel: threading.Event) -> None:
    if cancel.wait(seconds):
        raise _cancelled()


# ── the file source ──────────────────────────────────────────────────────────────────────────────


class _HttpSource:
    """An :class:`~polaris_key.cloud_sync.export.ExportFileSource` over the file routes and the engine."""

    def __init__(self, routes: FileRoutes, engine: TransferEngine, cancel: threading.Event) -> None:
        self._routes = routes
        self._engine = engine
        self._cancel = cancel
        self._hold = _Hold()

    def _call(self, fn: Callable[[], FileReply]) -> Optional[FileReply]:
        """One route call with the engine's recovery rules. ``None`` is "the Worker has none" (a path the
        routes refuse to build, a 404, a 410); any other refusal is the export's failure."""
        try:
            reply = self._engine._call(self._hold, self._cancel, fn)
        except TransferError as e:
            if e.reason == "aborted":
                raise _cancelled() from None
            if e.reason == "rejected" and e.code == "bad_path":
                return None
            raise SyncExportError("network") from None
        if reply.ok:
            return reply
        if reply.status in (404, 410):
            return None
        if reply.status == 403 and reply.code == ErrorCode.ACCOUNT_REQUIRED:
            raise PolarisError(ErrorCode.ACCOUNT_REQUIRED, "Cloud Sync needs a signed-in account")
        raise SyncExportError("network")

    @staticmethod
    def _version(v: Any) -> Optional[int]:
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        return v if isinstance(v, int) and not isinstance(v, bool) else None

    def pointers(self, collection: str, record: str) -> Sequence[Obj]:
        reply = self._call(lambda: self._routes.revisions(FileTarget(collection, record), self._cancel))
        if reply is None:
            return []
        revs = reply.value.get("revisions") if isinstance(reply.value, dict) else None
        return [r for r in revs if isinstance(r, dict)] if isinstance(revs, list) else []

    def stored(self, ref: ExportFileRef) -> Iterator[bytes]:
        version = self._version(ref.version)
        target = FileTarget(ref.collection, ref.record)
        if ref.format == "chunks":
            # The manifest: one unranged ``GET``, read under the manifest cap.
            reply = self._call(lambda: self._routes.get_file(target, FileQuery(version=version), self._cancel))
            body = reply.value if reply is not None else None
            if isinstance(body, FileBody) and body.status == 200:
                yield body.data
            return
        size = ref.size
        etag: Optional[str] = None
        at = 0
        while at < size:
            end = min(size, at + DOWNLOAD_RANGE_BYTES)
            query = FileQuery(version=version, range=(at, end), if_match=etag)
            reply = self._call(partial(self._routes.get_file, target, query, self._cancel))
            if reply is None or not isinstance(reply.value, FileBody):
                return
            body = reply.value
            # A Worker that answers inconsistently (another file, another range, a 200 for a range) ends
            # the stream here; the core flags what was read as partial.
            if etag is not None and body.etag is not None and body.etag != etag:
                return
            if etag is None:
                etag = body.etag
            if body.status == 206:
                cr = body.content_range
                if (
                    cr is None
                    or cr[0] != at
                    or cr[2] != size
                    or cr[1] <= cr[0]
                    or cr[1] > end
                    or len(body.data) != cr[1] - cr[0]
                ):
                    return
            elif body.status != 200 or at != 0 or len(body.data) != size:
                return
            at += len(body.data)
            yield body.data

    def chunk(self, collection: str, id_hex: str) -> Optional[bytes]:
        reply = self._call(lambda: self._routes.get_chunk(collection, id_hex, self._cancel))
        if reply is None or not isinstance(reply.value, (bytes, bytearray)):
            return None
        return bytes(reply.value)


# ── the destination ──────────────────────────────────────────────────────────────────────────────

_O_FLAGS = (
    os.O_WRONLY
    | os.O_CREAT
    | os.O_EXCL
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_BINARY", 0)
)


def _lstat(path: str) -> Optional[os.stat_result]:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError:
        raise SyncExportError("destination") from None


class _PartialFile:
    """The path destination as a :class:`~polaris_key.cloud_sync.export.ZipSink`. Nothing is created until
    the first write (a refused export leaves nothing); :meth:`commit` renames, :meth:`discard` removes the
    partial this object created, and only that."""

    def __init__(self, destination: Any) -> None:
        try:
            path = os.fspath(destination)
            if isinstance(path, bytes):
                path = os.fsdecode(path)
        except TypeError:
            raise SyncExportError("destination") from None
        if not isinstance(path, str) or path == "" or "\0" in path:
            raise SyncExportError("destination")
        self.dest = path
        self.partial = path + ".partial"
        self._f: Optional[Any] = None
        self._created = False

    def prepare(self) -> None:
        """Refuse a destination or partial that is not a regular file; remove a stale partial."""
        st = _lstat(self.dest)
        if st is not None and not stat.S_ISREG(st.st_mode):
            raise SyncExportError("destination")
        st = _lstat(self.partial)
        if st is not None:
            if not stat.S_ISREG(st.st_mode):
                raise SyncExportError("destination")
            try:
                os.unlink(self.partial)
            except OSError:
                raise SyncExportError("destination") from None

    def _open(self) -> Any:
        try:
            fd = os.open(self.partial, _O_FLAGS, 0o600)
        except OSError:
            raise SyncExportError("destination") from None
        self._created = True
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise SyncExportError("destination")
            return os.fdopen(fd, "wb")
        except BaseException:
            os.close(fd)
            raise

    def write(self, data: bytes) -> None:
        try:
            if self._f is None:
                self._f = self._open()
            self._f.write(data)
        except OSError:
            raise SyncExportError("destination") from None

    def commit(self) -> None:
        """Flush to disk and rename over the destination (replacing it atomically)."""
        try:
            if self._f is None:
                self._f = self._open()
            self._f.flush()
            os.fsync(self._f.fileno())
            self._f.close()
            self._f = None
            st = _lstat(self.dest)
            if st is not None and not stat.S_ISREG(st.st_mode):
                raise SyncExportError("destination")
            os.replace(self.partial, self.dest)
        except OSError:
            raise SyncExportError("destination") from None
        self._sync_parent()

    def _sync_parent(self) -> None:
        flags = getattr(os, "O_DIRECTORY", None)
        if flags is None or os.name == "nt":
            return
        try:
            fd = os.open(os.path.dirname(os.path.abspath(self.dest)), os.O_RDONLY | flags)
        except OSError:
            return
        try:
            os.fsync(fd)
        except OSError:
            pass
        finally:
            os.close(fd)

    def discard(self) -> None:
        """Close and remove the partial; the destination is left as it was."""
        f, self._f = self._f, None
        if f is not None:
            try:
                f.close()
            except OSError:
                pass
        if self._created:
            self._created = False
            try:
                os.unlink(self.partial)
            except OSError:
                pass


# ── the exporter ─────────────────────────────────────────────────────────────────────────────────


class CloudSyncExporter:
    def __init__(
        self,
        *,
        ctx: Any,
        host: Any,
        keyring: Any,
        tokens: Any,
        subject: Callable[[], Optional[str]],
        attach: Callable[[], None],
        flush: Callable[[], Obj],
        now: Optional[Callable[[], int]] = None,
        sleep: Optional[Callable[[float, threading.Event], None]] = None,
    ) -> None:
        self._ctx = ctx
        self._host = host
        self._keyring = keyring
        self._tokens = tokens
        self._subject = subject
        self._attach = attach
        self._flush = flush
        self._now = now or (lambda: int(time.time() * 1000))
        self._sleep = sleep or _wait
        self._busy = threading.Lock()

    def export(
        self,
        destination: Any,
        *,
        include_revisions: bool = False,
        on_progress: Optional[Callable[[Obj], None]] = None,
        cancel: Optional[threading.Event] = None,
    ) -> Obj:
        self._ctx.require_service("sync", Feature.SYNC_EXPORT)
        if not self._busy.acquire(blocking=False):
            raise SyncExportError("busy")
        try:
            return self._run(destination, include_revisions, on_progress, cancel or threading.Event())
        finally:
            self._busy.release()

    # ── one export ───────────────────────────────────────────────────────────────────────────

    def _run(
        self,
        destination: Any,
        include_revisions: bool,
        on_progress: Optional[Callable[[Obj], None]],
        cancel: threading.Event,
    ) -> Obj:
        if cancel.is_set():
            raise _cancelled()
        self._attach()
        e2e, client_id = self._preconditions()
        sink = _PartialFile(destination)
        sink.prepare()

        state = {"done": 0, "total": 0, "waiting": False}

        def report() -> None:
            if on_progress is not None:
                on_progress(dict(state))

        def on_wait(waiting: bool) -> None:
            state["waiting"] = waiting
            report()

        def on_bytes(done: int, total: int) -> None:
            state["done"], state["total"] = done, total
            report()

        budget = _Budget(cancel, self._sleep, on_wait)
        routes = FileRoutes(self._ctx, lambda: self._tokens.current)
        engine = TransferEngine(
            routes,
            _NoJournal(),  # type: ignore[arg-type]
            sleep=lambda seconds, _cancel: budget.sleep(seconds),
            max_attempts=_MAX_ATTEMPTS,
            max_retry_after_seconds=SYNC_EXPORT_RETRY_AFTER_MAX_MS / 1000,
        )
        # Send what is waiting, then read what the Worker holds.
        status = self._flush()
        unsynced = int(status.get("pending", 0)) if isinstance(status, dict) else 0
        budget.check()
        changes = self._pull_all(client_id, budget, cancel)
        inp = ExportInput(
            product=self._ctx.product,
            exported_at=self._now(),
            unsynced=unsynced,
            include_revisions=include_revisions,
            changes=changes,
            files=_HttpSource(routes, engine, cancel),
            codec=self._keyring.codec if e2e else None,
            file_codec=self._keyring.file_codec if e2e else None,
            cancel=cancel,
            on_progress=on_bytes,
        )
        try:
            summary = export_to_sink(inp, sink)
            budget.check()
            sink.commit()
        except BaseException:
            sink.discard()
            raise
        return {
            "path": sink.dest,
            "bytes": summary.bytes,
            "entries": summary.entries,
            "settings": summary.settings,
            "records": summary.records,
            "files": summary.files,
            "skipped": summary.skipped,
            "unsynced": unsynced,
        }

    def _preconditions(self) -> "tuple[bool, str]":
        host = self._host
        if not host.started:
            raise SyncExportError("network")
        with host.locked() as m:
            st = m.status()
            e2e = m.encryption_mode() == "e2e"
            machine_subject = m.persist().get("subject")
            journal = m.journal()
        if st.get("code") == ErrorCode.SYNC_ENCRYPTION_PINNED:
            raise PolarisError(ErrorCode.SYNC_ENCRYPTION_PINNED, "Cloud Sync is pinned to end-to-end encryption")
        state = st.get("state")
        refused = state == "blocked" and st.get("reason") == "account_required"
        if machine_subject is None or state == "local" or refused:
            raise PolarisError(ErrorCode.ACCOUNT_REQUIRED, "Cloud Sync needs a signed-in account")
        try:
            current = self._subject()
        except Exception:  # noqa: BLE001 - an unknown subject is not proof of another person
            current = None
        if current is not None and current != machine_subject:
            raise PolarisError(ErrorCode.ACCOUNT_REQUIRED, "Cloud Sync needs a signed-in account")
        if e2e and not self._keyring.unlocked:
            raise PolarisError(ErrorCode.SYNC_LOCKED, "Cloud Sync is locked: there is no root")
        if state == "blocked":
            raise SyncExportError("network")
        cid = (journal.get(machine_subject) or {}).get("clientId")
        if not isinstance(cid, str):
            raise SyncExportError("network")
        return e2e, cid

    # ── pulling ──────────────────────────────────────────────────────────────────────────────

    def _get_json(self, path: str, budget: _Budget, cancel: threading.Event) -> Obj:
        """One ``GET`` of a sync route with the bounded retries: the answer's JSON object."""
        ctx = self._ctx
        if not is_sync_path(ctx.product, path):
            raise SyncExportError("network")
        attempt = 0
        while True:
            budget.check()
            token = self._tokens.current
            if not token:
                raise PolarisError(ErrorCode.ACCOUNT_REQUIRED, "Cloud Sync needs a signed-in account")
            headers = ctx.headers({"authorization": f"Bearer {token}", "accept": "application/json"})
            status = 0
            text: Optional[str] = None
            told: Optional[int] = None
            try:
                with ctx.http().stream(
                    "GET", f"{ctx.base_url}{path}", headers=headers, timeout=ctx.timeout, follow_redirects=False
                ) as res:
                    text = read_capped_text(res, MAX_BODY_BYTES)
                    status = res.status_code
                    told = retry_after_seconds(res.headers.get("retry-after"))
            except PolarisError as e:
                if e.code == ErrorCode.LOCAL_ONLY:
                    raise
            except Exception:  # noqa: BLE001 - no answer: the network, a timeout
                status = 0
            if status == 200 and text is not None:
                try:
                    body = json.loads(text, parse_constant=_no_constant)
                except (ValueError, RecursionError):
                    body = None
                if isinstance(body, dict):
                    return body
                raise SyncExportError("network")
            if status == 403 and text is not None and ErrorCode.ACCOUNT_REQUIRED in text:
                raise PolarisError(ErrorCode.ACCOUNT_REQUIRED, "Cloud Sync needs a signed-in account")
            if status != 0 and status not in (408, 429) and status < 500:
                raise SyncExportError("network")
            attempt += 1
            if attempt >= _MAX_ATTEMPTS:
                raise SyncExportError("network")
            if told is not None:
                delay = float(told)
            else:
                delay = min(_BACKOFF_CAP, _BACKOFF_BASE * (2 ** (attempt - 1)))
            budget.sleep(delay)

    def _pull_all(self, client_id: str, budget: _Budget, cancel: threading.Event) -> List[Obj]:
        """The rows the Worker holds, as served: a pull from cursor 0 and every page that follows
        (``more``), a later row replacing an earlier one and a tombstone removing it."""
        settings: Dict[str, Obj] = {}
        records: Dict[Any, Obj] = {}
        cursor = 0
        for _ in range(SYNC_EXPORT_MAX_PULLS):
            body = self._get_json(f"/{self._ctx.product}/sync?cursor={cursor}&clientId={client_id}", budget, cancel)
            for c in body.get("changes") or []:
                if not isinstance(c, dict):
                    continue
                if isinstance(c.get("setting"), str):
                    settings[c["setting"]] = c
                else:
                    r = c.get("record")
                    if isinstance(r, list) and len(r) >= 2 and isinstance(r[0], str) and isinstance(r[1], str):
                        records[(r[0], r[1])] = c
            for t in body.get("tombstones") or []:
                if not isinstance(t, dict):
                    continue
                if isinstance(t.get("setting"), str):
                    settings.pop(t["setting"], None)
                r = t.get("record")
                if isinstance(r, list) and len(r) >= 2:
                    records.pop((r[0], r[1]) if isinstance(r[0], str) and isinstance(r[1], str) else None, None)
            if body.get("more") is not True:
                return [*settings.values(), *records.values()]
            nxt = body.get("cursor")
            if isinstance(nxt, bool) or not isinstance(nxt, (int, float)) or nxt <= cursor:
                raise SyncExportError("network")
            cursor = int(nxt)
        # More pages than the bound allows: the export does not wait for ever on a Worker that never ends.
        raise SyncExportError("network")

