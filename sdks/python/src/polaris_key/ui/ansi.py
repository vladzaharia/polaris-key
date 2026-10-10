# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
# packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
# `pnpm gen brand --check` fails the green gate on any difference. To change a value, edit
# its source and regenerate.
"""ANSI tables for the terminal kit (docs/design/UI-KITS.md §2.1 "Terminal").

Status roles map to the ANSI-16 palette so they follow the user's terminal theme; truecolor is used
only for the product accent, and only when COLORTERM is "truecolor" or "24bit". NO_COLOR,
`--no-color` and a non-TTY stdout drop every escape; TERM=dumb or `--ascii` selects ASCII symbols.
"""

from __future__ import annotations

#: SGR parameters per role (ESC [ <sgr> m). "accent" is the fallback without truecolor.
SGR = {
    "accent": "36",
    "success": "32",
    "warning": "33",
    "danger": "31",
    "info": "35",
    "muted": "2",
    "strong": "1",
    "link": "4",
    "chip": "7",
    "reset": "0",
}

#: Symbols, Unicode and ASCII.
SYMBOLS = {
    "unicode": {
        "stepActive": "◆",
        "stepDone": "◇",
        "ok": "✓",
        "fail": "✗",
        "warn": "▲",
        "radioOn": "●",
        "radioOff": "○",
        "rail": "│",
        "railStart": "┌",
        "railEnd": "└",
        "barFull": "━",
        "barEmpty": "─",
        "separator": "·",
        "ellipsis": "…",
        "arrows": "↑↓",
    },
    "ascii": {
        "stepActive": "*",
        "stepDone": "o",
        "ok": "+",
        "fail": "x",
        "warn": "!",
        "radioOn": "(*)",
        "radioOff": "( )",
        "rail": "|",
        "railStart": "+",
        "railEnd": "`",
        "barFull": "#",
        "barEmpty": "-",
        "separator": "-",
        "ellipsis": "...",
        "arrows": "^v",
    },
}

#: The waiting spinner: frames and the frame time (ms).
SPINNER = {
    "unicode": ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    "ascii": ["|", "/", "-", "\\"],
    "frameMs": 80,
}

#: Layout: target width, the narrowest supported width, the rail gutter and the bar width (cells).
LAYOUT = {
    "columns": 80,
    "minColumns": 60,
    "gutter": 2,
    "barWidth": 36,
}


def sgr(role: str) -> str:
    """The escape sequence that starts `role`."""
    return "\x1b[" + SGR[role] + "m"


def truecolor(hex_color: str) -> str:
    """The 24-bit foreground escape for `hex_color` ("#rrggbb")."""
    h = hex_color.lstrip("#")
    return "\x1b[38;2;%d;%d;%dm" % (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
