# @pkey-feature ui.gate
"""The Python headless runner for the ``gate`` family of ``ui-matrix.json``.

The shared runner contract compares component, state, sorted copy keys and sorted actions.  Hidden
rows are intentionally asserted as empty views rather than skipped.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping

import pytest

from polaris_key.constants_generated import UI_MATRIX_VERSION
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.core.ui_gate import (
    boot_view,
    gate_view,
    grace_banner_view,
    status_screen_view,
    toast_view,
)

ROOT = Path(__file__).resolve().parents[3]
MATRIX = json.loads(
    (ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8")
)
FAMILY = "gate"
MODELS = {
    "PolarisKeyGate": gate_view,
    "Boot": boot_view,
    "StatusScreen": status_screen_view,
    "GraceBanner": grace_banner_view,
    "Toast": toast_view,
}


def _with_defaults(input: Mapping[str, Any]) -> Dict[str, Any]:
    output: Dict[str, Any] = dict(input)
    for key, value in MATRIX["vocabulary"]["defaults"].items():
        if key == "capabilities":
            output[key] = {**value, **dict(input.get(key) or {})}
        elif key not in output:
            output[key] = value
    return output


def _id(row: Mapping[str, Any]) -> str:
    return str(row["name"])


@pytest.mark.parametrize("row", MATRIX[FAMILY], ids=_id)
def test_gate_family_rows(row: Mapping[str, Any]) -> None:
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
