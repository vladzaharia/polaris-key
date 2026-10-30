"""The Cloud Sync chunk cache (U-22.10, plan D-9): a port of ``packages/client-core/src/sync/chunkCache.ts``
and of ``packages/sdk-node/src/cloudSync/chunkCache.ts``.

It holds chunk objects as stored (ciphertext in E2E mode, never plaintext), keyed by the 64-character
lowercase hex chunk id, so a download fetches only the chunks the device lacks. Hosts name entries from
the id alone, never from server text: ``get``, ``put`` and ``delete`` refuse anything but an id that
matches ``SYNC_CHUNK_ID_PATTERN`` (:func:`is_chunk_cache_id`) with ``ValueError``.

A cache is best effort: the engine treats a failing ``get`` as a miss and a failing ``put`` as nothing,
and it opens every cached object again before use, so a damaged entry costs a fetch. The host bounds it
with an LRU of :func:`chunk_cache_budget` bytes per (product, subject, collection), keeps it out of OS
backup, and purges it with the person (sign-out, ``forget``).

:class:`FileChunkCache` keeps one file per object in a directory of its own (0700, files 0600, written
atomically). :func:`chunk_cache_dir` hashes the subject and the collection into the path, so one
person's chunks never serve another's and a collection name cannot climb out of the cache root. A name in
the directory that is not a chunk id is ignored (a stray temporary file is removed on the first scan). An
object over the budget is not kept. Python has no portable way to keep a file out of an OS backup: put the
state directory where the platform does not back up, or accept that the cache holds only ciphertext in E2E
mode.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import threading
from collections import OrderedDict
from typing import Optional, Protocol

from .state import write_bytes_atomic
from .transfer_codec import SERVER_CHUNK_MAX_STORED_BYTES

__all__ = [
    "CLOUD_SYNC_CHUNKS_DIR",
    "CHUNK_CACHE_MIN_BYTES",
    "ChunkCache",
    "FileChunkCache",
    "MemoryChunkCache",
    "chunk_cache_budget",
    "chunk_cache_dir",
    "is_chunk_cache_id",
]

CLOUD_SYNC_CHUNKS_DIR = "cloud-sync-chunks"
#: The least a cache is allowed to hold (D-9).
CHUNK_CACHE_MIN_BYTES = 256 * 1024 * 1024

_ID = re.compile(r"[0-9a-f]{64}\Z")


class ChunkCache(Protocol):
    def get(self, id: str) -> Optional[bytes]: ...

    def put(self, id: str, obj: bytes) -> None: ...

    def delete(self, id: str) -> None: ...

    def clear(self) -> None:
        """Drop every entry: the purge that goes with the person."""
        ...


def chunk_cache_budget(largest_save_bytes: int) -> int:
    """D-9: at most ``max(256 MiB, twice the largest save)``."""
    if isinstance(largest_save_bytes, bool) or not isinstance(largest_save_bytes, int) or largest_save_bytes < 0:
        raise ValueError("largest save")
    return max(CHUNK_CACHE_MIN_BYTES, 2 * largest_save_bytes)


def is_chunk_cache_id(id: str) -> bool:
    """True for a chunk id that is safe to turn into a file or key name."""
    return isinstance(id, str) and _ID.match(id) is not None


def _check(id: str) -> None:
    if not is_chunk_cache_id(id):
        raise ValueError("chunk cache id")


class MemoryChunkCache:
    """An in-memory LRU: tests, and a host with no durable store (the cache then lasts one session)."""

    def __init__(self, max_bytes: int = CHUNK_CACHE_MIN_BYTES) -> None:
        self._max = max_bytes
        self._map: "OrderedDict[str, bytes]" = OrderedDict()
        self._total = 0
        self._lock = threading.Lock()

    def get(self, id: str) -> Optional[bytes]:
        _check(id)
        with self._lock:
            hit = self._map.get(id)
            if hit is None:
                return None
            self._map.move_to_end(id)  # most recently used goes last
            return bytes(hit)

    def put(self, id: str, obj: bytes) -> None:
        _check(id)
        with self._lock:
            had = self._map.pop(id, None)
            if had is not None:
                self._total -= len(had)
            if len(obj) > self._max:
                return
            self._map[id] = bytes(obj)
            self._total += len(obj)
            while self._total > self._max and self._map:
                _, v = self._map.popitem(last=False)
                self._total -= len(v)

    def delete(self, id: str) -> None:
        _check(id)
        with self._lock:
            had = self._map.pop(id, None)
            if had is not None:
                self._total -= len(had)

    def clear(self) -> None:
        with self._lock:
            self._map.clear()
            self._total = 0


def chunk_cache_dir(state_dir: str, subject: str, collection: str) -> str:
    """``<state_dir>/cloud-sync-chunks/<hash(subject)>/<hash(collection)>``."""

    def h(s: str) -> str:
        return hashlib.sha256(s.encode("utf-8")).hexdigest()

    return os.path.join(state_dir, CLOUD_SYNC_CHUNKS_DIR, h(subject), h(collection))


class FileChunkCache:
    """The cache on disk: an LRU of at most ``max_bytes``, one file per object named by its chunk id."""

    def __init__(self, directory: str, max_bytes: int = CHUNK_CACHE_MIN_BYTES) -> None:
        self.dir = directory
        self._max = max_bytes
        #: id -> size, oldest first. ``None`` until the directory has been scanned.
        self._index: "Optional[OrderedDict[str, int]]" = None
        self._total = 0
        self._lock = threading.RLock()

    def _path(self, id: str) -> str:
        return os.path.join(self.dir, id)

    def _load(self) -> "OrderedDict[str, int]":
        """The directory's entries, oldest first (by modification time), scanned once."""
        if self._index is not None:
            return self._index
        found = []
        try:
            names = os.listdir(self.dir)
        except OSError:
            names = []
        for name in names:
            path = os.path.join(self.dir, name)
            if not is_chunk_cache_id(name):
                # A temporary file a crash left behind, or anything else we did not write.
                if name.endswith(".tmp"):
                    _unlink(path)
                continue
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if not os.path.isfile(path) or os.path.islink(path) or st.st_size > SERVER_CHUNK_MAX_STORED_BYTES:
                _unlink(path)
                continue
            found.append((st.st_mtime, name, st.st_size))
        found.sort()
        self._index = OrderedDict((name, size) for _, name, size in found)
        self._total = sum(size for _, _, size in found)
        return self._index

    def _drop(self, id: str) -> None:
        index = self._index
        if index is not None:
            size = index.pop(id, None)
            if size is not None:
                self._total -= size
        _unlink(self._path(id))

    def get(self, id: str) -> Optional[bytes]:
        _check(id)
        with self._lock:
            index = self._load()
            size = index.get(id)
            if size is None:
                return None
            try:
                with open(self._path(id), "rb") as f:
                    data = f.read(SERVER_CHUNK_MAX_STORED_BYTES + 1)
                if len(data) != size:
                    raise OSError("size")
                # Newest goes last, here and on disk (so a relaunch keeps the order).
                index.move_to_end(id)
                try:
                    os.utime(self._path(id))
                except OSError:
                    pass
                return data
            except OSError:
                self._drop(id)
                return None

    def put(self, id: str, obj: bytes) -> None:
        _check(id)
        with self._lock:
            index = self._load()
            self._drop(id)
            if len(obj) > self._max or len(obj) > SERVER_CHUNK_MAX_STORED_BYTES:
                return
            write_bytes_atomic(self._path(id), bytes(obj))
            index[id] = len(obj)
            self._total += len(obj)
            for oldest in list(index):
                if self._total <= self._max:
                    break
                if oldest == id:
                    continue
                _unlink(self._path(oldest))
                self._total -= index.pop(oldest)

    def delete(self, id: str) -> None:
        _check(id)
        with self._lock:
            self._load()
            self._drop(id)

    def clear(self) -> None:
        with self._lock:
            shutil.rmtree(self.dir, ignore_errors=True)
            self._index = OrderedDict()
            self._total = 0


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass
