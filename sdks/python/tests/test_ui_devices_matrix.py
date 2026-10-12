# @pkey-feature ui.devicelimit ui.devices
"""The Python headless runner for ``deviceLimit`` and ``devices`` in ``ui-matrix.json``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping

import pytest

from polaris_key.constants_generated import UI_MATRIX_VERSION
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.core.ui_devices import device_limit_view, devices_view

ROOT = Path(__file__).resolve().parents[3]
MATRIX = json.loads(
    (ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8")
)
FAMILIES = {"deviceLimit": {"DeviceLimit": device_limit_view}, "devices": {"Devices": devices_view}}


def _with_defaults(input: Mapping[str, Any]) -> Dict[str, Any]:
    output: Dict[str, Any] = dict(input)
    for key, value in MATRIX["vocabulary"]["defaults"].items():
        if key == "capabilities":
            output[key] = {**value, **dict(input.get(key) or {})}
        elif key not in output:
            output[key] = value
    return output


@pytest.mark.parametrize(
    "family,row",
    [(family, row) for family in FAMILIES for row in MATRIX[family]],
    ids=lambda item: str(item) if isinstance(item, str) else str(item["name"]),
)
def test_device_family_rows(family: str, row: Mapping[str, Any]) -> None:
    assert MATRIX["uiMatrixVersion"] == UI_MATRIX_VERSION
    expected = row["expect"]
    view = FAMILIES[family][expected["component"]](context_of(_with_defaults(row["input"])))
    assert view.component == expected["component"]
    assert view.state == expected["state"]
    assert list(view.copy) == sorted(expected["copy"])
    assert list(view.actions) == sorted(expected.get("actions", []))
    for forbidden in row.get("mustNot", {}).get("states", []):
        assert view.state != forbidden
    for forbidden in row.get("mustNot", {}).get("copy", []):
        assert forbidden not in view.copy
    for forbidden in row.get("mustNot", {}).get("actions", []):
        assert forbidden not in view.actions
