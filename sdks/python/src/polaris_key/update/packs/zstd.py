"""The Python zstd backend for packs (plans/P4-01.md §2.7, §5 "zstd per SDK"; PARITY §6.2–§6.3).

* CPython 3.14+: the stdlib ``compression.zstd``. A ``--patch-from`` frame decodes over
  ``ZstdDict(base, is_raw=True).as_prefix`` — the only stdlib mode that handles every base; the
  documented ``as_digested_dict``/``as_undigested_dict`` ignore ``is_raw`` and misread a base that
  starts with the dictionary magic. 3.14 also rejects windows over 128 MiB unless
  ``window_log_max`` is set, so it is always set.
* CPython 3.9–3.13: ``zstandard`` (a hard dependency there, BSD-3), with
  ``DICT_TYPE_RAWCONTENT`` and an explicit ``max_window_size``.

Either way a start-up probe decodes a tiny built-in ``--patch-from`` vector, and
``zstd-patch-from`` is advertised only when it decodes byte for byte. The window limit of §2.7
rule 3 is enforced by the appliers' header check (``window_allowed``) before every prefix decode,
never by trusting the decoder: the parameter set here is a second line only.
"""

from __future__ import annotations

import hashlib
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, List, Tuple

from .ports import READ_CHUNK, ByteSource
from .window import window_log_max

__all__ = [
    "PythonZstd",
    "ZstdInfo",
    "probe_prefix_decoder",
    "select_python_zstd",
    "PROBE_BASE",
    "PROBE_FRAME",
    "PROBE_SIZE",
    "PROBE_SHA256",
    "PROBE_MEM_BYTES",
]

#: P for this interpreter: 31 on a 64-bit build, 30 on a 32-bit one.
_POINTER_BITS = 31 if sys.maxsize > 2**32 else 30

# ── The probe vector ───────────────────────────────────────────────────────────────────────
# A 432-byte base and a `zstd --patch-from` frame (zstd 1.5.7) that decodes over it to a
# 469-byte target. The base is generated, so only the 80-byte frame is a literal.
PROBE_BASE = "".join(
    f"polaris key probe line {i:03d}: the quick brown fox jumps over the lazy dog\n"
    for i in range(6)
).encode("ascii")
PROBE_FRAME = bytes.fromhex(
    "28b52ffd64d500150200540230736c65657079206361740a313278797a357461696c20616464656420666f"
    "70726f62650a0a00db6bf840c481b4bbab0c04d021809e01ca9ab04cf0c8b204205fff9e32"
)
PROBE_SIZE = 469
PROBE_SHA256 = "cb0e436ee45ab5d453e18dd20612ce36c56e371dbf940bc5cabd20fd0ef27c27"
#: base + target, so ``window_log_max`` is 10.
PROBE_MEM_BYTES = 901


def _require_content_size(fcs: int, size: int) -> None:
    """Refuse a frame whose header declares a Frame_Content_Size other than ``size`` (``-1``:
    the header declares none). ``zstandard.decompress()`` allocates a declared content size up
    front and ignores ``max_output_size`` when one is present, so a small frame that claims
    1 GiB would cost 1 GiB before any byte is checked: the header is read first, every call."""
    if fcs != -1 and fcs != size:
        raise ValueError("zstd: content size")


#: The longest frame header (RFC 8878 §3.1.1): magic, descriptor, window, dictionary id, size.
_MAX_FRAME_HEADER = 18


def _plain_wlm(size: int) -> int:
    wlm = window_log_max(max(size, 0), _POINTER_BITS)
    return 10 if wlm is None else wlm


class _SourceReader:
    """A file-like ``read(n)`` over a :class:`ByteSource` (for ``zstandard.read_to_iter``)."""

    def __init__(self, source: ByteSource) -> None:
        self._source = source
        self._at = 0

    def read(self, n: int = -1) -> bytes:
        left = self._source.size - self._at
        if n is None or n < 0 or n > left:
            n = left
        if n <= 0:
            return b""
        chunk = self._source.read(self._at, min(n, READ_CHUNK))
        self._at += len(chunk)
        return chunk


class _Stdlib:
    """``compression.zstd`` (CPython 3.14+)."""

    name = "compression.zstd"

    def __init__(self) -> None:
        from compression import zstd as z  # type: ignore[import-not-found]

        self._z = z
        self.version = ".".join(str(x) for x in z.zstd_version_info)

    def _opts(self, wlm: int) -> Any:
        return {self._z.DecompressionParameter.window_log_max: wlm}

    def _check(self, frame: bytes, size: int) -> None:
        info = self._z.get_frame_info(bytes(frame[:_MAX_FRAME_HEADER]))
        fcs = info.decompressed_size
        _require_content_size(-1 if fcs is None else fcs, size)

    def decode(self, frame: bytes, size: int) -> bytes:
        self._check(frame, size)
        d = self._z.ZstdDecompressor(options=self._opts(_plain_wlm(size)))
        out = d.decompress(bytes(frame), max_length=size + 1)
        if len(out) != size or not d.eof:
            raise ValueError("zstd: length")
        return out

    def decode_with_prefix(self, frame: bytes, prefix: bytes, size: int, wlm: int) -> bytes:
        self._check(frame, size)
        zd = self._z.ZstdDict(bytes(prefix), is_raw=True)
        d = self._z.ZstdDecompressor(zstd_dict=zd.as_prefix, options=self._opts(wlm))
        out = d.decompress(bytes(frame), max_length=size + 1)
        if len(out) != size or not d.eof:
            raise ValueError("zstd: length")
        return out

    def decode_stream(
        self, frame: ByteSource, size: int, on_chunk: Callable[[bytes], None]
    ) -> None:
        self._check(frame.read(0, min(_MAX_FRAME_HEADER, frame.size)), size)
        d = self._z.ZstdDecompressor(options=self._opts(_plain_wlm(size)))
        total = 0
        at = 0
        while True:
            if d.needs_input:
                if at >= frame.size:
                    break
                data = frame.read(at, min(READ_CHUNK, frame.size - at))
                if not data:
                    break
                at += len(data)
            else:
                data = b""
            out = d.decompress(data, max_length=READ_CHUNK)
            if out:
                total += len(out)
                if total > size:
                    raise ValueError("zstd: overrun")
                on_chunk(out)
            if d.eof:
                break
        if total != size or not d.eof:
            raise ValueError("zstd: length")


