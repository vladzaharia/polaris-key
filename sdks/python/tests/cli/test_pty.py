# @pkey-feature ui.cli
"""The key reader on a real pseudo-terminal: what was typed while the flow waited is kept, and a
terminated process gives the terminal back (cooked mode, cursor, paste mode)."""

from __future__ import annotations

import os
import select
import signal
import subprocess
import sys
import textwrap
import time

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="a pty needs POSIX")

SRC = os.path.join(os.path.dirname(__file__), "..", "..", "src")


def _spawn(script: str):
    import pty

    master, slave = pty.openpty()
    env = dict(os.environ, PYTHONPATH=os.path.abspath(SRC))
    proc = subprocess.Popen(
        [sys.executable, "-c", textwrap.dedent(script)],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        close_fds=True,
        start_new_session=True,
    )
    return proc, master, slave


def _read_until(master: int, marker: bytes, timeout: float = 10.0) -> bytes:
    out = b""
    end = time.time() + timeout
    while marker not in out and time.time() < end:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                out += os.read(master, 4096)
            except OSError:
                break
    return out


def test_a_key_typed_before_the_reader_starts_is_not_thrown_away() -> None:
    proc, master, slave = _spawn(
        """
        import sys, time
        from polaris_key.ui.terminal.device import KeyReader
        print("READY", flush=True)
        time.sleep(0.8)  # the flow is on the network: the person presses Esc now
        with KeyReader(sys.stdin) as keys:
            print("KEY", keys.read(2.0), flush=True)
        """
    )
    try:
        _read_until(master, b"READY")
        os.write(master, b"\x1b")
        out = _read_until(master, b"KEY esc", 10)
        assert b"KEY esc" in out, out
    finally:
        proc.kill()
        proc.wait()
        os.close(master)
        os.close(slave)


def test_sigterm_gives_the_terminal_back_and_still_terminates() -> None:
    import termios

    proc, master, slave = _spawn(
        """
        import sys, time
        from polaris_key.ui.terminal.device import KeyReader
        with KeyReader(sys.stdin) as keys:
            print("UP", flush=True)
            time.sleep(30)
        """
    )
    try:
        _read_until(master, b"UP")
        assert not termios.tcgetattr(slave)[3] & termios.ICANON, "cbreak while the reader is open"
        proc.send_signal(signal.SIGTERM)
        # A pty drains only while its master is read: keep reading until the process is gone.
        tail = b""
        end = time.time() + 10
        while proc.poll() is None and time.time() < end:
            tail += _read_until(master, b"\0", 0.2)
        code = proc.wait(timeout=5)
        tail += _read_until(master, b"\0", 0.3)
        assert code == -signal.SIGTERM, "the termination goes on: exit status 128 + 15"
        assert termios.tcgetattr(slave)[3] & termios.ICANON, "cooked mode restored"
        assert termios.tcgetattr(slave)[3] & termios.ECHO
        assert b"\x1b[?25h" in tail and b"\x1b[?2004l" in tail, tail
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        os.close(slave)


def test_a_live_region_shows_the_cursor_again_when_terminated() -> None:
    """The region hides the cursor while it is up: a SIGTERM restores it, then the termination goes on."""
    proc, master, slave = _spawn(
        """
        import io, sys, time
        from polaris_key.ui.terminal.device import Device, LiveRegion
        from polaris_key.ui.terminal.env import detect
        from polaris_key.ui.terminal.parts import Kit
        e = detect(env={"TERM": "xterm-256color", "COLORTERM": "truecolor"}, stdout=sys.stdout)
        d = Device(e, Kit.create(e, product="tidewater", prog="tidewater").palette(), stdout=sys.stdout, use_rich=False)
        with LiveRegion(d) as live:
            print("UP", flush=True)
            time.sleep(30)
        """
    )
    try:
        _read_until(master, b"UP")
        proc.send_signal(signal.SIGTERM)
        tail = b""
        end = time.time() + 10
        while proc.poll() is None and time.time() < end:
            tail += _read_until(master, b"\0", 0.2)
        code = proc.wait(timeout=5)
        tail += _read_until(master, b"\0", 0.3)
        assert code == -signal.SIGTERM
        assert b"\x1b[?25h" in tail, tail
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        os.close(slave)
