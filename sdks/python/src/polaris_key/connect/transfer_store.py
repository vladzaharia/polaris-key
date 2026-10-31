"""The partial-file store for Direct Transfer (WIRE-CONTRACT-V5 §15.11, plan D-19). Mirrors the contract of
the machine's ``partial`` effects; nothing here decides, it performs.

Layout, under ``<state>/transfers/``:

- ``<ref>``: one file per kept partial, named only by the derived partial path (64 lower-case hex
  characters from the peer key, the transfer id and the hash). A transfer's ``name`` never reaches a path.
- ``index.json``: what the store needs to offer a resume again: per ref the peer (SHA-256 of the peer key,
  never the key), the id, the hash, the size, the chunk and the time of the last write.

The directory is owner-only (0700) and the files are 0600 where the platform has modes. A partial lives
24 hours after its last write; at most 8 are kept per peer (the machine evicts the oldest). Delivery is
temp file plus rename into a destination the host named; the SDK never picks it.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import time
from typing import Any, BinaryIO, Callable, Dict, List, Optional

from ..core.peer_xfer import XFER_PARTIAL_SECONDS

__all__ = ["FREE_RESERVE_BYTES", "PartialStore", "peer_tag"]

#: Bytes of free space the store leaves alone when it answers the quota check.
FREE_RESERVE_BYTES = 64 * 1024 * 1024
_REF = re.compile(r"[0-9a-f]{64}\Z")
_INDEX = "index.json"
_BLOCK = 1024 * 1024

Json = Dict[str, Any]


def peer_tag(peer_key: bytes) -> str:
    """The index's name for a peer: a hash, so the file holds no key."""
    return hashlib.sha256(b"pkey-xfer/1 peer\x00" + bytes(peer_key)).hexdigest()


