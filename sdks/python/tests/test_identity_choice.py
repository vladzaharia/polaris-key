# @pkey-feature identity.choice
"""``identity.choice.*`` (I-10a.17): the same semantics as Node's ``identityChoice.test.ts`` and
Kotlin's ``IdentityChoiceTest``. Refusals are results carrying ``retry_after_seconds``,
``manage_url``, ``sign_in_url``, ``key_entries`` and the fresh view; only discovery's endpoints
are dialled; no bearer is sent and the grant never appears in an error; ``keep`` gives
``attachable``; ``complete`` with no choice is the 409 transcript step."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx
import pytest

from polaris_key import PolarisError
from polaris_key.core.caps import UnsupportedError
from polaris_key.devices.store import InMemoryStore

from helpers import BASE_URL, PRODUCT, make_client
from test_identity_account import Worker, ok

PB = f"{BASE_URL}/{PRODUCT}"
GRANT = "sg_" + "Q" * 43
SUBJECT = "ps_" + "D" * 22
ENDPOINTS = {
    "choiceLicenses": f"{PB}/identity/choice/licenses",
    "choiceDevices": f"{PB}/identity/choice/devices",
    "choiceComplete": f"{PB}/identity/choice/complete",
    "choiceCancel": f"{PB}/identity/choice/cancel",
}
VIEW = {"state": "choose", "choices": [{"id": "lic_a"}, {"id": "lic_b"}]}
TOKEN = {
    "access_token": "pkeyt_chosen",
    "token_type": "Bearer",
    "scope": "profile email",
    "schemaVersion": 1,
    "device": {"id": "D"},
    "license": {"id": "lic_a"},
    "subject": SUBJECT,
}


def discovery(endpoints: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    return {
        "product": PRODUCT,
        "services": {
            "license": {"enabled": True},
            "config": {"enabled": True},
            "identity": {
                "enabled": True,
                "configured": True,
                "endpoints": ENDPOINTS if endpoints is None else endpoints,
            },
        },
    }


def make(w: Worker, token: Optional[str] = "pkeyt_old", **kw: Any) -> Any:
    store = InMemoryStore(PRODUCT)
    if token is not None:
        store.set_token(token)
    c = make_client(w, store=store, expected_services=["license", "config", "identity"], **kw)
    c.identity._deps.on_acquired = lambda: None
    return c


def calls(w: Worker) -> List[Dict[str, Any]]:
    return [c for c in w.calls if "/identity/choice/" in c["path"]]


def test_licenses_and_devices_are_views_and_send_no_bearer() -> None:
    w = Worker(
        discovery(),
        licenses=ok(**VIEW),
        devices=ok(licenseId="lic_a", devices=[{"id": "d1"}, {"id": "d2"}]),
    )
    c = make(w)
    r = c.identity.choice.licenses(GRANT)
    assert r.kind == "ok" and r.view.state == "choose" and r.view.license_ids == ["lic_a", "lic_b"]
    d = c.identity.choice.devices(GRANT, "lic_a")
    assert d.kind == "ok" and d.view.license_id == "lic_a" and d.view.device_ids == ["d1", "d2"]
    assert [x["body"] for x in calls(w)] == [
        {"grant": GRANT},
        {"grant": GRANT, "licenseId": "lic_a"},
    ]
    assert all(x["auth"] is None for x in calls(w))


def test_complete_stores_the_token_like_a_sign_in(tmp_path: Any) -> None:
    w = Worker(discovery(), complete=ok(**TOKEN, keyEntries={"used": 1, "limit": 10}))
    store = InMemoryStore(PRODUCT)
    c = make_client(w, store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path))
    c.identity._deps.on_acquired = lambda: None
    seen: List[Any] = []
    c.events.subscribe(lambda e: seen.append((e.get("change"), e.get("subject"))), ["identity"])
    r = c.identity.choice.complete(GRANT, {"kind": "key", "key": "pkey_secret"})
    assert (r.kind, r.license_id, r.subject, r.scope, r.attachable) == ("ok", "lic_a", SUBJECT, "profile email", False)
    assert (r.key_entries.used, r.key_entries.limit) == (1, 10)
    assert store.get_token() == "pkeyt_chosen"
    assert c.identity._account.stored_subject() == SUBJECT
    assert seen == [("signed_in", SUBJECT)]
    assert calls(w)[0]["body"] == {"grant": GRANT, "choice": {"kind": "key", "key": "pkey_secret"}}


def test_keep_gives_attachable() -> None:
    w = Worker(discovery(), complete=ok(**{**TOKEN, "license": None}))
    r = make(w).identity.choice.complete(GRANT, {"kind": "keep"})
    assert (r.kind, r.license_id, r.attachable) == ("ok", None, True)


def test_complete_with_no_choice_sends_none_and_the_409_is_a_result_with_the_fresh_view() -> None:
    w = Worker(
        discovery(),
        complete=httpx.Response(409, json={"error": {"code": "license_choice_required"}, "view": VIEW}),
    )
    c = make(w)
    r = c.identity.choice.complete(GRANT)
    assert calls(w)[0]["body"] == {"grant": GRANT}
    assert (r.kind, r.code, r.http_status, r.view.license_ids) == (
        "refused", "license_choice_required", 409, ["lic_a", "lic_b"],
    )
    assert c.core.store.get_token() == "pkeyt_old"


def test_every_refusal_is_a_result_that_keeps_the_token() -> None:
    cases = [
        (httpx.Response(400, json={"error": "invalid_grant"}), "invalid_grant", {}),
        (httpx.Response(404, json={"error": {"code": "not_found"}}), "not_found", {}),
        (
            httpx.Response(
                409,
                json={"error": {"code": "device_limit"}, "view": VIEW, "manageUrl": "https://key.example/#/manage/x"},
            ),
            "device_limit",
            {"manage_url": "https://key.example/#/manage/x", "view": True},
        ),
        (
            httpx.Response(429, json={"error": "rate_limited", "retryAfter": 1.5}),
            "rate_limited",
            {"retry_after_seconds": 2},
        ),
        (
            httpx.Response(429, json={"error": "rate_limited"}, headers={"retry-after": "9"}),
            "rate_limited",
            {"retry_after_seconds": 9},
        ),
        (
            httpx.Response(409, json={"error": {"code": "license_owned"}, "signInUrl": "https://key.example/signin"}),
            "license_owned",
            {"sign_in_url": "https://key.example/signin"},
        ),
        (
            httpx.Response(409, json={"error": {"code": "key_entry_limit"}, "keyEntries": {"used": 3, "limit": 3}}),
            "key_entry_limit",
            {"key_entries": True},
        ),
    ]
    for answer, code, more in cases:
        w = Worker(discovery(), complete=answer)
        c = make(w)
        r = c.identity.choice.complete(GRANT, {"kind": "create"})
        assert (r.kind, r.code) == ("refused", code)
        assert r.retry_after_seconds == more.get("retry_after_seconds")
        assert r.manage_url == more.get("manage_url")
        assert r.sign_in_url == more.get("sign_in_url")
        assert (r.view is not None) == bool(more.get("view"))
        assert (r.key_entries is not None) == bool(more.get("key_entries"))
        assert c.core.store.get_token() == "pkeyt_old"


def test_cancel_is_ok_on_204_and_a_result_on_refusal() -> None:
    assert make(Worker(discovery(), cancel=httpx.Response(204))).identity.choice.cancel(GRANT).kind == "ok"
    r = make(Worker(discovery(), cancel=httpx.Response(400, json={"error": "invalid_grant"}))).identity.choice.cancel(GRANT)
    assert (r.kind, r.code) == ("refused", "invalid_grant")


def test_a_5xx_raises_and_never_names_the_grant() -> None:
    w = Worker(discovery(), licenses=httpx.Response(503, json={"error": "unavailable"}))
    with pytest.raises(PolarisError) as e:
        make(w).identity.choice.licenses(GRANT)
    assert e.value.code == "server-error" and GRANT not in str(e.value) and GRANT not in repr(e.value)


def test_an_unreadable_view_or_token_is_bad_response() -> None:
    with pytest.raises(PolarisError) as e:
        make(Worker(discovery(), licenses=ok(state="choose"))).identity.choice.licenses(GRANT)
    assert e.value.code == "bad_response" and GRANT not in str(e.value)
    with pytest.raises(PolarisError) as e:
        make(Worker(discovery(), complete=ok(access_token="x"))).identity.choice.complete(GRANT, {"kind": "keep"})
    assert e.value.code == "bad_response"


def test_a_missing_endpoint_is_the_typed_na_before_any_request() -> None:
    w = Worker(discovery({"choiceLicenses": ENDPOINTS["choiceLicenses"]}))
    c = make(w)
    with pytest.raises(UnsupportedError) as e:
        c.identity.choice.complete(GRANT, {"kind": "keep"})
    assert e.value.code == "service-unavailable" and e.value.reason == "product"
    assert e.value.feature == "identity.choice" and calls(w) == []


def test_identity_off_is_the_typed_na() -> None:
    d = {"product": PRODUCT, "services": {"license": {"enabled": True}, "identity": {"enabled": False}}}
    w = Worker(d)
    with pytest.raises(UnsupportedError) as e:
        make(w).identity.choice.licenses(GRANT)
    assert e.value.code == "service-unavailable" and calls(w) == []


def test_an_endpoint_outside_this_product_is_never_dialled() -> None:
    w = Worker(discovery({**ENDPOINTS, "choiceLicenses": "https://evil.example/djdl/identity/choice/licenses"}))
    with pytest.raises(PolarisError) as e:
        make(w).identity.choice.licenses(GRANT)
    assert e.value.code == "bad_response" and calls(w) == []
