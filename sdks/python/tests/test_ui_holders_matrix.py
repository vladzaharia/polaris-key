"""The Python headless runner for the ``holders`` family of ``ui-matrix.json`` (ActivateDone,
AddToAccount and the SignIn / AccountAndLicense rows that draw them), and the ``maskEmail`` vectors."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping

import pytest

from polaris_key.constants_generated import UI_MATRIX_VERSION
from polaris_key.ui.core.format import mask_email
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.core.ui_holders import activate_done_view, add_to_account_view, lead_parts, recommend_reasons
from polaris_key.ui.core.ui_settings import account_view
from polaris_key.ui.core.ui_signin import sign_in_view

ROOT = Path(__file__).resolve().parents[3]
MATRIX = json.loads((ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8"))
MODELS = {
    "ActivateDone": activate_done_view,
    "AddToAccount": add_to_account_view,
    "SignIn": sign_in_view,
    "AccountAndLicense": account_view,
}


def _with_defaults(input: Mapping[str, Any]) -> Dict[str, Any]:
    output: Dict[str, Any] = dict(input)
    for key, value in MATRIX["vocabulary"]["defaults"].items():
        if key == "capabilities":
            output[key] = {**value, **dict(input.get(key) or {})}
        elif key not in output:
            output[key] = value
    return output


def test_the_runner_covers_every_row():
    assert MATRIX["uiMatrixVersion"] == UI_MATRIX_VERSION
    assert {row["expect"]["component"] for row in MATRIX["holders"]} <= set(MODELS)
    assert len(MATRIX["holders"]) >= 32


@pytest.mark.parametrize("row", MATRIX["holders"], ids=lambda row: str(row["name"]))
def test_holders_rows(row: Mapping[str, Any]) -> None:
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


@pytest.mark.parametrize("vector", MATRIX["holdersFlow"]["maskEmail"], ids=lambda v: repr(v["email"]))
def test_mask_email_vectors(vector: Mapping[str, Any]) -> None:
    assert mask_email(vector["email"]) == vector["masked"]


def test_reasons_follow_identity_and_sync() -> None:
    assert recommend_reasons(False, True) == ["activate.recommend.portal"]
    assert recommend_reasons(True, False) == ["activate.recommend.recover", "activate.recommend.devices"]
    assert recommend_reasons(True, True)[0] == "activate.recommend.sync"


def test_lead_parts_splits_on_the_markers() -> None:
    assert lead_parts("**Cloud Sync**: saves follow you") == [
        {"text": "Cloud Sync", "strong": True},
        {"text": ": saves follow you", "strong": False},
    ]
    assert lead_parts("plain") == [{"text": "plain", "strong": False}]
    assert lead_parts("") == []


def test_a_holder_email_with_identity_off_is_ready_with_the_portal_line() -> None:
    base = {"activateDone": {}, "licenseHolder": {"email": "maya@example.com"}}
    on = activate_done_view(context_of(_with_defaults({**base, "services": ["license", "identity"]})))
    assert on.state == "waiting"
    off = activate_done_view(context_of(_with_defaults({**base, "services": ["license"]})))
    assert off.state == "ready"
    for key in ("activate.recommend.portal", "signin.key.addInLocker", "a11y.externalLink"):
        assert key in off.copy
    assert "activate.waiting" not in off.copy
    assert "activate.waitingSignIn" not in off.copy
    assert "maskedEmail" not in off.args
