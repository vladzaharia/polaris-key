"""The Python pack store (CONTENT §9–§10), a port of ``@polaris-key/node``'s ``packs/storage.ts``:
staging, the content-addressed store and the install-state file under one directory, by default
``<data dir>/packs`` (P1b-09's platform data directory, excluded from backups).

  <root>/state.json                         the install state, written by temp + rename
  <root>/state.json.torn                    a torn state document held aside (never overwritten)
  <root>/state.json.torn.list               the torn hold's snapshot of the store
  <root>/staging/<planId>/objects/<sha256>  objects being fetched (appended, resumable)
  <root>/staging/<planId>/out/              the payload being built (a tree's files, or
                                            ``payload.bin`` for a container)
  <root>/staging/<planId>/journal.json      the chunk strategy's run bitmap (P4-11)
  <root>/index/<sha256>                     a seed's chunk index as fetched, by ``chunks.sha256``
                                            (P4-11; written by temp + rename, re-verified on use)
  <root>/store/<packId>/<payloadSha256>/    a committed payload, never overwritten; its
                                            ``.pkey/files.json`` holds the files index

"Missing" is only ever ``FileNotFoundError`` or ``NotADirectoryError`` (ENOENT, ENOTDIR): any
other error raises, so "cannot read" is never mistaken for "not there" — the state read, the
quarantine check, ``verify``, ``installed``, ``commit`` and ``list`` all rely on that, and
``list`` never answers a partial listing. Files and directories are fsynced (``F_FULLFSYNC`` on
macOS, where plain ``fsync`` stops at the drive's write cache) before a rename can name them.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import shutil
import sys
from typing import Any, Dict, List, Optional, Tuple

from .engine import InstalledPayload, PackOutput
from .files import tree_digest
from .ports import READ_CHUNK, InstalledFile

__all__ = [
    "DirChunkIndexStore",
    "DirRunJournal",
    "DirPackStorage",
    "DirPackStateStore",
    "FileSource",
    "directory_tree_digest",
    "measure_file",
    "measure_tree",
    "walk_tree",
]

_CONTAINER_FILE = "payload.bin"
_JOURNAL_FILE = "journal.json"
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_INDEX_FILE = os.path.join(".pkey", "files.json")
#: What a file system answers when it cannot sync a directory at all.
_DIR_SYNC_UNSUPPORTED = {errno.EISDIR, errno.EPERM, errno.EBADF, errno.EINVAL}


def _is_missing(e: BaseException) -> bool:
    return isinstance(e, (FileNotFoundError, NotADirectoryError))


def _exists(path: str) -> bool:
    """False ONLY for ENOENT and ENOTDIR; anything else (EACCES, EIO) raises."""
    try:
        os.stat(path)
        return True
    except (FileNotFoundError, NotADirectoryError):
        return False


def _fsync_fd(fd: int) -> None:
    """``F_FULLFSYNC`` where the platform has it (macOS), else ``fsync``."""
    if sys.platform == "darwin":
        try:
            import fcntl

            fcntl.fcntl(fd, getattr(fcntl, "F_FULLFSYNC", 51))
            return
        except OSError:
            pass  # A file system without full sync: the plain fsync below.
    os.fsync(fd)


def _sync_dir(path: str) -> None:
    """fsync a directory, so a rename or a new entry in it survives a power loss. Windows cannot
    open a directory for syncing; there it is a no-op. A file system that cannot sync a
    directory says so with EISDIR/EPERM/EBADF/EINVAL; anything else (EIO) raises."""
    if sys.platform == "win32":
        return
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError as e:
        if e.errno in _DIR_SYNC_UNSUPPORTED:
            return
        raise
    try:
        _fsync_fd(fd)
    except OSError as e:
        if e.errno not in _DIR_SYNC_UNSUPPORTED:
            raise
    finally:
        os.close(fd)


def _write_durable(path: str, data: bytes, flags: int) -> None:
    fd = os.open(path, flags, 0o600)
    try:
        view = memoryview(data)
        while view:
            n = os.write(fd, view)
            view = view[n:]
        _fsync_fd(fd)
    finally:
        os.close(fd)


def _sync_tree(path: str) -> None:
    """fsync every file under ``path``, then each directory, depth first."""
    with os.scandir(path) as it:
        entries = list(it)
    for e in entries:
        if e.is_dir(follow_symlinks=False):
            _sync_tree(e.path)
        elif e.is_file(follow_symlinks=False):
            fd = os.open(e.path, os.O_RDONLY)
            try:
                _fsync_fd(fd)
            finally:
                os.close(fd)
    _sync_dir(path)


def _rm(path: str) -> None:
    """``rm -rf`` that ignores only "not there"."""
    try:
        st = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return
    import stat as _stat

    if _stat.S_ISDIR(st.st_mode):
        shutil.rmtree(path)
    else:
        try:
            os.remove(path)
        except (FileNotFoundError, NotADirectoryError):
            pass


def _scandir_or_empty(path: str) -> List[os.DirEntry]:  # type: ignore[type-arg]
    """A directory's entries, or none ONLY when it does not exist."""
    try:
        with os.scandir(path) as it:
            return list(it)
    except (FileNotFoundError, NotADirectoryError):
        return []


