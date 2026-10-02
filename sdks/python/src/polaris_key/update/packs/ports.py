"""The ports every pack function takes (plans/P4-01.md §2.13; a port of client-core's
``packs/ports.ts``). Nothing in the pack core does I/O: SHA-256, zstd, byte storage and the
network are the host's, injected through these interfaces, so the same appliers, planner and
pipeline run over a directory store and under the corpus runner (in-memory ports). Byte sources
and sinks are positional (``read(offset, length)``, ``write(offset, data)``), so a payload is
streamed through them rather than held whole.
"""

from __future__ import annotations

import hashlib
from typing import Callable, Optional

from typing import Protocol

__all__ = [
    "READ_CHUNK",
    "ByteSource",
    "ByteSink",
    "TreeSink",
    "Sha256Hasher",
    "Sha256Port",
    "ZstdPort",
    "ObjectPort",
    "InstalledFile",
    "MemorySource",
    "SliceSource",
    "memory_source",
    "slice_source",
    "read_all",
    "sha256_of",
    "hash_source",
    "hashlib_sha256",
]

#: The chunk size every helper reads in: 1 MiB.
READ_CHUNK = 1 << 20


class ByteSource(Protocol):
    """A readable run of bytes of a known length. ``read`` returns exactly ``length`` bytes (or
    fewer only at the end)."""

    @property
    def size(self) -> int: ...

    def read(self, offset: int, length: int) -> bytes: ...


class ByteSink(Protocol):
    """A positional writer: a container payload being rebuilt."""

    def write(self, offset: int, data: bytes) -> None: ...


class TreeSink(Protocol):
    """Where a tree payload's files go while it is staged. Paths have passed ``check_paths``."""

    def write_file(self, path: str, data: bytes) -> None: ...


class Sha256Hasher(Protocol):
    def update(self, data: bytes) -> None: ...

    def hexdigest(self) -> str: ...


#: Creates a fresh hasher per digest.
Sha256Port = Callable[[], Sha256Hasher]


def hashlib_sha256() -> Sha256Hasher:
    """The default ``Sha256Port``: ``hashlib``'s streaming SHA-256."""
    return hashlib.sha256()  # type: ignore[return-value]


class ZstdPort(Protocol):
    """The zstd decoder (plans/P4-01.md §2.7 rules 1–3). ``decode`` takes one frame with its
    content size; ``decode_with_prefix`` one ``zstd --patch-from`` frame over the whole base as a
    raw-content prefix. Either may raise: every failure is the applier's verdict. The appliers
    run the window check themselves before ``decode_with_prefix`` (§2.7 rule 3), with
    ``pointer_bits`` as P. A port may also have ``decode_stream(source, size, on_chunk)``
    (optional; read with ``getattr``), which decodes one plain frame from a source and hands its
    output in order to ``on_chunk``: ``apply_full`` then streams instead of buffering."""

    pointer_bits: int

    def decode(self, frame: bytes, size: int) -> bytes: ...

    def decode_with_prefix(
        self, frame: bytes, prefix: bytes, size: int, window_log_max: int
    ) -> bytes: ...


#: A stored object by the SHA-256 of its stored bytes, or ``None`` when the host has none.
ObjectPort = Callable[[str], Optional[ByteSource]]


class InstalledFile:
    """One installed file, reachable by its SHA-256 (a file of an installed tree, or a range of
    an installed container payload)."""

    __slots__ = ("path", "sha256", "size", "source")

    def __init__(self, path: str, sha256: str, size: int, source: ByteSource) -> None:
        self.path = path
        self.sha256 = sha256
        self.size = size
        self.source = source

    def __repr__(self) -> str:  # pragma: no cover - diagnostics
        return f"InstalledFile({self.path!r}, {self.sha256[:12]}…, {self.size})"


class MemorySource:
    """A source over bytes already in memory."""

    def __init__(self, data: bytes) -> None:
        self._data = bytes(data)

    @property
    def size(self) -> int:
        return len(self._data)

    def read(self, offset: int, length: int) -> bytes:
        n = len(self._data)
        return self._data[min(offset, n) : min(offset + max(0, length), n)]


class SliceSource:
    """A source over a range of another source."""

    def __init__(self, source: ByteSource, offset: int, size: int) -> None:
        self._source = source
        self._offset = offset
        self._size = size

    @property
    def size(self) -> int:
        return self._size

    def read(self, offset: int, length: int) -> bytes:
        return self._source.read(self._offset + offset, max(0, min(length, self._size - offset)))


def memory_source(data: bytes) -> MemorySource:
    return MemorySource(data)


def slice_source(source: ByteSource, offset: int, size: int) -> SliceSource:
    return SliceSource(source, offset, size)


def read_all(source: ByteSource) -> bytes:
    """Every byte of a source, in one buffer. Only for objects the caller has bounded."""
    parts = []
    at = 0
    while at < source.size:
        chunk = source.read(at, min(READ_CHUNK, source.size - at))
        if not chunk:
            break
        parts.append(chunk)
        at += len(chunk)
    return b"".join(parts)


def sha256_of(sha256: Sha256Port, data: bytes) -> str:
    h = sha256()
    h.update(data)
    return h.hexdigest()


def hash_source(sha256: Sha256Port, source: ByteSource) -> str:
    """The SHA-256 of a whole source, read in chunks."""
    h = sha256()
    at = 0
    while at < source.size:
        chunk = source.read(at, min(READ_CHUNK, source.size - at))
        if not chunk:
            break
        h.update(chunk)
        at += len(chunk)
    return h.hexdigest()

