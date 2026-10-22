"""UK-02b fixtures for the Qt kit: one view per (component, state) of ui-matrix.json, plus a fake
presentation source (the HA-13 seam) that carries the product's name, developer and accent."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from polaris_key.ui.core import ui_activate, ui_choice, ui_devices, ui_gate, ui_paywall, ui_settings, ui_signin, ui_update
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
    "SignIn": ui_signin.sign_in_view,
    "SignInHandoff": ui_signin.sign_in_handoff_view,
    "DeviceLimit": ui_devices.device_limit_view,
    "Devices": ui_devices.devices_view,
    "UpdatePrompt": ui_update.update_prompt_view,
    "UpdateProgress": ui_update.update_progress_view,
    "ReleaseNotes": ui_update.release_notes_view,
    "AccountAndLicense": ui_settings.account_view,
    "Settings": ui_settings.settings_view,
    "LicenseChoice": ui_choice.license_choice_view,
    "Paywall": ui_paywall.paywall_view,
    "EntitlementGate": ui_paywall.entitlement_gate_view,
}
FAMILIES = ("gate", "activate", "signIn", "deviceLimit", "devices", "update", "settings", "paywall")


def rows():
    """Every row of the families the kit draws. LicenseChoice is drawn from the matrix and fixtures only:
    no runtime path hands the Python kit a grant roster before I-10b."""
    return [row for family in FAMILIES for row in MATRIX[family] if row["expect"]["component"] in MODELS]


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


#: What a host passes besides the matrix input: the tier a paywall sells and what it adds, which no
#: matrix row carries (the rows pin the copy, not the data).
TIER = "Pro"
FEATURES = ["Export to every format", "Batch processing", "Priority support"]


def dressed(row: Mapping[str, Any]) -> Dict[str, Any]:
    """The row's input with its defaults and, on the paywall family, the host's tier and features."""
    out = with_defaults(row["input"])
    if row["expect"]["component"] in ("Paywall", "EntitlementGate"):
        if "entitlement" in out:
            out["entitlement"] = {**out["entitlement"], "tier": TIER}
        if "offers" in out:
            out["offers"] = {**out["offers"], "tier": TIER, **({"features": FEATURES} if out["offers"].get("available") else {})}
    return out


def states() -> List[Tuple[str, str, str, View]]:
    """(component, state, row name, view) for the first row of every visible component state."""
    seen = set()
    out: List[Tuple[str, str, str, View]] = []
    for row in rows():
        expected = row["expect"]
        key = (expected["component"], expected["state"])
        if expected["state"] == "hidden" or key in seen:
            continue
        seen.add(key)
        view = MODELS[expected["component"]](context_of(dressed(row)))
        out.append((key[0], key[1], str(row["name"]), view))
    return out


def all_views() -> List[Tuple[str, View]]:
    """Every row of the families the kit draws as (row name, view)."""
    return [(str(row["name"]), MODELS[row["expect"]["component"]](context_of(dressed(row)))) for row in rows()]


#: The first view of each (component, state): ``BY_STATE_VIEWS[("Welcome", "default")]``.
BY_STATE_VIEWS = {(c, s): v for c, s, _, v in states()}