class FileSource:
    """A file on disk as a ``ByteSource``."""

    def __init__(self, path: str, size: int) -> None:
        self._path = path
        self._size = size

    @property
    def size(self) -> int:
        return self._size

    def read(self, offset: int, length: int) -> bytes:
        n = max(0, min(length, self._size - offset))
        if n == 0:
            return b""
        with open(self._path, "rb") as f:
            f.seek(offset)
            return f.read(n)


class _RangeSource:
    def __init__(self, whole: FileSource, offset: int, size: int) -> None:
        self._whole = whole
        self._offset = offset
        self._size = size

    @property
    def size(self) -> int:
        return self._size

    def read(self, at: int, n: int) -> bytes:
        return self._whole.read(self._offset + at, max(0, min(n, self._size - at)))


def walk_tree(root: str) -> List[str]:
    """Every regular file under ``root``, as ``/``-separated relative paths, skipping
    ``.pkey/``. Symlinks and other entries are never part of a tree payload."""
    out: List[str] = []

    def walk(at: str, rel: str) -> None:
        with os.scandir(at) as it:
            entries = list(it)
        for e in entries:
            r = f"{rel}/{e.name}" if rel else e.name
            if r == ".pkey" or r.startswith(".pkey/"):
                continue
            if e.is_dir(follow_symlinks=False):
                walk(e.path, r)
            elif e.is_file(follow_symlinks=False):
                out.append(r)

    walk(root, "")
    return out


