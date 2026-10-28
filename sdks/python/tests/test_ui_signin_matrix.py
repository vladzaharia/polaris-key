# @pkey-feature ui.signin
"""The Python headless runner for the ``signIn`` family in ``ui-matrix.json``: SignIn, SignInHandoff,
NearbyApproval and LicenseChoice. LicenseChoice reads the grant roster (a device-code sign-in never reaches it: the
card chooses), so a runtime kit cannot show it before I-10b; the model runs against the matrix alone."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping

import pytest

from polaris_key.constants_generated import UI_MATRIX_VERSION
from polaris_key.ui.core.ui_choice import license_choice_view
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.core.ui_signin import nearby_approval_view, sign_in_handoff_view, sign_in_view

ROOT = Path(__file__).resolve().parents[3]
MATRIX = json.loads((ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8"))
MODELS = {
    "SignIn": sign_in_view,
    "SignInHandoff": sign_in_handoff_view,
    "NearbyApproval": nearby_approval_view,
    "LicenseChoice": license_choice_view,
}
ROWS = [row for row in MATRIX["signIn"] if row["expect"]["component"] in MODELS]


def _with_defaults(input: Mapping[str, Any]) -> Dict[str, Any]:
    output: Dict[str, Any] = dict(input)
    for key, value in MATRIX["vocabulary"]["defaults"].items():
        if key == "capabilities":
            output[key] = {**value, **dict(input.get(key) or {})}
        elif key not in output:
            output[key] = value
    return output


def test_the_runner_covers_every_row():
    assert len(ROWS) == len(MATRIX["signIn"])
    assert sum(1 for row in ROWS if row["expect"]["component"] == "LicenseChoice") >= 40


@pytest.mark.parametrize("row", ROWS, ids=lambda row: str(row["name"]))
def test_sign_in_rows(row: Mapping[str, Any]) -> None:
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
