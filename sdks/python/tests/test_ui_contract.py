"""The Python UI-matrix vocabulary and platform helpers.

The full fixture runner lives with the view models.  These tests keep the small, shared contract
in lockstep with ``ui-matrix.json`` before any renderer is involved.
"""

from __future__ import annotations

import json
from pathlib import Path

from polaris_key.ui.core.ui_contract import (
    ACTIONS,
    COMPONENTS,
    DEFAULT_CAPABILITIES,
    UI_MATRIX_VERSION,
    can_browse,
    coarse_pointer,
    context_of,
    platform_class,
    services_without,
    system_confirm,
)

ROOT = Path(__file__).resolve().parents[3]
MATRIX = json.loads(
    (ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8")
)
CATALOG = json.loads(
    (ROOT / "packages" / "brand" / "kit-copy" / "components.json").read_text(encoding="utf-8")
)


def test_vocabulary_matches_the_generated_ui_matrix_version() -> None:
    assert MATRIX["uiMatrixVersion"] == UI_MATRIX_VERSION
    assert tuple(MATRIX["vocabulary"]["actions"].keys()) == ACTIONS
    assert set(COMPONENTS) == set(CATALOG["components"])
    matrix_components = {
        component
        for family in ("gate", "activate", "signIn", "deviceLimit", "devices", "update", "settings", "paywall")
        for component in (row["expect"]["component"] for row in MATRIX[family])
    }
    assert matrix_components <= set(COMPONENTS)


def test_context_merges_capabilities_and_defaults_services() -> None:
    ctx = context_of({"capabilities": {"signIn": False, "trial": True}})
    assert ctx.caps == {**DEFAULT_CAPABILITIES, "signIn": False, "trial": True}
    assert ctx.on("license")
    assert ctx.registration == "requires-license"


def test_service_closure_follows_dependencies() -> None:
    assert services_without("release") == ("license", "config", "identity", "sync")
    assert services_without("config") == ("license", "release", "distribution", "update", "identity")
    assert services_without("identity") == ("license", "config", "release", "distribution", "update")


def test_platform_helpers_follow_d14_and_d9() -> None:
    tv = {"os": "tvos", "formFactor": "tv"}
    console = {"os": "windows", "formFactor": "tv"}
    phone = {"os": "ios", "formFactor": "iphone"}
    desktop = {"os": "windows", "formFactor": "computer"}
    assert platform_class(tv) == "tv"
    assert platform_class(console) == "console"
    assert platform_class(phone) == "handheld"
    assert platform_class(desktop) == "desktop"
    assert not can_browse(tv)
    assert not can_browse(console)
    assert can_browse(phone)
    assert coarse_pointer(phone)
    assert not coarse_pointer(desktop)


def test_system_confirm_follows_platform_and_presentation() -> None:
    windows = {"os": "windows", "formFactor": "computer"}
    mac = {"os": "macos", "formFactor": "mac"}
    tv = {"os": "tvos", "formFactor": "tv"}
    assert system_confirm(windows, "inline")
    assert not system_confirm(windows, "sheet")
    assert system_confirm(mac, "sheet")
    assert not system_confirm(tv, "inline")
