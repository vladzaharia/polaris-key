# @pkey-feature identity.redirect.web identity.signin.hints
"""The redirect core (I-10a.17): client-core's ``identityRedirect.test.ts`` vectors, ported
table for table (RFC 7636 appendix B, the transcript conversation's authorize URL and form body,
the callback checks, the token answers), then the session: single use, the token endpoint on the
product's origin, refusals that never wipe, the hints."""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional
from urllib.parse import quote, parse_qsl, urlsplit

import httpx
import pytest

from polaris_key import PolarisError
from polaris_key.core.caps import UnsupportedError
from polaris_key.devices.store import InMemoryStore
from polaris_key.identity.redirect import (
    SignInError,
    check_callback,
    generate_code_verifier,
    generate_state,
    is_redirect_uri,
    parse_token_answer,
    pkce_challenge,
    start_redirect,
    token_form,
)

from helpers import BASE_URL, PRODUCT, make_client
from test_identity_account import Worker, ok

ISS = "https://key.plrs.im/djdl/identity"
STATE = "tidewater-state-0123456789"
VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
REDIRECT = "https://app.example/auth/callback"
BASE: Dict[str, Any] = dict(
    authorize_endpoint="https://key.plrs.im/djdl/identity/authorize",
    token_endpoint="https://key.plrs.im/djdl/identity/token",
    issuer=ISS,
    client_id="djdl",
    redirect_uri=REDIRECT,
    state=STATE,
    code_verifier=VERIFIER,
)
AUTH = (
    f"{BASE['authorize_endpoint']}?response_type=code&client_id=djdl"
    f"&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback&state={STATE}"
    "&code_challenge=-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10&code_challenge_method=S256"
    "&scope=profile+email"
)


@pytest.mark.parametrize(
    "verifier,challenge",
    [
        # RFC 7636 appendix B
        ("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"),
        # the conformance/transcripts conversation
        (VERIFIER, "-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10"),
    ],
)
def test_s256_challenge(verifier: str, challenge: str) -> None:
    assert pkce_challenge(verifier) == challenge


def test_generated_verifiers_and_states_differ() -> None:
    a = generate_code_verifier()
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", a)
    assert generate_code_verifier() != a
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", generate_state())
    assert generate_state(lambda n: bytes(n)) == "A" * 43


@pytest.mark.parametrize(
    "extra,url",
    [
        ({}, AUTH),
        (
            {"login_hint": "Ada@Example.com", "name_hint": "Ada", "purpose": "attach"},
            f"{AUTH}&login_hint=Ada%40Example.com&name_hint=Ada&purpose=attach",
        ),
        ({"login_hint": "not an email"}, f"{AUTH}&login_hint=not+an+email"),
        ({"license_choice": "app", "choice_available": True}, f"{AUTH}&license_choice=app"),
        ({"license_choice": "app", "choice_available": False}, AUTH),
        ({"license_choice": "card", "choice_available": True}, AUTH),
        ({"scope": ["profile", "cloudSync"]}, AUTH.replace("scope=profile+email", "scope=profile+cloudSync")),
        ({"login_hint": "", "name_hint": ""}, AUTH),
        ({"name_hint": "Zoë * ~"}, f"{AUTH}&name_hint=Zo%C3%AB+*+%7E"),
    ],
)
def test_the_authorize_url(extra: Dict[str, Any], url: str) -> None:
    p = start_redirect(**{**BASE, **extra})
    assert p.authorize_url == url
    assert p.state == STATE
    assert VERIFIER not in p.authorize_url and VERIFIER not in repr(p)


def test_random_entropy_satisfies_its_own_rules() -> None:
    p = start_redirect(**{**BASE, "state": None, "code_verifier": None})
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", p.state)
    assert f"code_challenge={pkce_challenge(p.code_verifier)}" in p.authorize_url


@pytest.mark.parametrize(
    "extra",
    [
        {"redirect_uri": "http://app.example/cb"},
        {"redirect_uri": "http://127.0.0.1:8080/cb"},
        {"redirect_uri": f"{REDIRECT}#x"},
        {"redirect_uri": "https://u:p@app.example/cb"},
        {"redirect_uri": "/cb"},
        {"state": "short"},
        {"code_verifier": "too-short"},
        {"code_verifier": "a" * 42 + "+"},
        {"issuer": ""},
        {"token_endpoint": "/djdl/identity/token"},
        {"scope": "  "},
    ],
)
def test_refuses_before_anything_is_built(extra: Dict[str, Any]) -> None:
    with pytest.raises(PolarisError) as e:
        start_redirect(**{**BASE, **extra})
    assert e.value.code == "invalid-argument"


