# @pkey-feature identity.devicecode
"""The dependency-free QR encoder (SDK parity pass §3.12) against the Godot suite's reference
fixtures (``sdks/godot/tests/qr/fixtures.json``, Nayuki's qrcodegen): the same module matrix at
the reference's version and mask, and the same mask when the encoder chooses it."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from polaris_key import qr

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[2] / "godot" / "tests" / "qr" / "fixtures.json").read_text()
)


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda c: c["text"][:40])
def test_matrices_match_the_reference(case) -> None:
    min_version = case["forcedVersion"] or 1
    at = qr.encode(case["text"], min_version, case["mask"])
    assert at is not None and at.version == case["version"] and at.rows() == case["rows"]
    if case["forcedMask"] is None:
        auto = qr.encode(case["text"], min_version)
        assert auto.mask == case["mask"] and auto.rows() == case["rows"]


def test_capacity_and_bounds() -> None:
    assert qr.capacity(1) == 14 and qr.capacity(10) == 213
    assert qr.encode("x" * 214) is None
    assert qr.encode("x", 0) is None and qr.encode("x", 11) is None and qr.encode("x", 1, 8) is None


def test_renderers() -> None:
    url = "https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT"
    code = qr.encode(url)
    t = qr.terminal(url, quiet_zone=2)
    lines = t.splitlines()
    assert len(lines) == (code.size + 4 + 1) // 2 and all(len(line) == code.size + 4 for line in lines)
    a = qr.terminal(url, ascii=True, quiet_zone=0).splitlines()
    assert a[0].startswith("##############") and len(a) == code.size
    s = qr.svg(url)
    assert s.startswith("<svg") and s.count("h1v1h-1z") == sum(code.modules)
    assert qr.terminal("x" * 300) is None
