"""What the terminal can do, read once per command (docs/design/UI-KITS.md §1.4 Terminal, §4.8).

* **Colour.** ``NO_COLOR`` (any non-empty value), ``--no-color``, ``TERM=dumb`` and a stdout that is
  not a terminal drop every escape; ``FORCE_COLOR`` keeps them on a pipe. Status roles are
  ANSI-16; truecolor is used for the product accent only with ``COLORTERM=truecolor`` or ``24bit``.
* **Symbols.** Unicode, or ASCII with ``--ascii``, ``theme.symbols = "ascii"`` or ``TERM=dumb``.
* **Width.** The layout targets 80 columns and degrades to 60; a narrower terminal still gets 60.
* **Scheme.** The theme's ``color_scheme``, then ``PKEY_THEME``, then the terminal's background
  (OSC 11, asked only on an interactive terminal and only when the answer matters: truecolor, or
  no colour, where the QR inverts), then ``COLORFGBG``, then dark.
* **Motion.** Spinners animate only on an interactive terminal, never with ``CI`` set, ``TERM=dumb``
  or ``theme.motion`` reduced or none (UI-KITS §4.8).
* **Headless** (SIGN-IN.md D-68): ``SSH_CONNECTION`` or ``SSH_TTY``; on Linux no ``DISPLAY`` and no
  ``WAYLAND_DISPLAY``; ``CI``. Sign-in then goes straight to the code.
"""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass, replace
from typing import IO, Any, Callable, Mapping, Optional

from .. import ansi

__all__ = ["TermEnv", "detect", "parse_colorfgbg", "parse_osc11"]


@dataclass(frozen=True)
class TermEnv:
    #: stdout is a terminal (or colour is forced).
    tty: bool = False
    #: stdin and stdout are terminals and no CI runs: the kit may prompt and read keys.
    interactive: bool = False
    color: str = "none"
    symbols: str = "unicode"
    #: Layout width in cells, 60 to 80.
    width: int = ansi.LAYOUT["columns"]
    #: Terminal rows, for the QR's 20-row floor.
    height: int = 24
    #: ``"dark"`` or ``"light"``: the terminal's background.
    scheme: str = "dark"
    hyperlinks: bool = False
    #: OSC 52 copy: an interactive terminal that is not ``TERM=dumb``.
    clipboard: bool = False
    motion: bool = False
    headless: bool = False
    #: ``--json``: one JSON object per state on stdout, no prompts, no escapes.
    json: bool = False

    @property
    def symbol(self) -> Mapping[str, str]:
        return ansi.SYMBOLS[self.symbols]

    def but(self, **changes: Any) -> "TermEnv":
        return replace(self, **changes)


def parse_colorfgbg(value: Optional[str]) -> Optional[str]:
    """``COLORFGBG`` (``"15;0"``, ``"0;default;15"``): the background's scheme, or ``None``."""
    if not value:
        return None
    last = value.split(";")[-1].strip()
    if not last.isdigit():
        return None
    bg = int(last)
    return "light" if bg in (7, 9, 10, 11, 12, 13, 14, 15) else "dark"


def parse_osc11(reply: str) -> Optional[str]:
    """An OSC 11 answer (``ESC ] 11 ; rgb:ffff/ffff/ffff ESC \\``): the scheme, or ``None``."""
    i = reply.find("rgb:")
    if i < 0:
        return None
    body = reply[i + 4 :]
    for stop in ("\x1b", "\x07"):
        j = body.find(stop)
        if j >= 0:
            body = body[:j]
    parts = body.split("/")
    if len(parts) != 3:
        return None
    try:
        rgb = [int(p, 16) / (16 ** len(p) - 1) for p in parts]
    except ValueError:
        return None
    luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    return "light" if luminance > 0.5 else "dark"