def test_is_redirect_uri() -> None:
    assert is_redirect_uri(REDIRECT)
    assert is_redirect_uri("https://app.example")
    assert not is_redirect_uri("https://app.example/a b")
    assert not is_redirect_uri("https://app.example\\@evil.example/")
    assert not is_redirect_uri(5)


# ── The callback ─────────────────────────────────────────────────────────────────────

ISS_Q = quote(ISS, safe="")
OK = f"{REDIRECT}?code=abc_DEF-123&state={STATE}&iss={ISS_Q}"


def check(url: str) -> Dict[str, Any]:
    r = check_callback(STATE, REDIRECT, ISS, url)
    out: Dict[str, Any] = {"kind": r.kind}
    if r.kind == "code":
        out["code"] = r.code
    if r.kind == "failed":
        out["code"] = r.code
        out["reason"] = r.reason
        if r.error is not None:
            out["error"] = r.error
    return out


def failed(reason: str, **more: Any) -> Dict[str, Any]:
    return {"kind": "failed", "code": "sign-in-failed", "reason": reason, **more}


@pytest.mark.parametrize(
    "url,expected",
    [
        (OK, {"kind": "code", "code": "abc_DEF-123"}),
        (f"{REDIRECT}?iss={ISS_Q}&x=1&state={STATE}&code=c", {"kind": "code", "code": "c"}),
        (f"{REDIRECT}?error=access_denied&state={STATE}&iss={ISS_Q}", {"kind": "cancelled"}),
        (
            f"{REDIRECT}?error=server_error&state={STATE}&iss={ISS_Q}",
            failed("authorization-error", error="server_error"),
        ),
        (OK.replace(STATE, "another-state-0123456789"), failed("state-mismatch")),
        (f"{REDIRECT}?code=c&iss={ISS_Q}", failed("state-mismatch")),
        (
            f"{REDIRECT}?code=c&state={STATE}&iss={quote('https://evil.example/djdl/identity', safe='')}",
            failed("issuer-mismatch"),
        ),
        (f"{REDIRECT}?code=c&state={STATE}", failed("issuer-mismatch")),
        (f"{REDIRECT}?error=access_denied&state=bad-state-0123456789&iss=x", failed("state-mismatch")),
        (f"{REDIRECT}?error=access_denied&state={STATE}&iss=x", failed("issuer-mismatch")),
        (f"{REDIRECT}?state={STATE}&iss={ISS_Q}", failed("missing-code")),
        (f"{REDIRECT}?code=&state={STATE}&iss={ISS_Q}", failed("missing-code")),
        (f"{OK}&code=other", failed("malformed")),
        (OK.replace("/auth/callback", "/other"), failed("redirect-mismatch")),
        (OK.replace("app.example", "evil.example"), failed("redirect-mismatch")),
        (f"{REDIRECT}#code=c&state={STATE}&iss={ISS_Q}", failed("state-mismatch")),
        ("code=c&state=x", failed("malformed")),
        (f"{REDIRECT}?code=%E0%A4%A&state={STATE}", failed("malformed")),
    ],
)
def test_check_callback(url: str, expected: Dict[str, Any]) -> None:
    assert check(url) == expected


# ── The token form and the answers ───────────────────────────────────────────────────


def test_token_form_has_a_fixed_member_order() -> None:
    assert token_form("djdl", VERIFIER, REDIRECT, "pql7NwTrZq8ADBYf14sz1sjf4BSnZl-AaWyCGWs9TX0") == (
        "grant_type=authorization_code&client_id=djdl&code=pql7NwTrZq8ADBYf14sz1sjf4BSnZl-AaWyCGWs9TX0"
        f"&code_verifier={VERIFIER}&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback"
    )


def test_token_form_adds_device_name_last() -> None:
    assert re.search(
        r"&redirect_uri=[^&]+&device_name=Ada%27s\+PC$",
        token_form("djdl", VERIFIER, REDIRECT, "c", "Ada's PC"),
    )


DEVICE = {"id": "D", "status": "authorized"}
GRANT = "sg_" + "A" * 43


def test_a_token_answer() -> None:
    a = parse_token_answer(
        200,
        {
            "access_token": "pkeyt_x",
            "token_type": "Bearer",
            "scope": "profile email",
            "schemaVersion": 1,
            "device": DEVICE,
            "license": None,
            "subject": "ps_abc",
        },
    )
    assert (a.kind, a.access_token, a.scope, a.subject, a.schema_version, a.device, a.license) == (
        "token", "pkeyt_x", "profile email", "ps_abc", 1, DEVICE, None,
    )
    assert "pkeyt_x" not in repr(a)