class _Zstandard:
    """``zstandard`` (CPython 3.9–3.13, or wherever it is installed)."""

    name = "zstandard"

    def __init__(self) -> None:
        import zstandard as z  # type: ignore[import-not-found,import-untyped,unused-ignore]

        self._z = z
        self.version = f"{z.__version__} (libzstd {'.'.join(str(x) for x in z.ZSTD_VERSION)})"

    def _check(self, frame: bytes, size: int) -> None:
        _require_content_size(self._z.frame_content_size(bytes(frame[:_MAX_FRAME_HEADER])), size)

    def decode(self, frame: bytes, size: int) -> bytes:
        self._check(frame, size)
        d = self._z.ZstdDecompressor(max_window_size=2 ** _plain_wlm(size))
        out = d.decompress(bytes(frame), max_output_size=max(size, 1))
        if len(out) != size:
            raise ValueError("zstd: length")
        return out

    def decode_with_prefix(self, frame: bytes, prefix: bytes, size: int, wlm: int) -> bytes:
        self._check(frame, size)
        zd = self._z.ZstdCompressionDict(bytes(prefix), dict_type=self._z.DICT_TYPE_RAWCONTENT)
        d = self._z.ZstdDecompressor(dict_data=zd, max_window_size=2**wlm)
        out = d.decompress(bytes(frame), max_output_size=max(size, 1))
        if len(out) != size:
            raise ValueError("zstd: length")
        return out

    def decode_stream(
        self, frame: ByteSource, size: int, on_chunk: Callable[[bytes], None]
    ) -> None:
        self._check(frame.read(0, min(_MAX_FRAME_HEADER, frame.size)), size)
        d = self._z.ZstdDecompressor(max_window_size=2 ** _plain_wlm(size))
        total = 0
        reader: Any = _SourceReader(frame)
        for out in d.read_to_iter(reader, read_size=READ_CHUNK, write_size=READ_CHUNK):
            total += len(out)
            if total > size:
                raise ValueError("zstd: overrun")
            on_chunk(out)
        if total != size:
            raise ValueError("zstd: length")


@dataclass
class ZstdInfo:
    """Which library serves every frame, for diagnostics and ``caps``."""

    #: ``compression.zstd`` or ``zstandard``.
    library: str
    #: The library's (and libzstd's) version.
    version: str
    #: ``["zstd-patch-from"]`` when the prefix decoder decodes the probe, else empty.
    patch_methods: List[str] = field(default_factory=list)


class PythonZstd:
    """A ``ZstdPort`` over one backend."""

    def __init__(self, backend: Any, pointer_bits: int = _POINTER_BITS) -> None:
        self._b = backend
        self.pointer_bits = pointer_bits

    def decode(self, frame: bytes, size: int) -> bytes:
        return bytes(self._b.decode(frame, size))

    def decode_with_prefix(self, frame: bytes, prefix: bytes, size: int, window_log_max: int) -> bytes:
        return bytes(self._b.decode_with_prefix(frame, prefix, size, window_log_max))

    def decode_stream(
        self, frame: ByteSource, size: int, on_chunk: Callable[[bytes], None]
    ) -> None:
        self._b.decode_stream(frame, size, on_chunk)


def probe_prefix_decoder(decode_with_prefix: Callable[[bytes, bytes, int, int], bytes]) -> bool:
    """Whether a prefix decoder turns the probe vector into its target, byte for byte."""
    try:
        wlm = window_log_max(PROBE_MEM_BYTES)
        assert wlm is not None
        out = decode_with_prefix(PROBE_FRAME, PROBE_BASE, PROBE_SIZE, wlm)
        return len(out) == PROBE_SIZE and hashlib.sha256(out).hexdigest() == PROBE_SHA256
    except Exception:
        return False


def _backends(mode: str) -> List[Any]:
    out: List[Any] = []
    if mode in ("auto", "stdlib"):
        try:
            out.append(_Stdlib())
        except Exception:
            pass
    if mode in ("auto", "zstandard"):
        try:
            out.append(_Zstandard())
        except Exception:
            pass
    return out


def select_python_zstd(mode: str = "auto") -> Tuple[PythonZstd, ZstdInfo]:
    """Pick this process's zstd backend: ``auto`` prefers the stdlib (3.14+), else
    ``zstandard``; ``stdlib`` and ``zstandard`` force one. Raises ``ImportError`` when none is
    available (``zstandard`` is a hard dependency below 3.14, so an install has one)."""
    found = _backends(mode)
    if not found:
        raise ImportError(
            "No zstd decoder: install zstandard (a dependency of polaris-key below Python 3.14)."
        )
    backend = found[0]
    port = PythonZstd(backend)
    ok = probe_prefix_decoder(port.decode_with_prefix)
    return port, ZstdInfo(
        library=backend.name,
        version=backend.version,
        patch_methods=["zstd-patch-from"] if ok else [],
    )


def available_backends() -> List[str]:
    """The backends this interpreter can load (``compression.zstd``, ``zstandard``)."""
    return [b.name for b in _backends("auto")]

