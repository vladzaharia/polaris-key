# @pkey-feature identity.accesstoken
"""``identity.access_token()`` (I-21b, WIRE-CONTRACT-V5 §12.13.10): the device exchange over a mock Worker.

The same semantics as Node's ``identityAccessToken.test.ts``: gated on discovery (typed
``service-unavailable``, no request), the exact form, a cache bound to the device token with the 60 second
reuse margin, one request at a time, failures and refusals not cached, a 429's wait honoured, the endpoint
pinned to the Worker's origin and never followed through a redirect, and the token capped at 8 KiB."""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest
from helpers import BASE_URL, PRODUCT, TOKEN, TRUST, make_client, mock_client

from polaris_key import AsyncClient, PolarisError
from polaris_key.constants_generated import ErrorCode
from polaris_key.core.caps import UnsupportedError
from polaris_key.devices.store import InMemoryStore

BASE = f"{BASE_URL}/{PRODUCT}"
TOKEN_URL = f"{BASE}/identity/token"
OTHER_TOKEN = "pkeyt_" + "o" * 43
JWT = "aaaa.bbbb.cccc"


class Clock:
    def __init__(self, now: float = 1_700_000_000) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    c = Clock()
    monkeypatch.setattr(time, "time", c)
    return c


def discovery(access_token: bool = True, token_url: Optional[str] = TOKEN_URL, identity: bool = True) -> Dict[str, Any]:
    ident: Dict[str, Any] = (
        {"enabled": True, "configured": True, "endpoints": {"token": token_url} if token_url else {}}
        if identity
        else {"enabled": False}
    )
    if identity and access_token:
        ident["accessToken"] = True
    services = {"license": {"enabled": True}, "config": {"enabled": True}, "identity": ident}
    return {"product": PRODUCT, "services": services}


def grant(token: str = JWT, **over: Any) -> Dict[str, Any]:
    return {
        "access_token": token,
        "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
        "token_type": "Bearer",
        "expires_in": 600,
        "scope": "",
        **over,
    }


class Worker:
    def __init__(
        self,
        doc: Optional[Dict[str, Any]] = None,
        answer: Optional[Callable[[httpx.Request], httpx.Response]] = None,
    ) -> None:
        self.doc = doc if doc is not None else discovery()
        self.answer = answer or (lambda r: httpx.Response(200, json=grant()))
        self.exchanges: List[httpx.Request] = []

    def __call__(self, r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/.well-known/polaris.json":
            return httpx.Response(200, json=self.doc)
        self.exchanges.append(r)
        return self.answer(r)


def client(w: Worker, token: Optional[str] = TOKEN, http: Optional[httpx.Client] = None) -> Any:
    store = InMemoryStore(PRODUCT)
    if token is not None:
        store.set_token(token)
    return make_client(
        w, store=store, client=http, expected_services=["license", "config", "identity"]
    )


def _swap_token(c: Any, token: str) -> None:
    c._tokens.set(token, "activate", provenance="signin")


# ── Gate ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "doc",
    [discovery(access_token=False), discovery(token_url=None), discovery(identity=False)],
    ids=["no-member", "no-endpoint", "identity-off"],
)
def test_without_discovery_naming_it_the_call_is_service_unavailable_and_sends_nothing(doc: Dict[str, Any]) -> None:
    w = Worker(doc)
    c = client(w)
    with pytest.raises(UnsupportedError) as e:
        c.identity.access_token()
    assert e.value.code == ErrorCode.SERVICE_UNAVAILABLE
    assert w.exchanges == []


def test_no_device_token_is_no_token_and_sends_nothing() -> None:
    w = Worker()
    c = client(w, token=None)
    with pytest.raises(PolarisError) as e:
        c.identity.access_token()
    assert e.value.code == ErrorCode.NO_TOKEN
    assert w.exchanges == []


def test_an_endpoint_on_another_origin_is_service_unavailable_and_sends_nothing() -> None:
    w = Worker(discovery(token_url="https://evil.example/djdl/identity/token"))
    c = client(w)
    with pytest.raises(UnsupportedError) as e:
        c.identity.access_token()
    assert e.value.code == ErrorCode.SERVICE_UNAVAILABLE
    assert w.exchanges == []


# ── The request and the answer ───────────────────────────────────────────────────────


def test_the_exchange_is_the_fixed_form_with_the_device_header_and_no_authorization(clock: Clock) -> None:
    w = Worker()
    c = client(w)
    at = c.identity.access_token()
    assert at.access_token == JWT and at.token_type == "Bearer"
    assert at.expires_in == 600 and at.expires_at == 1_700_000_600
    assert JWT not in repr(at)
    (req,) = w.exchanges
    assert req.method == "POST" and str(req.url) == TOKEN_URL
    assert req.headers["content-type"] == "application/x-www-form-urlencoded"
    assert "authorization" not in req.headers and req.headers["x-pkey-device"]
    assert req.content.decode() == (
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange"
        f"&client_id={PRODUCT}&subject_token={TOKEN}"
        "&subject_token_type=urn%3Apolaris-key%3Atoken-type%3Adevice"
        "&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token"
    )