def query_osc11(timeout: float = 0.12) -> Optional[str]:
    """Ask the terminal for its background (POSIX only). ``None`` when it does not answer in
    ``timeout`` seconds, or when there is no controlling terminal."""
    if os.name != "posix":
        return None
    try:
        import select
        import termios
        import tty as _tty

        fd = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
    except Exception:
        return None
    try:
        old = termios.tcgetattr(fd)
        try:
            _tty.setraw(fd)
            os.write(fd, b"\x1b]11;?\x1b\\")
            buf = b""
            while True:
                ready, _, _ = select.select([fd], [], [], timeout)
                if not ready:
                    break
                buf += os.read(fd, 64)
                if buf.endswith(b"\x1b\\") or buf.endswith(b"\x07"):
                    break
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        return parse_osc11(buf.decode("ascii", "replace")) if buf else None
    except Exception:
        return None
    finally:
        os.close(fd)


def _isatty(stream: Any) -> bool:
    try:
        return bool(stream.isatty())
    except Exception:
        return False


def detect(
    *,
    env: Optional[Mapping[str, str]] = None,
    stdout: Optional[IO[str]] = None,
    stdin: Optional[IO[str]] = None,
    no_color: bool = False,
    ascii: bool = False,
    json: bool = False,
    device_code: bool = False,
    color_scheme: str = "system",
    symbols: str = "auto",
    motion: str = "system",
    platform: Optional[str] = None,
    size: Optional[Callable[[], "os.terminal_size"]] = None,
    osc11: Optional[Callable[[], Optional[str]]] = None,
) -> TermEnv:
    """Read the environment, the streams and the command's flags into a :class:`TermEnv`."""
    e = os.environ if env is None else env
    out = sys.stdout if stdout is None else stdout
    inp = sys.stdin if stdin is None else stdin
    plat = sys.platform if platform is None else platform
    term = e.get("TERM", "")
    dumb = term == "dumb"
    ci = bool(e.get("CI"))
    forced = bool(e.get("FORCE_COLOR")) and e.get("FORCE_COLOR") != "0"
    out_tty = _isatty(out)
    tty = out_tty or forced
    interactive = out_tty and _isatty(inp) and not ci and not json

    if json or no_color or bool(e.get("NO_COLOR")) or dumb or not tty:
        color = "none"
    elif e.get("COLORTERM", "").lower() in ("truecolor", "24bit"):
        color = "truecolor"
    else:
        color = "ansi16"

    sym = symbols if symbols in ("unicode", "ascii") else ("ascii" if (ascii or dumb) else "unicode")
    if ascii:
        sym = "ascii"

    try:
        cols, rows = (size or shutil.get_terminal_size)()
    except Exception:
        cols, rows = ansi.LAYOUT["columns"], 24
    width = ansi.LAYOUT["columns"] if not out_tty else min(ansi.LAYOUT["columns"], max(ansi.LAYOUT["minColumns"], cols))

    scheme: Optional[str] = color_scheme if color_scheme in ("dark", "light") else None
    if scheme is None and e.get("PKEY_THEME") in ("dark", "light"):
        scheme = e["PKEY_THEME"]
    # The background matters for the truecolor accent and for a QR drawn without colour; only
    # then is the terminal asked, so a terminal that never answers costs nothing elsewhere.
    if scheme is None and interactive and not dumb and color in ("truecolor", "none"):
        scheme = (osc11 or query_osc11)()
    if scheme is None:
        scheme = parse_colorfgbg(e.get("COLORFGBG"))
    scheme = scheme or "dark"

    headless = (
        device_code
        or bool(e.get("SSH_CONNECTION") or e.get("SSH_TTY"))
        or ci
        or (plat.startswith("linux") and not e.get("DISPLAY") and not e.get("WAYLAND_DISPLAY"))
    )
    return TermEnv(
        tty=tty,
        interactive=interactive,
        color=color,
        symbols=sym,
        width=width,
        height=rows if out_tty else 24,
        scheme=scheme,
        hyperlinks=color != "none" and not dumb,
        clipboard=interactive and not dumb,
        motion=interactive and not dumb and motion == "system",
        headless=headless,
        json=json,
    )
