"""The zstd window check (plans/P4-01.md §2.7 rule 3; WIRE-CONTRACT-V4 §2.6), a port of
client-core's ``packs/window.ts``. Before an applier decodes a ``zstd-patch-from`` frame it reads
the frame's window from the header bytes alone (:func:`frame_window`) and refuses the frame as
``delta-apply-failed`` when that is ``None`` or above 2^``window_log_max(memBytes)``. No decoder
parameter replaces the check: libzstd enforces its own window limit only when it streams through
a small buffer.
"""

from __future__ import annotations

from typing import Any, Optional

from ...constants_generated import MAX_WIRE_INTEGER

__all__ = ["frame_window", "window_log_max", "window_allowed"]

#: 2^32: the saturation point of ``frame_window``, above every ``window_log_max``.
_WINDOW_CEILING = 2**32


def frame_window(data: Any) -> Optional[int]:
    """The window of the zstd frame whose header starts ``data`` (RFC 8878 §3.1.1). ``None``
    unless bytes 0–3 are ``28 B5 2F FD``, the reserved bit (``0x08``) of the descriptor is clear,
    and ``data`` holds the whole header. With Single_Segment_flag the window is
    Frame_Content_Size (plus 256 for a 2-byte field); otherwise
    ``b + (b >> 3) × (w & 7)`` with ``b = 2^(10 + (w >> 3))``. Saturates at 2^32. Never
    raises."""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        return None
    b = bytes(data[:18])
    if len(b) < 5 or b[:4] != b"\x28\xb5\x2f\xfd":
        return None
    d = b[4]
    if d & 0x08:
        return None
    single = bool(d & 0x20)
    dict_bytes = (0, 1, 2, 4)[d & 0x03]
    fcs_flag = d >> 6
    fcs_bytes = (1 if single else 0) if fcs_flag == 0 else (0, 2, 4, 8)[fcs_flag]
    header = 5 + (0 if single else 1) + dict_bytes + fcs_bytes
    if len(b) < header:
        return None
    if not single:
        w = b[5]
        base = 2 ** (10 + (w >> 3))
        return min(base + (base // 8) * (w & 7), _WINDOW_CEILING)
    at = 5 + dict_bytes
    v = int.from_bytes(b[at : at + fcs_bytes], "little")
    if fcs_bytes == 2:
        v += 256
    return min(v, _WINDOW_CEILING)


def window_log_max(mem_bytes: Any, p: int = 31) -> Optional[int]:
    """``max(10, min(P, ⌈log2(memBytes)⌉))`` in integers: ⌈log2(m)⌉ is the bit length of m − 1.
    ``p`` is 31 for a 64-bit decoder and 30 for a 32-bit one. ``None`` when ``mem_bytes`` is not
    a non-negative safe integer or ``p`` is not 30 or 31."""
    if isinstance(mem_bytes, bool) or not isinstance(mem_bytes, int):
        return None
    if mem_bytes < 0 or mem_bytes > MAX_WIRE_INTEGER:
        return None
    if p not in (30, 31):
        return None
    n = (mem_bytes - 1).bit_length() if mem_bytes > 0 else 0
    return max(10, min(p, n))


def window_allowed(frame: Any, mem_bytes: Any, p: int = 31) -> bool:
    """True when ``frame``'s header window is known and at most 2^``window_log_max``."""
    limit = window_log_max(mem_bytes, p)
    window = frame_window(frame)
    return limit is not None and window is not None and window <= 2**limit