def _chmod(path: str, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass  # a platform with no modes


class PartialStore:
    """One directory of partial files. Thread-safe. ``clock`` is epoch seconds."""

    def __init__(self, directory: str, clock: Callable[[], float] = time.time) -> None:
        self._dir = directory
        self._clock = clock
        self._lock = threading.RLock()
        self._open: Dict[str, BinaryIO] = {}
        self._idx: Dict[str, Json] = {}
        self._loaded = False

    # -- the directory ------------------------------------------------------------------------------

    @property
    def directory(self) -> str:
        return self._dir

    def _ensure(self) -> None:
        with self._lock:
            if self._loaded:
                return
            os.makedirs(self._dir, mode=0o700, exist_ok=True)
            _chmod(self._dir, 0o700)
            try:
                with open(os.path.join(self._dir, _INDEX), "rb") as f:
                    d = json.loads(f.read().decode("utf-8"))
                ents = d.get("entries") if isinstance(d, dict) else None
                if isinstance(ents, dict):
                    self._idx = {k: v for k, v in ents.items() if _REF.match(k) and _entry_ok(v)}
            except (OSError, ValueError):
                self._idx = {}
            self._loaded = True
            self._sweep_locked()

    def _path(self, ref: str) -> str:
        if _REF.match(ref) is None:
            raise ValueError("partial ref")
        return os.path.join(self._dir, ref)

    def _flush_index(self) -> None:
        body = json.dumps({"v": 1, "entries": self._idx}, separators=(",", ":")).encode("utf-8")
        fd, tmp = tempfile.mkstemp(prefix=".index-", dir=self._dir)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(body)
                f.flush()
                os.fsync(f.fileno())
            _chmod(tmp, 0o600)
            os.replace(tmp, os.path.join(self._dir, _INDEX))
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # -- what the machine is told -------------------------------------------------------------------

    def partials(self, peer_key: bytes, held: Optional[set] = None) -> List[Json]:  # type: ignore[type-arg]
        """The kept partials of one peer key, as the machine reads them (``writtenAt`` in epoch seconds)."""
        with self._lock:
            self._ensure()
            self._sweep_locked()
            tag = peer_tag(peer_key)
            out: List[Json] = []
            for ref, e in self._idx.items():
                if e["peer"] != tag:
                    continue
                try:
                    size = os.stat(self._path(ref)).st_size
                except OSError:
                    continue
                p: Json = {
                    "ref": ref,
                    "id": e["id"],
                    "sha256": e["sha256"],
                    "size": e["size"],
                    "chunk": e["chunk"],
                    "bytes": size,
                    "writtenAt": e["at"],
                }
                if held is not None and ref in held:
                    p["held"] = True
                out.append(p)
            return out

    def rehash(self, ref: str, offset: int) -> Any:
        """A SHA-256 object fed with the first ``offset`` bytes of a kept partial, read again now."""
        h = hashlib.sha256()
        with self._lock:
            f = self._open.get(ref)
            if f is not None:
                f.flush()
        left = offset
        with open(self._path(ref), "rb") as r:
            while left > 0:
                b = r.read(min(_BLOCK, left))
                if not b:
                    raise OSError(errno.EIO, "partial shorter than its record")
                h.update(b)
                left -= len(b)
        return h

    def free(self) -> int:
        """Bytes the store can take, after the reserve."""
        with self._lock:
            self._ensure()
        return max(0, shutil.disk_usage(self._dir).free - FREE_RESERVE_BYTES)

    # -- effects ------------------------------------------------------------------------------------

    def apply(self, peer_key: bytes, effect: Json, meta: Optional[Json] = None) -> None:
        """One effect of the machine on the partial files, or a write into one. ``meta`` carries what a
        ``create`` needs to remember: ``id``, ``sha256``, ``size``, ``chunk``."""
        with self._lock:
            self._ensure()
            if "write" in effect:
                f = self._handle(effect["write"])
                f.seek(effect["offset"])
                f.write(effect["data"])
                e = self._idx.get(effect["write"])
                if e is not None:
                    e["at"] = self._clock()
                return
            if "create" in effect:
                ref = effect["create"]
                if meta is None:
                    raise ValueError("create needs meta")
                self._close(ref)
                fd = os.open(self._path(ref), os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
                os.close(fd)
                _chmod(self._path(ref), 0o600)
                self._idx[ref] = {
                    "peer": peer_tag(peer_key),
                    "id": meta["id"],
                    "sha256": meta["sha256"],
                    "size": meta["size"],
                    "chunk": meta["chunk"],
                    "at": self._clock(),
                }
                self._flush_index()
            elif "truncate" in effect:
                ref = effect["truncate"]
                self._close(ref)
                with open(self._path(ref), "r+b") as f:
                    f.truncate(effect["to"])
                e = self._idx.get(ref)
                if e is not None:
                    e["at"] = self._clock()
            elif "keep" in effect:
                self._close(effect["keep"])
                self._flush_index()
            elif "discard" in effect or "evict" in effect or "delete" in effect:
                self._remove(effect.get("discard") or effect.get("evict") or effect["delete"])
            elif "finalize" in effect:
                raise ValueError("finalize goes through deliver")

    def deliver(self, ref: Optional[str], dest: str, overwrite: bool = False) -> None:
        """Move a complete partial to ``dest``, the host's choice: a temp file in the destination's directory,
        then a rename (never over an existing file unless ``overwrite``). The partial is removed. ``ref``
        None delivers an empty file (a transfer of zero bytes keeps no partial)."""
        with self._lock:
            self._ensure()
            if ref is not None:
                self._close(ref)
            ddir = os.path.dirname(os.path.abspath(dest))
            fd, tmp = tempfile.mkstemp(prefix=".pkey-xfer-", dir=ddir)
            os.close(fd)
            try:
                with open(tmp, "wb") as w:
                    if ref is not None:
                        with open(self._path(ref), "rb") as r:
                            shutil.copyfileobj(r, w, _BLOCK)
                    w.flush()
                    os.fsync(w.fileno())
                _chmod(tmp, 0o600)
                if overwrite:
                    os.replace(tmp, dest)
                else:
                    try:
                        os.link(tmp, dest)  # fails if dest exists, atomically
                    except OSError as e:
                        if e.errno == errno.EEXIST:
                            raise FileExistsError(errno.EEXIST, "destination exists") from None
                        if os.path.lexists(dest):
                            raise FileExistsError(errno.EEXIST, "destination exists") from None
                        os.rename(tmp, dest)  # no hard links on this volume
                    else:
                        os.unlink(tmp)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            if ref is not None:
                self._remove(ref)

    def destination_ok(self, dest: str) -> bool:
        d = os.path.dirname(os.path.abspath(dest))
        return os.path.isdir(d) and os.access(d, os.W_OK)

    # -- upkeep -------------------------------------------------------------------------------------

    def purge(self, peer_key: Optional[bytes] = None) -> None:
        """Delete the partials of one peer key, or all of them (sign-out)."""
        with self._lock:
            if not self._loaded and not os.path.isdir(self._dir):
                return
            self._ensure()
            tag = peer_tag(peer_key) if peer_key is not None else None
            for ref in [r for r, e in self._idx.items() if tag is None or e["peer"] == tag]:
                self._remove(ref, flush=False)
            stuck = False
            if tag is None:
                for n in os.listdir(self._dir):
                    if _REF.match(n):
                        try:
                            os.unlink(os.path.join(self._dir, n))
                        except OSError:
                            stuck = True
            self._flush_index()
            if stuck:
                raise OSError("a kept partial could not be deleted")

    def sweep(self) -> None:
        with self._lock:
            self._ensure()
            self._sweep_locked()

    def close(self) -> None:
        with self._lock:
            for ref in list(self._open):
                self._close(ref)
            if self._loaded:
                self._flush_index()

    def _sweep_locked(self) -> None:
        now = self._clock()
        gone = [r for r, e in self._idx.items() if now - e["at"] > XFER_PARTIAL_SECONDS and r not in self._open]
        for r in gone:
            self._remove(r, flush=False)
        known = set(self._idx)
        for n in os.listdir(self._dir):
            if _REF.match(n) and n not in known:
                try:
                    os.unlink(os.path.join(self._dir, n))  # a file no record holds
                except OSError:
                    pass
        if gone:
            self._flush_index()

    def _handle(self, ref: str) -> BinaryIO:
        f = self._open.get(ref)
        if f is None:
            f = open(self._path(ref), "r+b")
            self._open[ref] = f
        return f

    def _close(self, ref: str) -> None:
        f = self._open.pop(ref, None)
        if f is not None:
            try:
                f.close()
            except OSError:
                pass

    def _remove(self, ref: str, flush: bool = True) -> None:
        self._close(ref)
        try:
            os.unlink(self._path(ref))
        except OSError:
            pass
        if self._idx.pop(ref, None) is not None and flush:
            self._flush_index()


def _entry_ok(e: Any) -> bool:
    return (
        isinstance(e, dict)
        and isinstance(e.get("peer"), str)
        and isinstance(e.get("id"), str)
        and isinstance(e.get("sha256"), str)
        and all(type(e.get(k)) is int for k in ("size", "chunk"))
        and isinstance(e.get("at"), (int, float))
    )
