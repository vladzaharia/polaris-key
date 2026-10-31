"""The Cloud Sync transfer journal (U-22.10): what an interrupted file transfer needs to carry on after
a kill. A port of ``packages/client-core/src/sync/transferJournal.ts`` and of
``packages/sdk-node/src/cloudSync/journal.ts``.

It is host-local state, never a wire shape, so it has no corpus family; the unit tests prove it. A
record is versioned so a later layout can be told from this one: a reader refuses a version it does not
know and leaves the record alone, rather than guess at it or delete it. Only uploads are journaled: a
download resumes from the chunk cache (``chunks``) or restarts.

::

    {"v": 1, "id", "kind", "collection", "record", "uploadId", "mode", "partBytes", "done": [...],
     "sha256", "size", "expiresAt", "state"}

``id``        the caller's stable transfer id (the key of the record)
``kind``      ``"upload"``
``record``    the wire record id the file belongs to (blinded in E2E mode)
``mode``      ``"single"``, ``"multipart"`` or ``"chunks"``, as ``begin`` answered
``partBytes`` the size of every part but the last; ``None`` for ``single`` and ``chunks``
``done``      part numbers the server holds, ascending (``[1]`` once a ``single`` body is in); always
              empty for ``chunks``, whose progress the server's plan answers
``sha256``/``size`` the stored bytes (ciphertext in E2E mode), as begun. For ``chunks``, ``size`` is the
              file's stored size and ``sha256`` the stored manifest's; a sealed manifest is different on
              every run, so a ``chunks`` record is only ever used to abort its upload before the next
              one begins
``expiresAt`` Unix seconds, from ``begin``
``state``     ``"uploading"`` until every part is in, then ``"finalizing"``; a finished transfer's record
              is deleted

On disk (:class:`FileJournal`) a record is one JSON file in ``<state_dir>/cloud-sync-transfers/`` named by
the SHA-256 of the transfer id, never by the id (a save id may hold dots, and the id is the caller's
text, so no id can climb out of the directory or collide with another file). The directory is 0700 and a
file 0600, written atomically like the state file beside it. A record holds ids, counts, hashes and times:
no key, no plaintext, no bearer token. The directory is purged with the person (:meth:`FileJournal.clear`).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
from typing import Any, Dict, List, Optional, Protocol

from ..constants_generated import SYNC_FILE_MAX_BYTES, SYNC_MAX_PARTS
from .state import write_json_atomic

__all__ = [
    "TRANSFER_JOURNAL_VERSION",
    "CLOUD_SYNC_TRANSFERS_DIR",
    "TransferJournalError",
    "JournalStore",
    "MemoryJournal",
    "FileJournal",
    "journal_file_name",
    "parse_journal_record",
]

TRANSFER_JOURNAL_VERSION = 1
CLOUD_SYNC_TRANSFERS_DIR = "cloud-sync-transfers"

JournalRecord = Dict[str, Any]

_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_FILE_NAME = re.compile(r"[0-9a-f]{64}\.json\Z")


class JournalStore(Protocol):
    """Where records live. The host picks the medium (a file at 0600, a keychain-adjacent store); a value
    is plain JSON. ``get`` returns what was stored, unchecked: the engine validates the version."""

    def get(self, id: str) -> Optional[Any]: ...

    def put(self, id: str, record: JournalRecord) -> None: ...

    def delete(self, id: str) -> None: ...

    def list(self) -> List[str]:
        """The ids held."""
        ...


class TransferJournalError(Exception):
    """``reason`` is ``version`` for a ``v`` this build does not know, ``shape`` for anything else wrong."""

    def __init__(self, reason: str, found: Any = None) -> None:
        super().__init__("transfer journal: " + reason)
        self.reason = reason
        self.found = found


def _is_text(x: Any) -> bool:
    return isinstance(x, str) and x != ""


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def parse_journal_record(raw: Any) -> JournalRecord:
    """The record, or a :class:`TransferJournalError`: ``version`` for a ``v`` this build does not know,
    ``shape`` for anything else wrong. The result is a fresh dict; the input is not touched."""
    if not isinstance(raw, dict):
        raise TransferJournalError("shape")
    v = raw.get("v")
    if not _is_int(v) or v != TRANSFER_JOURNAL_VERSION:
        raise TransferJournalError("version", v)
    id_, kind, collection, record = raw.get("id"), raw.get("kind"), raw.get("collection"), raw.get("record")
    upload_id, mode, part_bytes = raw.get("uploadId"), raw.get("mode"), raw.get("partBytes")
    done, sha256, size = raw.get("done"), raw.get("sha256"), raw.get("size")
    expires_at, state = raw.get("expiresAt"), raw.get("state")
    part_bytes_n = part_bytes if isinstance(part_bytes, int) and not isinstance(part_bytes, bool) else 0
    size_n = size if isinstance(size, int) and not isinstance(size, bool) else 0
    if (
        not _is_text(id_)
        or kind != "upload"
        or not _is_text(collection)
        or not _is_text(record)
        or not _is_text(upload_id)
        or mode not in ("single", "multipart", "chunks")
        or not isinstance(sha256, str)
        or _HEX64.match(sha256) is None
        or not _is_int(size)
        or size_n < 0
        or size_n > SYNC_FILE_MAX_BYTES
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, (int, float))
        or expires_at != expires_at
        or expires_at in (float("inf"), float("-inf"))
        or state not in ("uploading", "finalizing")
        or not isinstance(done, list)
    ):
        raise TransferJournalError("shape")
    parts = 1
    if mode == "multipart":
        if not _is_int(part_bytes) or part_bytes_n < 1:
            raise TransferJournalError("shape")
        parts = max(1, -(-size_n // part_bytes_n))
        if parts > SYNC_MAX_PARTS:
            raise TransferJournalError("shape")
    elif part_bytes is not None:
        raise TransferJournalError("shape")
    if mode == "chunks" and len(done) != 0:
        raise TransferJournalError("shape")
    last = 0
    for n in done:
        if not _is_int(n) or n <= last or n > parts:
            raise TransferJournalError("shape")
        last = n
    return {
        "v": TRANSFER_JOURNAL_VERSION,
        "id": id_,
        "kind": kind,
        "collection": collection,
        "record": record,
        "uploadId": upload_id,
        "mode": mode,
        "partBytes": part_bytes if mode == "multipart" else None,
        "done": list(done),
        "sha256": sha256,
        "size": size,
        "expiresAt": expires_at,
        "state": state,
    }


class MemoryJournal:
    """An in-memory journal: tests, and a host with nothing durable to offer (a transfer then does not
    survive a kill). A record is stored as JSON text, so a caller cannot change what was stored."""

    def __init__(self) -> None:
        self._map: Dict[str, str] = {}
        self._lock = threading.Lock()

    def get(self, id: str) -> Optional[Any]:
        with self._lock:
            s = self._map.get(id)
        return None if s is None else json.loads(s)

    def put(self, id: str, record: JournalRecord) -> None:
        text = json.dumps(record, separators=(",", ":"), allow_nan=False)
        with self._lock:
            self._map[id] = text

    def delete(self, id: str) -> None:
        with self._lock:
            self._map.pop(id, None)

    def list(self) -> List[str]:
        with self._lock:
            return list(self._map)


def journal_file_name(id: str) -> str:
    """The file a transfer id lives in: the lowercase hex SHA-256 of the id, ``.json``."""
    return hashlib.sha256(id.encode("utf-8")).hexdigest() + ".json"


class FileJournal:
    """The journal on disk. ``state_dir`` is the host's state directory; the journal sits in its own
    folder beside the state file."""

    def __init__(self, state_dir: str) -> None:
        self.dir = os.path.join(state_dir, CLOUD_SYNC_TRANSFERS_DIR)
        #: Writes and deletes run one at a time, so a late write never lands after a delete.
        self._lock = threading.Lock()

    def _path(self, id: str) -> str:
        return os.path.join(self.dir, journal_file_name(id))

    @staticmethod
    def _read(path: str) -> Optional[Any]:
        """A missing file is ``None``. A file that is not JSON is not any build's record (writes are
        atomic), so it also reads as ``None`` and is overwritten by the next write. A record of another
        version or shape is returned as found: the engine refuses it and leaves it alone."""
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError, RecursionError):
            return None

    def get(self, id: str) -> Optional[Any]:
        return self._read(self._path(id))

    def put(self, id: str, record: JournalRecord) -> None:
        with self._lock:
            write_json_atomic(self._path(id), record)

    def delete(self, id: str) -> None:
        with self._lock:
            try:
                os.unlink(self._path(id))
            except FileNotFoundError:
                pass

    def list(self) -> List[str]:
        """The ids of the records held, keeping only a record whose file name is the hash of its own id."""
        try:
            names = os.listdir(self.dir)
        except OSError:
            return []
        ids: List[str] = []
        for name in names:
            if _FILE_NAME.match(name) is None:
                continue
            raw = self._read(os.path.join(self.dir, name))
            rid = raw.get("id") if isinstance(raw, dict) else None
            if isinstance(rid, str) and journal_file_name(rid) == name:
                ids.append(rid)
        return ids

    def clear(self) -> None:
        """Remove every record: the purge that goes with the person (sign-out, ``forget``)."""
        with self._lock:
            shutil.rmtree(self.dir, ignore_errors=True)
