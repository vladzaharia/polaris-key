"""The AddToAccount model and its SDK driver over the recorded ``holders-add-to-account-preview``
conversation (UK-43.16), through ``test_transcripts.py``'s replayer.

The recording is one flow the model drives end to end: key activation, then the sign-in the driver
starts (no native redirect is advertised here, so ``channel="redirect"`` answers
``redirect-unavailable`` and the driver asks for a device code with the hints), the poll that answers
``choose``, ``choice.complete`` keeping this device's license, the attach preview (``confirm: false``) and the
confirmed attach. The five recorded steps after the activation are replayed as one ordered step, so the
replayer asserts every request and nothing else is sent."""

# @pkey-feature ui.kit.holders identity.devicecode.choice identity.attach

from __future__ import annotations

import copy
from typing import Any, Dict

import pytest
import test_transcripts as tt
from transcript_replay import applies

from polaris_key.identity.sign_in import SignInSession
from polaris_key.ui.core.add_to_account import AddToAccountModel, driver_of

TRANSCRIPT_ID = "holders-add-to-account-preview"
ORIGINAL = next(t for t in tt.TRANSCRIPTS if t["id"] == TRANSCRIPT_ID)
BASE: Dict[str, Any] = {
    "platform": {"os": "macos", "formFactor": "mac"},
    "presentation": {"name": "Tidewater Studio", "icon": True},
    "services": ["license", "identity"],
}


def _merged() -> Dict[str, Any]:
    """The transcript with everything after the activation as one ordered step."""
    t = copy.deepcopy(ORIGINAL)
    first, rest = t["steps"][0], t["steps"][1:]
    assert [s["action"] for s in rest] == ["beginSignIn", "pollSignIn", "choiceComplete", "attach", "attach"]
    items = [item for s in rest for item in s["exchanges"]["items"]]
    args: Dict[str, Any] = {}
    for s in rest:
        args.update(s["args"])
    step = copy.deepcopy(rest[0])
    step["args"] = args
    step["exchanges"] = {"ordered": True, "items": items}
    step["expect"] = {}
    t["steps"] = [first, step]
    return t


def test_the_model_replays_the_recorded_conversation(monkeypatch: pytest.MonkeyPatch) -> None:
    if not applies(ORIGINAL, tt.MANIFEST):
        pytest.skip("sdks/python/parity.json does not claim the transcript's features")
    seen: Dict[str, Any] = {}
    real_act = tt._act

    def act(client: Any, store: Any, step: Dict[str, Any], session: Dict[str, Any]) -> Dict[str, Any]:
        if step["action"] != "beginSignIn":
            return real_act(client, store, step, session)
        model = AddToAccountModel(
            driver=driver_of(client.identity),
            base={**BASE, "licenseHolder": {"email": "ada@example.com"}},
            device_kind="Mac",
        )
        model.set_field("name", "Ada")
        model.set_field("email", "ada@example.com")
        model.submit()
        seen["step"] = model.snapshot.step
        seen["view"] = model.view().state
        seen["token"] = client.identity._deps.tokens.current is not None
        return {}

    # The poll interval is real time; the clock is pinned, so skip the sleep.
    monkeypatch.setattr(SignInSession, "_sleep", lambda self, seconds, token: None)
    monkeypatch.setattr(tt, "_act", act)
    tt.replay(_merged(), monkeypatch)
    assert seen == {"step": "added", "view": "added", "token": True}
