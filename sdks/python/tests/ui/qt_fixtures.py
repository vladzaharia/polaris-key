"""UK-02b fixtures for the Qt kit: one view per (component, state) of ui-matrix.json, plus a fake
presentation source (the HA-13 seam) that carries the product's name, developer and accent."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from polaris_key.ui.core import ui_activate, ui_devices, ui_gate, ui_settings, ui_update
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.core.ui_view import View

ROOT = Path(__file__).resolve().parents[4]
MATRIX = json.loads((ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8"))
SNAPSHOTS = Path(__file__).resolve().parent / "snapshots"

MODELS = {
    "PolarisKeyGate": ui_gate.gate_view,
    "Boot": ui_gate.boot_view,
    "StatusScreen": ui_gate.status_screen_view,
    "GraceBanner": ui_gate.grace_banner_view,
    "Toast": ui_gate.toast_view,
    "Welcome": ui_activate.welcome_view,
    "Activate": ui_activate.activate_view,
    "OfflineActivation": ui_activate.offline_activation_view,
    "DeviceLimit": ui_devices.device_limit_view,
    "Devices": ui_devices.devices_view,
    "UpdatePrompt": ui_update.update_prompt_view,
    "UpdateProgress": ui_update.update_progress_view,
    "ReleaseNotes": ui_update.release_notes_view,
    "AccountAndLicense": ui_settings.account_view,
    "Settings": ui_settings.settings_view,
}
FAMILIES = ("gate", "activate", "deviceLimit", "devices", "update", "settings")


class FakeSource:
    """Structurally a ``polaris_key.presentation.PresentationSource``: current(), icon(), subscribe()."""

    def __init__(self, member: Optional[Mapping[str, Any]], icon: Optional[bytes] = None) -> None:
        self.member = member
        self._icon = icon
        #: This device's id, the offline-activation request code (the QR under step 1 encodes it).
        self.request_code = "d3f9a1c07be24a6c9d51e8f20b7c4a36"
        self.listeners: List[Any] = []

    def current(self) -> Optional[Mapping[str, Any]]:
        return self.member

    def icon(self, px: float, scale: float = 1.0) -> Optional[bytes]:
        return self._icon

    def subscribe(self, fn: Any) -> Any:
        self.listeners.append(fn)
        return lambda: self.listeners.remove(fn)

    def set(self, member: Optional[Mapping[str, Any]]) -> None:
        self.member = member
        for fn in list(self.listeners):
            fn(member)


TIDEWATER = {"name": "Tidewater Studio", "developerName": "Harbor Audio", "accent": "#1f7a6d", "accentDark": "#4fd1be"}


def with_defaults(input: Mapping[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = dict(input)
    for key, value in MATRIX["vocabulary"]["defaults"].items():
        if key == "capabilities":
            out[key] = {**value, **dict(input.get(key) or {})}
        elif key not in out:
            out[key] = value
    return out


def states() -> List[Tuple[str, str, str, View]]:
    """(component, state, row name, view) for the first row of every visible component state."""
    seen = set()
    out: List[Tuple[str, str, str, View]] = []
    for family in FAMILIES:
        for row in MATRIX[family]:
            expected = row["expect"]
            key = (expected["component"], expected["state"])
            if expected["state"] == "hidden" or key in seen:
                continue
            seen.add(key)
            view = MODELS[expected["component"]](context_of(with_defaults(row["input"])))
            out.append((key[0], key[1], str(row["name"]), view))
    return out


def all_views() -> List[Tuple[str, View]]:
    """Every row of the six families as (row name, view)."""
    return [
        (str(row["name"]), MODELS[row["expect"]["component"]](context_of(with_defaults(row["input"]))))
        for family in FAMILIES
        for row in MATRIX[family]
    ]
