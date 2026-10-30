"""Cloud Sync file primitives, part I (U-22.8; WIRE-CONTRACT-V5 §13.8.3, §13.10.2): the
content-defined chunker ``pkey-sync-cdc/1``, chunk ids and ``pkey-sync-chunk/1`` objects, and the
``pkey-sync-chunks/1`` manifest. Pure functions over ``bytes``; no I/O, no state.

A port of ``packages/client-core/src/sync/{cdc,chunks,manifest}.ts``, pinned by
``conformance/corpus/v2/sync-vectors.json`` (``cdcCases``, ``cdcEditCases``, ``deltaCases``,
``chunkCases``, ``manifestCases``). The file stream and the transfer plan are U-22.9.

Rules this module keeps:

* a root and a key are ``bytes`` held by the caller; none is put in an exception, a ``repr`` or a
  log line, and no function here prints anything;
* every ``open`` and ``parse`` answers a reason instead of raising on hostile input, and says
  nothing about which byte was wrong beyond the contract's reasons, in the contract's order;
* a zstd frame's declared content size is read from its header and checked against the 1 MiB
  limit **before** anything is decoded, so a bomb costs nothing;
* comparisons of ids, tags and nonces go through ``hmac.compare_digest``.

Writers emit codec 0 (raw) chunks only; readers decode codecs 0 and 1 (plans D-4). The decoder is
the caller's: ``decode(frame, size)`` (``PythonZstd.decode`` fits).
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass, field
from typing import Callable, Iterable, Iterator, List, Optional

from ..constants_generated import (
    SYNC_CDC_AVG_BYTES,
    SYNC_CDC_GEAR_SEED,
    SYNC_CDC_MAX_BYTES,
    SYNC_FILE_MAX_BYTES,
    SYNC_MAX_CHUNKS_PER_FILE,
)
from . import sync_crypto as sc

__all__ = [
    "CdcParams",
    "SYNC_CDC_PARAMS",
    "cdc_params",
    "CdcChunker",
    "cdc_stream",
    "cdc_lengths",
    "CHUNK_OBJECT_VERSION",
    "CHUNK_CODEC_RAW",
    "CHUNK_CODEC_ZSTD",
    "CHUNK_OBJECT_MIN_BYTES",
    "chunk_id",
    "chunk_id_hex",
    "chunk_id_bytes",
    "seal_chunk",
    "OpenedChunk",
    "open_chunk",
    "zstd_content_size",
    "MANIFEST_MAGIC",
    "MANIFEST_VERSION",
    "MANIFEST_HEADER_BYTES",
    "MANIFEST_RECORD_BYTES",
    "ManifestRecord",
    "ChunkManifest",
    "ParsedManifest",
    "encode_manifest",
    "parse_manifest",
]

# ── pkey-sync-cdc/1 ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CdcParams:
    avg: int
    min: int
    max: int


def cdc_params(avg: int) -> CdcParams:
    """The parameters for an average chunk size (a power of two, at least 64)."""
    if avg < 64 or (avg & (avg - 1)) != 0:
        raise ValueError("cdc average must be a power of two of at least 64")
    return CdcParams(avg=avg, min=avg >> 2, max=avg * 4)


#: Average 256 KiB, minimum 64 KiB, maximum 1 MiB.
SYNC_CDC_PARAMS = cdc_params(SYNC_CDC_AVG_BYTES)


def _gear_table() -> List[int]:
    g: List[int] = []
    x = SYNC_CDC_GEAR_SEED & 0xFFFFFFFF
    for _ in range(256):
        x = (x ^ (x << 13)) & 0xFFFFFFFF
        x = (x ^ (x >> 17)) & 0xFFFFFFFF
        x = (x ^ (x << 5)) & 0xFFFFFFFF
        g.append(x)
    return g


_GEAR = _gear_table()


def _top_mask(n: int) -> int:
    return 0xFFFFFFFF if n >= 32 else (~(0xFFFFFFFF >> n)) & 0xFFFFFFFF


def _round_log2(avg: int) -> int:
    # avg is a power of two, so its log is exact; JavaScript's Math.round of it is the same.
    return avg.bit_length() - 1


def _cut_length(buf: bytearray, length: int, p: CdcParams) -> int:
    """The length of the chunk at the start of ``buf[:length]``, which is the rest of the input
    or at least ``max`` bytes."""
    if length <= p.min:
        return length
    bits = _round_log2(p.avg)
    strict = _top_mask(bits + 1)
    loose = _top_mask(bits - 1)
    end = min(length, p.max)
    normal = min(end, p.avg)
    gear = _GEAR
    h = 0
    i = p.min
    while i < end:
        h = ((h << 1) + gear[buf[i]]) & 0xFFFFFFFF
        if (h & (strict if i < normal else loose)) == 0:
            return i + 1
        i += 1
    return end


class CdcChunker:
    """A push chunker: :meth:`push` returns the chunks that are decided, :meth:`finish` the rest.
    It holds at most ``max`` bytes."""

    def __init__(self, params: CdcParams = SYNC_CDC_PARAMS) -> None:
        self.params = params
        self._buf = bytearray()

    def push(self, data: bytes) -> List[bytes]:
        out: List[bytes] = []
        view = memoryview(data)
        at = 0
        while at < len(view):
            take = min(self.params.max - len(self._buf), len(view) - at)
            self._buf += view[at : at + take]
            at += take
            if len(self._buf) == self.params.max:
                self._emit(out, _cut_length(self._buf, len(self._buf), self.params))
        return out

    def finish(self) -> List[bytes]:
        """The last chunks, once the input has ended. The chunker is empty afterwards."""
        out: List[bytes] = []
        while self._buf:
            self._emit(out, _cut_length(self._buf, len(self._buf), self.params))
        return out

    def _emit(self, out: List[bytes], n: int) -> None:
        out.append(bytes(self._buf[:n]))
        del self._buf[:n]


def cdc_stream(source: Iterable[bytes], params: CdcParams = SYNC_CDC_PARAMS) -> Iterator[bytes]:
    """Chunks a stream of byte pieces of any size without holding more than ``max`` bytes of it."""
    chunker = CdcChunker(params)
    for piece in source:
        yield from chunker.push(piece)
    yield from chunker.finish()


def cdc_lengths(data: bytes, params: CdcParams = SYNC_CDC_PARAMS) -> List[int]:
    """The chunk lengths of a whole buffer (tests and tools; production code streams)."""
    c = CdcChunker(params)
    return [len(x) for x in c.push(data) + c.finish()]


# ── chunk ids and pkey-sync-chunk/1 objects ─────────────────────────────────────────────────────

CHUNK_OBJECT_VERSION = 0x01
CHUNK_CODEC_RAW = 0
CHUNK_CODEC_ZSTD = 1
#: Version, codec, nonce and the tag: the smallest object (an empty body).
CHUNK_OBJECT_MIN_BYTES = 2 + 12 + 16
_NONCE_BYTES = 12

#: ``decode(frame, size)``: one zstd frame with a declared content size; it may raise.
ChunkZstdDecode = Callable[[bytes, int], bytes]


def _synthetic_nonce(key: bytes, codec: int, body: bytes) -> bytes:
    msg = bytes([CHUNK_OBJECT_VERSION, codec]) + body
    return hmac.new(key, msg, hashlib.sha256).digest()[:_NONCE_BYTES]


def chunk_id_bytes(hex_id: str) -> Optional[bytes]:
    """The 32 raw bytes of a chunk id, or ``None`` when the text is not 64 lowercase hex characters."""
    if len(hex_id) != 64 or any(c not in "0123456789abcdef" for c in hex_id):
        return None
    return bytes.fromhex(hex_id)


def chunk_id(root: Optional[bytes], collection: str, plain: bytes) -> bytes:
    """The id of a plaintext chunk: ``HMAC-SHA256(K_cid(c), plain)`` for a ring ``root``, the plain
    SHA-256 for ``None`` (server mode)."""
    if root is None:
        return hashlib.sha256(plain).digest()
    return hmac.new(sc.derive_chunk_id_key(root, collection), plain, hashlib.sha256).digest()


def chunk_id_hex(root: Optional[bytes], collection: str, plain: bytes) -> str:
    return chunk_id(root, collection, plain).hex()


def seal_chunk(root: bytes, collection: str, chunk: bytes, codec: int, body: bytes) -> bytes:
    """Seals ``body`` (the chunk for codec 0, one zstd frame for codec 1) as the object for the
    chunk id ``chunk``. The caller computed the id from the plaintext; :func:`open_chunk` checks
    it again."""
    if len(chunk) != 32:
        raise ValueError("chunk id length")
    if codec not in (CHUNK_CODEC_RAW, CHUNK_CODEC_ZSTD):
        raise ValueError("chunk codec")
    aad = bytes([CHUNK_OBJECT_VERSION, codec]) + chunk
    key = sc.derive_chunk_key(sc.derive_coll_key(root, collection), chunk)
    nonce = _synthetic_nonce(key, codec, body)
    return aad[:2] + nonce + sc.aes_gcm_seal(key, nonce, aad, body)


@dataclass(frozen=True)
class OpenedChunk:
    """The result of :func:`open_chunk`: ``ok`` with ``plain`` and ``codec``, or ``reason`` (one of
    ``shape``, ``version``, ``codec``, ``auth``, ``nonce``, ``decode``, ``size``, ``id``, in the
    order a reader checks them). The plaintext is the caller's own data; it is left out of the
    ``repr``."""

    ok: bool
    plain: bytes = field(default=b"", repr=False)
    codec: int = 0
    reason: Optional[str] = None


def _bad(reason: str) -> OpenedChunk:
    return OpenedChunk(ok=False, reason=reason)


def zstd_content_size(f: bytes) -> Optional[int]:
    """The content size a zstd frame header declares (RFC 8878 §3.1.1.1), or ``None`` when the
    frame does not start with the magic, is cut short or declares none."""
    if len(f) < 6 or f[0:4] != b"\x28\xb5\x2f\xfd":
        return None
    d = f[4]
    flag = d >> 6
    single = (d >> 5) & 1
    at = 5 + (0 if single == 1 else 1) + (0, 1, 2, 4)[d & 3]
    width = (1 if single == 1 else 0) if flag == 0 else (0, 2, 4, 8)[flag]
    if width == 0 or len(f) < at + width:
        return None
    v = int.from_bytes(f[at : at + width], "little")
    return v + 256 if flag == 1 else v


def open_chunk(
    root: bytes,
    collection: str,
    chunk: bytes,
    obj: bytes,
    decode: Optional[ChunkZstdDecode] = None,
) -> OpenedChunk:
    """Opens the object for the chunk id ``chunk`` in ``collection``. The checks run in the order
    of the reasons: shape, version, codec, the tag (which covers the codec and the id), the
    synthetic nonce, the zstd frame (it must declare a content size of at most 1 MiB, or ``size``;
    the declared size is read before anything is decoded), and last that the keyed hash of the
    plaintext is the id. A codec 1 object needs ``decode``; without one it is ``decode``."""
    o = bytes(obj)
    if len(o) < CHUNK_OBJECT_MIN_BYTES:
        return _bad("shape")
    if o[0] != CHUNK_OBJECT_VERSION:
        return _bad("version")
    codec = o[1]
    if codec not in (CHUNK_CODEC_RAW, CHUNK_CODEC_ZSTD):
        return _bad("codec")
    if len(chunk) != 32:
        return _bad("auth")
    aad = o[:2] + bytes(chunk)
    key = sc.derive_chunk_key(sc.derive_coll_key(root, collection), chunk)
    nonce = o[2 : 2 + _NONCE_BYTES]
    body = sc.aes_gcm_open(key, nonce, aad, o[2 + _NONCE_BYTES :])
    if body is None:
        return _bad("auth")
    if not hmac.compare_digest(_synthetic_nonce(key, codec, body), nonce):
        return _bad("nonce")
    if codec == CHUNK_CODEC_RAW:
        plain = body
    else:
        size = zstd_content_size(body)
        if size is None or decode is None:
            return _bad("decode")
        if size > SYNC_CDC_MAX_BYTES:
            return _bad("size")
        try:
            plain = bytes(decode(body, size))
        except Exception:
            return _bad("decode")
        if len(plain) != size:
            return _bad("decode")
    if len(plain) > SYNC_CDC_MAX_BYTES:
        return _bad("size")
    if not hmac.compare_digest(chunk_id(root, collection, plain), bytes(chunk)):
        return _bad("id")
    return OpenedChunk(ok=True, plain=plain, codec=codec)


# ── pkey-sync-chunks/1 ──────────────────────────────────────────────────────────────────────────

MANIFEST_MAGIC = b"PKSYNCCH"
MANIFEST_VERSION = 1
MANIFEST_HEADER_BYTES = 64
MANIFEST_RECORD_BYTES = 48


@dataclass(frozen=True)
class ManifestRecord:
    #: 32 raw bytes.
    id: bytes
    plain_len: int


@dataclass(frozen=True)
class ChunkManifest:
    plain_size: int
    #: 32 bytes.
    plain_sha256: bytes
    records: List[ManifestRecord]


@dataclass(frozen=True)
class ParsedManifest:
    """The parsed manifest, or the first violation's ``reason``: ``shape``, ``magic``, ``version``,
    ``recordSize``, ``flags``, ``reserved``, ``count``, ``length``, ``size`` (a ``plainSize`` over
    1 GiB, or lengths that do not add up to it), ``record`` or ``chunkLen``."""

    ok: bool
    manifest: Optional[ChunkManifest] = None
    reason: Optional[str] = None


def encode_manifest(m: ChunkManifest) -> bytes:
    if len(m.plain_sha256) != 32:
        raise ValueError("plain_sha256 length")
    if m.plain_size < 0:
        raise ValueError("plain_size")
    out = bytearray(MANIFEST_HEADER_BYTES)
    out[0:8] = MANIFEST_MAGIC
    out[8:10] = MANIFEST_VERSION.to_bytes(2, "little")
    out[10:12] = MANIFEST_RECORD_BYTES.to_bytes(2, "little")
    out[16:20] = len(m.records).to_bytes(4, "little")
    out[24:32] = m.plain_size.to_bytes(8, "little")
    out[32:64] = m.plain_sha256
    for r in m.records:
        if len(r.id) != 32:
            raise ValueError("chunk id length")
        out += r.id + r.plain_len.to_bytes(4, "little") + bytes(12)
    return bytes(out)


def _le(b: bytes, at: int, n: int) -> int:
    return int.from_bytes(b[at : at + n], "little")


def parse_manifest(data: bytes) -> ParsedManifest:
    """Parses a manifest, refusing the first violation in the contract's order (``manifestCases``).
    ``plainSha256`` binds the reassembled file and is checked by whoever reassembles it."""
    b = bytes(data)

    def fail(reason: str) -> ParsedManifest:
        return ParsedManifest(ok=False, reason=reason)

    if len(b) < MANIFEST_HEADER_BYTES:
        return fail("shape")
    if b[0:8] != MANIFEST_MAGIC:
        return fail("magic")
    if _le(b, 8, 2) != MANIFEST_VERSION:
        return fail("version")
    if _le(b, 10, 2) != MANIFEST_RECORD_BYTES:
        return fail("recordSize")
    if _le(b, 12, 4) != 0:
        return fail("flags")
    if _le(b, 20, 4) != 0:
        return fail("reserved")
    count = _le(b, 16, 4)
    if count > SYNC_MAX_CHUNKS_PER_FILE:
        return fail("count")
    if len(b) != MANIFEST_HEADER_BYTES + MANIFEST_RECORD_BYTES * count:
        return fail("length")
    plain_size = _le(b, 24, 8)
    if plain_size > SYNC_FILE_MAX_BYTES:
        return fail("size")
    records: List[ManifestRecord] = []
    total = 0
    for i in range(count):
        at = MANIFEST_HEADER_BYTES + MANIFEST_RECORD_BYTES * i
        if _le(b, at + 36, 4) != 0 or _le(b, at + 40, 8) != 0:
            return fail("record")
        plain_len = _le(b, at + 32, 4)
        if plain_len == 0 or plain_len > SYNC_CDC_MAX_BYTES:
            return fail("chunkLen")
        total += plain_len
        records.append(ManifestRecord(id=b[at : at + 32], plain_len=plain_len))
    if total != plain_size:
        return fail("size")
    return ParsedManifest(
        ok=True,
        manifest=ChunkManifest(plain_size=plain_size, plain_sha256=b[32:64], records=records),
    )
