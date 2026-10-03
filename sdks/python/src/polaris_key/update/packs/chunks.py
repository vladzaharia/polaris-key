"""``pkey-chunks/1``, the binary chunk index (plans/P4-10.md §2.3; WIRE-CONTRACT-V4 §2.6), and its
parser, a port of client-core's ``packs/chunks.ts``. ``content/cases.json#chunkIndexCases`` pins
:func:`parse_chunk_index`. Pure over bytes, never raises; the zstd decoder is the caller's.

Layout (all little-endian), exactly A7 §3.1::

  header   64 B   "PKEYCHNK" | version u16 = 1 | recordSize u16 = 48 | flags u32 (bit 0
                  fileAware) | chunkCount u32 | bundleCount u32 | payloadSize u64 |
                  payloadSha256[32]
  chunks   48 B   id[32] | len u32 | clen u32 | bundle u32 | offset u32, in payload order
  bundles  48 B   sha256[32] | size u64 | reserved u64

The u64 rule: a u64 is read as ``hi * 2^32 + lo`` from two u32 reads (low word first) and
saturated at 2^53, never through a native 64-bit read (no ``<Q``), so every SDK (GDScript's
``int``, a JavaScript double, Python's unbounded ``int``) reaches the same value.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional

from ...constants_generated import MAX_CHUNK_INDEX_BYTES, ErrorCode

__all__ = [
    "ParseChunkIndexResult",
    "parse_chunk_index",
    "parse_chunk_index_bytes",
    "read_u64",
]

#: ``PKEYCHNK``.
_MAGIC = b"PKEYCHNK"
_HEADER_BYTES = 64
_RECORD_BYTES = 48
_FLAG_FILE_AWARE = 1
_TWO_32 = 4294967296
_TWO_53 = 9007199254740992


@dataclass(frozen=True)
class ParseChunkIndexResult:
    """The parsed index (``index``: ``fileAware``, ``payloadSize``, ``payloadSha256``,
    ``records`` as ``[idHex, len, clen, bundle, offset]`` lists, ``bundles`` as ``[shaHex, size]``
    lists), or the first failure's ``error`` with ``chunk`` or ``bundle``."""

    ok: bool
    index: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    chunk: Optional[int] = None
    bundle: Optional[int] = None

    def failure(self) -> Dict[str, Any]:
        """The failure as the corpus spells it: ``{ok: false, error, chunk?|bundle?}``."""
        out: Dict[str, Any] = {"ok": False, "error": self.error}
        if self.chunk is not None:
            out["chunk"] = self.chunk
        if self.bundle is not None:
            out["bundle"] = self.bundle
        return out

    def verdict(self) -> Dict[str, Any]:
        """The corpus verdict: ``{ok: true, chunks, bundleSizes}`` or :meth:`failure`."""
        if self.ok:
            assert self.index is not None
            return {
                "ok": True,
                "chunks": len(self.index["records"]),
                "bundleSizes": [b[1] for b in self.index["bundles"]],
            }
        return self.failure()


def _fail(error: str, chunk: Optional[int] = None, bundle: Optional[int] = None) -> ParseChunkIndexResult:
    return ParseChunkIndexResult(ok=False, error=error, chunk=chunk, bundle=bundle)


def _u16(b: bytes, at: int) -> int:
    return b[at] | (b[at + 1] << 8)


def _u32(b: bytes, at: int) -> int:
    return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)


def read_u64(b: bytes, at: int) -> int:
    """A u64 at ``at`` by the u64 rule: two u32 reads, low word first, saturated at 2^53."""
    v = _u32(b, at + 4) * _TWO_32 + _u32(b, at)
    return _TWO_53 if v >= _TWO_53 else v


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def parse_chunk_index(
    stored: bytes,
    ref: Mapping[str, Any],
    payload: Optional[Mapping[str, Any]],
    *,
    decode: Optional[Callable[[bytes, int], bytes]] = None,
    max_bytes: Optional[int] = None,
) -> ParseChunkIndexResult:
    """``parseChunkIndex(stored, ref, payload | None, {decode, maxBytes})`` (plans/P4-10.md
    §2.3): the index, or the first failure in this order:

     0. ``ref.size`` above ``max_bytes`` (before anything is decoded), the stored SHA-256 or
        length differs from the ref, a ``zstd`` ref fails to decode, or the decoded length is
        not ``ref.size`` → ``chunks-ref-mismatch``;
     1–10. :func:`parse_chunk_index_bytes`.

    Never raises."""
    try:
        limit = MAX_CHUNK_INDEX_BYTES if max_bytes is None else max_bytes
        size = ref.get("size")
        if not _num(size) or size > limit:
            return _fail(ErrorCode.CHUNKS_REF_MISMATCH)
        if len(stored) != ref.get("bytes"):
            return _fail(ErrorCode.CHUNKS_REF_MISMATCH)
        if hashlib.sha256(bytes(stored)).hexdigest() != ref.get("sha256"):
            return _fail(ErrorCode.CHUNKS_REF_MISMATCH)
        codec = ref.get("codec")
        if codec == "none":
            b: Any = bytes(stored)
        elif codec == "zstd" and decode is not None:
            if size != int(size):
                return _fail(ErrorCode.CHUNKS_REF_MISMATCH)
            try:
                b = decode(bytes(stored), int(size))
            except Exception:
                return _fail(ErrorCode.CHUNKS_REF_MISMATCH)
        else:
            return _fail(ErrorCode.CHUNKS_REF_MISMATCH)
        if not isinstance(b, (bytes, bytearray)) or len(b) != size:
            return _fail(ErrorCode.CHUNKS_REF_MISMATCH)
        return parse_chunk_index_bytes(bytes(b), payload)
    except Exception:
        return _fail(ErrorCode.CHUNKS_REF_MISMATCH)


