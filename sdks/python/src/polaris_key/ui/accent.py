"""The accent resolver (docs/design/UI-KITS.md §3.3), a step-for-step port of
packages/brand/src/accent.ts.

``tests/test_ui_accent.py`` holds it to the shared vectors (``tests/fixtures/accent-vectors.json``,
from packages/brand/fixtures/accent-vectors.json): change the algorithm only together with every
port.

    derive_accent(rgba)            the input colour from a product icon when it supplies none
    resolve_accent(hex, dark)      solid, on, fg, subtle and focus for one colour scheme

Colours cross this API as lower-case ``"#rrggbb"`` strings.
"""

from __future__ import annotations

import math
from typing import Callable, List, NamedTuple, Optional, Sequence, Tuple

from . import _tokens

WHITE = "#ffffff"
INK = "#060912"

_TEXT = 4.5
_UI = 3.0
_WHITE_SHIFT = 0.08
_FG_DARK_L = 0.78
_FG_LIGHT_L = 0.52
_STEPS = 32
_OPAQUE_ALPHA = 128
_GREY_CHROMA = 0.04
_HUE_BIN = 30.0
_MIN_SHARE = 0.08
_DERIVED_L = (0.45, 0.6)
_SUBTLE_ALPHA = {"dark": 0.12, "light": 0.1}

Triple = Tuple[float, float, float]


class ResolvedAccent(NamedTuple):
    """One colour resolved for one scheme."""

    #: Fills and indicators: at least 3:1 on every surface of the scheme.
    solid: str
    #: The label on ``solid``: white unless the accent is light; the same in both schemes.
    on: str
    #: Text and links: at least 4.5:1 on every surface of the scheme.
    fg: str
    #: The tinted fill for selected rows.
    subtle: str
    #: The focus ring: ``fg`` in dark schemes, ``solid`` in light ones.
    focus: str


def surfaces(dark: bool) -> List[str]:
    """The scheme's surfaces, in the resolver's order: page, raised, overlay, sunken."""
    return list(_tokens.ACCENT_SURFACES["dark" if dark else "light"])


def resolve_accent(hex_color: str, dark: bool) -> Optional[ResolvedAccent]:
    """Resolve any input colour (``#rgb`` or ``#rrggbb``) for one scheme; None for anything else."""
    value = normalize(hex_color)
    if value is None:
        return None
    white = is_white_label(value)
    s = accent_solid(value, dark, white)
    f = accent_fg(value, dark)
    scheme = "dark" if dark else "light"
    return ResolvedAccent(
        solid=s,
        on=WHITE if white else INK,
        fg=f,
        subtle=_mix_over(s, _SUBTLE_ALPHA[scheme], surfaces(dark)[0]),
        focus=f if dark else s,
    )


def is_white_label(hex_color: str) -> bool:
    """True when darkening by at most 0.08 reaches 4.5:1 against white; the scheme never matters."""
    base = _hex_to_oklch(hex_color)
    shifted = _at(base, base[0] - _WHITE_SHIFT)
    return contrast(WHITE, shifted) >= _TEXT


def accent_solid(hex_color: str, dark: bool, white_label: bool) -> str:
    """``solid`` for a colour, a scheme and a label (the danger solid passes white_label=True)."""
    base = _hex_to_oklch(hex_color)
    grounds = surfaces(dark)

    def on_ui(h: str) -> bool:
        return _clears(h, grounds, _UI)

    if white_label:
        s = _move_until(base, -1.0, lambda h: contrast(WHITE, h) >= _TEXT)
        return _move_until(_hex_to_oklch(s), 1.0, on_ui) if dark and not on_ui(s) else s
    s = _move_until(base, 1.0, lambda h: contrast(INK, h) >= _TEXT)
    return _move_until(_hex_to_oklch(s), -1.0, on_ui) if not dark and not on_ui(s) else s


