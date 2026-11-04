"""The Python runner for the ``holdersFlow`` family of ``ui-matrix.json`` (UK-43.16): the
AddToAccount model over a scripted driver, the same scenarios every native port replays."""

# @pkey-feature ui.kit.holders

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

import pytest

from polaris_key.ui.core.add_to_account import (
    AddToAccountDriver,
    AddToAccountHints,
    AddToAccountModel,
    AttachOutcome,
    ChoiceComplete,
    SignInWait,
)

ROOT = Path(__file__).resolve().parents[3]
FLOW = json.loads((ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8"))[
    "holdersFlow"
]
BASE: Dict[str, Any] = {
    "platform": {"os": "macos", "formFactor": "mac"},
    "presentation": {"name": "Tidewater Studio", "icon": True},
    "services": ["license", "identity"],
}


class Network(Exception):
    pass


def _wait(raw: Mapping[str, Any]) -> SignInWait:
    return SignInWait(raw["outcome"], grant=raw.get("grant"), email=raw.get("email"))


def _outcome(raw: Any) -> AttachOutcome:
    if raw == "network":
        raise Network()
    return AttachOutcome(raw["kind"], raw.get("code"))


class Scripted(AddToAccountDriver):
    """A driver answering from a scenario's script; a call past it answers ok (preview, attach) or
    cancelled (waits)."""

    def __init__(self, script: Mapping[str, Any]) -> None:
        self.script = script
        self.waits = [_wait(w) for w in script.get("waits", [{"outcome": "signedIn"}])]
        self.preview: List[Any] = list(script.get("preview", []))
        self.attach_script: List[Any] = list(script.get("attach", []))
        self.calls: List[str] = []
        self.hints: List[Dict[str, str]] = []
        self.during_first_wait: Optional[Any] = None
        self._waited = False

    def sign_in(self, hints: AddToAccountHints) -> Any:
        self.calls.append("signIn")
        self.hints.append({"loginHint": hints.login_hint, "nameHint": hints.name_hint, "purpose": hints.purpose})
        if self.script.get("signInError"):
            raise Network()
        return _Handle(self)

    def complete(self, grant: str, choice: Mapping[str, Any]) -> ChoiceComplete:
        self.calls.append("complete:%s:%s" % (grant, choice["kind"]))
        done = self.script.get("complete")
        return ChoiceComplete(done["outcome"]) if done else ChoiceComplete("signedIn")

    def attach(self, confirm: bool = True) -> Any:
        self.calls.append("attach" if confirm else "preview")
        queue = self.attach_script if confirm else self.preview
        return _outcome(queue.pop(0) if queue else {"kind": "ok"})


class _Handle:
    user_code = None

    def __init__(self, driver: Scripted) -> None:
        self.driver = driver

    def wait(self) -> SignInWait:
        d = self.driver
        if not d._waited and d.during_first_wait is not None:
            d._waited = True
            d.during_first_wait()
        return d.waits.pop(0) if d.waits else SignInWait("cancelled")

    def reopen(self) -> bool:
        return True

    def cancel(self) -> None:
        self.driver.calls.append("cancel")


def test_the_runner_covers_every_scenario() -> None:
    assert len(FLOW["scenarios"]) == 20


@pytest.mark.parametrize("sc", FLOW["scenarios"], ids=lambda sc: str(sc["name"]))
def test_holders_flow(sc: Mapping[str, Any]) -> None:
    driver = Scripted(sc["driver"])
    model = AddToAccountModel(
        driver=driver,
        base={**BASE, "licenseHolder": FLOW["base"]["licenseHolder"]},
        device_kind=FLOW["base"]["deviceKind"],
    )
    fields = sc.get("fields", {})
    model.set_field("name", fields.get("name", "Ada Lovelace"))
    model.set_field("email", fields.get("email", "ada@example.com"))
    steps: List[str] = []
    for action in sc["actions"]:
        if action == "submit-then-cancel":
            # The cancel lands while the sign-in's first wait is in flight.
            driver.during_first_wait = model.cancel
            model.submit()
        else:
            getattr(model, {"tryAgain": "try_again"}.get(action, action))()
        steps.append(model.snapshot.step)
    want = sc["expect"]
    assert steps == want["steps"]
    assert driver.calls == want["calls"]
    assert driver.hints == want["hints"]
    assert model.view().state == want["viewState"]
    snap = model.snapshot
    if "field" in want:
        assert snap.field == want["field"]
    if "typedEmail" in want:
        assert snap.typed_email == want["typedEmail"]
    if "signedEmail" in want:
        assert snap.signed_email == want["signedEmail"]


def test_the_typed_values_stay_out_of_the_views_input() -> None:
    model = AddToAccountModel(driver=Scripted({}), base=BASE, device_kind="Mac")
    model.set_field("name", "Ada Lovelace")
    model.set_field("email", "ada@example.com")
    text = json.dumps(model.input())
    assert "Ada Lovelace" not in text and "ada@example.com" not in text
    assert model.input()["addToAccount"] == {"step": "form", "deviceKind": "Mac"}
