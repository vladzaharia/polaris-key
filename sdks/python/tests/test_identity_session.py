# @pkey-feature identity.devicecode identity.toggle identity.account
"""``identity.sign_in.start`` (I-10a.15): the session's ``wait`` (the outcomes, ``once``, the P1-07
attach opt-in), the hints, the typed refusals, the subject stored on ``signed_in``, the
``identity`` event kind and ``license.deactivate()`` forgetting the identity. The pacing rules are
in ``test_identity_mint.py``; the same semantics as Node's ``identity.test.ts``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import pytest

from polaris_key import PolarisError
from polaris_key.core.caps import UnsupportedError
from polaris_key.devices.store import InMemoryStore

from helpers import PRODUCT, TOKEN, make_client
from test_identity_account import SUBJECT, Worker, discovery, ok
from test_identity_mint import BASE, T0, clock  # noqa: F401

START = {
    "status": "pending",
    "deviceCode": "device-code-1",
    "userCode": "WDJB-MJHT",
    "verificationUri": f"{BASE}/{PRODUCT}/identity/auth/device",
    "verificationUriComplete": f"{BASE}/{PRODUCT}/identity/auth/device?user_code=WDJB-MJHT",
    "expiresIn": 600,
    "interval": 2,
}
ADA = {"name": "Ada", "email": "ada@example.com"}
CONFIRM = ok(status="confirm", identity=ADA, attachable=True)
READY = ok(status="ready", token="pkeyt_signed_in", schemaVersion=1, identity=ADA, attached="claimed")


def queue(*answers: httpx.Response) -> Any:
    items: List[httpx.Response] = list(answers)
    return lambda r: items.pop(0) if len(items) > 1 else items[0]


def make(worker: Worker, token: Optional[str] = None, **kw: Any) -> Any:
    store = InMemoryStore(PRODUCT)
    if token is not None:
        store.set_token(token)
    return make_client(worker, store=store, expected_services=["license", "config", "identity"], **kw)


def worker(*polls: httpx.Response, **extra: Any) -> Worker:
    return Worker(discovery(), start=ok(**START), poll=queue(*polls), **extra)


def polls(w: Worker) -> List[Dict[str, Any]]:
    return [c for c in w.calls if c["path"].endswith("/device/poll")]


def test_ready_carries_the_identity_the_activation_and_the_subject(clock, tmp_path: Any) -> None:
    w = worker(READY, subject=ok(subject=SUBJECT))
    c = make(w, state_dir=str(tmp_path))
    o = c.identity.sign_in.start().wait()
    assert o.kind == "signed_in" and o.identity.name == "Ada"
    assert o.activation.attached == "claimed"
    assert o.subject == SUBJECT
    assert c.identity.current() == {"name": "Ada", "email": "ada@example.com", "activatedAt": None}
    # The subject is stored for the next launch.
    assert json.loads((Path(c.core.dirs.state) / "subject.json").read_text()) == {"subject": SUBJECT}
    assert c.identity._account.stored_subject() == SUBJECT


def test_ready_without_a_subject_endpoint_is_a_null_subject(clock) -> None:
    c = make(Worker({**discovery(), "services": {"identity": {"enabled": True, "configured": True}}}, start=ok(**START), poll=queue(READY)))
    o = c.identity.sign_in.start().wait()
    assert o.kind == "signed_in" and o.subject is None


def test_the_identity_event_reports_the_sign_in_and_the_sign_out(clock) -> None:
    w = worker(READY, subject=ok(subject=SUBJECT), signout=ok(released=True))
    c = make(w)
    seen: List[Any] = []
    c.events.subscribe(lambda e: seen.append((e.get("change"), e.get("subject"), e.get("released"))), ["identity"])
    c.identity.sign_in.start().wait()
    c.identity.sign_out()
    assert seen == [("signed_in", SUBJECT, None), ("signed_out", None, True)]


def test_the_start_carries_the_hints(clock) -> None:
    w = worker(READY)
    c = make(w)
    c.identity.sign_in.start(
        device_name="Deck", login_hint="a@b.c", name_hint="Ada", purpose="signin", scope=["openid", "email"], license_choice="app"
    )
    body = next(c for c in w.calls if c["path"].endswith("/device/start"))["body"]
    assert body["loginHint"] == "a@b.c" and body["nameHint"] == "Ada" and body["purpose"] == "signin"
    assert body["scope"] == "openid email" and body["licenseChoice"] == "app" and body["deviceName"] == "Deck"


def test_an_ordinary_poll_sends_no_opt_in_and_no_bearer(clock) -> None:
    w = worker(READY)
    c = make(w, token="pkeyt_anonymous")
    c.identity.sign_in.start().wait()
    p = polls(w)[0]
    assert "confirmIdentity" not in p["body"] and p["auth"] is None


def test_the_attach_opt_in_asks_then_sends_the_decision_with_the_bearer(clock) -> None:
    w = worker(CONFIRM, READY)
    c = make(w, token="pkeyt_anonymous")
    asked: List[Any] = []
    o = c.identity.sign_in.start().wait(confirm=lambda who, attachable: asked.append((who.email, attachable)) or True)
    assert o.kind == "signed_in" and asked == [("ada@example.com", True)]
    p = polls(w)
    assert p[0]["body"] == {"deviceCode": "device-code-1", "deviceId": c.core.device_id, "confirmIdentity": True}
    assert p[1]["body"]["attachLicense"] is True
    assert p[0]["auth"] == "Bearer pkeyt_anonymous"


def test_declining_the_attach_still_signs_in_without_it(clock) -> None:
    w = worker(CONFIRM, READY)
    c = make(w)
    assert c.identity.sign_in.start().wait(confirm=lambda who, attachable: False).kind == "signed_in"
    assert polls(w)[1]["body"]["attachLicense"] is False


def test_once_polls_one_time_and_answers_pending_then_the_confirm_decision(clock) -> None:
    w = worker(ok(status="pending"), CONFIRM, READY)
    c = make(w)
    s = c.identity.sign_in.start()
    t0 = clock["now"]
    assert s.wait(once=True).kind == "pending"
    assert clock["now"] == t0  # no leading pause
    held = s.wait(once=True, confirm=lambda who, attachable: True)
    assert held.kind == "pending" and held.slow_down is False
    assert s.wait(once=True, confirm=lambda who, attachable: True).kind == "signed_in"


def test_once_answers_slow_down_with_the_longer_interval(clock) -> None:
    w = worker(httpx.Response(429, json={"status": "slow_down", "interval": 7}))
    c = make(w)
    s = c.identity.sign_in.start()
    o = s.wait(once=True)
    assert (o.kind, o.slow_down, o.interval) == ("pending", True, 7) and s.interval == 7


def test_once_raises_a_transient_failure_for_the_caller_to_pace(clock) -> None:
    w = worker(httpx.Response(503, json={}))
    c = make(w)
    with pytest.raises(PolarisError) as e:
        c.identity.sign_in.start().wait(once=True)
    assert e.value.code == "server-error"


def test_cancel_makes_wait_answer_cancelled_without_a_request(clock) -> None:
    w = worker(READY)
    c = make(w)
    s = c.identity.sign_in.start()
    s.cancel()
    assert s.wait().kind == "cancelled"
    assert polls(w) == []


def test_a_refusal_raises_sign_in_denied_and_a_failure_sign_in_failed(clock) -> None:
    denied = make(worker(ok(status="error", reason="access_denied")))
    with pytest.raises(PolarisError) as e:
        denied.identity.sign_in.start().wait()
    assert e.value.code == "sign-in-denied"
    failed = make(worker(ok(status="error")))
    with pytest.raises(PolarisError) as e2:
        failed.identity.sign_in.start().wait()
    assert e2.value.code == "sign-in-failed"
    assert failed._tokens.current is None


def test_a_404_on_the_start_is_service_unavailable(clock) -> None:
    c = make(Worker(discovery(), start=httpx.Response(404, json={"error": {"code": "not_found"}})), token="pkeyt_anonymous")
    with pytest.raises(UnsupportedError) as e:
        c.identity.sign_in.start()
    assert e.value.code == "service-unavailable" and e.value.reason == "product"
    assert c._tokens.current == "pkeyt_anonymous"


def test_a_start_refused_with_a_code_raises_it(clock) -> None:
    c = make(Worker(discovery(), start=httpx.Response(429, json={"error": {"code": "rate_limited"}})))
    with pytest.raises(PolarisError) as e:
        c.identity.sign_in.start()
    assert e.value.code == "rate_limited"


def test_identity_off_refuses_before_any_request(clock) -> None:
    w = Worker(discovery(identity=False), start=ok(**START))
    c = make_client(w, expected_services=["license", "config"])
    with pytest.raises(UnsupportedError) as e:
        c.identity.sign_in.start()
    assert e.value.code == "service-unavailable"
    assert not any(x["path"].endswith("/device/start") for x in w.calls)


def test_no_provider_set_up_is_disabled_before_any_request(clock) -> None:
    doc = discovery()
    doc["services"]["identity"]["configured"] = False
    w = Worker(doc, start=ok(**START))
    c = make_client(w, expected_services=["license", "config", "identity"])
    c.discover()
    with pytest.raises(PolarisError) as e:
        c.identity.sign_in.start()
    assert e.value.code == "disabled"
    assert not any(x["path"].endswith("/device/start") for x in w.calls)


def test_a_channel_this_version_lacks_is_the_typed_version_na(clock) -> None:
    c = make(worker(READY))
    with pytest.raises(UnsupportedError) as e:
        c.identity.sign_in.start(channel="loopback", redirect_uri="http://127.0.0.1:8080/cb")
    assert e.value.reason == "version" and e.value.feature == "identity.redirect.web"


def test_reopen_opens_the_complete_uri(clock) -> None:
    opened: List[str] = []
    c = make(worker(READY))
    c.identity._deps.open_url = lambda url: opened.append(url) or True
    s = c.identity.sign_in.start()
    assert s.reopen() is True and opened == [s.verification_uri_complete]


def test_deactivate_forgets_the_identity_and_the_subject(clock) -> None:
    w = worker(READY, subject=ok(subject=SUBJECT), deauthorize=ok(ok=True))
    c = make(w)
    c.identity.sign_in.start().wait()
    assert c.identity.current() is not None
    assert c.identity._account.stored_subject() == SUBJECT
    c.license.deactivate()
    assert c.identity._account.stored_subject() is None
    assert c.identity.current() is None
