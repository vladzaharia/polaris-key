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
from .screen import fit_screen
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
            if (palette.color == "none" and not palette.attributes and not link) or not (s.roles or link):
                out.append(text)
                continue
            params = palette.params(s.roles) if s.roles else ""
            out.append(text, _rich_style(params, link))
    return out


def rich_console(env: TermEnv, stream: IO[str], *, width: Optional[int] = None, environ: Optional[dict] = None) -> Any:
    from rich.console import Console

    # NO_COLOR drops colour, not weight: on a terminal rich keeps bold and reverse (no_color strips the
    # colours), anywhere else it writes nothing.
    keeps_weight = env.tty and not env.dumb and not env.json
    system = {"none": "standard" if keeps_weight else None, "ansi16": "standard", "truecolor": "truecolor"}[env.color]
    kw: dict = dict(
        file=stream,
        force_terminal=env.tty and not env.dumb and not env.json,
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


def guard_sigterm(restore: Callable[[], None]) -> Callable[[], None]:
    """Run ``restore`` (give the terminal back: cooked mode, cursor, paste mode) when the process is
    terminated by SIGTERM, then let the termination go on as it would have (the previous handler,
    or the default action, so the exit status is still 128 + 15). Returns the call that removes it.
    Nothing is installed off the main thread, where Python cannot set handlers, or where the host
    ignores SIGTERM on purpose."""
    if not hasattr(signal, "SIGTERM") or threading.current_thread() is not threading.main_thread():
        return lambda: None
    prev: Any = signal.getsignal(signal.SIGTERM)
    if prev == signal.SIG_IGN:
        return lambda: None
    if not callable(prev):
        prev = signal.SIG_DFL  # getsignal says 0 or None for a handler Python did not install

    def on_term(signum: int, frame: Any) -> None:
        try:
            restore()
        except Exception:
            pass
        signal.signal(signal.SIGTERM, prev)
        if callable(prev):
            prev(signum, frame)
        else:
            os.kill(os.getpid(), signal.SIGTERM)

    try:
        signal.signal(signal.SIGTERM, on_term)
    except (ValueError, OSError):
        return lambda: None

    def undo() -> None:
        try:
            if signal.getsignal(signal.SIGTERM) is on_term:
                signal.signal(signal.SIGTERM, prev)
        except (ValueError, OSError):
            pass

    return undo


# ── Keys ─────────────────────────────────────────────────────────────────────────────────────


class KeyReader:
    """Raw keys from an interactive terminal: ``enter``, ``esc``, ``up``, ``down``, ``backspace``,
    ``ctrl-u``, or the text typed or pasted (bracketed paste is unwrapped). ``Ctrl-C`` raises
    ``KeyboardInterrupt``. POSIX through termios, Windows through msvcrt."""

    def __init__(self, stdin: Optional[IO[str]] = None, *, bracketed_paste: bool = True, wake: Optional[int] = None) -> None:
        self._in = stdin or sys.stdin
        #: A pipe the device writes to on SIGWINCH: a blocking read wakes (returning ``""``), so the
        #: flow's loop redraws at the new size without waiting for a key.
        self._wake = wake
        self._fd: Optional[int] = None
        self._old: Any = None
        self._pending = ""
        self._paste = bracketed_paste
        self._undo_term: Callable[[], None] = lambda: None

    def __enter__(self) -> "KeyReader":
        if os.name == "posix":
            import termios
            import tty

            self._fd = self._in.fileno()
            self._old = termios.tcgetattr(self._fd)
            # TCSADRAIN, never the default TCSAFLUSH: a key typed while the flow waited on the
            # network (Esc, say) is read, not thrown away.
            tty.setcbreak(self._fd, termios.TCSADRAIN)
            if self._paste:
                sys.stdout.write("\x1b[?2004h")
                sys.stdout.flush()
            self._undo_term = guard_sigterm(self._give_back)
        return self

    def _give_back(self) -> None:
        """Cooked mode, paste mode off and the cursor shown again (also from a SIGTERM handler)."""
        import termios

        if self._fd is None:
            return
        try:
            if self._paste:
                sys.stdout.write("\x1b[?2004l")
            sys.stdout.write("\x1b[?25h")
            sys.stdout.flush()
        except Exception:
            pass
        termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old)

    def __exit__(self, *exc: Any) -> None:
        if os.name == "posix" and self._fd is not None:
            import termios

            self._undo_term()
            if self._paste:
                sys.stdout.write("\x1b[?2004l")
                sys.stdout.flush()
            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old)

    def _raw(self, timeout: Optional[float]) -> str:
        if os.name == "posix":
            import select

            fds = [self._fd] + ([self._wake] if self._wake is not None else [])
            ready, _, _ = select.select(fds, [], [], timeout)  # type: ignore[list-item]
            if self._wake is not None and self._wake in ready:
                try:
                    os.read(self._wake, 4096)
                except OSError:
                    pass
                return ""
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
        #: A resize pushed the flow's header into the terminal's scrollback: it is never printed again.
        self.header_gone = False
        self._wake_r: Optional[int] = None
        self._wake_w: Optional[int] = None
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
        if self.header_gone:
            lines = [ln for ln in lines if ln.role != "header"]
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
        return KeyReader(self.inp, bracketed_paste=not self.env.dumb, wake=self._wake_fd())

    def _wake_fd(self) -> Optional[int]:
        """The read end of a pipe SIGWINCH writes to (POSIX, interactive terminals only)."""
        if os.name != "posix" or not self.env.interactive:
            return None
        if self._wake_r is None:
            try:
                self._wake_r, self._wake_w = os.pipe()
                os.set_blocking(self._wake_r, False)
                os.set_blocking(self._wake_w, False)
            except OSError:
                self._wake_r = self._wake_w = None
        return self._wake_r

    def wake(self) -> None:
        """Wake a blocking key read (a resize needs the flow to redraw)."""
        if self._wake_w is not None:
            try:
                os.write(self._wake_w, b"\0")
            except OSError:
                pass

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
    """A flow's whole screen, redrawn in place (spinners, countdowns, progress) at most every 80 ms;
    on a terminal without motion it is drawn once per change and never animated.

    The flow hands over its lines (header to key hints), as a list or a function that builds them.
    Each update lays them out spaced, compacts them to fit the terminal (``screen.fit_screen``) and
    replaces the previous frame, erased by the rows it really took on the (reflowed) screen.

    Nothing is written above the region while it is up, so no line is left at an old width: on a
    resize (SIGWINCH) the region re-reads the size at its next update, erases what it drew, and lays
    the same screen out again, as a fresh launch would. A header the resize pushed into the
    terminal's own scrollback cannot be erased: it is never printed again (``Device.header_gone``),
    so an outcome leaves one header and one result block, never the code view above it. The Node
    kit's ``LiveRegion`` behaves the same."""

    def __init__(self, device: Device) -> None:
        self.d = device
        self._frame: Optional[Frame] = None
        #: Cell widths of the lines drawn now, and how many of the leading ones are the header.
        self._drawn: List[int] = []
        self._head = 0
        self._live: Any = None
        self._lock = threading.RLock()
        self._undo_term: Callable[[], None] = lambda: None
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
        self._undo_term = guard_sigterm(lambda: (self.d.out.write("\x1b[?25h"), self.d.out.flush()))
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
        # A signal handler never writes to the terminal (it may land mid-write): it notes the resize
        # and wakes a blocking key read, and the flow's next update redraws.
        old = self._old_winch
        if callable(old):
            old(signum, frame)
        self._resize_pending = True
        self.d.wake()

    def _erase_rows(self) -> int:
        """Rows to erase before the next frame. After a resize the terminal reflowed what was drawn,
        and rows beyond its new height went into its scrollback, where they cannot be erased."""
        cols = self.d.env.columns
        if not self._resize_pending:
            return physical_rows(self._drawn, cols)
        self._resize_pending = False
        self.d.refresh_size()
        env = self.d.env
        reflowed = physical_rows(self._drawn, env.columns)
        gone = max(0, reflowed - env.height)
        if gone > 0 and self._head > 0:
            self.d.header_gone = True
        return reflowed - gone

    def update(self, frame: Frame) -> None:
        """Show ``frame`` (lines, or a function that builds them at the current size) in place of the
        last one."""
        with self._lock:
            self._frame = frame
            if self._live is not None:
                lines = list(frame() if callable(frame) else frame)
                self._live.update(to_rich(lines, self.d.palette), refresh=True)
                return
            if not self._redraws:
                return
            erase = _erase(self._erase_rows())
            lines = list(frame() if callable(frame) else frame)
            if self.d.header_gone:
                lines = [ln for ln in lines if ln.role != "header"]
            env = self.d.env
            fitted = fit_screen(lines, env.height - 1, env.width, env.symbol["separator"])
            self._drawn = self._widths(fitted.lines)
            self._head = fitted.head
            self.d.out.write(erase + "\n".join(to_ansi(ln, self.d.palette) for ln in fitted.lines))
            self.d.out.flush()

    def clear(self) -> None:
        with self._lock:
            if self._live is not None:
                self._live.update(to_rich([], self.d.palette), refresh=True)
            elif self._drawn and self._redraws:
                self.d.out.write(_erase(self._erase_rows()))
                self.d.out.flush()
            self._drawn = []
            self._frame = None
            self._head = 0

    def __exit__(self, *exc: Any) -> None:
        self.clear()
        self._listen(False)
        self._undo_term()
        self._undo_term = lambda: None
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