def accent_fg(hex_color: str, dark: bool) -> str:
    """``fg`` for a colour in a scheme: text that clears 4.5:1 on every surface."""
    base = _hex_to_oklch(hex_color)
    grounds = surfaces(dark)

    def readable(h: str) -> bool:
        return _clears(h, grounds, _TEXT)

    if dark:
        return _move_until((max(base[0], _FG_DARK_L), base[1], base[2]), 1.0, readable)
    return _move_until((min(base[0], _FG_LIGHT_L), base[1], base[2]), -1.0, readable)


def derive_accent(rgba: Sequence[int]) -> Optional[str]:
    """The input colour for a product without one, from its icon's RGBA bytes (row-major, 4 per
    pixel; ``bytes`` or a list): the mean of the most saturated 30° hue cluster covering at least
    8 % of the opaque pixels, at an accent lightness. None for a near-greyscale or empty icon (the
    kit falls back to ink)."""
    count = int(360 / _HUE_BIN)
    n = [0] * count
    sum_l = [0.0] * count
    sum_a = [0.0] * count
    sum_b = [0.0] * count
    sum_c = [0.0] * count
    opaque = 0
    i = 0
    size = len(rgba)
    while i + 3 < size:
        if rgba[i + 3] >= _OPAQUE_ALPHA:
            opaque += 1
            lab = _rgb_to_oklab((rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255))
            lch = _oklab_to_oklch(lab)
            if lch[1] >= _GREY_CHROMA:
                k = min(count - 1, int(math.floor(lch[2] / _HUE_BIN)))
                n[k] += 1
                sum_l[k] += lab[0]
                sum_a[k] += lab[1]
                sum_b[k] += lab[2]
                sum_c[k] += lch[1]
        i += 4
    if opaque == 0:
        return None
    best = -1
    for k in range(count):
        if n[k] < _MIN_SHARE * opaque:
            continue
        if best < 0:
            best = k
            continue
        chroma = sum_c[k] / n[k]
        best_chroma = sum_c[best] / n[best]
        if chroma > best_chroma or (chroma == best_chroma and n[k] > n[best]):
            best = k
    if best < 0:
        return None
    total = float(n[best])
    mean = _oklab_to_oklch((sum_l[best] / total, sum_a[best] / total, sum_b[best] / total))
    lo, hi = _DERIVED_L
    return _oklch_to_hex((min(hi, max(lo, mean[0])), mean[1], mean[2]))


def contrast(a: str, b: str) -> float:
    """WCAG 2 contrast ratio between two ``"#rrggbb"`` colours."""
    la = _luminance(a)
    lb = _luminance(b)
    return (la + 0.05) / (lb + 0.05) if la > lb else (lb + 0.05) / (la + 0.05)


def normalize(hex_color: str) -> Optional[str]:
    """Lower-case ``"#rrggbb"`` for ``#rgb`` or ``#rrggbb``; None for anything else."""
    rgb = _parse_hex(hex_color)
    return None if rgb is None else _to_hex(rgb)


# ── Search ───────────────────────────────────────────────────────────────────────────────────


def _at(base: Triple, l: float) -> str:
    return _oklch_to_hex((min(1.0, max(0.0, l)), base[1], base[2]))


def _move_until(base: Triple, direction: float, ok: Callable[[str], bool]) -> str:
    start = _at(base, base[0])
    if ok(start):
        return start
    lo = 0.0
    hi = base[0] if direction < 0 else 1 - base[0]
    if not ok(_at(base, base[0] + direction * hi)):
        return _at(base, base[0] + direction * hi)
    for _ in range(_STEPS):
        mid = (lo + hi) / 2
        if ok(_at(base, base[0] + direction * mid)):
            hi = mid
        else:
            lo = mid
    return _at(base, base[0] + direction * hi)


def _clears(hex_color: str, grounds: Sequence[str], minimum: float) -> bool:
    return all(contrast(hex_color, g) >= minimum for g in grounds)


