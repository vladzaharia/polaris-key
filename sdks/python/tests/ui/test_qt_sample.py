# @pkey-feature ui.gate
"""examples/ui/qt (UK-12): the Tidewater sample gates a window from its fixture client, offscreen."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

pytest.importorskip("PySide6.QtWidgets")

from polaris_key.ui.core.theme import Theme

SAMPLE = Path(__file__).resolve().parents[4] / "examples" / "ui" / "qt" / "tidewater_qt.py"


def test_sample_gates_a_window_from_the_fixtures(kit_app, monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location("tidewater_qt", SAMPLE)
    sample = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sample)
    import tidewater_fixtures

    monkeypatch.setattr(tidewater_fixtures, "STATE", str(tmp_path / "state.json"))
    client = sample.make_client(type("A", (), {"live": False})())
    gate = sample.build(client, Theme(color_scheme="dark"))
    try:
        assert gate.view.state == "needs-activation"
        assert "Tidewater Studio" in gate.kit.bridge.screen_spec.product
        client.state["activated"] = True
        gate.refresh()
        assert gate.open
    finally:
        gate.close()
