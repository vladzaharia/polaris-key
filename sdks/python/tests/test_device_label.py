# @pkey-feature identity.devicelabel
"""The Python runner for ``conformance/corpus/v2/device-label.json`` (WIRE-CONTRACT-V4 §12.7.1,
plans/PX-W13.md §4), and the label's precedence (a per-call name, the ``device_name`` option,
the platform default)."""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from polaris_key.constants_generated import DEVICE_LABEL_MAX_CODEPOINTS, DEVICE_LABEL_VERSION
from polaris_key.core import device_label as _dl
from polaris_key.core.device_label import (
    clean_display_label,
    default_device_name,
    normalize_device_label,
    resolve_device_label,
)

_CORPUS = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "device-label.json"
CASES = json.loads(_CORPUS.read_text(encoding="utf-8"))


def test_version_and_limit() -> None:
    assert CASES["deviceLabelVersion"] == DEVICE_LABEL_VERSION == 2
    assert DEVICE_LABEL_MAX_CODEPOINTS == 64
    assert len(CASES["cases"]) >= 20
    assert len(CASES["helloCases"]) >= 10


def test_tables_equal_the_corpus_ranges() -> None:
    assert [list(p) for p in _dl._SPACE] == CASES["ranges"]["space"]
    assert [list(p) for p in _dl._STRIP] == CASES["ranges"]["strip"]


@pytest.mark.parametrize("row", CASES["cases"], ids=lambda r: r["id"])
def test_row(row: dict) -> None:
    assert normalize_device_label(row["raw"]) == row["expect"]
    # The expectation is a fixed point (an absent label cleans to absent).
    if row["expect"] is not None:
        assert normalize_device_label(row["expect"]) == row["expect"]


@pytest.mark.parametrize("row", CASES["helloCases"], ids=lambda r: r["id"])
def test_hello_row(row: dict) -> None:
    assert clean_display_label(row["raw"]) == row["expect"]
    if row["expect"] is not None:
        assert clean_display_label(row["expect"]) == row["expect"]


def test_lone_surrogates_are_deleted() -> None:
    assert normalize_device_label("A\ud800B\udfffC") == "ABC"
    assert clean_display_label("e\udc00\u0301") == "\u00e9"
    assert normalize_device_label("\ud83d") is None


def test_clean_display_label_is_a_fixed_point_on_a_seeded_fuzz() -> None:
    rng = random.Random(0x504B4559)
    pool = [0x20, 0x41, 0x65, 0x301, 0x300, 0x200B, 0x3164, 0xFE0F, 0x2800, 0x2000, 0x958, 0xD800, 0x1F3F4, 0xE0067]
    for _ in range(2000):
        s = "".join(chr(rng.choice(pool)) for _ in range(rng.randrange(0, 80)))
        once = clean_display_label(s)
        assert clean_display_label(once) == once
        assert normalize_device_label(once) == once


def test_not_a_string_is_no_label() -> None:
    assert normalize_device_label(None) is None
    assert normalize_device_label(42) is None
    assert clean_display_label(None) is None


def test_precedence() -> None:
    assert resolve_device_label("Den PC", "TV", lambda: "host") == "Den PC"
    assert resolve_device_label(None, "TV", lambda: "host") == "TV"
    assert resolve_device_label(None, None, lambda: " host\t") == "host"
    assert resolve_device_label("", "TV", lambda: "host") is None
    assert resolve_device_label(None, "", lambda: "host") is None


def test_default_drops_local_suffix(monkeypatch: pytest.MonkeyPatch) -> None:
    import platform

    monkeypatch.setattr(platform, "node", lambda: "studio-mac.local")
    assert default_device_name() == "studio-mac"
    monkeypatch.setattr(platform, "node", lambda: "")
    assert default_device_name() is None
