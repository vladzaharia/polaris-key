"""The terminal itself: writing lines (through rich when it is installed), a live region that
redraws in place, raw keys, OSC 52 copy and opening the browser.

**rich** (the ``[cli]`` extra) is the renderer when it is importable: lines become ``rich.text.Text``
with styles built from the same SGR parameters :func:`~.text.to_ansi` writes, printed through a
``rich.console.Console`` whose colour system the kit chose (so ``NO_COLOR`` and pipes stay plain),
and live regions use ``rich.live.Live``. rich also brings colour to legacy Windows consoles.
Without rich the kit writes :func:`~.text.to_ansi`'s bytes itself: the same output on any VT
terminal, so rich is never a hard requirement.
"""

from __future__ import annotations

import base64
import json as _json
import os
import shutil
import signal
import sys
import threading
import time
from typing import IO, Any, Callable, Iterable, List, Optional, Sequence, Tuple, Union

from .env import TermEnv
from .text import Line, Palette, Span, _merge, cell_len, clean, safe_link, to_ansi

__all__ = ["Device", "KeyReader", "LiveRegion", "physical_rows", "rich_available", "to_rich"]


def rich_available() -> bool:
    try:
        import rich  # noqa: F401
    except Exception:
        return False
    return True


# ── rich ─────────────────────────────────────────────────────────────────────────────────────


def _rich_style(params: str, link: Optional[str]) -> Any:
    from rich.color import Color
    from rich.style import Style

    kw: dict = {}
    codes = [c for c in params.split(";") if c] if params else []
    i = 0
    while i < len(codes):
        c = int(codes[i])
        if c in (38, 48) and i + 4 < len(codes) and codes[i + 1] == "2":
            rgb = Color.from_rgb(int(codes[i + 2]), int(codes[i + 3]), int(codes[i + 4]))
            kw["color" if c == 38 else "bgcolor"] = rgb
            i += 5
            continue
        if c == 1:
            kw["bold"] = True
        elif c == 2:
            kw["dim"] = True
        elif c == 3:
            kw["italic"] = True
        elif c == 4:
            kw["underline"] = True
        elif c == 7:
            kw["reverse"] = True
        elif 30 <= c <= 37:
            kw["color"] = Color.from_ansi(c - 30)
        elif 90 <= c <= 97:
            kw["color"] = Color.from_ansi(c - 90 + 8)
        elif 40 <= c <= 47:
            kw["bgcolor"] = Color.from_ansi(c - 40)
        elif 100 <= c <= 107:
            kw["bgcolor"] = Color.from_ansi(c - 100 + 8)
        i += 1
    if link:
        kw["link"] = link
    return Style(**kw)


def to_rich(lines: Iterable[Line], palette: Palette) -> Any:
    """``lines`` as one ``rich.text.Text`` (newline-separated), styled as :func:`to_ansi` styles."""
    from rich.text import Text

    out = Text(end="")
    first = True
    for line in lines:
        if not first:
            out.append("\n")
        first = False
        spans = _merge(line.spans)
        while spans and not spans[-1].roles and spans[-1].text != spans[-1].text.rstrip(" "):
            last = spans[-1]
            spans = spans[:-1] + ([Span(last.text.rstrip(" "), last.roles, last.link, last.src)] if last.text.strip() else [])
        for s in spans:
            text = clean(s.text)
            link = safe_link(s.link) if palette.hyperlinks else None
            if palette.color == "none" or not (s.roles or link):
                out.append(text)
                continue
            params = palette.params(s.roles) if s.roles else ""
            out.append(text, _rich_style(params, link))
    return out


def rich_console(env: TermEnv, stream: IO[str], *, width: Optional[int] = None, environ: Optional[dict] = None) -> Any:
    from rich.console import Console

    system = {"none": None, "ansi16": "standard", "truecolor": "truecolor"}[env.color]
    kw: dict = dict(
        file=stream,
        force_terminal=env.tty and env.color != "none",
        color_system=system,
        no_color=env.color == "none",
        highlight=False,
        emoji=False,
        markup=False,
        soft_wrap=True,
    )
    if width is not None:
        kw["width"] = width
    if environ is not None:
        kw["_environ"] = environ
        kw["legacy_windows"] = False
    return Console(**kw)


# ── Keys ─────────────────────────────────────────────────────────────────────────────────────


