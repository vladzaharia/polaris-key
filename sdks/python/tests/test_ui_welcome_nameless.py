# @pkey-feature ui.activate
"""A Welcome with no product name anywhere is titled "Welcome", never "Welcome to" and nothing."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from polaris_key.ui.core import Copy
from polaris_key.ui.core.ui_activate import welcome_view
from polaris_key.ui.core.ui_contract import context_of

ROOT = Path(__file__).resolve().parents[3]
DEFAULTS = json.loads(
    (ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8")
)["vocabulary"]["defaults"]


def _input(**extra: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = dict(DEFAULTS)
    out.update(presentation=None, bundle=None, integrator=None)
    caps = dict(DEFAULTS["capabilities"])
    caps.update(extra.pop("capabilities", {}))
    out["capabilities"] = caps
    out.update(extra)
    return out


def test_nameless_welcome_uses_the_neutral_title() -> None:
    for inputs in (
        _input(),
        _input(pending="sign-in"),
        _input(capabilities={"signIn": False}),
    ):
        view = welcome_view(context_of(inputs))
        assert "common.welcomeNoProductTitle" in view.copy
        assert "welcome.title" not in view.copy
    sign_in_only = welcome_view(context_of(_input(capabilities={"keyEntry": False})))
    assert "common.signInToContinue" in sign_in_only.copy
    assert "welcome.ledeSignInOnly" not in sign_in_only.copy


def test_the_neutral_title_reads_welcome() -> None:
    assert Copy("en")("common.welcomeNoProductTitle") == "Welcome"


def test_a_named_product_keeps_its_title() -> None:
    view = welcome_view(context_of(dict(DEFAULTS)))
    assert "welcome.title" in view.copy
