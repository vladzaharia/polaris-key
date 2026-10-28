# @pkey-feature ui.activate
"""The Python headless runner for the ``activate`` family of ``ui-matrix.json``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping

import pytest

from polaris_key.constants_generated import UI_MATRIX_VERSION
from polaris_key.ui.core.ui_activate import activate_view, offline_activation_view, welcome_view
from polaris_key.ui.core.ui_contract import context_of

ROOT = Path(__file__).resolve().parents[3]
MATRIX = json.loads(
    (ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8")
)
FAMILY = "activate"
MODELS = {"Welcome": welcome_view, "Activate": activate_view, "OfflineActivation": offline_activation_view}


def _with_defaults(input: Mapping[str, Any]) -> Dict[str, Any]:
    output: Dict[str, Any] = dict(input)
    for key, value in MATRIX["vocabulary"]["defaults"].items():
        if key == "capabilities":
            output[key] = {**value, **dict(input.get(key) or {})}
        elif key not in output:
            output[key] = value
    return output


@pytest.mark.parametrize("row", MATRIX[FAMILY], ids=lambda row: str(row["name"]))
def test_activate_family_rows(row: Mapping[str, Any]) -> None:
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


@pytest.mark.parametrize(
    "result,tone",
    [
        ("unauthorized", "danger"),
        ("error", "danger"),
        ("license-disabled", "neutral"),
        ("license-expired", "neutral"),
        ("key-entry-limit", "neutral"),
    ],
)
def test_a_refused_key_is_danger_only_when_the_key_itself_is_wrong(result: str, tone: str) -> None:
    """UI-KITS DL6/DL7: a refusal of a well-formed key is a neutral callout (bug package H2)."""
    view = activate_view(
        context_of(
            _with_defaults(
                {
                    "keyField": {"text": "pkey_tidewater_AbCdEfGhIjKlMnOpQrStUv", "submitted": True},
                    "activation": {"result": result},
                }
            )
        )
    )
    # The key-entry limit is a focused step (no field), not a stacked callout.
    assert view.state == ("key-entry-limit" if result == "key-entry-limit" else "rejected")
    assert view.decisions.tone == tone