def parse_chunk_index_bytes(
    b: bytes, payload: Optional[Mapping[str, Any]]
) -> ParseChunkIndexResult:
    """Steps 1–10 of :func:`parse_chunk_index` over the decoded index bytes (no ref):

     1. length < 64 → ``chunks-bad-length``; 2. magic → ``chunks-bad-magic``; 3. version ≠ 1 →
        ``chunks-unsupported-version``; 4. recordSize ≠ 48 → ``chunks-bad-record-size``;
        5. ``flags & ~1`` → ``chunks-bad-flags``;
     6. length ≠ 64 + 48 × (chunkCount + bundleCount), in exact arithmetic →
        ``chunks-bad-length``;
     7. bundle records in order: reserved ≠ 0 → ``chunks-reserved-nonzero {bundle}``;
     8. chunk records in order: ``len == 0`` → ``chunks-zero-length``; ``clen == 0 || clen >
        len`` → ``chunks-bad-clen``; ``bundle ≥ bundleCount`` → ``chunks-bad-bundle-ref``;
        ``offset + clen > bundles[bundle].size`` → ``chunks-bad-bundle-range``, each ``{chunk}``;
     9. Σ len ≠ payloadSize → ``chunks-size-mismatch``;
    10. with ``payload``, (``payloadSha256``, ``payloadSize``) ≠ (``payload.sha256``,
        ``payload.size``) → ``chunks-payload-mismatch``.

    Never raises."""
    try:
        b = bytes(b)
        if len(b) < _HEADER_BYTES:
            return _fail(ErrorCode.CHUNKS_BAD_LENGTH)
        if b[:8] != _MAGIC:
            return _fail(ErrorCode.CHUNKS_BAD_MAGIC)
        if _u16(b, 8) != 1:
            return _fail(ErrorCode.CHUNKS_UNSUPPORTED_VERSION)
        if _u16(b, 10) != _RECORD_BYTES:
            return _fail(ErrorCode.CHUNKS_BAD_RECORD_SIZE)
        flags = _u32(b, 12)
        if flags & ~_FLAG_FILE_AWARE:
            return _fail(ErrorCode.CHUNKS_BAD_FLAGS)
        n = _u32(b, 16)
        nb = _u32(b, 20)
        # Python integers are exact: 64 + 48 × (n + nb) < 2^39 never wraps.
        if len(b) != _HEADER_BYTES + _RECORD_BYTES * (n + nb):
            return _fail(ErrorCode.CHUNKS_BAD_LENGTH)
        payload_size = read_u64(b, 24)
        payload_sha256 = b[32:64].hex()

        bundles: List[List[Any]] = []
        for j in range(nb):
            o = _HEADER_BYTES + _RECORD_BYTES * (n + j)
            if _u32(b, o + 40) != 0 or _u32(b, o + 44) != 0:
                return _fail(ErrorCode.CHUNKS_RESERVED_NONZERO, bundle=j)
            bundles.append([b[o : o + 32].hex(), read_u64(b, o + 32)])
        records: List[List[Any]] = []
        total = 0
        for i in range(n):
            o = _HEADER_BYTES + _RECORD_BYTES * i
            length = _u32(b, o + 32)
            clen = _u32(b, o + 36)
            bundle = _u32(b, o + 40)
            offset = _u32(b, o + 44)
            if length == 0:
                return _fail(ErrorCode.CHUNKS_ZERO_LENGTH, chunk=i)
            if clen == 0 or clen > length:
                return _fail(ErrorCode.CHUNKS_BAD_CLEN, chunk=i)
            if bundle >= nb:
                return _fail(ErrorCode.CHUNKS_BAD_BUNDLE_REF, chunk=i)
            if offset + clen > bundles[bundle][1]:
                return _fail(ErrorCode.CHUNKS_BAD_BUNDLE_RANGE, chunk=i)
            total += length
            records.append([b[o : o + 32].hex(), length, clen, bundle, offset])
        if total != payload_size:
            return _fail(ErrorCode.CHUNKS_SIZE_MISMATCH)
        if payload is not None and (
            payload_sha256 != payload.get("sha256") or payload_size != payload.get("size")
        ):
            return _fail(ErrorCode.CHUNKS_PAYLOAD_MISMATCH)
        return ParseChunkIndexResult(
            ok=True,
            index={
                "fileAware": (flags & _FLAG_FILE_AWARE) != 0,
                "payloadSize": payload_size,
                "payloadSha256": payload_sha256,
                "records": records,
                "bundles": bundles,
            },
        )
    except Exception:
        return _fail(ErrorCode.CHUNKS_BAD_LENGTH)