def test_choose_is_decided_by_status_alone() -> None:
    a = parse_token_answer(
        200,
        {
            "status": "choose",
            "grant": GRANT,
            "expiresIn": 300,
            "choices": {"state": "choose"},
            "access_token": "pkeyt_ignored",
        },
    )
    assert (a.kind, a.grant, a.expires_in, a.choices) == ("choose", GRANT, 300, {"state": "choose"})
    assert GRANT not in repr(a)


@pytest.mark.parametrize(
    "body",
    [
        {"status": "choose", "grant": "sg_short", "expiresIn": 1, "choices": {}},
        {"scope": "x", "subject": "s", "device": DEVICE, "license": None},
        {"access_token": "t", "scope": "x", "device": DEVICE, "license": None},
        {"access_token": "t", "scope": "x", "subject": "s", "device": DEVICE},
        "x",
    ],
)
def test_a_200_that_is_neither_is_malformed(body: Any) -> None:
    assert parse_token_answer(200, body).kind == "malformed"


@pytest.mark.parametrize(
    "status,body,error,retry",
    [
        (400, {"error": "invalid_grant"}, "invalid_grant", None),
        (401, {"error": "invalid_client"}, "invalid_client", None),
        (429, {"error": "rate_limited", "retryAfter": 2.2}, "rate_limited", 3),
        (500, "oops", "server_error", None),
        (502, {"error": ""}, "server_error", None),
    ],
)
def test_a_refusal(status: int, body: Any, error: str, retry: Optional[int]) -> None:
    a = parse_token_answer(status, body)
    assert (a.kind, a.error, a.status, a.retry_after_seconds) == ("refused", error, status, retry)


# ── The session ──────────────────────────────────────────────────────────────────────

PB = f"{BASE_URL}/{PRODUCT}"
CB = "https://app.example/auth/callback"
TOKEN_ANSWER = {
    "access_token": "pkeyt_redirect",
    "token_type": "Bearer",
    "scope": "profile email",
    "schemaVersion": 1,
    "device": DEVICE,
    "license": {"id": "lic_pro"},
    "subject": "ps_" + "C" * 22,
}


def disc(**endpoints: Any) -> Dict[str, Any]:
    ep = {
        "authorize": f"{PB}/identity/authorize",
        "token": f"{PB}/identity/token",
        "subject": f"{PB}/identity/subject",
        **endpoints,
    }
    return {
        "product": PRODUCT,
        "services": {
            "license": {"enabled": True},
            "config": {"enabled": True},
            "identity": {"enabled": True, "configured": True, "issuer": f"{PB}/identity", "endpoints": ep},
        },
    }


def make(w: Worker, token: Optional[str] = None) -> Any:
    store = InMemoryStore(PRODUCT)
    if token is not None:
        store.set_token(token)
    c = make_client(w, store=store, expected_services=["license", "config", "identity"], device_name="")
    # The redirect recordings pin the token exchange alone; the sync a sign-in raises is pinned
    # by the sync transcripts.
    c.identity._deps.on_acquired = lambda: None
    c.identity._deps.entropy = {"state": STATE, "code_verifier": VERIFIER}
    return c


def callback(code: str = "the-code", **over: str) -> str:
    q = {"code": code, "state": STATE, "iss": f"{PB}/identity", **over}
    return CB + "?" + "&".join(f"{k}={quote(v, safe='')}" for k, v in q.items())


def token_calls(w: Worker) -> List[Dict[str, Any]]:
    return [c for c in w.calls if c["path"].endswith("/identity/token")]