class KeyReader:
    """Raw keys from an interactive terminal: ``enter``, ``esc``, ``up``, ``down``, ``backspace``,
    ``ctrl-u``, or the text typed or pasted (bracketed paste is unwrapped). ``Ctrl-C`` raises
    ``KeyboardInterrupt``. POSIX through termios, Windows through msvcrt."""

    def __init__(self, stdin: Optional[IO[str]] = None, *, bracketed_paste: bool = True) -> None:
        self._in = stdin or sys.stdin
        self._fd: Optional[int] = None
        self._old: Any = None
        self._pending = ""
        self._paste = bracketed_paste

    def __enter__(self) -> "KeyReader":
        if os.name == "posix":
            import termios
            import tty

            self._fd = self._in.fileno()
            self._old = termios.tcgetattr(self._fd)
            tty.setcbreak(self._fd)
            if self._paste:
                sys.stdout.write("\x1b[?2004h")
                sys.stdout.flush()
        return self

    def __exit__(self, *exc: Any) -> None:
        if os.name == "posix" and self._fd is not None:
            import termios

            if self._paste:
                sys.stdout.write("\x1b[?2004l")
                sys.stdout.flush()
            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old)

    def _raw(self, timeout: Optional[float]) -> str:
        if os.name == "posix":
            import select

            ready, _, _ = select.select([self._fd], [], [], timeout)
            if not ready:
                return ""
            data = os.read(self._fd, 4096)  # type: ignore[arg-type]
            return data.decode("utf-8", "replace")
        import msvcrt  # type: ignore[import-not-found]

        deadline = None if timeout is None else time.monotonic() + timeout
        while not msvcrt.kbhit():  # type: ignore[attr-defined]
            if deadline is not None and time.monotonic() >= deadline:
                return ""
            time.sleep(0.01)
        ch = msvcrt.getwch()  # type: ignore[attr-defined]
        if ch in ("\x00", "\xe0"):
            code = msvcrt.getwch()  # type: ignore[attr-defined]
            return {"H": "\x1b[A", "P": "\x1b[B"}.get(code, "")
        return ch

    def read(self, timeout: Optional[float] = None) -> Optional[str]:
        buf = self._pending or self._raw(timeout)
        self._pending = ""
        if not buf:
            return None
        if buf.startswith("\x1b[200~"):
            end = buf.find("\x1b[201~")
            while end < 0:
                more = self._raw(0.2)
                if not more:
                    break
                buf += more
                end = buf.find("\x1b[201~")
            body = buf[6:end] if end >= 0 else buf[6:]
            self._pending = buf[end + 6 :] if end >= 0 else ""
            return body
        if buf == "\x1b":
            more = self._raw(0.05)
            if not more:
                return "esc"
            buf += more
        if buf.startswith("\x1b["):
            seq, self._pending = buf[:3], buf[3:]
            return {"\x1b[A": "up", "\x1b[B": "down"}.get(seq, "")
        ch, self._pending = buf[0], buf[1:]
        if ch == "\x03":
            raise KeyboardInterrupt
        if ch in ("\r", "\n"):
            return "enter"
        if ch in ("\x7f", "\x08"):
            return "backspace"
        if ch == "\x15":
            return "ctrl-u"
        if ch == "\x1b":
            return "esc"
        if ord(ch) < 32:
            return ""
        # Group a burst of printable characters (a paste without bracketed paste).
        text = ch
        while self._pending and ord(self._pending[0]) >= 32 and self._pending[0] != "\x7f":
            text, self._pending = text + self._pending[0], self._pending[1:]
        return text


# ── The device ───────────────────────────────────────────────────────────────────────────────


def _enable_vt() -> bool:
    """Turn on virtual-terminal processing for this Windows console (Windows 10 and later), so
    escapes draw instead of printing. False when the console cannot."""
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


