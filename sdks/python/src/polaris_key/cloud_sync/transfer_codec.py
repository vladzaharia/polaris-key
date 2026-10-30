"""What the transfer engine needs to know about how a collection stores its files (U-22.10): the chunk
ids, the chunk objects, and the stored form of a manifest or a whole file. A port of
``packages/client-core/src/sync/transferCodec.ts``. The engine moves stored bytes and checks hashes; a
:class:`FileCodec` is the one place that knows whether those bytes are sealed.

``E2eFileCodec``
    ids are HMAC-SHA256 under ``K_cid(c)``; chunks are ``pkey-sync-chunk/1`` objects (§13.8.3); a manifest
    and a whole file are ``pkey-sync-file/1`` streams
``ServerFileCodec``
    ids are the plain SHA-256; a chunk object is ``0x00 | codec | body`` (D-5); a manifest and a file are
    stored as they are

Writers emit codec 0 (raw) chunks only (D-4); readers decode codecs 0 and 1. A stored chunk is at most
:data:`SERVER_CHUNK_MAX_STORED_BYTES` (D-5: 1 MiB plus 30). The root of an end-to-end codec is held by
reference and never put in an exception, a ``repr`` or a log line.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Iterable, Iterator, Optional, Protocol

from ..constants_generated import SYNC_CDC_MAX_BYTES
from ..core import sync_crypto as sc
from ..core import sync_files as sf

__all__ = [
    "SERVER_CHUNK_MAX_STORED_BYTES",
    "SERVER_CHUNK_OBJECT_VERSION",
    "FileCodec",
    "E2eFileCodec",
    "ServerFileCodec",
    "e2e_file_codec",
    "server_file_codec",
]

#: D-5: the largest stored chunk object, 1 MiB of body plus the 30 bytes of the E2E layout.
SERVER_CHUNK_MAX_STORED_BYTES = SYNC_CDC_MAX_BYTES + 30
#: The version byte of a server-mode chunk object.
SERVER_CHUNK_OBJECT_VERSION = 0x00


class FileCodec(Protocol):
    #: What ``begin`` calls it: ``"e2e"`` or ``"none"``.
    enc: str

    def chunk_id(self, plain: bytes) -> bytes:
        """The 32 raw bytes of a plaintext chunk's id."""
        ...

    def chunk_object_bytes(self, plain_len: int) -> int:
        """The size of the raw (codec 0) object for a chunk of ``plain_len`` bytes."""
        ...

    def seal_chunk(self, id: bytes, plain: bytes) -> bytes:
        """The stored object of a chunk, codec 0."""
        ...

    def open_chunk(self, id: bytes, obj: bytes) -> sf.OpenedChunk:
        """Opens a stored object for ``id``: every check of the format, the id of the plaintext last."""
        ...

    def stored_size(self, plain_size: int) -> int:
        """The stored form of a file of ``plain_size`` bytes, as ``begin`` declares it."""
        ...

    def plain_size(self, stored_size: int) -> Optional[int]:
        """The plaintext size a stored size implies, or ``None`` when none does."""
        ...

    def seal_manifest(self, plain: bytes) -> bytes: ...

    def open_manifest(self, stored: bytes) -> sf.OpenedFile: ...

    def seal_stream(self, source: Iterable[bytes]) -> Iterator[bytes]:
        """The stored form of a whole file: ``source`` sealed as one stream (a fresh salt every call)."""
        ...

    def open_stream(self, stored: Iterable[bytes]) -> Iterator[bytes]:
        """The plaintext of a whole stored file, piece by piece; raises ``FileStreamError``. A piece is
        provisional until the iterator ends."""
        ...


