# @pkey-feature identity.devicecode
"""Sign-in conveniences (SDK parity pass §3.12, SP-P10): P1-07's attach opt-in, ``ready`` carrying
the identity, ``sign_in_with_browser()`` (device code opened in the system browser, never the
deprecated ``/identity/auth/poll``), ``current()`` and ``sign_out()``."""

from __future__ import annotations

import httpx
import pytest

from polaris_key import PolarisError

from test_identity_mint import POLL, START, Plane, clock, make, started  # noqa: F401

CONFIRM = httpx.Response(200, json={"status": "confirm", "identity": {"name": "Ada", "email": "ada@example.com"}, "attachable": True})
READY_ID = httpx.Response(
    200,
    json={"status": "ready", "token": "pkeyt_signed_in", "schemaVersion": 1, "identity": {"name": "Ada", "email": "ada@example.com"}, "attached": "claimed"},
)


def test_ready_carries_the_identity(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [READY_ID]})
    c = make(plane, ["identity"])
    r = c.identity.wait_for_sign_in(c.identity.begin_sign_in())
    assert r.status == "ready" and r.identity.name == "Ada" and r.attached == "claimed"
    assert c.identity.current() == {"name": "Ada", "email": "ada@example.com", "activatedAt": None}


def test_the_attach_opt_in_asks_then_sends_the_decision_with_the_bearer(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [CONFIRM, READY_ID]})
    c = make(plane, ["identity"], token="pkeyt_anonymous")
    asked = []
    prompt = c.identity.begin_sign_in(confirm_identity=True)
    r = c.identity.wait_for_sign_in(prompt, on_confirm=lambda ident, attachable: asked.append((ident.email, attachable)) or True)
    assert r.status == "ready" and asked == [("ada@example.com", True)]
    polls = [x for x in plane.calls if x["path"] == POLL]
    assert polls[0]["body"] == {"deviceCode": "device-code-1", "deviceId": "D" * 32, "confirmIdentity": True}
    assert polls[1]["body"]["attachLicense"] is True
    assert polls[0]["authorization"] == "Bearer pkeyt_anonymous"


def test_an_ordinary_poll_sends_no_opt_in_and_no_bearer(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [READY_ID]})
    c = make(plane, ["identity"], token="pkeyt_anonymous")
    c.identity.poll_sign_in(c.identity.begin_sign_in())
    poll = [x for x in plane.calls if x["path"] == POLL][0]
    assert "confirmIdentity" not in poll["body"] and poll["authorization"] is None


def test_declining_the_identity_cancels(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [CONFIRM]})
    c = make(plane, ["identity"])
    with pytest.raises(PolarisError) as e:
        c.identity.wait_for_sign_in(c.identity.begin_sign_in(confirm_identity=True), on_confirm=lambda i, a: None)
    assert e.value.code == "cancelled"


def test_accept_sign_in_sends_one_poll(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [CONFIRM, READY_ID]})
    c = make(plane, ["identity"])
    prompt = c.identity.begin_sign_in(confirm_identity=True)
    first = c.identity.poll_sign_in(prompt)
    assert first.status == "confirm" and first.attachable is True and first.identity.name == "Ada"
    done = c.identity.accept_sign_in(prompt, attach_license=False)
    assert done.status == "ready"
    assert [x for x in plane.calls if x["path"] == POLL][1]["body"]["attachLicense"] is False


def test_sign_in_with_browser_opens_the_complete_uri(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [READY_ID]})
    c = make(plane, ["identity"])
    opened, prompts = [], []
    r = c.identity.sign_in_with_browser(open_url=opened.append, on_prompt=prompts.append)
    assert r.status == "ready"
    assert opened == [prompts[0].verificationUriComplete]
    assert not any(x["path"].endswith("/identity/auth/poll") for x in plane.calls)


def test_sign_out_clears_the_credential_and_identity(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [READY_ID]})
    c = make(plane, ["identity"])
    c.identity.wait_for_sign_in(c.identity.begin_sign_in())
    c.identity.sign_out()
    assert c._tokens.current is None and c.identity.current() is None
    assert any(x["path"].endswith("/license/deauthorize") for x in plane.calls)
