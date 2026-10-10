"""A program on a real pseudo-terminal with pyte as the terminal (``pyterm.Term``): it answers the
OSC 11 and cursor-position questions as a person's terminal does, resizes the window (the process
gets SIGWINCH from the kernel) and reflows what was drawn."""

from __future__ import annotations

import codecs
import fcntl
import os
import select
import signal
import struct
import sys
import termios
import time
import warnings
from typing import Callable, Dict, List, Optional

from .pyterm import Term

CHILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pty_flow.py")


class PtyRun:
    def __init__(self, cols: int, rows: int, *args: str, env: Optional[Dict[str, str]] = None, answer_osc11: bool = True, answer_cpr: bool = True) -> None:
        import pty

        self.term = Term(cols, rows)
        self.answer_osc11 = answer_osc11
        self.answer_cpr = answer_cpr
        self.raw = ""
        self.osc11_seen = False
        self.osc11_at: Optional[float] = None
        self.exited_at: Optional[float] = None
        self.cpr_asked = 0
        self.status: Optional[int] = None
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.t0 = time.monotonic()
        child_env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", LANG="en_US.UTF-8", DISPLAY=":0")
        for name in ("PKEY_THEME", "CI", "NO_COLOR", "SSH_CONNECTION", "SSH_TTY"):
            child_env.pop(name, None)
        child_env.update(env or {})
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            pid, master = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.execve(sys.executable, [sys.executable, CHILD, *args], child_env)
        self.pid, self.master = pid, master
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    # ── the terminal's side ─────────────────────────────────────────────────────────────────

    def pump(self, seconds: float = 0.1) -> None:
        """Read what the program wrote for up to ``seconds``, draw it and answer its questions."""
        end = time.monotonic() + seconds
        while self.status is None:
            left = end - time.monotonic()
            if left <= 0:
                return
            ready, _, _ = select.select([self.master], [], [], min(left, 0.05))
            if not ready:
                self._reap()
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                data = b""
            if not data:
                self._reap(block=True)
                return
            self._take(data)

    def _take(self, data: bytes) -> None:
        """Draw what the program wrote and answer its questions."""
        text = self._decoder.decode(data)
        self.raw += text
        self.term.write(text)
        if "\x1b]11;?" in text:
            self.osc11_seen = True
            if self.osc11_at is None:
                self.osc11_at = time.monotonic()
            if self.answer_osc11:
                os.write(self.master, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        if "\x1b[6n" in text:
            self.cpr_asked += 1
            if self.answer_cpr:
                s = self.term.screen
                os.write(self.master, f"\x1b[{s.cursor.y + 1};{s.cursor.x + 1}R".encode())

    def _reap(self, block: bool = False) -> None:
        if self.status is not None:
            return
        pid, st = os.waitpid(self.pid, 0 if block else os.WNOHANG)
        if pid:
            self.status = os.waitstatus_to_exitcode(st)
            self.exited_at = time.monotonic()

    def until(self, check: Callable[[], bool], timeout: float = 15.0) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if check():
                return True
            if self.status is not None:
                return check()
            self.pump(0.05)
        return check()

    def shows(self, text: str, timeout: float = 15.0) -> bool:
        return self.until(lambda: any(text in r for r in self.term.viewport()), timeout)

    def wait_exit(self, timeout: float = 10.0) -> Optional[int]:
        self.until(lambda: self.status is not None, timeout)
        self.pump(0.2)
        return self.status

    def type(self, data: bytes) -> None:
        os.write(self.master, data)

    def resize(self, cols: int, rows: int) -> None:
        """Reflow the window, then tell the program (SIGWINCH). The program is paused between two of
        its frames meanwhile: a frame laid out for the old size and drawn after the reflow (a busy
        machine reads it late, or the program was laying it out) leaves rows the kit cannot know
        about, a race a person's terminal has too and that these tests are not about."""
        self.pump(0.05)
        self._pause()
        try:
            self.pump(0.05)  # what the program wrote before it stopped, drawn at the old size
            self.term.resize(cols, rows)
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        finally:
            if self.status is None:
                os.kill(self.pid, signal.SIGCONT)

    def _pause(self) -> None:
        """SIGSTOP the program while it waits between frames. A live region redraws every 80 ms and
        then waits: stopped within 40 ms of a frame arriving, it is waiting, not laying one out. A
        program that draws nothing for 0.3 s is waiting for a key."""
        for _ in range(50):
            if self.status is not None:
                return
            ready, _, _ = select.select([self.master], [], [], 0.3)
            seen = time.monotonic()
            if ready:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    data = b""
                if not data:
                    self._reap(block=True)
                    return
                self._take(data)
            os.kill(self.pid, signal.SIGSTOP)
            _, st = os.waitpid(self.pid, os.WUNTRACED)
            if not os.WIFSTOPPED(st):
                self.status = os.waitstatus_to_exitcode(st)
                self.exited_at = time.monotonic()
                return
            if not ready or time.monotonic() - seen < 0.04:
                return
            os.kill(self.pid, signal.SIGCONT)

    def signal(self, signum: int) -> None:
        os.kill(self.pid, signum)

    def tty_flags(self) -> List[bool]:
        """(canonical mode, echo) on the pty now."""
        lflag = termios.tcgetattr(self.master)[3]
        return [bool(lflag & termios.ICANON), bool(lflag & termios.ECHO)]

    def close(self) -> None:
        if self.status is None:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                os.waitpid(self.pid, 0)
            except OSError:
                pass
            self.status = -9
        try:
            os.close(self.master)
        except OSError:
            pass

    def __enter__(self) -> "PtyRun":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
