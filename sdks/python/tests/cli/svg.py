"""Draw golden ANSI text as an SVG terminal (UI-KITS §7.1 Terminal): a real cell grid, 14 px
JetBrains Mono at line-height 1.2 (8.4 × 16.8 px cells), with each theme's terminal palette (the
terminal board's, docs/design/ui-kits/terminal.html).

Box-drawing rails and half blocks are drawn as geometry, edge to edge, as a terminal draws them;
every other character is text pinned to its cells. The output is a pure function of the ANSI
text, so the SVG baselines are compared byte for byte like the text goldens.
"""

from __future__ import annotations

import re
from html import escape
from typing import Dict, List, Optional, Sequence, Tuple

from polaris_key.ui.terminal.text import _char_width

CELL_W = 8.4
CELL_H = 16.8
PAD_X = 16.8
PAD_Y = 14.0

#: The terminal board's palettes (terminal.html): ANSI-16 roles follow the theme.
PALETTES: Dict[str, Dict[str, str]] = {
    "dark": {
        "bg": "#101114",
        "fg": "#d7dae0",
        "frame": "#26282e",
        "30": "#000000",
        "31": "#ef6b73",
        "32": "#5fd38d",
        "33": "#e5c07b",
        "34": "#61afef",
        "35": "#c678dd",
        "36": "#56b6c2",
        "37": "#d7dae0",
        "90": "#7f848e",
        "97": "#ffffff",
    },
    "light": {
        "bg": "#fbfbfc",
        "fg": "#24292f",
        "frame": "#dcdee3",
        "30": "#000000",
        "31": "#cf222e",
        "32": "#1a7f37",
        "33": "#9a6700",
        "34": "#0969da",
        "35": "#8250df",
        "36": "#1b7c83",
        "37": "#6e7781",
        "90": "#6e7781",
        "97": "#ffffff",
    },
}

_SGR = re.compile(r"\x1b\[([0-9;]*)m")
_OSC8 = re.compile(r"\x1b\]8;[^;]*;[^\x1b]*\x1b\\")

Cell = Tuple[str, Optional[str], Optional[str], bool, bool]  # char, fg, bg, bold, underline


def _rgb(params: Sequence[str]) -> str:
    return "#%02x%02x%02x" % (int(params[0]), int(params[1]), int(params[2]))


def parse(text: str, theme: str) -> List[List[Cell]]:
    """ANSI text into rows of cells (fg and bg resolved against ``theme``'s palette)."""
    pal = PALETTES[theme]
    rows: List[List[Cell]] = []
    for raw in text.split("\n"):
        raw = _OSC8.sub("", raw)
        row: List[Cell] = []
        fg: Optional[str] = None
        bg: Optional[str] = None
        bold = under = rev = False
        pos = 0
        for m in list(_SGR.finditer(raw)) + [None]:
            chunk = raw[pos : m.start()] if m else raw[pos:]
            for ch in chunk:
                f, b = (bg or pal["bg"], fg or pal["fg"]) if rev else (fg, bg)
                row.append((ch, f, b, bold, under))
                if _char_width(ch) == 2:
                    row.append(("", f, b, bold, under))
            if m is None:
                break
            pos = m.end()
            codes = [c for c in m.group(1).split(";") if c] or ["0"]
            i = 0
            while i < len(codes):
                c = codes[i]
                if c in ("38", "48") and i + 4 < len(codes) and codes[i + 1] == "2":
                    color = _rgb(codes[i + 2 : i + 5])
                    if c == "38":
                        fg = color
                    else:
                        bg = color
                    i += 5
                    continue
                n = int(c)
                if n == 0:
                    fg = bg = None
                    bold = under = rev = False
                elif n == 1:
                    bold = True
                elif n == 4:
                    under = True
                elif n == 7:
                    rev = True
                elif 30 <= n <= 37 or 90 <= n <= 97:
                    fg = pal.get(c, pal["fg"])
                elif 40 <= n <= 47:
                    bg = pal.get(str(n - 10), pal["bg"])
                elif 100 <= n <= 107:
                    bg = pal.get(str(n - 10), pal["bg"])
                i += 1
        rows.append(row)
    while rows and not rows[-1]:
        rows.pop()
    return rows


