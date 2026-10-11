# @pkey-feature ui.settings
"""The Python headless runner for the ``settings`` family of ``ui-matrix.json``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping

import pytest

from polaris_key.constants_generated import UI_MATRIX_VERSION
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.core.ui_settings import account_view, settings_view

ROOT = Path(__file__).resolve().parents[3]
MATRIX = json.loads(
    (ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8")
)
FAMILY = "settings"
MODELS = {
    "AccountAndLicense": account_view,
    "Settings": settings_view,
}


def _with_defaults(input: Mapping[str, Any]) -> Dict[str, Any]:
    output: Dict[str, Any] = dict(input)
    for key, value in MATRIX["vocabulary"]["defaults"].items():
        if key == "capabilities":
            output[key] = {**value, **dict(input.get(key) or {})}
        elif key not in output:
            output[key] = value
    return output


@pytest.mark.parametrize("row", MATRIX[FAMILY], ids=lambda row: str(row["name"]))
def test_settings_family_rows(row: Mapping[str, Any]) -> None:
    assert MATRIX["uiMatrixVersion"] == UI_MATRIX_VERSION
    expected = row["expect"]
    view = MODELS[expected["component"]](context_of(_with_defaults(row["input"])))
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