class E2eFileCodec:
    """The codec of a collection of an end-to-end product. ``root`` is the ring root."""

    enc = "e2e"

    def __init__(
        self,
        root: bytes,
        collection: str,
        decode: Optional[sf.ChunkZstdDecode] = None,
    ) -> None:
        self._root = root
        self._collection = collection
        self._decode = decode
        self._coll_key = sc.derive_coll_key(root, collection)
        self._kid = sc.derive_kid(root)

    def __repr__(self) -> str:
        return "E2eFileCodec(collection=%r)" % (self._collection,)

    def chunk_id(self, plain: bytes) -> bytes:
        return sf.chunk_id(self._root, self._collection, plain)

    def chunk_object_bytes(self, plain_len: int) -> int:
        return plain_len + 30

    def seal_chunk(self, id: bytes, plain: bytes) -> bytes:
        return sf.seal_chunk(self._root, self._collection, id, sf.CHUNK_CODEC_RAW, plain)

    def open_chunk(self, id: bytes, obj: bytes) -> sf.OpenedChunk:
        return sf.open_chunk(self._root, self._collection, id, obj, self._decode)

    def stored_size(self, plain_size: int) -> int:
        return sf.sealed_file_size(plain_size)

    def plain_size(self, stored_size: int) -> Optional[int]:
        return sf.plain_file_size(stored_size)

    def seal_manifest(self, plain: bytes) -> bytes:
        return sf.seal_file(self._coll_key, self._kid, plain)

    def open_manifest(self, stored: bytes) -> sf.OpenedFile:
        return sf.open_file(self._coll_key, self._kid, stored)

    def seal_stream(self, source: Iterable[bytes]) -> Iterator[bytes]:
        return sf.seal_file_stream(self._coll_key, self._kid, source)

    def open_stream(self, stored: Iterable[bytes]) -> Iterator[bytes]:
        return sf.open_file_stream(self._coll_key, self._kid, stored)


class ServerFileCodec:
    """The codec of a collection of a server-mode product."""

    enc = "none"

    def __init__(self, decode: Optional[sf.ChunkZstdDecode] = None) -> None:
        self._decode = decode

    def chunk_id(self, plain: bytes) -> bytes:
        return hashlib.sha256(plain).digest()

    def chunk_object_bytes(self, plain_len: int) -> int:
        return plain_len + 2

    def seal_chunk(self, id: bytes, plain: bytes) -> bytes:
        if len(id) != 32:
            raise ValueError("chunk id length")
        return bytes([SERVER_CHUNK_OBJECT_VERSION, sf.CHUNK_CODEC_RAW]) + bytes(plain)

    def open_chunk(self, id: bytes, obj: bytes) -> sf.OpenedChunk:
        o = bytes(obj)
        if len(o) < 2:
            return sf.OpenedChunk(ok=False, reason="shape")
        if len(o) > SERVER_CHUNK_MAX_STORED_BYTES:
            return sf.OpenedChunk(ok=False, reason="size")
        if o[0] != SERVER_CHUNK_OBJECT_VERSION:
            return sf.OpenedChunk(ok=False, reason="version")
        codec = o[1]
        if codec not in (sf.CHUNK_CODEC_RAW, sf.CHUNK_CODEC_ZSTD):
            return sf.OpenedChunk(ok=False, reason="codec")
        body = o[2:]
        if codec == sf.CHUNK_CODEC_RAW:
            plain = body
        else:
            decoded = sf.decode_zstd_chunk(body, self._decode)
            if isinstance(decoded, str):
                return sf.OpenedChunk(ok=False, reason=decoded)
            plain = decoded
        if len(plain) > SYNC_CDC_MAX_BYTES:
            return sf.OpenedChunk(ok=False, reason="size")
        if not hmac.compare_digest(hashlib.sha256(plain).digest(), bytes(id)):
            return sf.OpenedChunk(ok=False, reason="id")
        return sf.OpenedChunk(ok=True, plain=plain, codec=codec)

    def stored_size(self, plain_size: int) -> int:
        return plain_size

    def plain_size(self, stored_size: int) -> Optional[int]:
        return stored_size

    def seal_manifest(self, plain: bytes) -> bytes:
        return bytes(plain)

    def open_manifest(self, stored: bytes) -> sf.OpenedFile:
        return sf.OpenedFile(ok=True, plain=bytes(stored))

    def seal_stream(self, source: Iterable[bytes]) -> Iterator[bytes]:
        return iter(source)

    def open_stream(self, stored: Iterable[bytes]) -> Iterator[bytes]:
        return iter(stored)


def e2e_file_codec(root: bytes, collection: str, decode: Optional[sf.ChunkZstdDecode] = None) -> E2eFileCodec:
    return E2eFileCodec(root, collection, decode)


def server_file_codec(decode: Optional[sf.ChunkZstdDecode] = None) -> ServerFileCodec:
    return ServerFileCodec(decode)