def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(READ_CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def measure_tree(root: str) -> List[Dict[str, Any]]:
    """A directory's files with their sizes and SHA-256 (the embedded and reload checks)."""
    files = []
    for path in walk_tree(root):
        absolute = os.path.join(root, *path.split("/"))
        files.append({"path": path, "size": os.stat(absolute).st_size, "sha256": _hash_file(absolute)})
    return files


def directory_tree_digest(root: str) -> str:
    """``tree_digest`` of a directory, minus ``.pkey/`` (plans/P4-01.md §2.6)."""
    return tree_digest(measure_tree(root))


def measure_file(path: str) -> Dict[str, Any]:
    """A single file's SHA-256 and size."""
    return {"sha256": _hash_file(path), "size": os.stat(path).st_size}


class DirPackStateStore:
    """The atomic-replace state file, with a torn document's quarantine at ``state.json.torn``
    and the hold's snapshot at ``state.json.torn.list``. ``name`` gives the same store under a
    second name: the sibling ``revocations.json`` (plans/P4-13.md §2.5)."""

    def __init__(self, root: str, name: str = "state.json") -> None:
        self._root = root
        self.path = os.path.join(root, name)
        self.torn_path = self.path + ".torn"
        self.hold_list_path = self.path + ".torn.list"

    def read(self) -> Optional[str]:
        try:
            with open(self.path, "rb") as f:
                data = f.read()
        except (FileNotFoundError, NotADirectoryError):
            return None  # Only a missing file is "no state"; anything else raises.
        return data.decode("utf-8", errors="replace")

    def replace(self, text: str) -> None:
        os.makedirs(self._root, mode=0o700, exist_ok=True)
        tmp = f"{self.path}.{os.getpid()}.tmp"
        _write_durable(tmp, text.encode("utf-8"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        os.replace(tmp, self.path)
        _sync_dir(self._root)

    def quarantine(self, text: str) -> None:
        if _exists(self.torn_path):
            return
        _write_durable(
            self.torn_path, text.encode("utf-8", "replace"), os.O_WRONLY | os.O_CREAT | os.O_EXCL
        )
        _sync_dir(self._root)

    def quarantined(self) -> bool:
        return _exists(self.torn_path)

    def clear_quarantine(self) -> None:
        _rm(self.hold_list_path)
        _rm(self.torn_path)

    def read_hold_list(self) -> Optional[str]:
        try:
            with open(self.hold_list_path, "rb") as f:
                return f.read().decode("utf-8", errors="replace")
        except (FileNotFoundError, NotADirectoryError):
            return None

    def write_hold_list(self, text: str) -> None:
        if _exists(self.hold_list_path):
            return
        tmp = f"{self.hold_list_path}.{os.getpid()}.tmp"
        _write_durable(tmp, text.encode("utf-8"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        os.replace(tmp, self.hold_list_path)
        _sync_dir(self._root)


class _StagedFile:
    def __init__(self, path: str) -> None:
        self._path = path

    def size(self) -> int:
        try:
            return os.stat(self._path).st_size
        except (FileNotFoundError, NotADirectoryError):
            return 0

    def source(self) -> FileSource:
        return FileSource(self._path, self.size())

    def append(self, data: bytes) -> None:
        os.makedirs(os.path.dirname(self._path), exist_ok=True)
        with open(self._path, "ab") as f:
            f.write(data)

    def reset(self) -> None:
        try:
            os.remove(self._path)
        except (FileNotFoundError, NotADirectoryError):
            pass


class _TreeOut:
    def __init__(self, root: str, inside: Any) -> None:
        self._root = root
        self._inside = inside

    def write_file(self, path: str, data: bytes) -> None:
        target = self._inside(self._root, *path.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as f:
            f.write(data)


class _ContainerOut:
    def __init__(self, path: str) -> None:
        self._path = path

    def write(self, offset: int, data: bytes) -> None:
        with open(self._path, "r+b") as f:
            f.seek(offset)
            f.write(data)

    def read(self, offset: int, length: int) -> bytes:
        """What was written at ``offset`` (fewer bytes past the end)."""
        if length <= 0:
            return b""
        with open(self._path, "rb") as f:
            f.seek(offset)
            return f.read(length)


class DirChunkIndexStore:
    """P4-11's seed-index store, ``<root>/index/<sha256>``: each seed's chunk index object as
    fetched (possibly zstd), by ``chunks.sha256``. Written by temp + rename; the engine re-verifies
    every index against its record each time it uses one, so nothing here is trusted."""

    def __init__(self, root: str) -> None:
        self.dir = os.path.join(root, "index")

    def _path(self, sha256: str) -> str:
        if not isinstance(sha256, str) or _SHA256_RE.fullmatch(sha256) is None:
            raise ValueError("a seed index is named by a lowercase SHA-256")
        return os.path.join(self.dir, sha256)

    def get(self, sha256: str) -> Optional[bytes]:
        try:
            with open(self._path(sha256), "rb") as f:
                return f.read()
        except (FileNotFoundError, NotADirectoryError):
            return None

    def put(self, sha256: str, data: bytes) -> None:
        target = self._path(sha256)
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        tmp = f"{target}.{os.getpid()}.tmp"
        _write_durable(tmp, bytes(data), os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        os.replace(tmp, target)
        _sync_dir(self.dir)

    def list(self) -> List[str]:
        return sorted(
            e.name
            for e in _scandir_or_empty(self.dir)
            if e.is_file(follow_symlinks=False) and _SHA256_RE.fullmatch(e.name) is not None
        )

    def remove(self, sha256: str) -> None:
        _rm(self._path(sha256))


class DirRunJournal:
    """P4-11's run journal, ``staging/<planId>/journal.json`` (temp + rename), removed with the
    plan's staging."""

    def __init__(self, storage: "DirPackStorage") -> None:
        self._storage = storage

    def _path(self, plan_id: str) -> str:
        return self._storage._inside(self._storage.staging_dir, plan_id, _JOURNAL_FILE)

    def read(self, plan_id: str) -> Optional[str]:
        try:
            with open(self._path(plan_id), "rb") as f:
                return f.read().decode("utf-8", errors="replace")
        except (FileNotFoundError, NotADirectoryError):
            return None

    def write(self, plan_id: str, text: str) -> None:
        target = self._path(plan_id)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = f"{target}.{os.getpid()}.tmp"
        _write_durable(tmp, text.encode("utf-8"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        os.replace(tmp, target)


class DirPackStorage:
    """The ``PackStorage`` over a directory (and its :meth:`state_store`)."""

    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)
        self.staging_dir = os.path.join(self.root, "staging")
        self.store_dir = os.path.join(self.root, "store")
        #: Measured trees of embedded locations (verified once per process).
        self._embedded_files: Dict[str, List[InstalledFile]] = {}
        #: P4-11: the seed-index store and the chunk strategy's run journal.
        self.chunk_indexes = DirChunkIndexStore(self.root)
        self.run_journal = DirRunJournal(self)

    def state_store(self) -> DirPackStateStore:
        return DirPackStateStore(self.root)

    def revocation_store(self) -> DirPackStateStore:
        """The sibling ``revocations.json`` (plans/P4-13.md §2.5): the same atomic replace and
        quarantine (``revocations.json.torn``) under a second name. The engine never creates it
        empty."""
        return DirPackStateStore(self.root, "revocations.json")

    @staticmethod
    def _inside(root: str, *parts: str) -> str:
        """``parts`` joined under ``root``, refusing anything that would land outside it."""
        p = os.path.abspath(os.path.join(root, *parts))
        if p != root and not p.startswith(root + os.sep):
            raise ValueError(f"pack path escapes its root: {'/'.join(parts)}")
        return p

    def staged_object(self, plan_id: str, sha256: str) -> _StagedFile:
        return _StagedFile(self._inside(self.staging_dir, plan_id, "objects", sha256))

    def output(self, plan_id: str, layout: str, resume: bool = False) -> PackOutput:
        """The plan's output area, emptied, except that with ``resume`` (P4-11's chunk strategy)
        a container keeps the ``payload.bin`` an earlier attempt of the same plan wrote."""
        out = self._inside(self.staging_dir, plan_id, "out")
        target = os.path.join(out, _CONTAINER_FILE)
        if resume and layout != "tree" and _exists(target):
            c = _ContainerOut(target)
            return PackOutput(sink=c, read=c.read)
        _rm(out)
        os.makedirs(out, exist_ok=True)
        if layout == "tree":
            return PackOutput(tree=_TreeOut(out, self._inside))
        with open(target, "wb"):
            pass
        c = _ContainerOut(target)
        return PackOutput(sink=c, read=c.read)

    def commit(
        self,
        plan_id: str,
        pack_id: str,
        payload_sha256: str,
        layout: str,
        index: Optional[Dict[str, Any]],
    ) -> str:
        out = self._inside(self.staging_dir, plan_id, "out")
        location = self._inside(self.store_dir, pack_id, payload_sha256)
        if index is not None:
            os.makedirs(os.path.join(out, ".pkey"), exist_ok=True)
            with open(os.path.join(out, _INDEX_FILE), "w", encoding="utf-8") as f:
                f.write(json.dumps(index, separators=(",", ":"), ensure_ascii=False))
        if _exists(location):
            # The same payload is already stored (a rollback target, say): keep that copy.
            _rm(out)
            return location
        # The payload is durable before the pointer can name it.
        _sync_tree(out)
        os.makedirs(os.path.dirname(location), exist_ok=True)
        os.rename(out, location)
        _sync_dir(os.path.dirname(location))
        return location

    @staticmethod
    def _payload_file(install: Dict[str, Any]) -> str:
        """``payload.bin`` in the store, or the embedded file itself."""
        if install.get("embedded") is True:
            return install["location"]
        return os.path.join(install["location"], _CONTAINER_FILE)

    def installed(self, install: Dict[str, Any]) -> Optional[InstalledPayload]:
        loc = install["location"]
        if not _exists(loc):
            return None
        if install["layout"] == "tree":
            files = self._tree_files(loc, install.get("embedded") is True)
            return None if files is None else InstalledPayload(payload=None, files=files)
        target = self._payload_file(install)
        if not _exists(target):
            return None
        whole = FileSource(target, os.stat(target).st_size)
        index = self._read_index(loc)
        files2: Optional[List[InstalledFile]] = None
        if index is not None:
            files2 = [
                InstalledFile(f["path"], f["sha256"], f["size"], _RangeSource(whole, f.get("offset", 0), f["size"]))
                for f in index["files"]
            ]
        return InstalledPayload(payload=whole, files=files2)

    def _read_index(self, location: str) -> Optional[Dict[str, Any]]:
        try:
            with open(os.path.join(location, _INDEX_FILE), "rb") as f:
                data = f.read()
        except (FileNotFoundError, NotADirectoryError):
            return None
        try:
            doc = json.loads(data.decode("utf-8"))
        except Exception:
            return None  # Not JSON: no kept index.
        return doc if isinstance(doc, dict) else None

    def _tree_files(self, location: str, embedded: bool) -> Optional[List[InstalledFile]]:
        index = None if embedded else self._read_index(location)
        if index is not None:
            entries = index["files"]
        else:
            cached = self._embedded_files.get(location)
            if cached is not None:
                return cached
            entries = measure_tree(location)
        files = [
            InstalledFile(
                f["path"],
                f["sha256"],
                f["size"],
                FileSource(os.path.join(location, *f["path"].split("/")), f["size"]),
            )
            for f in entries
        ]
        if index is None:
            self._embedded_files[location] = files
        return files

    def verify(self, install: Dict[str, Any]) -> bool:
        """False when the payload is missing or its digest differs; raises when it cannot be
        read (the engine then neither uses nor collects it this load)."""
        if install["layout"] == "tree":
            if not _exists(install["location"]):
                return False
            return directory_tree_digest(install["location"]) == install["payloadSha256"]
        target = self._payload_file(install)
        if not _exists(target):
            return False
        m = measure_file(target)
        return m["sha256"] == install["payloadSha256"] and m["size"] == install["payloadSize"]

    def remove(self, location: str) -> None:
        """Only ever inside the store: an embedded payload lives in the app's resources."""
        absolute = os.path.abspath(location)
        if not absolute.startswith(self.store_dir + os.sep):
            return
        _rm(absolute)

    def remove_staging(self, plan_id: str) -> None:
        _rm(self._inside(self.staging_dir, plan_id))

    def list(self) -> Tuple[List[str], List[str]]:
        """Every stored location and staging plan. Only a missing directory is "nothing
        there"; an unreadable one raises, so the engine never collects from a partial listing."""
        locations: List[str] = []
        plans: List[str] = []
        for pack in _scandir_or_empty(self.store_dir):
            if pack.is_dir(follow_symlinks=False):
                for v in _scandir_or_empty(pack.path):
                    if v.is_dir(follow_symlinks=False):
                        locations.append(os.path.join(self.store_dir, pack.name, v.name))
        for p in _scandir_or_empty(self.staging_dir):
            if p.is_dir(follow_symlinks=False):
                plans.append(p.name)
        return locations, plans

    def free_disk(self) -> int:
        os.makedirs(self.root, mode=0o700, exist_ok=True)
        return shutil.disk_usage(self.root).free