class Device:
    """Where a flow's lines go. ``print`` writes lines, ``live`` redraws a region in place,
    ``keys`` reads raw keys, ``emit`` writes one JSON object per line (``--json``)."""

    def __init__(
        self,
        env: TermEnv,
        palette: Palette,
        *,
        stdout: Optional[IO[str]] = None,
        stdin: Optional[IO[str]] = None,
        use_rich: Optional[bool] = None,
        size: Optional[Callable[[], Tuple[int, int]]] = None,
    ) -> None:
        self.env = env
        self.palette = palette
        self.out = stdout or sys.stdout
        self.inp = stdin or sys.stdin
        self.use_rich = rich_available() if use_rich is None else use_rich
        self._console: Any = None
        self._size = size
        self._resized: List[Callable[[TermEnv], None]] = []
        if not self.use_rich and env.color != "none" and os.name == "nt" and not _enable_vt():
            # A legacy Windows console without virtual-terminal processing: plain lines.
            self.palette = Palette(color="none")

    @property
    def console(self) -> Any:
        if self._console is None:
            self._console = rich_console(self.env, self.out)
        return self._console

    def size(self) -> Tuple[int, int]:
        """The terminal's size now (columns, rows)."""
        if self._size is not None:
            return self._size()
        try:
            sz = os.get_terminal_size(self.out.fileno())
        except Exception:
            sz = shutil.get_terminal_size((self.env.columns, self.env.height))
        return sz.columns, sz.lines

    def on_resize(self, fn: Callable[[TermEnv], None]) -> None:
        """Call ``fn`` with the new :class:`TermEnv` when the terminal changes size."""
        self._resized.append(fn)

    def refresh_size(self) -> None:
        """Re-read the terminal's size into ``env`` (and every ``on_resize`` listener: the kit)."""
        try:
            cols, rows = self.size()
        except Exception:
            return
        if (cols, rows) == (self.env.columns, self.env.height):
            return
        self.env = self.env.resized(cols, rows)
        for fn in self._resized:
            fn(self.env)

    def print(self, lines: Sequence[Line]) -> None:
        if self.env.json or not lines:
            return
        if self.use_rich:
            self.console.print(to_rich(lines, self.palette))
        else:
            for line in lines:
                self.out.write(to_ansi(line, self.palette) + "\n")
            self.out.flush()

    def emit(self, obj: dict) -> None:
        # ASCII only: every control and C1 character in server text is escaped (\u001b, \u009b).
        self.out.write(_json.dumps(obj, ensure_ascii=True, sort_keys=False) + "\n")
        self.out.flush()

    def keys(self) -> KeyReader:
        return KeyReader(self.inp, bracketed_paste=not self.env.dumb)

    def live(self) -> "LiveRegion":
        return LiveRegion(self)

    def copy(self, text: str) -> bool:
        """OSC 52: put ``text`` on the clipboard of the terminal the person is looking at (over SSH
        too). Terminals that do not support it ignore the sequence."""
        if not self.env.clipboard:
            return False
        payload = base64.b64encode(text.encode("utf-8")).decode("ascii")
        self.out.write(f"\x1b]52;c;{payload}\x07")
        self.out.flush()
        return True

    @staticmethod
    def open_url(url: str) -> bool:
        """Open ``url`` in the browser: only an ``https`` (or loopback ``http``) URL with no control
        character, whatever the server sent."""
        if not safe_link(url):
            return False
        try:
            import webbrowser

            return bool(webbrowser.open(url))
        except Exception:
            return False


Frame = Union[Sequence[Line], Callable[[], Sequence[Line]]]


