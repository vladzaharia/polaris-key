# @pkey-feature packs.apply.delta
"""Python's zstd traps (plans/P4-01.md §2.7 rules 3 and 5; notes/A7 §6–§7; PARITY §6.3), proven
on frames generated in the test:

* a ``--patch-from`` frame over a base that starts with the dictionary magic ``37 A4 30 EC``
  decodes through ``ZstdDict(base, is_raw=True).as_prefix`` (3.14's stdlib) and through
  ``DICT_TYPE_RAWCONTENT`` (``zstandard``), while the documented ``as_digested_dict`` cannot even
  load it — and the applier still refuses such a base (rule 5: CI never publishes one);
* a frame whose header window is over 128 MiB decodes once ``window_log_max`` is set, and the
  window check reads that window from the header alone.
"""

from __future__ import annotations

import hashlib
import sys

import pytest

from polaris_key.update.packs import ApplyPorts, apply_delta, frame_window, memory_source, window_allowed
from polaris_key.update.packs.zstd import PythonZstd, _backends, select_python_zstd

_MAGIC_BASE = bytes([0x37, 0xA4, 0x30, 0xEC]) + b"hello world base content " * 50
_TARGET = _MAGIC_BASE[:600] + b"changed tail " * 20



def _have(name: str) -> bool:
    return any(b.name == name for b in _backends("auto"))


def _frame_stdlib(base: bytes, target: bytes, window_log: int) -> bytes:
    from compression import zstd as z  # type: ignore[import-not-found]

    c = z.ZstdCompressor(
        options={z.CompressionParameter.window_log: window_log},
        zstd_dict=z.ZstdDict(base, is_raw=True).as_prefix,
    )
    # CONTINUE then FLUSH_FRAME: the size is unknown, so the frame keeps the whole window.
    return c.compress(target, z.ZstdCompressor.CONTINUE) + c.flush(z.ZstdCompressor.FLUSH_FRAME)


def _frame_zstandard(base: bytes, target: bytes, window_log: int) -> bytes:
    import zstandard as zs  # type: ignore[import-not-found,import-untyped,unused-ignore]

    params = zs.ZstdCompressionParameters.from_level(3, window_log=window_log, write_content_size=0)
    c = zs.ZstdCompressor(
        compression_params=params,
        dict_data=zs.ZstdCompressionDict(base, dict_type=zs.DICT_TYPE_RAWCONTENT),
    )
    o = c.compressobj()
    return o.compress(target) + o.flush()


def _frame(base: bytes, target: bytes, window_log: int) -> bytes:
    return (_frame_stdlib if _have("compression.zstd") else _frame_zstandard)(base, target, window_log)


def test_select_reports_a_backend_that_passes_the_probe() -> None:
    _, info = select_python_zstd()
    assert info.patch_methods == ["zstd-patch-from"]
    if sys.version_info >= (3, 14):
        assert info.library == "compression.zstd"
    else:
        assert info.library == "zstandard"


@pytest.mark.skipif(not _have("compression.zstd"), reason="compression.zstd needs CPython 3.14")
def test_stdlib_as_prefix_decodes_a_magic_base() -> None:
    from compression import zstd as z  # type: ignore[import-not-found]

    port, _ = select_python_zstd("stdlib")
    frame = _frame(_MAGIC_BASE, _TARGET, 20)
    assert port.decode_with_prefix(frame, _MAGIC_BASE, len(_TARGET), 20) == _TARGET
    # The documented digested dictionary misreads the magic and refuses to load.
    with pytest.raises(Exception):
        z.decompress(frame, zstd_dict=z.ZstdDict(_MAGIC_BASE, is_raw=True).as_digested_dict)


@pytest.mark.skipif(not _have("zstandard"), reason="zstandard is not installed here")
def test_zstandard_rawcontent_decodes_a_magic_base() -> None:
    port, _ = select_python_zstd("zstandard")
    frame = _frame(_MAGIC_BASE, _TARGET, 20)
    assert port.decode_with_prefix(frame, _MAGIC_BASE, len(_TARGET), 20) == _TARGET


def test_the_applier_still_refuses_a_magic_base() -> None:
    port, _ = select_python_zstd()
    frame = _frame(_MAGIC_BASE, _TARGET, 20)
    sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
    variant = {
        "variant": {},
        "payload": {"size": len(_TARGET), "sha256": sha(_TARGET)},
        "full": {"sha256": sha(b"f"), "bytes": 1, "size": len(_TARGET), "codec": "zstd"},
        "files": {"format": "pkey-files/1", "layout": "container", "sha256": sha(b"i"), "bytes": 1, "size": 1, "codec": "zstd"},
        "deltas": [
            {
                "method": "zstd-patch-from",
                "scope": "payload",
                "from": sha(_MAGIC_BASE),
                "memBytes": len(_MAGIC_BASE) + len(_TARGET),
                "artifact": {"sha256": sha(frame), "bytes": len(frame)},
            }
        ],
    }
    r = apply_delta(variant, 0, memory_source(_MAGIC_BASE), ApplyPorts(objects=lambda h: memory_source(frame), zstd=port))
    assert r.verdict == {"ok": False, "error": "delta-apply-failed"}


@pytest.mark.parametrize("name", [b.name for b in _backends("auto")])
def test_a_window_over_128_mib_decodes_with_window_log_max_set(name: str) -> None:
    backend = next(b for b in _backends("auto") if b.name == name)
    port = PythonZstd(backend)
    base = b"0123456789abcdef" * 64
    target = base + b"appended after the base " * 10
    frame = _frame(base, target, 28)
    assert frame_window(frame) == 2**28  # 256 MiB, read from the header alone
    assert window_allowed(frame, 2**28) and not window_allowed(frame, 2**27)
    assert port.decode_with_prefix(frame, base, len(target), 28) == target
    # Below the frame's window the decoder refuses too (the header check refuses first).
    with pytest.raises(Exception):
        port.decode_with_prefix(frame, base, len(target), 27)
    if name == "compression.zstd":
        from compression import zstd as z  # type: ignore[import-not-found]

        # 3.14's default limit is 128 MiB: without window_log_max the frame is refused.
        with pytest.raises(Exception):
            z.decompress(frame, zstd_dict=z.ZstdDict(base, is_raw=True).as_prefix)


def test_streaming_full_decode_matches_one_shot() -> None:
    port, _ = select_python_zstd()
    data = bytes(range(256)) * 9000
    if _have("compression.zstd"):
        from compression import zstd as z  # type: ignore[import-not-found]

        frame = z.compress(data)
    else:
        import zstandard as zs  # type: ignore[import-not-found,import-untyped,unused-ignore]

        frame = zs.ZstdCompressor().compress(data)
    out = bytearray()
    port.decode_stream(memory_source(frame), len(data), out.extend)
    assert bytes(out) == data == port.decode(frame, len(data))
    with pytest.raises(Exception):
        port.decode_stream(memory_source(frame), len(data) - 1, lambda b: None)
