# @pkey-feature ui.cli.contract
"""Security fixes of UK-48's review round: the CI log-command guard follows the real stdout, the
piped key read is bounded, and an empty --key-file is a usage error."""

from __future__ import annotations

import io
import os
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from typing import Any

from polaris_key.cli import core, verbs
from polaris_key.ui.terminal.env import detect
from polaris_key.ui.terminal.flows import Terminal


class _Out(io.StringIO):
    def isatty(self) -> bool:
        return False


def _client(value: str) -> Any:
    return SimpleNamespace(product="tidewater", config=SimpleNamespace(get_secret=lambda k: value))


def _run(value: str, env: dict, allow: bool = False) -> tuple:
    from polaris_key.ui.terminal import flows

    out = _Out()
    t = Terminal.create(product="tidewater", env=env, stdout=out, stdin=_Out(), use_rich=False, term_env=None, verb="secret")
    t.err = io.StringIO()
    outcome = flows.secret(_client(value), t, ["k"], reveal=True, allow_workflow_commands=allow)
    t.finish(outcome)
    return outcome.code, out.getvalue(), t.err.getvalue()


def test_force_color_does_not_switch_off_the_log_command_guard() -> None:
    env = {"FORCE_COLOR": "1", "GITHUB_ACTIONS": "true", "TERM": "xterm-256color"}
    assert detect(env=env, stdout=_Out(), stdin=_Out()).tty and not detect(env=env, stdout=_Out(), stdin=_Out()).out_tty
    code, out, err = _run("::add-mask::x", env)
    assert code == 1 and out == "" and "--allow-workflow-commands" in err


def test_force_color_prints_a_value_byte_for_byte_when_allowed() -> None:
    env = {"FORCE_COLOR": "1", "GITHUB_ACTIONS": "true", "TERM": "xterm-256color"}
    value = "a\x1b[31mb\x07\n::add-mask::x"
    code, out, _ = _run(value, env, allow=True)
    assert code == 0 and out == value + "\n"


def test_the_guard_reads_the_env_the_terminal_was_given(monkeypatch) -> None:
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    code, out, _ = _run("::add-mask::x", {"TERM": "xterm-256color"})
    assert code == 0 and out == "::add-mask::x\n"


def test_a_file_with_no_newline_is_cut_at_4096_bytes() -> None:
    with tempfile.NamedTemporaryFile() as f:
        f.write(b"k" * 5_000_000)
        f.flush()
        with open(f.name, "rb") as fd:
            assert core.read_piped_key(fd) is None
    with tempfile.NamedTemporaryFile() as f:
        f.write(b"\n\n" + b"pkey_x" + b"\n" + b"k" * 100000)
        f.flush()
        with open(f.name, "rb") as fd:
            assert core.read_piped_key(fd) == "pkey_x"


def test_a_pipe_and_a_socket_with_endless_input_are_cut_at_4096_bytes() -> None:
    for make in ("pipe", "socket"):
        if make == "pipe":
            rd, wr = os.pipe()
            fd_read, closers = rd, [rd, wr]
            write = lambda b: os.write(wr, b)  # noqa: E731
        else:
            a, b_ = socket.socketpair()
            fd_read, closers = b_.fileno(), []
            write = a.sendall
        os.set_blocking(wr if make == "pipe" else a.fileno(), False)
        try:
            try:
                for _ in range(100):
                    write(b"k" * 4096)
            except (BlockingIOError, OSError):
                pass
            stream = SimpleNamespace(fileno=lambda: fd_read, isatty=lambda: False)
            t0 = time.monotonic()
            assert core.read_piped_key(stream) is None
            assert time.monotonic() - t0 < 1.4
        finally:
            for c in closers:
                os.close(c)
            if make == "socket":
                a.close()
                b_.close()


def test_key_stdin_takes_the_same_bound(monkeypatch) -> None:
    with tempfile.NamedTemporaryFile() as f:
        f.write(b"k" * 100_000)
        f.flush()
        with open(f.name, "rb") as fd:
            monkeypatch.setattr(sys, "stdin", fd)
            assert verbs._NoPrompt().readline() == ""


def test_an_empty_key_file_is_a_usage_error_not_a_fallback_to_stdin() -> None:
    from polaris_key.ui.terminal.exit import EXIT

    with tempfile.NamedTemporaryFile() as empty:
        t = Terminal.create(product="tidewater", env={}, stdout=_Out(), stdin=_Out(), use_rich=False, verb="activate")
        v = next(x for x in verbs.VERBS if x.name == "activate")
        ns = dict(verbs.namespace(v, [], {"key_file": empty.name}), _term=t)
        r = v.run(SimpleNamespace(product="tidewater"), ns)
        assert r.code == EXIT.usage
