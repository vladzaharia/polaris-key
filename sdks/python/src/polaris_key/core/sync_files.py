"""Cloud Sync file primitives (U-22.8, U-22.9; WIRE-CONTRACT-V5 §13.8, §13.10.2, §13.10.4).

Part I (U-22.8): the content-defined chunker ``pkey-sync-cdc/1``, chunk ids and
``pkey-sync-chunk/1`` objects, and the ``pkey-sync-chunks/1`` manifest. Part II (U-22.9): the
``pkey-sync-file/1`` stream (sealed and opened a segment at a time, with ranged opens), the
reassembly check, and the upload planner. Pure functions over ``bytes``; no I/O, no state. A
source is any iterable of ``bytes`` pieces, and a ranged open reads through a callable.

A port of ``packages/client-core/src/sync/{cdc,chunks,manifest,fileStream,transferPlan}.ts``,
pinned by ``conformance/corpus/v2/sync-vectors.json`` (``cdcCases``, ``cdcEditCases``,
``deltaCases``, ``chunkCases``, ``manifestCases``, ``fileStreamCases``, ``transferPlanCases``).

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
import os
import struct
from dataclasses import dataclass, field
from typing import Callable, Iterable, Iterator, List, Optional

from ..constants_generated import (
    SYNC_CDC_AVG_BYTES,
    SYNC_CDC_GEAR_SEED,
    SYNC_CDC_MAX_BYTES,
    SYNC_DELTA_MIN_FILE_BYTES,
    SYNC_FILE_MAX_BYTES,
    SYNC_FILE_SEGMENT_BYTES,
    SYNC_MAX_CHUNKS_PER_FILE,
    SYNC_MAX_PARTS,
    SYNC_PART_MAX_BYTES,
    SYNC_PART_MIN_BYTES,
    SYNC_PART_ROUND_BYTES,
    SYNC_SINGLE_PUT_MAX_BYTES,
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
    "FILE_STREAM_MAGIC",
    "FILE_STREAM_VERSION",
    "FILE_HEADER_BYTES",
    "FILE_SEGMENT_BYTES",
    "FILE_TAG_BYTES",
    "FILE_SALT_BYTES",
    "FileStreamError",
    "encode_file_header",
    "sealed_file_size",
    "plain_file_size",
    "seal_file_stream",
    "seal_file",
    "open_file_stream",
    "OpenedFile",
    "open_file",
    "open_file_range_stream",
    "open_file_range",
    "verify_reassembly",
    "TransferPlan",
    "plan_transfer",
    "part_range",
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


# ── pkey-sync-file/1 (§13.10.4) ─────────────────────────────────────────────────────────────────
#
#   header, 64 bytes little-endian: "PKSYNCF1", version u16 (1), flags u16 (0), segmentBytes u32
#     (1 MiB), kid (16 bytes), salt (32 bytes)
#   segment i: AES-256-GCM(K_file, nonce = u8(last) | 0x00 0x00 0x00 | u64be(i), aad = header,
#     the segment's plaintext), so 16 bytes longer than its plaintext
#
# Every segment but the last holds exactly 1 MiB of plaintext; the last holds 1..1 MiB, except
# that an empty file is one empty last segment. The end of the stream says which segment is last,
# so a truncated stream, a dropped or reordered segment and a missing last flag all fail the tag.
# Nothing here holds a whole file: the sealer and the opener keep at most one segment and the
# piece in hand, and a ranged open reads and decrypts only the segments it needs.

FILE_STREAM_MAGIC = b"PKSYNCF1"
FILE_STREAM_VERSION = 1
FILE_HEADER_BYTES = 64
#: The only segment size ``pkey-sync-file/1`` defines.
FILE_SEGMENT_BYTES = SYNC_FILE_SEGMENT_BYTES
FILE_TAG_BYTES = 16
FILE_SALT_BYTES = 32
_KID_BYTES = sc.SYNC_KID_BYTES


class FileStreamError(Exception):
    """A stream the reader refuses. ``reason`` is, in the order a reader checks: ``shape`` (under
    64 bytes, no segment, or a tail shorter than a tag), ``magic``, ``version``, ``flags``,
    ``segmentSize``, ``kid``, then ``size`` (an empty last segment after others), ``auth`` (a
    segment fails its tag: truncation, reordering, a missing last flag, a tampered header),
    ``range`` (a ranged open outside the file), and the reassembly checks ``plainSize`` and
    ``plainSha256``. Nothing about the bytes is put in the message."""

    def __init__(self, reason: str) -> None:
        super().__init__("pkey-sync-file/1: " + reason)
        self.reason = reason


def encode_file_header(kid: bytes, salt: bytes) -> bytes:
    if len(kid) != _KID_BYTES:
        raise ValueError("kid length")
    if len(salt) != FILE_SALT_BYTES:
        raise ValueError("salt length")
    return struct.pack("<8sHHI", FILE_STREAM_MAGIC, FILE_STREAM_VERSION, 0, FILE_SEGMENT_BYTES) + bytes(kid) + bytes(salt)


def sealed_file_size(plain_size: int) -> int:
    """The sealed size of a plaintext of ``plain_size`` bytes."""
    if isinstance(plain_size, bool) or not isinstance(plain_size, int) or plain_size < 0:
        raise ValueError("plain size")
    segments = max(1, -(-plain_size // FILE_SEGMENT_BYTES))
    return FILE_HEADER_BYTES + plain_size + segments * FILE_TAG_BYTES


def plain_file_size(sealed_size: int) -> Optional[int]:
    """The plaintext size a sealed size implies, or ``None`` when no stream has that size."""
    if isinstance(sealed_size, bool) or not isinstance(sealed_size, int):
        return None
    body = sealed_size - FILE_HEADER_BYTES
    whole = FILE_SEGMENT_BYTES + FILE_TAG_BYTES
    if body < FILE_TAG_BYTES:
        return None
    full, rest = divmod(body, whole)
    if rest == 0:
        return full * FILE_SEGMENT_BYTES
    if rest < FILE_TAG_BYTES:
        return None
    # An empty last segment is only the empty file.
    if rest == FILE_TAG_BYTES and full > 0:
        return None
    return full * FILE_SEGMENT_BYTES + (rest - FILE_TAG_BYTES)


def _segment_nonce(index: int, last: bool) -> bytes:
    return bytes([1 if last else 0, 0, 0, 0]) + index.to_bytes(8, "big")


def seal_file_stream(
    coll_key: bytes,
    kid: bytes,
    source: Iterable[bytes],
    fixed_salt: Optional[bytes] = None,
) -> Iterator[bytes]:
    """Seals ``source`` as a ``pkey-sync-file/1`` stream, yielding the header and then one sealed
    segment at a time. ``kid`` is ``derive_kid(root)`` and ``coll_key`` is ``K_coll``. Every seal
    draws a fresh random 32-byte salt from the platform generator (§13.10.2), never one derived
    from the content: a salt names one file version, and reusing it under the same ``coll_key``
    repeats ``K_file`` and every nonce. ``fixed_salt`` is for known-answer vectors only."""
    salt = fixed_salt if fixed_salt is not None else os.urandom(FILE_SALT_BYTES)
    header = encode_file_header(kid, salt)
    key = sc.derive_file_key(coll_key, salt)

    def run() -> Iterator[bytes]:
        yield header
        buf = bytearray()
        index = 0
        for part in source:
            buf += part
            # Hold one byte back so the final segment is known to be last.
            while len(buf) > FILE_SEGMENT_BYTES:
                yield sc.aes_gcm_seal(key, _segment_nonce(index, False), header, bytes(buf[:FILE_SEGMENT_BYTES]))
                del buf[:FILE_SEGMENT_BYTES]
                index += 1
        yield sc.aes_gcm_seal(key, _segment_nonce(index, True), header, bytes(buf))

    return run()


def seal_file(coll_key: bytes, kid: bytes, plain: bytes, fixed_salt: Optional[bytes] = None) -> bytes:
    """:func:`seal_file_stream` over one buffer, concatenated. For files that fit in memory."""
    return b"".join(seal_file_stream(coll_key, kid, [plain], fixed_salt))


def _parse_header(b: bytes, kid: bytes) -> "tuple[bytes, bytes]":
    if len(b) < FILE_HEADER_BYTES:
        raise FileStreamError("shape")
    if b[0:8] != FILE_STREAM_MAGIC:
        raise FileStreamError("magic")
    if int.from_bytes(b[8:10], "little") != FILE_STREAM_VERSION:
        raise FileStreamError("version")
    if int.from_bytes(b[10:12], "little") != 0:
        raise FileStreamError("flags")
    if int.from_bytes(b[12:16], "little") != FILE_SEGMENT_BYTES:
        raise FileStreamError("segmentSize")
    if len(kid) != _KID_BYTES or not hmac.compare_digest(bytes(b[16:32]), bytes(kid)):
        raise FileStreamError("kid")
    return bytes(b[:FILE_HEADER_BYTES]), bytes(b[32:FILE_HEADER_BYTES])


def open_file_stream(coll_key: bytes, kid: bytes, source: Iterable[bytes]) -> Iterator[bytes]:
    """Opens a sealed stream, yielding each segment's plaintext once its tag has verified. Raises
    :class:`FileStreamError`. Truncation is only known at the end, so a caller that writes the
    plaintext out treats it as provisional until the iterator finishes without raising. ``kid`` is
    ``derive_kid(root)``; a stream sealed under another ring is refused as ``kid``."""
    pieces = iter(source)
    buf = bytearray()
    ended = False

    def fill(until: int) -> None:
        nonlocal ended
        while not ended and len(buf) < until:
            try:
                buf.extend(next(pieces))
            except StopIteration:
                ended = True

    def take(n: int) -> bytes:
        out = bytes(buf[:n])
        del buf[:n]
        return out

    fill(FILE_HEADER_BYTES)
    if len(buf) < FILE_HEADER_BYTES:
        raise FileStreamError("shape")
    header, salt = _parse_header(take(FILE_HEADER_BYTES), kid)
    key = sc.derive_file_key(coll_key, salt)
    whole = FILE_SEGMENT_BYTES + FILE_TAG_BYTES

    index = 0
    while True:
        # One byte beyond a whole segment proves the segment is not the last.
        fill(whole + 1)
        if len(buf) > whole:
            plain = sc.aes_gcm_open(key, _segment_nonce(index, False), header, take(whole))
            if plain is None:
                raise FileStreamError("auth")
            yield plain
            index += 1
            continue
        if len(buf) < FILE_TAG_BYTES:
            raise FileStreamError("shape")
        if len(buf) == FILE_TAG_BYTES and index > 0:
            raise FileStreamError("size")
        plain = sc.aes_gcm_open(key, _segment_nonce(index, True), header, take(len(buf)))
        if plain is None:
            raise FileStreamError("auth")
        yield plain
        return


@dataclass(frozen=True)
class OpenedFile:
    """The result of :func:`open_file`: ``ok`` with ``plain``, or the ``reason`` (a
    :class:`FileStreamError` reason). The plaintext is the caller's own data; it is left out of the
    ``repr``."""

    ok: bool
    plain: bytes = field(default=b"", repr=False)
    reason: Optional[str] = None


def open_file(coll_key: bytes, kid: bytes, sealed: bytes) -> OpenedFile:
    """:func:`open_file_stream` over one buffer, concatenated; a refusal carries its ``reason``."""
    try:
        return OpenedFile(ok=True, plain=b"".join(open_file_stream(coll_key, kid, [bytes(sealed)])))
    except FileStreamError as e:
        return OpenedFile(ok=False, reason=e.reason)


#: Reads ``length`` bytes of the stored file at ``offset``; a short answer is a ``size`` refusal.
RangeReader = Callable[[int, int], bytes]


def open_file_range_stream(
    coll_key: bytes,
    kid: bytes,
    read: RangeReader,
    sealed_size: int,
    start: int,
    end: int,
) -> Iterator[bytes]:
    """Opens bytes ``[start, end)`` of the plaintext of a stored stream of ``sealed_size`` bytes,
    yielding the pieces in order. It reads the header and then only the segments that overlap the
    range, each verified as a whole; the last-segment flag comes from ``sealed_size``, so a server
    that lies about the size or drops a tail fails the tag. ``end`` past the plaintext is
    ``range``."""
    plain_size = plain_file_size(sealed_size)
    if plain_size is None:
        raise FileStreamError("shape")
    if (
        isinstance(start, bool)
        or isinstance(end, bool)
        or not isinstance(start, int)
        or not isinstance(end, int)
        or start < 0
        or start > end
        or end > plain_size
    ):
        raise FileStreamError("range")

    def fetch(offset: int, length: int) -> bytes:
        b = bytes(read(offset, length))
        if len(b) != length:
            raise FileStreamError("size")
        return b

    header, salt = _parse_header(fetch(0, FILE_HEADER_BYTES), kid)
    if start == end:
        return
    key = sc.derive_file_key(coll_key, salt)
    whole = FILE_SEGMENT_BYTES + FILE_TAG_BYTES
    segments = max(1, -(-plain_size // FILE_SEGMENT_BYTES))
    first = start // FILE_SEGMENT_BYTES
    last = (end - 1) // FILE_SEGMENT_BYTES
    for i in range(first, last + 1):
        is_last = i == segments - 1
        plain_len = plain_size - i * FILE_SEGMENT_BYTES if is_last else FILE_SEGMENT_BYTES
        sealed = fetch(FILE_HEADER_BYTES + i * whole, plain_len + FILE_TAG_BYTES)
        plain = sc.aes_gcm_open(key, _segment_nonce(i, is_last), header, sealed)
        if plain is None:
            raise FileStreamError("auth")
        frm = max(start, i * FILE_SEGMENT_BYTES) - i * FILE_SEGMENT_BYTES
        to = min(end, i * FILE_SEGMENT_BYTES + plain_len) - i * FILE_SEGMENT_BYTES
        yield plain[frm:to]


def open_file_range(
    coll_key: bytes,
    kid: bytes,
    read: RangeReader,
    sealed_size: int,
    start: int,
    end: int,
) -> bytes:
    """:func:`open_file_range_stream`, concatenated."""
    return b"".join(open_file_range_stream(coll_key, kid, read, sealed_size, start, end))


def verify_reassembly(source: Iterable[bytes], plain_size: int, plain_sha256: bytes) -> Iterator[bytes]:
    """Passes the plaintext of a reassembled file through while hashing it, and at the end checks
    the length and SHA-256 the chunk manifest declared (``ChunkManifest.plain_size`` /
    ``plain_sha256``). Raises ``plainSize`` or ``plainSha256`` after the last piece; the caller
    discards what it wrote (a file is not usable until this iterator finishes). Never holds the
    file."""
    if plain_size > SYNC_FILE_MAX_BYTES:
        raise FileStreamError("plainSize")
    digest = hashlib.sha256()
    n = 0
    for part in source:
        n += len(part)
        # Stop a source that overruns before it can write the rest of a runaway file.
        if n > plain_size:
            raise FileStreamError("plainSize")
        digest.update(part)
        yield part
    if n != plain_size:
        raise FileStreamError("plainSize")
    if not hmac.compare_digest(digest.digest(), bytes(plain_sha256)):
        raise FileStreamError("plainSha256")


# ── The upload planner (§13.8.1) ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TransferPlan:
    """``mode`` is ``too_large`` (over 1 GiB), ``chunks`` (``files.delta`` and at least 1 MiB;
    never multipart), ``single`` (at most 16 MiB: one PUT) or ``multipart`` (``part_bytes`` =
    clamp(8 MiB .. 64 MiB, ceil(size / 9,999) up to a MiB)). ``part_bytes`` and ``parts`` are
    ``None`` except for ``multipart``."""

    mode: str
    part_bytes: Optional[int] = None
    parts: Optional[int] = None


def plan_transfer(size: int, delta: bool) -> TransferPlan:
    """The mode of a file transfer from its stored size (the sealed size in E2E mode) and the
    collection's ``files.delta``. ``begin`` answers the same numbers; a client plans first so it
    can pick ``format`` and slice parts."""
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise ValueError("transfer size")
    if size > SYNC_FILE_MAX_BYTES:
        return TransferPlan("too_large")
    if delta and size >= SYNC_DELTA_MIN_FILE_BYTES:
        return TransferPlan("chunks")
    if size <= SYNC_SINGLE_PUT_MAX_BYTES:
        return TransferPlan("single")
    per_part = -(-size // SYNC_MAX_PARTS)
    rounded = -(-per_part // SYNC_PART_ROUND_BYTES) * SYNC_PART_ROUND_BYTES
    part_bytes = min(max(SYNC_PART_MIN_BYTES, rounded), SYNC_PART_MAX_BYTES)
    return TransferPlan("multipart", part_bytes, -(-size // part_bytes))


def part_range(plan: TransferPlan, size: int, n: int) -> "tuple[int, int]":
    """Part ``n`` (from 1) of a multipart plan as a half-open byte range ``(start, end)`` of the
    stored file."""
    if plan.mode != "multipart" or plan.part_bytes is None or plan.parts is None:
        raise ValueError("not a multipart plan")
    if isinstance(n, bool) or not isinstance(n, int) or n < 1 or n > plan.parts:
        raise ValueError("part number")
    start = (n - 1) * plan.part_bytes
    return start, min(size, start + plan.part_bytes)