@pytest.mark.parametrize(
    "body",
    [
        grant(token="not-a-jws"),
        grant(token="a.b.c" + "d" * 8192),
        grant(token_type="mac"),
        grant(issued_token_type="urn:x"),
        grant(expires_in=0),
        grant(expires_in=600.5),
        grant(expires_in="600"),
        [],
    ],
    ids=["not-jws", "over-8kib", "token-type", "issued-type", "zero", "fraction", "string", "array"],
)
def test_a_200_that_is_not_the_grant_is_bad_response(body: Any, clock: Clock) -> None:
    c = client(Worker(answer=lambda r: httpx.Response(200, json=body)))
    with pytest.raises(PolarisError) as e:
        c.identity.access_token()
    assert e.value.code == ErrorCode.BAD_RESPONSE


def test_a_token_of_exactly_8_kib_is_accepted(clock: Clock) -> None:
    token = "a.b." + "c" * (8192 - 4)
    c = client(Worker(answer=lambda r: httpx.Response(200, json=grant(token=token))))
    assert c.identity.access_token().access_token == token


# ── The cache ────────────────────────────────────────────────────────────────────────


def test_reuses_until_60_seconds_before_expiry_then_asks_again(clock: Clock) -> None:
    w = Worker()
    c = client(w)
    c.identity.access_token()
    clock.now += 539
    again = c.identity.access_token()
    assert len(w.exchanges) == 1 and again.expires_in == 61
    clock.now += 1  # 540: expires_at - 60 is no longer in the future
    c.identity.access_token()
    assert len(w.exchanges) == 2


def test_refresh_asks_again_inside_the_window(clock: Clock) -> None:
    w = Worker()
    c = client(w)
    c.identity.access_token()
    c.identity.access_token(refresh=True)
    assert len(w.exchanges) == 2


def test_failures_are_not_cached(clock: Clock) -> None:
    answers = [httpx.Response(500, json={"error": "server_error"}), httpx.Response(200, json=grant())]
    w = Worker(answer=lambda r: answers.pop(0))
    c = client(w)
    with pytest.raises(PolarisError) as e:
        c.identity.access_token()
    assert e.value.code == ErrorCode.SERVER_ERROR
    assert c.identity.access_token().access_token == JWT
    assert len(w.exchanges) == 2


def test_a_refusal_keeps_its_wire_code_and_invalid_grant_drops_the_held_token(clock: Clock) -> None:
    answers = [httpx.Response(200, json=grant()), httpx.Response(400, json={"error": "invalid_grant"})]
    w = Worker(answer=lambda r: answers.pop(0))
    c = client(w)
    c.identity.access_token()
    with pytest.raises(PolarisError) as e:
        c.identity.access_token(refresh=True)
    assert (e.value.code, e.value.status) == ("invalid_grant", 400)
    answers.append(httpx.Response(200, json=grant("dddd.eeee.ffff")))
    assert c.identity.access_token().access_token == "dddd.eeee.ffff"  # not the held one


def test_forget_drops_the_held_token(clock: Clock) -> None:
    w = Worker()
    c = client(w)
    c.identity.access_token()
    c.identity.forget()
    c.identity.access_token()
    assert len(w.exchanges) == 2


def test_concurrent_calls_share_one_exchange(clock: Clock) -> None:
    release = threading.Event()
    entered = threading.Event()

    def answer(r: httpx.Request) -> httpx.Response:
        entered.set()
        release.wait(5)
        return httpx.Response(200, json=grant())

    w = Worker(answer=answer)
    c = client(w)
    got: List[Any] = []
    threads = [threading.Thread(target=lambda: got.append(c.identity.access_token())) for _ in range(3)]
    threads[0].start()
    assert entered.wait(5)
    for t in threads[1:]:
        t.start()
    time.sleep(0.05)  # the other two reach the cache while the first is in flight
    release.set()
    for t in threads:
        t.join(5)
    assert len(got) == 3 and len(w.exchanges) == 1


# ── The cache is bound to the device token ───────────────────────────────────────────


def test_a_replaced_device_token_is_a_miss(clock: Clock) -> None:
    w = Worker()
    c = client(w)
    c.identity.access_token()
    _swap_token(c, OTHER_TOKEN)  # signed in as another account, no forget()
    c.identity.access_token()
    assert len(w.exchanges) == 2
    assert f"subject_token={OTHER_TOKEN}" in w.exchanges[1].content.decode()
    c.identity.access_token()  # the new one is held under the new token
    assert len(w.exchanges) == 2