def physical_rows(widths: Sequence[int], columns: int) -> int:
    """Rows lines of these cell widths take on a terminal ``columns`` wide (a wider line wraps)."""
    c = max(1, columns)
    return sum(max(1, -(-w // c)) for w in widths)


def _erase(rows: int) -> str:
    """Erase ``rows`` rows ending at the cursor's, leaving it at the start of the first."""
    if rows <= 0:
        return ""
    return "\r" + (f"\x1b[{rows - 1}A" if rows > 1 else "") + "\x1b[J"


class LiveRegion:
    """Lines redrawn in place (spinners, countdowns, progress) at most every 80 ms; on a terminal
    without motion the region is drawn once per change and never animated.

    Each frame replaces the last, erased by the rows its lines really took on the screen (a line
    wider than the terminal wraps). A frame taller than the terminal does not fit: the lines at its
    top that do not fit (the header first) are printed once above the region and scroll away, so the
    rows that matter at the bottom (the code, the URL, the key hints) stay in view and redraw
    cleanly; rich's ``Live`` would crop them to "...".

    On SIGWINCH the region re-reads the size, erases what it drew by the rows that now take on the
    reflowed screen (with the lines it printed above, when they are still all on it) and draws its
    frame again at the new width: pass ``update`` a function to have it laid out again. Narrowing a
    terminal mid-flow never leaves a duplicated header, a stack of progress bars or a line wider than
    the screen. The Node kit's ``LiveRegion`` behaves the same."""

    def __init__(self, device: Device) -> None:
        self.d = device
        self._frame: Optional[Frame] = None
        #: Cell widths of the lines drawn now.
        self._drawn: List[int] = []
        #: Lines at the top of the frame already printed above the region, and their widths.
        self._head = 0
        self._head_widths: List[int] = []
        self._live: Any = None
        self._lock = threading.Lock()
        self._resize_pending = False
        self._old_winch: Any = None
        self._winch = False

    @property
    def _redraws(self) -> bool:
        """A region redraws on an interactive terminal (key entry needs it even with motion off;
        motion only decides whether spinners turn), never on ``TERM=dumb``."""
        return (self.d.env.interactive or self.d.env.motion) and not self.d.env.dumb

    @staticmethod
    def _widths(lines: Sequence[Line]) -> List[int]:
        return [cell_len(clean(line.text).rstrip()) for line in lines]

    def __enter__(self) -> "LiveRegion":
        if not self._redraws:
            return self
        if self.d.use_rich and getattr(self.d.console, "legacy_windows", False):
            # A legacy Windows console takes no cursor escapes: rich drives it through the console API.
            from rich.live import Live

            self._live = Live(console=self.d.console, auto_refresh=False, transient=True, redirect_stdout=False, redirect_stderr=False)
            self._live.__enter__()
            return self
        self.d.out.write("\x1b[?25l")
        self.d.out.flush()
        self._listen(True)
        return self

    def _listen(self, on: bool) -> None:
        """Take SIGWINCH while the region is up (main thread only; the previous handler still runs)."""
        if on == self._winch or not hasattr(signal, "SIGWINCH"):
            return
        if threading.current_thread() is not threading.main_thread():
            return
        try:
            if on:
                self._old_winch = signal.signal(signal.SIGWINCH, self._on_winch)
            else:
                signal.signal(signal.SIGWINCH, self._old_winch if self._old_winch is not None else signal.SIG_DFL)
        except (ValueError, OSError):
            return
        self._winch = on

    def _on_winch(self, signum: int, frame: Any) -> None:
        old = self._old_winch
        if callable(old):
            old(signum, frame)
        self.resize()

    def _place(self, lines: Sequence[Line]) -> str:
        """The frame's lines from the head on, printing any that do not fit above the region."""
        widths = self._widths(lines)
        cols, rows = self.d.env.columns, self.d.env.height
        start = min(self._head, len(lines))
        while start < len(lines) - 1 and physical_rows(widths[start:], cols) > rows:
            start += 1
        out = ""
        if start > self._head:
            out += "".join(to_ansi(ln, self.d.palette) + "\n" for ln in lines[self._head : start])
            self._head_widths += widths[self._head : start]
            self._head = start
        out += "\n".join(to_ansi(ln, self.d.palette) for ln in lines[start:])
        self._drawn = widths[start:]
        return out

    def update(self, frame: Frame) -> None:
        """Show ``frame`` (lines, or a function that draws them at the current size) in place of the
        last one."""
        with self._lock:
            self._frame = frame
            lines = list(frame() if callable(frame) else frame)
            if self._live is not None:
                self._live.update(to_rich(lines, self.d.palette), refresh=True)
                return
            if not self._redraws:
                return
            out = _erase(physical_rows(self._drawn, self.d.env.columns)) + self._place(lines)
            self.d.out.write(out)
            self.d.out.flush()
            if self._resize_pending:
                self._resize()

    def resize(self) -> None:
        """The terminal changed size (SIGWINCH): lay the region out again. Safe from a signal
        handler: a resize that lands mid-draw runs when that draw ends."""
        if not self._lock.acquire(blocking=False):
            self._resize_pending = True
            return
        try:
            self._resize()
        finally:
            self._lock.release()

    def _resize(self) -> None:
        self._resize_pending = False
        self.d.refresh_size()
        if self._frame is None or self._live is not None or not self._redraws:
            return
        cols, rows = self.d.env.columns, self.d.env.height
        n = physical_rows(self._drawn, cols)
        head = physical_rows(self._head_widths, cols) if self._head else 0
        if self._head and head + n <= rows:
            # The lines printed above are all still on the screen: lay them out again too.
            n += head
            self._head, self._head_widths = 0, []
        frame = self._frame
        lines = list(frame() if callable(frame) else frame)
        self._drawn = []
        self.d.out.write(_erase(n) + self._place(lines))
        self.d.out.flush()

    def clear(self) -> None:
        with self._lock:
            if self._live is not None:
                self._live.update(to_rich([], self.d.palette), refresh=True)
            elif self._drawn and self._redraws:
                self.d.out.write(_erase(physical_rows(self._drawn, self.d.env.columns)))
                self.d.out.flush()
            self._drawn = []
            self._frame = None
            self._head, self._head_widths = 0, []

    def __exit__(self, *exc: Any) -> None:
        self.clear()
        self._listen(False)
        if self._live is not None:
            self._live.__exit__(None, None, None)
        elif self._redraws:
            self.d.out.write("\x1b[?25h")
            self.d.out.flush()


def run_in_thread(fn: Callable[[], Any]) -> "Worker":
    w = Worker(fn)
    w.start()
    return w


class Worker(threading.Thread):
    """A call on a daemon thread, with its result or exception kept for the flow."""

    def __init__(self, fn: Callable[[], Any]) -> None:
        super().__init__(daemon=True)
        self._fn = fn
        self.result: Any = None
        self.error: Optional[BaseException] = None

    def run(self) -> None:
        try:
            self.result = self._fn()
        except BaseException as e:  # handed to the flow, which reports it
            self.error = e
