"""A dependency-free QR encoder for device-code sign-in (SDK parity pass §3.12, ``qr``).

A port of the Godot addon's ``ui/qr/qr_encoder.gd`` (ISO/IEC 18004): byte mode, error
correction level M, versions 1–10 (up to 213 bytes — a ``verificationUriComplete`` is about 70),
all eight masks scored by the standard's four penalty rules. The Godot suite's reference
fixtures (``sdks/godot/tests/qr/fixtures.json``, produced by Nayuki's qrcodegen) hold both ports
to the same module matrices.

* :func:`encode` — a :class:`QrCode` (``size``, ``is_dark(x, y)``, ``rows()``), or ``None``
  when the text does not fit version 10;
* :func:`terminal` — the code as text for a terminal (two modules per character with the
  Unicode half blocks, or plain ``##`` pairs with ``ascii=True``), quiet zone included;
* :func:`svg` — a standalone SVG document, one path, scalable.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Sequence

__all__ = ["QrCode", "encode", "encode_bytes", "capacity", "terminal", "svg", "MAX_VERSION"]

MIN_VERSION = 1
MAX_VERSION = 10
_ECL_M_BITS = 0

# Per version (index 0 unused), level M: [EC codewords per block, blocks in group 1, data
# codewords per group-1 block, blocks in group 2, data codewords per group-2 block].
_BLOCKS = [
    [],
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
]
_ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]
_N1, _N2, _N3, _N4 = 3, 3, 40, 10

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


@dataclass(frozen=True)
class QrCode:
    version: int
    mask: int
    size: int
    modules: bytes

    def is_dark(self, x: int, y: int) -> bool:
        return 0 <= x < self.size and 0 <= y < self.size and self.modules[y * self.size + x] == 1

    def rows(self) -> List[str]:
        return [
            "".join("1" if self.modules[y * self.size + x] else "0" for x in range(self.size))
            for y in range(self.size)
        ]


def capacity(v: int) -> int:
    """How many bytes version ``v`` holds at level M in byte mode."""
    return (_data_codewords(v) * 8 - 4 - _count_bits(v)) // 8


def _count_bits(v: int) -> int:
    return 8 if v <= 9 else 16


def _data_codewords(v: int) -> int:
    b = _BLOCKS[v]
    return b[1] * b[2] + b[3] * b[4]


def encode(text: str, min_version: int = MIN_VERSION, mask: int = -1) -> Optional[QrCode]:
    """The QR code for ``text`` (UTF-8): the smallest version from ``min_version`` that fits,
    the best-scoring mask unless ``mask`` (0–7) is forced. ``None`` when it does not fit
    version 10 or an argument is out of range."""
    return encode_bytes(text.encode("utf-8"), min_version, mask)


def encode_bytes(data: bytes, min_version: int = MIN_VERSION, mask: int = -1) -> Optional[QrCode]:
    if min_version < MIN_VERSION or min_version > MAX_VERSION or mask < -1 or mask > 7:
        return None
    version = next((v for v in range(min_version, MAX_VERSION + 1) if len(data) <= capacity(v)), -1)
    if version < 0:
        return None
    codewords = _codewords(data, version)
    size = version * 4 + 17
    modules = bytearray(size * size)
    function = bytearray(size * size)
    _draw_function_patterns(modules, function, size, version)
    _draw_codewords(modules, function, size, codewords)
    chosen = mask
    if chosen < 0:
        best = -1
        for m in range(8):
            _apply_mask(modules, function, size, m)
            _draw_format(modules, function, size, m)
            p = penalty(modules, size)
            if best < 0 or p < best:
                best = p
                chosen = m
            _apply_mask(modules, function, size, m)
    _apply_mask(modules, function, size, chosen)
    _draw_format(modules, function, size, chosen)
    return QrCode(version, chosen, size, bytes(modules))


def _codewords(data: bytes, version: int) -> bytes:
    bits: List[int] = []

    def append(value: int, count: int) -> None:
        for i in range(count - 1, -1, -1):
            bits.append((value >> i) & 1)

    append(0b0100, 4)
    append(len(data), _count_bits(version))
    for b in data:
        append(b, 8)
    capacity_bits = _data_codewords(version) * 8
    append(0, min(4, capacity_bits - len(bits)))
    append(0, (8 - len(bits) % 8) % 8)
    stream = bytearray()
    for i in range(0, len(bits), 8):
        v = 0
        for j in range(8):
            v = (v << 1) | bits[i + j]
        stream.append(v)
    pad = 0xEC
    while len(stream) < _data_codewords(version):
        stream.append(pad)
        pad = 0x11 if pad == 0xEC else 0xEC
    spec = _BLOCKS[version]
    ec_len = spec[0]
    generator = _rs_generator(ec_len)
    data_blocks: List[bytes] = []
    ec_blocks: List[bytes] = []
    at = 0
    for group in range(2):
        for _ in range(spec[1 + group * 2]):
            length = spec[2 + group * 2]
            block = bytes(stream[at : at + length])
            at += length
            data_blocks.append(block)
            ec_blocks.append(_rs_remainder(block, generator))
    out = bytearray()
    for i in range(max(len(b) for b in data_blocks)):
        for block in data_blocks:
            if i < len(block):
                out.append(block[i])
    for i in range(ec_len):
        for block in ec_blocks:
            out.append(block[i])
    return bytes(out)


def _mul(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _rs_generator(degree: int) -> List[int]:
    g = [1]
    for i in range(degree):
        nxt = [0] * (len(g) + 1)
        for j in range(len(g)):
            nxt[j] ^= g[j]
            nxt[j + 1] ^= _mul(g[j], _EXP[i])
        g = nxt
    return g[1:]


def _rs_remainder(data: bytes, generator: Sequence[int]) -> bytes:
    rem = [0] * len(generator)
    for byte in data:
        factor = byte ^ rem[0]
        for i in range(len(rem) - 1):
            rem[i] = rem[i + 1] ^ _mul(generator[i], factor)
        rem[-1] = _mul(generator[-1], factor)
    return bytes(rem)


def _set(modules: bytearray, function: bytearray, size: int, x: int, y: int, dark: bool) -> None:
    modules[y * size + x] = 1 if dark else 0
    function[y * size + x] = 1


def _draw_function_patterns(modules: bytearray, function: bytearray, size: int, version: int) -> None:
    for i in range(size):
        _set(modules, function, size, 6, i, i % 2 == 0)
        _set(modules, function, size, i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                xx, yy = cx + dx, cy + dy
                if 0 <= xx < size and 0 <= yy < size:
                    dist = max(abs(dx), abs(dy))
                    _set(modules, function, size, xx, yy, dist not in (2, 4))
    align = _ALIGN[version]
    last = len(align) - 1
    for i in range(len(align)):
        for j in range(len(align)):
            if (i == 0 and j == 0) or (i == 0 and j == last) or (i == last and j == 0):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    _set(modules, function, size, align[i] + dx, align[j] + dy, max(abs(dx), abs(dy)) != 1)
    _draw_format(modules, function, size, 0)
    if version >= 7:
        rem = version
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        bits = (version << 12) | rem
        for i in range(18):
            dark = ((bits >> i) & 1) == 1
            a = size - 11 + i % 3
            b = i // 3
            _set(modules, function, size, a, b, dark)
            _set(modules, function, size, b, a, dark)


def _draw_format(modules: bytearray, function: bytearray, size: int, mask: int) -> None:
    data = (_ECL_M_BITS << 3) | mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    bits = ((data << 10) | rem) ^ 0x5412

    def bit(i: int) -> bool:
        return ((bits >> i) & 1) == 1

    for i in range(6):
        _set(modules, function, size, 8, i, bit(i))
    _set(modules, function, size, 8, 7, bit(6))
    _set(modules, function, size, 8, 8, bit(7))
    _set(modules, function, size, 7, 8, bit(8))
    for i in range(9, 15):
        _set(modules, function, size, 14 - i, 8, bit(i))
    for i in range(8):
        _set(modules, function, size, size - 1 - i, 8, bit(i))
    for i in range(8, 15):
        _set(modules, function, size, 8, size - 15 + i, bit(i))
    _set(modules, function, size, 8, size - 8, True)


def _draw_codewords(modules: bytearray, function: bytearray, size: int, data: bytes) -> None:
    i = 0
    total = len(data) * 8
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        upward = ((right + 1) & 2) == 0
        for vert in range(size):
            y = size - 1 - vert if upward else vert
            for j in range(2):
                x = right - j
                if function[y * size + x] == 0 and i < total:
                    modules[y * size + x] = (data[i >> 3] >> (7 - (i & 7))) & 1
                    i += 1
        right -= 2


def _mask_bit(mask: int, x: int, y: int) -> bool:
    if mask == 0:
        return (x + y) % 2 == 0
    if mask == 1:
        return y % 2 == 0
    if mask == 2:
        return x % 3 == 0
    if mask == 3:
        return (x + y) % 3 == 0
    if mask == 4:
        return (x // 3 + y // 2) % 2 == 0
    if mask == 5:
        return x * y % 2 + x * y % 3 == 0
    if mask == 6:
        return (x * y % 2 + x * y % 3) % 2 == 0
    return ((x + y) % 2 + x * y % 3) % 2 == 0


def _apply_mask(modules: bytearray, function: bytearray, size: int, mask: int) -> None:
    for y in range(size):
        for x in range(size):
            if function[y * size + x] == 0 and _mask_bit(mask, x, y):
                modules[y * size + x] ^= 1


def penalty(modules: Sequence[int], size: int) -> int:
    """ISO/IEC 18004 §7.8.3: runs (N1), 2x2 blocks (N2), finder-like patterns (N3), balance
    (N4)."""
    result = 0
    for columns in (False, True):
        for a in range(size):
            run_dark = False
            run = 0
            history = [0] * 7
            for b in range(size):
                dark = modules[(b * size + a) if columns else (a * size + b)] == 1
                if dark == run_dark:
                    run += 1
                    if run == 5:
                        result += _N1
                    elif run > 5:
                        result += 1
                else:
                    _history_add(history, run, size)
                    if not run_dark:
                        result += _finder_count(history) * _N3
                    run_dark = dark
                    run = 1
            if run_dark:
                _history_add(history, run, size)
                run = 0
            run += size
            _history_add(history, run, size)
            result += _finder_count(history) * _N3
    for y in range(size - 1):
        for x in range(size - 1):
            c = modules[y * size + x]
            if c == modules[y * size + x + 1] and c == modules[(y + 1) * size + x] and c == modules[(y + 1) * size + x + 1]:
                result += _N2
    dark_count = sum(modules)
    total = size * size
    k = math.ceil(abs(dark_count * 20.0 - total * 10.0) / total) - 1
    return result + max(k, 0) * _N4


def _history_add(history: List[int], run: int, size: int) -> None:
    r = run + size if history[0] == 0 else run
    history.insert(0, r)
    history.pop()


def _finder_count(h: Sequence[int]) -> int:
    n = h[1]
    core = n > 0 and h[2] == n and h[3] == n * 3 and h[4] == n and h[5] == n
    return (1 if core and h[0] >= n * 4 and h[6] >= n else 0) + (1 if core and h[6] >= n * 4 and h[0] >= n else 0)


# ── Renderers ───────────────────────────────────────────────────────────────────────
def terminal(text: str, *, quiet_zone: int = 2, ascii: bool = False, invert: bool = False) -> Optional[str]:
    """The QR code for ``text`` as terminal text, or ``None`` when it does not fit.

    By default two rows of modules per line with the Unicode half blocks (``▀▄█``), drawn dark
    on the terminal's light background; ``invert=True`` for a dark terminal theme that renders
    the "light" cells as the background. ``ascii=True`` draws ``##`` per dark module instead,
    one row per line, for consoles without Unicode."""
    code = encode(text)
    if code is None:
        return None
    q = max(quiet_zone, 0)
    n = code.size + 2 * q

    def dark(x: int, y: int) -> bool:
        d = code.is_dark(x - q, y - q)
        return not d if invert else d

    lines: List[str] = []
    if ascii:
        for y in range(n):
            lines.append("".join("##" if dark(x, y) else "  " for x in range(n)))
        return "\n".join(lines)
    for y in range(0, n, 2):
        row = []
        for x in range(n):
            top = dark(x, y)
            bottom = dark(x, y + 1) if y + 1 < n else False
            row.append("█" if top and bottom else "▀" if top else "▄" if bottom else " ")
        lines.append("".join(row))
    return "\n".join(lines)


def svg(text: str, *, module: int = 8, quiet_zone: int = 4, dark: str = "#000", light: str = "#fff") -> Optional[str]:
    """A standalone SVG of the QR code for ``text``, or ``None`` when it does not fit."""
    code = encode(text)
    if code is None:
        return None
    n = code.size + 2 * quiet_zone
    parts = []
    for y in range(code.size):
        for x in range(code.size):
            if code.is_dark(x, y):
                parts.append(f"M{x + quiet_zone},{y + quiet_zone}h1v1h-1z")
    px = n * module
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" '
        f'viewBox="0 0 {n} {n}" shape-rendering="crispEdges">'
        f'<rect width="{n}" height="{n}" fill="{light}"/>'
        f'<path d="{"".join(parts)}" fill="{dark}"/></svg>'
    )