class FormWorker(Worker):
    """Records the form body of the token request (the base class reads JSON)."""

    def __init__(self, doc: Dict[str, Any], **answers: Any) -> None:
        super().__init__(doc, **answers)
        self.forms: List[Dict[str, str]] = []
        self.headers: List[httpx.Headers] = []

    def __call__(self, r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("/identity/token"):
            self.calls.append({"method": r.method, "path": r.url.path, "auth": r.headers.get("authorization"), "body": None})
            self.forms.append(dict(parse_qsl(r.content.decode("ascii"), strict_parsing=True)))
            self.headers.append(r.headers)
            a = self.answers["token"]
            return a(r) if callable(a) else a
        return super().__call__(r)


def test_start_builds_the_authorize_url_from_discovery() -> None:
    w = FormWorker(disc(), token=ok(**TOKEN_ANSWER))
    s = make(w).identity.sign_in.start(
        channel="redirect", redirect_uri=CB, login_hint="Ada@Example.com", purpose="attach"
    )
    assert s.authorize_url == (
        f"{PB}/identity/authorize?response_type=code&client_id=djdl"
        f"&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback&state={STATE}"
        "&code_challenge=-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10&code_challenge_method=S256"
        "&scope=profile+email&login_hint=Ada%40Example.com&purpose=attach"
    )
    assert VERIFIER not in repr(s) and token_calls(w) == []


def test_complete_redeems_the_code_stores_the_token_and_the_subject(tmp_path: Any) -> None:
    w = FormWorker(disc(), token=ok(**TOKEN_ANSWER))
    store = InMemoryStore(PRODUCT)
    c = make_client(w, store=store, expected_services=["license", "config", "identity"], state_dir=str(tmp_path), device_name="")
    c.identity._deps.on_acquired = lambda: None
    c.identity._deps.entropy = {"state": STATE, "code_verifier": VERIFIER}
    seen: List[Any] = []
    c.events.subscribe(lambda e: seen.append((e.get("change"), e.get("subject"))), ["identity"])
    s = c.identity.sign_in.start(channel="redirect", redirect_uri=CB)
    o = s.complete(callback("pql7"))
    assert (o.kind, o.subject, o.scope, o.activation.license_id) == (
        "signed_in", TOKEN_ANSWER["subject"], "profile email", "lic_pro",
    )
    assert store.get_token() == "pkeyt_redirect"
    assert w.forms == [
        {
            "grant_type": "authorization_code",
            "client_id": "djdl",
            "code": "pql7",
            "code_verifier": VERIFIER,
            "redirect_uri": CB,
        }
    ]
    assert w.headers[0]["content-type"] == "application/x-www-form-urlencoded"
    assert "authorization" not in w.headers[0]
    assert c.identity._account.stored_subject() == TOKEN_ANSWER["subject"]
    assert seen == [("signed_in", TOKEN_ANSWER["subject"])]


def test_a_second_complete_is_refused_locally() -> None:
    w = FormWorker(disc(), token=ok(**TOKEN_ANSWER))
    s = make(w).identity.sign_in.start(channel="redirect", redirect_uri=CB)
    s.complete(callback())
    with pytest.raises(SignInError) as e:
        s.complete(callback())
    assert e.value.code == "sign-in-failed"
    assert len(token_calls(w)) == 1


def test_cancel_then_complete_is_refused_without_a_request() -> None:
    w = FormWorker(disc(), token=ok(**TOKEN_ANSWER))
    s = make(w).identity.sign_in.start(channel="redirect", redirect_uri=CB)
    s.cancel()
    assert s.wait().kind == "cancelled"
    with pytest.raises(SignInError):
        s.complete(callback())
    assert token_calls(w) == []


@pytest.mark.parametrize(
    "url,reason",
    [
        (callback(state="another-state-0123456789"), "state-mismatch"),
        (callback(iss="https://evil.example/djdl/identity"), "issuer-mismatch"),
        (callback().replace("/auth/callback", "/other"), "redirect-mismatch"),
    ],
)
def test_a_bad_callback_never_reaches_the_token_endpoint(url: str, reason: str) -> None:
    w = FormWorker(disc(), token=ok(**TOKEN_ANSWER))
    c = make(w, token="pkeyt_old")
    s = c.identity.sign_in.start(channel="redirect", redirect_uri=CB)
    with pytest.raises(SignInError) as e:
        s.complete(url)
    assert e.value.code == "sign-in-failed" and reason in e.value.message
    assert token_calls(w) == [] and c.core.store.get_token() == "pkeyt_old"


def test_access_denied_is_a_cancel_outcome() -> None:
    w = FormWorker(disc(), token=ok(**TOKEN_ANSWER))
    s = make(w).identity.sign_in.start(channel="redirect", redirect_uri=CB)
    assert s.complete(f"{CB}?error=access_denied&state={STATE}&iss={quote(PB + '/identity', safe='')}").kind == "cancelled"
    assert token_calls(w) == []


def test_a_refusal_keeps_the_token_and_carries_retry_after() -> None:
    w = FormWorker(
        disc(),
        token=httpx.Response(429, json={"error": "rate_limited"}, headers={"retry-after": "7"}),
    )
    c = make(w, token="pkeyt_old")
    s = c.identity.sign_in.start(channel="redirect", redirect_uri=CB)
    with pytest.raises(SignInError) as e:
        s.complete(callback())
    assert (e.value.code, e.value.retry_after_seconds, e.value.status) == ("rate_limited", 7, 429)
    assert c.core.store.get_token() == "pkeyt_old"


def test_invalid_grant_is_raised_under_its_own_code_and_a_5xx_is_server_error() -> None:
    w = FormWorker(disc(), token=httpx.Response(400, json={"error": "invalid_grant"}))
    c = make(w, token="pkeyt_old")
    with pytest.raises(PolarisError) as e:
        c.identity.sign_in.start(channel="redirect", redirect_uri=CB).complete(callback())
    assert e.value.code == "invalid_grant" and c.core.store.get_token() == "pkeyt_old"
    w = FormWorker(disc(), token=httpx.Response(503, json={"error": "unavailable"}))
    with pytest.raises(PolarisError) as e:
        make(w).identity.sign_in.start(channel="redirect", redirect_uri=CB).complete(callback())
    assert e.value.code == "server-error"


def test_a_malformed_token_answer_is_bad_response() -> None:
    w = FormWorker(disc(), token=ok(access_token="pkeyt_x"))
    with pytest.raises(PolarisError) as e:
        make(w).identity.sign_in.start(channel="redirect", redirect_uri=CB).complete(callback())
    assert e.value.code == "bad_response"


def test_a_token_endpoint_on_another_origin_is_refused_before_any_request() -> None:
    d = disc(token="https://evil.example/djdl/identity/token")
    w = FormWorker(d, token=ok(**TOKEN_ANSWER))
    with pytest.raises(PolarisError) as e:
        make(w).identity.sign_in.start(channel="redirect", redirect_uri=CB)
    assert e.value.code == "bad_response" and token_calls(w) == []


def test_discovery_without_authorize_is_sign_in_unavailable() -> None:
    d = disc()
    del d["services"]["identity"]["endpoints"]["authorize"]
    with pytest.raises(PolarisError) as e:
        make(FormWorker(d)).identity.sign_in.start(channel="redirect", redirect_uri=CB)
    assert e.value.code == "sign-in-unavailable"


def test_identity_off_is_service_unavailable_before_any_sign_in_request() -> None:
    d = {"product": PRODUCT, "services": {"license": {"enabled": True}, "identity": {"enabled": False}}}
    w = FormWorker(d)
    with pytest.raises(UnsupportedError) as e:
        make(w).identity.sign_in.start(channel="redirect", redirect_uri=CB)
    assert e.value.code == "service-unavailable"
    assert [c["path"] for c in w.calls] == [f"/{PRODUCT}/.well-known/polaris.json"]


@pytest.mark.parametrize("uri", ["http://app.example/cb", "https://app.example/cb#x", "/cb"])
def test_a_bad_redirect_uri_is_invalid_argument(uri: str) -> None:
    with pytest.raises(PolarisError) as e:
        make(FormWorker(disc())).identity.sign_in.start(channel="redirect", redirect_uri=uri)
    assert e.value.code == "invalid-argument"


def test_license_choice_app_is_sent_only_when_discovery_has_the_choice_endpoints() -> None:
    choice = {k: f"{PB}/identity/choice/{k[6:].lower()}" for k in ("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel")}
    with_choice = make(FormWorker(disc(**choice))).identity.sign_in.start(
        channel="redirect", redirect_uri=CB, license_choice="app"
    )
    assert with_choice.authorize_url.endswith("&license_choice=app")
    without = make(FormWorker(disc())).identity.sign_in.start(
        channel="redirect", redirect_uri=CB, license_choice="app"
    )
    assert "license_choice" not in without.authorize_url


def test_choose_settles_as_the_choice_outcome_only_when_the_session_asked() -> None:
    choose = ok(status="choose", grant=GRANT, expiresIn=300, choices={"state": "choose"})
    choice = {k: f"{PB}/identity/choice/{k[6:].lower()}" for k in ("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel")}
    w = FormWorker(disc(**choice), token=choose)
    c = make(w, token="pkeyt_old")
    o = c.identity.sign_in.start(channel="redirect", redirect_uri=CB, license_choice="app").complete(callback())
    assert (o.kind, o.grant, o.expires_in, o.choices) == ("choose", GRANT, 300, {"state": "choose"})
    assert GRANT not in repr(o) and c.core.store.get_token() == "pkeyt_old"
    # A sign-in that did not ask for it gets a bad_response, and stores nothing.
    w = FormWorker(disc(**choice), token=choose)
    c = make(w, token="pkeyt_old")
    with pytest.raises(PolarisError) as e:
        c.identity.sign_in.start(channel="redirect", redirect_uri=CB).complete(callback())
    assert e.value.code == "bad_response" and c.core.store.get_token() == "pkeyt_old"


def test_other_channels_stay_the_typed_version_na() -> None:
    with pytest.raises(UnsupportedError) as e:
        make(FormWorker(disc())).identity.sign_in.start(channel="loopback")
    assert e.value.reason == "version"
