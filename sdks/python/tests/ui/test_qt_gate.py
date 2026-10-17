# @pkey-feature ui.gate
"""run_gate drives the kit from a client's own state (a fake client; no network)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

pytest.importorskip("PySide6.QtQuick")

from polaris_key.ui.core.theme import Theme
from polaris_key.ui.qt.gate import run_gate
from qt_fixtures import TIDEWATER, FakeSource


class Client:
    def __init__(self, status):
        self.st = status
        self.presentation_source = FakeSource(TIDEWATER)

    def status(self, now=None):
        return SimpleNamespace(status=self.st)


def test_gate_shows_while_the_app_may_not_proceed_and_hides_when_it_may(kit_app):
    client = Client("needs-activation")
    opened = []
    gate = run_gate(client, None, theme=Theme(color_scheme="dark"), on_open=lambda: opened.append(1))
    try:
        assert not gate.open and gate.view.state == "needs-activation"
        assert gate.kit.view.isVisible()
        assert "Tidewater Studio" in gate.kit.bridge.screen_spec.product
        client.st = "ok"
        gate.refresh()
        assert gate.open and not gate.kit.view.isVisible() and opened == [1]
    finally:
        gate.close()


def test_try_again_rereads_the_client(kit_app):
    client = Client("grace")
    gate = run_gate(client, None, theme=Theme(color_scheme="light"))
    try:
        assert gate.view.state == "grace"
        client.st = "ok"
        gate.kit.bridge.invoke("common.reconnect", "retry")
        assert gate.open
    finally:
        gate.close()
