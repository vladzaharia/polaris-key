# @pkey-feature ui.devices
# @pkey-feature ui.settings
"""Re-rendering one KitView from screen to screen prints no QML console error.

A delegate is built from the previous screen's model for a moment, so a binding that assumes a row
has a button (``r.actions[0].role``) throws only when a screen is drawn from another one: the
rename state of a device list printed ``KitGroup.qml:273: TypeError: Cannot read property 'role' of
undefined``. ``conftest.qml_console`` fails every UI test on such a message; these tests draw the
screens in the orders that used to print it."""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

pytest.importorskip("PySide6.QtQuick")

from polaris_key.ui.core import ui_devices
from polaris_key.ui.core.theme import Theme
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.qt.kit import KitView
from qt_fixtures import TIDEWATER, FakeSource, states

DEVICES: List[Dict[str, Any]] = [
    {"id": "d1", "name": "Studio iMac", "platform": "macos", "formFactor": "mac", "lastSeenDays": 0, "current": True},
    {"id": "d2", "name": "Laptop", "platform": "windows", "formFactor": "computer", "lastSeenDays": 3},
]


def _show(kit: KitView, app, state: Dict[str, Any]) -> None:
    kit.set_view(ui_devices.devices_view(context_of(state)), data=state)
    app.processEvents()
    kit.grab()


def test_a_device_list_re_rendered_into_rename_prints_no_qml_error(kit_app, qml_console):
    kit = KitView(Theme(color_scheme="dark"), source=FakeSource(TIDEWATER), loading_delay_ms=0)
    try:
        listing = {"devices": DEVICES}
        _show(kit, kit_app, listing)
        _show(kit, kit_app, {**listing, "edit": {"kind": "rename", "device": "Laptop"}, "selected": 1})
        _show(kit, kit_app, {**listing, "edit": {"kind": "remove", "device": "Laptop"}, "selected": 1})
        _show(kit, kit_app, listing)
        assert qml_console == []
    finally:
        kit.close()


def test_every_screen_drawn_after_every_other_prints_no_qml_error(kit_app, qml_console):
    """One view, every ui-matrix state in turn: a list of rows with none of the previous screen's."""
    kit = KitView(Theme(color_scheme="light"), source=FakeSource(TIDEWATER), loading_delay_ms=0)
    try:
        for _component, _state, _name, view in states():
            kit.set_view(view)
            kit_app.processEvents()
            kit.grab()
        assert qml_console == []
    finally:
        kit.close()
