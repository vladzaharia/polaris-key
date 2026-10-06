# @pkey-feature identity.devicelabel
"""The Python runner for ``conformance/corpus/v2/device-label.json`` (WIRE-CONTRACT-V4 §12.7.1,
plans/PX-W13.md §4), and the label's precedence (a per-call name, the ``device_name`` option,
the platform default)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from polaris_key.constants_generated import DEVICE_LABEL_MAX_CODEPOINTS, DEVICE_LABEL_VERSION
from polaris_key.core.device_label import (
    default_device_name,
    normalize_device_label,
    resolve_device_label,
)

_CORPUS = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "device-label.json"
CASES = json.loads(_CORPUS.read_text(encoding="utf-8"))


def test_version_and_limit() -> None:
    assert CASES["deviceLabelVersion"] == DEVICE_LABEL_VERSION == 1
    assert DEVICE_LABEL_MAX_CODEPOINTS == 64
    assert len(CASES["cases"]) >= 20


@pytest.mark.parametrize("row", CASES["cases"], ids=lambda r: r["id"])
def test_row(row: dict) -> None:
    assert normalize_device_label(row["raw"]) == row["expect"]


def test_not_a_string_is_no_label() -> None:
    assert normalize_device_label(None) is None
    assert normalize_device_label(42) is None


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