# ── Colour science (packages/brand/src/color.ts) ─────────────────────────────────────────────

_HEX_DIGITS = set("0123456789abcdef")


def _parse_hex(hex_color: str) -> Optional[Triple]:
    if not isinstance(hex_color, str) or not hex_color.startswith("#"):
        return None
    digits = hex_color[1:].lower()
    if len(digits) not in (3, 6) or not set(digits) <= _HEX_DIGITS:
        return None
    if len(digits) == 3:
        digits = "".join(c + c for c in digits)
    v = int(digits, 16)
    return (((v >> 16) & 0xFF) / 255, ((v >> 8) & 0xFF) / 255, (v & 0xFF) / 255)


def _to_hex(rgb: Triple) -> str:
    return "#" + "".join("%02x" % int(math.floor(min(1.0, max(0.0, x)) * 255 + 0.5)) for x in rgb)


def _to_linear(v: float) -> float:
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def _from_linear(v: float) -> float:
    return v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


def _cbrt(x: float) -> float:
    # math.cbrt is 3.11+; below it, pow plus one Newton step lands on the same value.
    cbrt = getattr(math, "cbrt", None)
    if cbrt is not None:
        return cbrt(x)
    if x == 0.0:
        return 0.0
    a = abs(x)
    r = a ** (1.0 / 3.0)
    r = r - (r * r * r - a) / (3.0 * r * r)
    return r if x > 0 else -r


def _rgb_to_oklab(c: Triple) -> Triple:
    lr, lg, lb = _to_linear(c[0]), _to_linear(c[1]), _to_linear(c[2])
    l = _cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
    m = _cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
    s = _cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
    return (
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    )


def _oklab_to_rgb(c: Triple) -> Triple:
    l = (c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2]) ** 3
    m = (c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2]) ** 3
    s = (c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2]) ** 3
    return (
        _from_linear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        _from_linear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        _from_linear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    )


def _oklab_to_oklch(c: Triple) -> Triple:
    h = math.atan2(c[2], c[1]) * 180 / math.pi
    if h < 0:
        h += 360
    return (c[0], math.hypot(c[1], c[2]), h)


def _oklch_to_oklab(c: Triple) -> Triple:
    rad = c[2] * math.pi / 180
    return (c[0], c[1] * math.cos(rad), c[1] * math.sin(rad))


def _hex_to_oklch(hex_color: str) -> Triple:
    return _oklab_to_oklch(_rgb_to_oklab(_parse_hex(hex_color) or (0.0, 0.0, 0.0)))


def _in_gamut(c: Triple) -> bool:
    eps = 1e-6
    return all(-eps <= x <= 1 + eps for x in c)


def _oklch_to_hex(color: Triple) -> str:
    rgb = _oklab_to_rgb(_oklch_to_oklab(color))
    if not _in_gamut(rgb):
        lo, hi = 0.0, color[1]
        while hi - lo > 1e-5:
            mid = (lo + hi) / 2
            if _in_gamut(_oklab_to_rgb(_oklch_to_oklab((color[0], mid, color[2])))):
                lo = mid
            else:
                hi = mid
        rgb = _oklab_to_rgb(_oklch_to_oklab((color[0], lo, color[2])))
    return _to_hex(rgb)


def _luminance(hex_color: str) -> float:
    r, g, b = _parse_hex(hex_color) or (0.0, 0.0, 0.0)
    return 0.2126 * _to_linear(r) + 0.7152 * _to_linear(g) + 0.0722 * _to_linear(b)


def _mix_over(fg: str, alpha: float, bg: str) -> str:
    f = _parse_hex(fg) or (0.0, 0.0, 0.0)
    b = _parse_hex(bg) or (0.0, 0.0, 0.0)
    return _to_hex(tuple(f[i] * alpha + b[i] * (1 - alpha) for i in range(3)))  # type: ignore[arg-type]
