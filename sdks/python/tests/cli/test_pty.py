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


# ── The kit on a real pty with a terminal that answers (pyte): ptyrun.py, pty_flow.py ──────────

import re

from .ptyrun import PtyRun


def _tidy(rows: list) -> str:
    return re.sub(r"[⠀-⣿]", "*", re.sub(r"\d+:\d\d", "m:ss", "\n".join(r.rstrip() for r in rows).rstrip()))


@pytest.mark.parametrize("answers", [True, False], ids=["osc11-answered", "osc11-silent"])
def test_an_esc_typed_005_seconds_after_launch_is_honoured(answers: bool) -> None:
    with PtyRun(80, 24, "login", answer_osc11=answers) as run:
        run.pump(0.05)
        run.type(b"\x1b")
        # The 3 s bound is for the kit, not the machine: it runs from the program's first question
        # (OSC 11, asked once the program is up), so a loaded runner's interpreter start-up is not
        # counted. The wait itself only guards against a hang.
        code = run.wait_exit(20)
        text = "\n".join(r for r, _ in run.term.all())
        assert "Sign-in cancelled" in text and "Code expired" not in text, text
        assert code == 1
        assert run.osc11_seen and run.osc11_at is not None and run.exited_at is not None
        assert run.exited_at - run.osc11_at < 3


@pytest.mark.parametrize("mode", ["login", "device-limit"])
@pytest.mark.parametrize(
    "sizes",
    [[(80, 24), (60, 10), (80, 24)], [(80, 24), (32, 10), (110, 30)]],
    ids=lambda s: "-".join("x".join(map(str, z)) for z in s),
)
def test_a_window_dragged_back_on_a_real_pty_shows_a_fresh_launchs_screen(mode: str, sizes: list) -> None:
    ready = "Esc cancel" if mode == "login" else "Enter"
    env = {"PKEY_THEME": "dark", "PTY_EXPIRE": "60"}
    with PtyRun(*sizes[0], mode, "long", env=env) as run, PtyRun(*sizes[-1], mode, "long", env=env) as fresh:
        assert run.shows(ready) and fresh.shows(ready)
        for c, r in sizes[1:]:
            run.resize(c, r)
            run.pump(0.5)
        fresh.pump(0.3)
        assert _tidy(run.term.viewport()) == _tidy(fresh.term.viewport())
        assert run.cpr_asked >= 1, "the window grew back: the kit asked where the cursor is"
        run.type(b"\x1b")
        fresh.type(b"\x1b")
        run.wait_exit()
        fresh.wait_exit()
        assert _tidy(run.term.viewport()) == _tidy(fresh.term.viewport())


def test_sigterm_during_update_apply_gives_the_terminal_back() -> None:
    with PtyRun(80, 24, "update", env={"PKEY_THEME": "dark"}) as run:
        assert run.shows("Esc cancel")
        assert run.tty_flags() == [False, False], "cbreak with echo off while the Esc watcher reads"
        run.signal(signal.SIGTERM)
        code = run.wait_exit(10)
        assert code == -signal.SIGTERM, "the termination goes on: exit status 128 + 15"
        assert run.tty_flags() == [True, True], "cooked mode and echo are back"
        assert "\x1b[?2004l" in run.raw and "\x1b[?25h" in run.raw
