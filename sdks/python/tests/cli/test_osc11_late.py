# @pkey-feature ui.terminal
"""A late OSC 11 answer is not a key (B-111)."""

from __future__ import annotations

import sys

from polaris_key.ui.terminal.device import KeyReader




def test_a_whole_late_reply_is_dropped() -> None:
    r = KeyReader(sys.stdin)
    assert r._scan(b"\x1b]11;rgb:ffff/ffff/ffff\x1b\\") == b""
    assert r._scan(b"\x1b]11;rgb:0000/0000/0000\x07a") == b"a"


def test_a_split_reply_waits_for_its_rest_and_never_reads_as_esc() -> None:
    r = KeyReader(sys.stdin)
    assert r._scan(b"\x1b]11;rgb:ff") == b""
    assert r._scan(b"ff/ffff/ffff\x1b\\") == b""
    assert r._osc_tail == b""
    assert r._scan(b"x") == b"x"


def test_a_key_before_the_reply_is_kept() -> None:
    r = KeyReader(sys.stdin)
    assert r._scan(b"q\x1b]11;rgb:00") == b"q"
    assert r._scan(b"00/0000/0000\x07") == b""


def test_a_lone_esc_is_still_esc() -> None:
    r = KeyReader(sys.stdin)
    assert r._scan(b"\x1b") == b"\x1b"