def test_a_token_change_while_an_exchange_is_in_flight_does_not_join_or_keep_it(clock: Clock) -> None:
    release = threading.Event()
    entered = threading.Event()

    def answer(r: httpx.Request) -> httpx.Response:
        if f"subject_token={TOKEN}" in r.content.decode():
            entered.set()
            release.wait(5)
            return httpx.Response(200, json=grant("aaaa.bbbb.old1"))
        return httpx.Response(200, json=grant("aaaa.bbbb.new1"))

    w = Worker(answer=answer)
    c = client(w)
    old: List[Any] = []
    t = threading.Thread(target=lambda: old.append(c.identity.access_token()))
    t.start()
    assert entered.wait(5)
    _swap_token(c, OTHER_TOKEN)
    assert c.identity.access_token().access_token == "aaaa.bbbb.new1"  # its own exchange
    release.set()
    t.join(5)
    assert old[0].access_token == "aaaa.bbbb.old1"
    assert c.identity.access_token().access_token == "aaaa.bbbb.new1"  # the late answer was not kept
    assert len(w.exchanges) == 2


def test_a_sign_out_while_an_exchange_is_in_flight_keeps_nothing(clock: Clock) -> None:
    release = threading.Event()
    entered = threading.Event()
    calls = {"n": 0}

    def answer(r: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            entered.set()
            release.wait(5)
        return httpx.Response(200, json=grant())

    w = Worker(answer=answer)
    c = client(w)
    t = threading.Thread(target=c.identity.access_token)
    t.start()
    assert entered.wait(5)
    c.identity.forget()
    release.set()
    t.join(5)
    c.identity.access_token()
    assert len(w.exchanges) == 2


# ── 429 ──────────────────────────────────────────────────────────────────────────────


def test_a_429_keeps_the_wait_from_the_body_and_holds_off_until_it_passes(clock: Clock) -> None:
    answers = [httpx.Response(429, json={"error": "rate_limited", "retryAfter": 60}), httpx.Response(200, json=grant())]
    w = Worker(answer=lambda r: answers.pop(0))
    c = client(w)
    with pytest.raises(PolarisError) as e:
        c.identity.access_token()
    assert (e.value.code, e.value.status, e.value.retry_after_seconds) == ("rate_limited", 429, 60)
    clock.now += 20
    for refresh in (False, True):
        with pytest.raises(PolarisError) as e2:
            c.identity.access_token(refresh=refresh)
        assert e2.value.code == ErrorCode.RATE_LIMITED and e2.value.retry_after_seconds == 40
    assert len(w.exchanges) == 1  # nothing was sent while it held off
    clock.now += 40
    assert c.identity.access_token().access_token == JWT
    assert len(w.exchanges) == 2


def test_a_429_header_wins_over_the_body(clock: Clock) -> None:
    body = {"error": "rate_limited", "retryAfter": 60}
    w = Worker(answer=lambda r: httpx.Response(429, headers={"retry-after": "7"}, json=body))
    with pytest.raises(PolarisError) as e:
        client(w).identity.access_token()
    assert e.value.retry_after_seconds == 7


def test_a_held_token_is_still_handed_out_while_the_limit_holds(clock: Clock) -> None:
    answers = [httpx.Response(200, json=grant()), httpx.Response(429, json={"error": "rate_limited", "retryAfter": 60})]
    w = Worker(answer=lambda r: answers.pop(0))
    c = client(w)
    c.identity.access_token()
    with pytest.raises(PolarisError):
        c.identity.access_token(refresh=True)
    assert c.identity.access_token().access_token == JWT
    assert len(w.exchanges) == 2


# ── Redirects ────────────────────────────────────────────────────────────────────────


def test_a_redirect_is_not_followed_even_on_a_client_that_follows(clock: Clock) -> None:
    w = Worker(answer=lambda r: httpx.Response(307, headers={"location": "https://evil.example/steal"}))
    http = httpx.Client(transport=httpx.MockTransport(w), follow_redirects=True)
    c = client(w, http=http)
    with pytest.raises(PolarisError) as e:
        c.identity.access_token()
    assert e.value.code == ErrorCode.BAD_RESPONSE
    assert len(w.exchanges) == 1


# ── The async client ─────────────────────────────────────────────────────────────────


def test_the_async_client_awaits_it(clock: Clock) -> None:
    w = Worker()

    async def main() -> None:
        c = await AsyncClient.create(
            product_slug=PRODUCT,
            version="1.0.0",
            pinned_keys=TRUST,
            base_url=BASE_URL,
            store=InMemoryStore(PRODUCT),
            client=mock_client(w),
            expected_services=["license", "config", "identity"],
        )
        c.sync_client._tokens.set(TOKEN, "activate", provenance="signin")
        at = await c.identity.access_token(refresh=True)
        assert at.access_token == JWT
        await c.aclose()

    asyncio.run(main())
    assert len(w.exchanges) == 1