def _f(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s or "0"


def render(text: str, theme: str, cols: int, title: str = "") -> str:
    """The SVG for ``text`` at ``cols`` columns in ``theme``."""
    pal = PALETTES[theme]
    rows = parse(text, theme)
    width = cols * CELL_W + 2 * PAD_X
    height = max(len(rows), 1) * CELL_H + 2 * PAD_Y
    out: List[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_f(width)}" height="{_f(height)}" viewBox="0 0 {_f(width)} {_f(height)}" role="img" aria-label="{escape(title)}">',
        f'<rect width="{_f(width)}" height="{_f(height)}" rx="12" fill="{pal["bg"]}" stroke="{pal["frame"]}"/>',
        '<g font-family="JetBrains Mono, ui-monospace, monospace" font-size="14" xml:space="preserve">',
    ]
    for y, row in enumerate(rows):
        top = PAD_Y + y * CELL_H
        # Backgrounds, merged per run.
        x = 0
        while x < len(row):
            bg = row[x][2]
            if bg is None:
                x += 1
                continue
            start = x
            while x < len(row) and row[x][2] == bg:
                x += 1
            out.append(f'<rect x="{_f(PAD_X + start * CELL_W)}" y="{_f(top)}" width="{_f((x - start) * CELL_W)}" height="{_f(CELL_H)}" fill="{bg}"/>')
        # Glyphs: geometry for rails and blocks, text runs for the rest.
        x = 0
        while x < len(row):
            ch, fg, _, bold, under = row[x]
            color = fg or pal["fg"]
            left = PAD_X + x * CELL_W
            mid_x = left + CELL_W / 2
            mid_y = top + CELL_H / 2
            if ch in "│┌└━▀▄█":
                if ch == "│":
                    out.append(f'<rect x="{_f(mid_x - 0.5)}" y="{_f(top)}" width="1" height="{_f(CELL_H)}" fill="{color}"/>')
                elif ch == "┌":
                    out.append(f'<rect x="{_f(mid_x - 0.5)}" y="{_f(mid_y)}" width="1" height="{_f(CELL_H / 2)}" fill="{color}"/>')
                    out.append(f'<rect x="{_f(mid_x - 0.5)}" y="{_f(mid_y - 0.5)}" width="{_f(CELL_W / 2 + 0.5)}" height="1" fill="{color}"/>')
                elif ch == "└":
                    out.append(f'<rect x="{_f(mid_x - 0.5)}" y="{_f(top)}" width="1" height="{_f(CELL_H / 2)}" fill="{color}"/>')
                    out.append(f'<rect x="{_f(mid_x - 0.5)}" y="{_f(mid_y - 0.5)}" width="{_f(CELL_W / 2 + 0.5)}" height="1" fill="{color}"/>')
                elif ch == "━":
                    out.append(f'<rect x="{_f(left)}" y="{_f(mid_y - 1.2)}" width="{_f(CELL_W)}" height="2.4" fill="{color}"/>')
                elif ch == "▀":
                    out.append(f'<rect x="{_f(left)}" y="{_f(top)}" width="{_f(CELL_W)}" height="{_f(CELL_H / 2)}" fill="{color}"/>')
                elif ch == "▄":
                    out.append(f'<rect x="{_f(left)}" y="{_f(mid_y)}" width="{_f(CELL_W)}" height="{_f(CELL_H / 2)}" fill="{color}"/>')
                else:
                    out.append(f'<rect x="{_f(left)}" y="{_f(top)}" width="{_f(CELL_W)}" height="{_f(CELL_H)}" fill="{color}"/>')
                x += 1
                continue
            if ch in (" ", ""):
                if under and ch == " ":
                    out.append(f'<rect x="{_f(left)}" y="{_f(top + CELL_H - 2.6)}" width="{_f(CELL_W)}" height="1" fill="{color}"/>')
                x += 1
                continue
            attrs = f' fill="{color}"'
            if bold:
                attrs += ' font-weight="600"'
            if under:
                attrs += ' text-decoration="underline"'
            if ord(ch) >= 0x2000:
                # A symbol is pinned to its own cells, centred, as a terminal draws it.
                cells = 2 if _char_width(ch) == 2 else 1
                out.append(f'<text x="{_f(left + cells * CELL_W / 2)}" y="{_f(top + 12.6)}" text-anchor="middle"{attrs}>{escape(ch)}</text>')
                x += cells
                continue
            start = x
            text = ""
            while x < len(row):
                c2, fg2, _, b2, u2 = row[x]
                if (fg2 or pal["fg"]) != color or b2 != bold or u2 != under or (c2 and ord(c2) >= 0x2000) or c2 == "":
                    break
                text += c2
                x += 1
            trimmed = text.rstrip(" ")
            cells = len(trimmed)
            if under and trimmed != text:
                cells = len(text)
                trimmed = text
            out.append(
                f'<text x="{_f(PAD_X + start * CELL_W)}" y="{_f(top + 12.6)}" textLength="{_f(cells * CELL_W)}" lengthAdjust="spacingAndGlyphs"{attrs}>{escape(trimmed)}</text>'
            )
    out.append("</g></svg>")
    return "\n".join(out) + "\n"
