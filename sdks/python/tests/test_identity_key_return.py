# @pkey-feature identity.keyreturn
"""The key return on the redirect sign-in (WIRE-CONTRACT-V5 §12.4.2, §12.5): the opt-in, the
activated outcome, the strict token parse and the flat refusals with their details, on the web
redirect and the native one. The wire conversations are the ``redirect-web-key-return*``
transcripts' (``test_transcripts.py``)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl

import httpx
import pytest
import test_identity_native_redirect as nat
import test_identity_redirect as web
from helpers import make_client
from test_identity_account import ok

from polaris_key.constants_generated import ErrorCode
from polaris_key.core.manage import KeyEntries
from polaris_key.devices.store import InMemoryStore
from polaris_key.identity.native_redirect import push_request
from polaris_key.identity.redirect import (
    RefusalDetails,
    SignInError,
    parse_token_answer,
    start_redirect,
)

SUBJECT = "ps_" + "C" * 22

KEY_OK: Dict[str, Any] = {
    "access_token": "pkeyt_key",
    "token_type": "Bearer",
    "scope": "",
    "schemaVersion": 1,
    "device": {"id": "D"},
    "license": {"id": "lic_1"},
    "subject": None,
    "via": "key",
    "keyEntries": {"used": 1, "limit": 10},
}


def _web_client(w: Any, tmp_path: Any, token: Optional[str] = None) -> Any:
    store = InMemoryStore(web.PRODUCT)
    if token is not None:
        store.set_token(token)
    c = make_client(
        w, store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path), device_name=""
    )
    c.identity._deps.on_acquired = lambda: None
    c.identity._deps.entropy = {"state": web.STATE, "code_verifier": web.VERIFIER}
    return c


def _events(c: Any) -> List[Tuple[Any, Any]]:
    seen: List[Tuple[Any, Any]] = []
    c.events.subscribe(lambda e: seen.append((e.get("change"), e.get("subject"))), ["identity"])
    return seen


# ── Rule 1: the opt-in is never sent unless set ─────────────────────────────────────────


def test_the_authorize_request_carries_key_return_last_and_only_when_set() -> None:
    off = start_redirect(**web.BASE)
    on = start_redirect(**web.BASE, key_return=True)
    assert "key_return" not in off.authorize_url and off.key_return is False
    assert on.authorize_url == off.authorize_url + "&key_return=allow" and on.key_return is True
    both = start_redirect(**web.BASE, key_return=True, license_choice="app", choice_available=True)
    assert both.authorize_url.endswith("&license_choice=app&key_return=allow")


def test_the_pushed_request_carries_key_return_before_the_label_and_only_when_set() -> None:
    kw: Dict[str, Any] = dict(
        request_endpoint=f"{nat.PB}/identity/request",
        authorize_endpoint=f"{nat.PB}/identity/authorize",
        token_endpoint=f"{nat.PB}/identity/token",
        issuer=nat.ISS,
        client_id="djdl",
        redirect_uri="http://127.0.0.1:49152/pkey/callback",
        device_name="Ada's Mac",
        state=nat.STATE,
        code_verifier=nat.VERIFIER,
    )
    assert "key_return" not in dict(parse_qsl(push_request(**kw).body))
    on = push_request(**kw, key_return=True)
    keys = [k for k, _ in parse_qsl(on.body)]
    assert keys[-2:] == ["key_return", "device_name"] and dict(parse_qsl(on.body))["key_return"] == "allow"
    assert on.pending.key_return is True


def test_a_bare_web_start_sends_no_key_return(tmp_path: Any) -> None:
    c = _web_client(web.FormWorker(web.disc(), token=ok(**web.TOKEN_ANSWER)), tmp_path)
    s = c.identity.sign_in.start(channel="redirect", redirect_uri=web.CB)
    assert "key_return" not in s.authorize_url
    on = c.identity.sign_in.start(channel="redirect", redirect_uri=web.CB, key_return=True)
    assert on.authorize_url.endswith("&key_return=allow")


# ── Rule 2: the activated outcome, the strict parse, the flat refusals ────────────────────


def test_a_via_key_answer_is_activated_a_key_activation_with_no_account(tmp_path: Any) -> None:
    w = web.FormWorker(web.disc(), token=ok(**KEY_OK))
    c = _web_client(w, tmp_path, token="pkeyt_old")
    c.identity._account.write_subject(SUBJECT)
    seen = _events(c)
    s = c.identity.sign_in.start(channel="redirect", redirect_uri=web.CB, key_return=True)
    o = s.complete(web.callback("C"))
    assert (o.kind, o.subject, o.scope, o.activation.license_id) == ("activated", None, "", "lic_1")
    assert o.key_entries == KeyEntries(used=1, limit=10)
    assert c._tokens.current == "pkeyt_key" and c._tokens.source == "activate"
    # The account the device held is gone with its subject; a key activation is not a sign-in.
    assert c.identity._account.stored_subject() is None
    assert seen == [("subject_changed", None)]
    assert ("signed_in", SUBJECT) not in seen


def test_a_key_return_on_a_device_with_no_account_emits_no_subject_change(tmp_path: Any) -> None:
    c = _web_client(web.FormWorker(web.disc(), token=ok(**KEY_OK)), tmp_path)
    seen = _events(c)
    s = c.identity.sign_in.start(channel="redirect", redirect_uri=web.CB, key_return=True)
    assert s.complete(web.callback("C")).kind == "activated"
    assert seen == []


def test_a_via_key_answer_without_the_opt_in_is_malformed_and_stores_nothing(tmp_path: Any) -> None:
    c = _web_client(web.FormWorker(web.disc(), token=ok(**KEY_OK)), tmp_path, token="pkeyt_old")
    s = c.identity.sign_in.start(channel="redirect", redirect_uri=web.CB)
    with pytest.raises(Exception) as e:
        s.complete(web.callback("C"))
    assert getattr(e.value, "code", None) == ErrorCode.BAD_RESPONSE
    assert c.core.store.get_token() == "pkeyt_old"


def test_an_ordinary_answer_still_signs_in_with_the_opt_in(tmp_path: Any) -> None:
    c = _web_client(web.FormWorker(web.disc(), token=ok(**web.TOKEN_ANSWER)), tmp_path)
    s = c.identity.sign_in.start(channel="redirect", redirect_uri=web.CB, key_return=True)
    o = s.complete(web.callback("C"))
    assert (o.kind, o.subject) == ("signed_in", web.TOKEN_ANSWER["subject"])


@pytest.mark.parametrize(
    "over",
    [
        {"via": "device"},
        {"scope": "profile"},
        {"license": None},
        {"keyEntries": None},
        {"keyEntries": {"used": -1, "limit": 3}},
        {"keyEntries": {"used": 1}},
        {"subject": "someone"},
        {"subject": ""},
        {"access_token": ""},
        {"device": None},
    ],
)
def test_a_via_key_body_that_breaks_a_rule_is_malformed(over: Dict[str, Any]) -> None:
    assert parse_token_answer(200, {**KEY_OK, **over}, key_return=True).kind == "malformed"


def test_the_activated_parse_keeps_the_answered_subject_and_the_count() -> None:
    a = parse_token_answer(200, {**KEY_OK, "subject": SUBJECT}, key_return=True)
    assert (a.kind, a.subject, a.key_entries) == ("activated", SUBJECT, KeyEntries(1, 10))
    assert parse_token_answer(200, KEY_OK).kind == "malformed"


def _refusal(c: Any, tmp_path: Any = None) -> SignInError:
    s = c.identity.sign_in.start(channel="redirect", redirect_uri=web.CB, key_return=True)
    with pytest.raises(SignInError) as e:
        s.complete(web.callback("C"))
    return e.value


def test_device_limit_carries_its_details_and_keeps_the_token(tmp_path: Any) -> None:
    manage = "https://key.plrs.im/activate?product=djdl"
    body = {"error": "device_limit", "limit": 1, "deviceCount": 1, "manageUrl": manage}
    c = _web_client(web.FormWorker(web.disc(), token=httpx.Response(403, json=body)), tmp_path, token="pkeyt_old")
    err = _refusal(c)
    assert (err.code, err.status) == ("device_limit", 403)
    assert err.details == RefusalDetails(limit=1, device_count=1, manage_url=manage)
    assert c.core.store.get_token() == "pkeyt_old"


def test_license_owned_and_key_entry_limit_carry_their_links_and_counts(tmp_path: Any) -> None:
    owned = {"error": "license_owned", "signInUrl": "https://key.plrs.im/signin?product=djdl"}
    c = _web_client(web.FormWorker(web.disc(), token=httpx.Response(403, json=owned)), tmp_path)
    err = _refusal(c)
    assert err.code == "license_owned"
    assert err.details == RefusalDetails(sign_in_url="https://key.plrs.im/signin?product=djdl")
    limit = {"error": "key_entry_limit", "keyEntries": {"used": 3, "limit": 3}, "manageUrl": "javascript:alert(1)"}
    c = _web_client(web.FormWorker(web.disc(), token=httpx.Response(403, json=limit)), tmp_path)
    err = _refusal(c)
    # A link that is not https is dropped.
    assert err.details == RefusalDetails(key_entries=KeyEntries(used=3, limit=3))


def test_a_refusal_with_no_flat_members_has_no_details(tmp_path: Any) -> None:
    c = _web_client(web.FormWorker(web.disc(), token=httpx.Response(400, json={"error": "invalid_grant"})), tmp_path)
    assert _refusal(c).details is None


# ── The native redirect ──────────────────────────────────────────────────────────────────


def _native(w: Any, **opts: Any) -> Tuple[Any, Any]:
    c = nat.make(w)
    s = nat.start(c, loopback=False, registered_schemes=[nat.SCHEME], **opts)
    return c, s


def _deliver(s: Any) -> str:
    return nat.SCHEME + "?code=" + nat.CODE + "&state=" + nat.STATE + "&iss=" + nat.ISS


def test_a_native_start_pushes_key_return_only_when_set() -> None:
    w = nat.World()
    _native(w)
    assert "key_return" not in w.of("/identity/request")[0][2]
    w = nat.World()
    _native(w, key_return=True)
    assert w.of("/identity/request")[0][2]["key_return"] == "allow"


def test_a_native_via_key_answer_is_activated() -> None:
    w = nat.World()
    w.token_answer = (200, KEY_OK)
    c, s = _native(w, key_return=True)
    c.identity._account.write_subject(SUBJECT)
    seen = _events(c)
    o = c.identity.sign_in.handle_redirect(_deliver(s))
    assert (o.kind, o.subject, o.activation.license_id, o.key_entries) == (
        "activated", None, "lic_1", KeyEntries(1, 10),
    )
    assert c._tokens.current == "pkeyt_key" and c.identity._account.stored_subject() is None
    assert seen == [("subject_changed", None)]


def test_a_native_via_key_answer_without_the_opt_in_is_malformed() -> None:
    w = nat.World()
    w.token_answer = (200, KEY_OK)
    c, s = _native(w)
    with pytest.raises(Exception) as e:
        c.identity.sign_in.handle_redirect(_deliver(s))
    assert getattr(e.value, "code", None) == ErrorCode.BAD_RESPONSE
    assert c._tokens.current is None


def test_a_native_refusal_carries_its_details() -> None:
    w = nat.World()
    w.token_answer = (403, {"error": "license_owned", "signInUrl": "https://key.plrs.im/signin?product=djdl"})
    c, s = _native(w, key_return=True)
    with pytest.raises(SignInError) as e:
        c.identity.sign_in.handle_redirect(_deliver(s))
    assert e.value.code == "license_owned"
    assert e.value.details == RefusalDetails(sign_in_url="https://key.plrs.im/signin?product=djdl")
