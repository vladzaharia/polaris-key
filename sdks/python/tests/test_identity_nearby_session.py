# @pkey-feature identity.nearby
"""``identity.sign_in.start(channel="nearby")`` (I-47.8): the new device's session over a fake LAN half and a
fake Worker. ``nearby/start`` goes first and the LAN request carries its handle; the poll is the authority
(``VOUCH_RESULT`` is for display only); a token is stored as a device-code sign-in stores it; a denial raises
``sign-in-denied``; ``timeout`` is ``expired``; pacing follows ``interval``, ``slow_down`` and ``Retry-After``;
a ``KEYRING_WRAP`` is held until the person confirms the account; no secret is in a ``repr``. The two halves
joined for real over loopback are ``test_nearby_e2e.py`` (I-47.9)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest

from polaris_key import AsyncClient, PolarisError
from polaris_key.core.caps import UnsupportedError
from polaris_key.identity.nearby_session import KEYRING_WRAP_RECORD, NearbyApprover, NearbyCode

from helpers import PRODUCT
from test_identity_account import SUBJECT, ok
from test_identity_mint import T0, clock  # noqa: F401
from test_identity_nearby import HANDLE, TOKEN_ANSWER, Fake, client, nearby_discovery, queue
from test_transcripts import _FixtureKeys

PENDING = httpx.Response(200, json={"status": "pending"})
START = httpx.Response(201, json={"request": HANDLE, "expiresIn": 300, "interval": 3})
TOKEN = httpx.Response(200, json=TOKEN_ANSWER)


class FakeRequest:
    """The LAN half's request (``cloud_connect.nearby.request``), by hand."""

    def __init__(self, items: Optional[List[Any]] = None) -> None:
        self.items = items if items is not None else []
        self.result: Optional[str] = None
        self.closed = False
        self.calls: List[str] = []
        self.chosen: Optional[str] = None
        self._approvers: List[Callable[[List[Any]], None]] = []
        self._results: List[Callable[[str], None]] = []
        self._records: List[Callable[[Any], None]] = []

    @property
    def approvers(self) -> List[Any]:
        return [] if self.chosen else list(self.items)

    def on_approvers(self, fn: Callable[[List[Any]], None]) -> Callable[[], None]:
        self._approvers.append(fn)
        return lambda: self._approvers.remove(fn)

    def on_result(self, fn: Callable[[str], None]) -> Callable[[], None]:
        self._results.append(fn)
        return lambda: self._results.remove(fn)

    def on_record(self, fn: Callable[[Any], None]) -> Callable[[], None]:
        self._records.append(fn)
        return lambda: self._records.remove(fn)

    def choose(self, id_: str) -> Any:
        self.calls.append(f"choose:{id_}")
        self.chosen = id_
        return SimpleNamespace(code="482 913")

    def confirm_account(self) -> None:
        self.calls.append("confirm_account")

    def decline_account(self) -> None:
        self.calls.append("decline_account")

    def close(self) -> None:
        self.calls.append("close")
        self.closed = True


class FakeNearby:
    def __init__(self, request: Optional[FakeRequest] = None) -> None:
        self.request_obj = request or FakeRequest()
        self.requests: List[Dict[str, Any]] = []
        self.order: List[str] = []

    def request(self, handle: str, *, label: Optional[str] = None, expires_in: Optional[float] = None) -> FakeRequest:
        self.requests.append({"handle": handle, "label": label, "expires_in": expires_in})
        self.order.append("lan")
        return self.request_obj


def approver(id_: str = "a1", label: Optional[str] = "Ana's phone", platform: str = "ios") -> Any:
    return SimpleNamespace(id=id_, label=label, platform=platform)


def wire(c: Any, nearby: Optional[FakeNearby] = None, supported: bool = True) -> FakeNearby:
    """Give the client D's keys, the fake LAN and a runtime that can browse."""
    fake = nearby or FakeNearby()
    ident = c.identity
    ident._nearby_signer = lambda: (_FixtureKeys("d-1"), c.core.device_id)
    ident._cloud_nearby = lambda: fake
    ident._nearby_runtime = (lambda role: True) if supported else None
    return fake


def session(worker: Fake, **kw: Any) -> Any:
    c = client(worker)
    fake = wire(c)
    return c, fake, c.identity.sign_in.start(channel="nearby", **kw)


def poll_times(w: Fake, now: Callable[[], float]) -> List[float]:
    return [now()] * len([x for x in w.calls if x["path"].endswith("/nearby/poll")])


def test_start_goes_to_the_worker_first_and_the_lan_request_carries_the_handle(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=PENDING)
    c = client(w)
    fake = wire(c)
    s = c.identity.sign_in.start(channel="nearby", device_name="Living-room console")
    assert [x["path"] for x in w.nearby_calls()] == [f"/{PRODUCT}/identity/nearby/start"]
    assert fake.requests == [{"handle": HANDLE, "label": "Living-room console", "expires_in": 300}]
    assert (s.channel, s.expires_in, s.interval, s.device_name) == ("nearby", 300, 3, "Living-room console")
    assert s.expires_at == T0 + 300


def test_nothing_is_sent_when_the_runtime_cannot_browse(clock) -> None:
    w = Fake(nearby_discovery(), start=START)
    c = client(w)
    wire(c, supported=False)
    with pytest.raises(UnsupportedError) as e:
        c.identity.sign_in.start(channel="nearby")
    assert e.value.code == "nearby-unsupported" and w.nearby_calls() == []


def test_a_product_that_serves_no_nearby_is_the_typed_na_and_no_lan_request(clock) -> None:
    doc = nearby_discovery()
    del doc["services"]["identity"]["nearby"]
    w = Fake(doc, start=START)
    c = client(w)
    fake = wire(c)
    with pytest.raises(UnsupportedError) as e:
        c.identity.sign_in.start(channel="nearby")
    assert e.value.code == "service-unavailable"
    assert w.nearby_calls() == [] and fake.requests == []


def test_a_start_the_worker_refuses_raises_its_code_and_starts_no_lan_request(clock) -> None:
    w = Fake(nearby_discovery(), start=httpx.Response(429, json={"error": {"code": "rate_limited"}}))
    c = client(w)
    fake = wire(c)
    with pytest.raises(PolarisError) as e:
        c.identity.sign_in.start(channel="nearby")
    assert (e.value.code, e.value.status) == ("rate_limited", 429) and fake.requests == []


def test_a_404_from_start_is_the_typed_na(clock) -> None:
    w = Fake(nearby_discovery(), start=httpx.Response(404, json={"error": {"code": "not_found"}}))
    c = client(w)
    fake = wire(c)
    with pytest.raises(UnsupportedError) as e:
        c.identity.sign_in.start(channel="nearby")
    assert e.value.code == "service-unavailable" and fake.requests == []


def test_the_person_sees_cleaned_approvers_and_chooses_one(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=PENDING)
    c = client(w)
    fake = wire(c)
    fake.request_obj.items = [approver("a1", "Ana\x1b[31m's‮ phone"), approver("a2", None, "bad\nplatform")]
    s = c.identity.sign_in.start(channel="nearby")
    assert s.approvers == [NearbyApprover("a1", "Ana[31m's phone", "ios"), NearbyApprover("a2", None, "Unknown")]
    seen: List[Any] = []
    s.on_approvers(lambda items: seen.append(items))
    for fn in list(fake.request_obj._approvers):
        fn([approver("a3", "Den\x07")])
    assert seen == [[NearbyApprover("a3", "Den", "ios")]]
    assert s.code is None
    shown = s.choose("a1")
    assert isinstance(shown, NearbyCode) and shown.code == "482 913" and s.code == shown
    assert fake.request_obj.calls == ["choose:a1"]
    assert s.approvers == []  # once the person chose


def test_the_code_the_handle_and_the_token_are_in_no_repr(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=TOKEN)
    c = client(w)
    fake = wire(c)
    fake.request_obj.items = [approver()]
    s = c.identity.sign_in.start(channel="nearby")
    shown = s.choose("a1")
    o = s.wait(once=True)
    for text in (repr(s), str(s), repr(shown), repr(o), repr(c.identity)):
        assert "482" not in text and HANDLE not in text and "pkeyt_nearby_token" not in text
    with pytest.raises(TypeError):
        import pickle

        pickle.dumps(s)


def test_the_poll_is_the_authority_not_vouch_result(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=PENDING)
    c = client(w)
    fake = wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    fake.request_obj.result = "approved"
    for fn in list(fake.request_obj._results):
        fn("approved")
    assert s.result == "approved"
    o = s.wait(once=True)
    assert o.kind == "pending" and c._tokens.current is None
    assert c.identity.auto_sign_in().reason == "no_credential"


def test_a_token_from_the_poll_is_a_sign_in_stored_as_device_code_stores_it(clock, tmp_path: Any) -> None:
    w = Fake(nearby_discovery(), start=START, poll=queue(PENDING, httpx.Response(429, json={"status": "slow_down", "interval": 5}), TOKEN))
    c = client(w, state_dir=str(tmp_path))
    c.identity.sign_out()  # signed out earlier: the flag is up
    fake = wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    o = s.wait()
    assert o.kind == "signed_in" and o.subject == SUBJECT
    assert (o.activation.license_id, o.identity.email, o.scope) == ("lic_n1", "ada@example.com", "email")
    assert c._tokens.current == "pkeyt_nearby_token"
    assert c._tokens.provenance == "signin" and c._tokens.explicit_sign_out is False
    assert c.identity.current() == {"name": "Ada", "email": "ada@example.com", "activatedAt": None}
    assert c.identity._account.stored_subject() == SUBJECT
    # The LAN side stays open for the wrap until the person confirms the account.
    assert fake.request_obj.closed is False
    s.confirm_account()
    assert fake.request_obj.calls[-1] == "confirm_account"


def test_the_poll_is_paced_by_the_interval_the_slow_down_and_a_503(clock) -> None:
    times: List[float] = []

    def poll(r: httpx.Request) -> httpx.Response:
        import time as _t

        times.append(_t.time() - T0)
        n = len(times)
        if n == 1:
            return httpx.Response(429, json={"status": "slow_down", "interval": 6})
        if n == 2:
            return httpx.Response(503, json={"error": "unavailable"}, headers={"retry-after": "20"})
        return TOKEN

    w = Fake(nearby_discovery(), start=START, poll=poll)
    c = client(w)
    wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    assert s.wait().kind == "signed_in"
    # 3 s, then the longer 6 s after the slow_down, then the 503's Retry-After (20 s) held back the third.
    assert times == [3, 9, 29]


def test_timeout_is_expired_and_closes_the_lan_side(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=httpx.Response(200, json={"status": "timeout"}))
    c = client(w)
    fake = wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    assert s.wait().kind == "expired" and fake.request_obj.closed


def test_the_request_lapsing_locally_is_expired_without_another_poll(clock) -> None:
    w = Fake(nearby_discovery(), start=httpx.Response(201, json={"request": HANDLE, "expiresIn": 4, "interval": 3}), poll=PENDING)
    c = client(w)
    fake = wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    assert s.wait().kind == "expired"
    assert len([x for x in w.nearby_calls() if x["path"].endswith("/poll")]) == 1 and fake.request_obj.closed


def test_a_denial_raises_sign_in_denied(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=httpx.Response(200, json={"status": "error", "reason": "access_denied"}))
    c = client(w)
    fake = wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    with pytest.raises(PolarisError) as e:
        s.wait()
    assert e.value.code == "sign-in-denied" and fake.request_obj.closed and c._tokens.current is None


def test_a_refused_poll_raises_the_workers_code(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=httpx.Response(400, json={"error": {"code": "invalid_grant"}}))
    c = client(w)
    wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    with pytest.raises(PolarisError) as e:
        s.wait()
    assert (e.value.code, e.value.status) == ("invalid_grant", 400)


def test_a_transient_failure_is_ridden_out_at_the_interval(clock) -> None:
    state = {"n": 0}

    def poll(r: httpx.Request) -> httpx.Response:
        state["n"] += 1
        if state["n"] == 1:
            raise httpx.ConnectError("down")
        return TOKEN

    w = Fake(nearby_discovery(), start=START, poll=poll)
    c = client(w)
    wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    assert s.wait().kind == "signed_in" and state["n"] == 2


def test_once_polls_exactly_once_and_raises_a_transient_failure(clock) -> None:
    def down(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    w = Fake(nearby_discovery(), start=START, poll=down)
    c = client(w)
    wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    with pytest.raises(PolarisError) as e:
        s.wait(once=True)
    assert e.value.code == "network-error"


def test_the_gate_going_off_mid_flow_is_the_typed_na(clock) -> None:
    nf = httpx.Response(404, json={"error": {"code": "not_found"}})
    w = Fake(nearby_discovery(), start=START, poll=nf)
    c = client(w)
    fake = wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    # A 404 on the poll is a refusal until start learned the gate is off; it is not read as a sign-in.
    with pytest.raises(PolarisError) as e:
        s.wait()
    assert e.value.code == "not_found" and fake.request_obj.closed


def test_cancel_answers_cancelled_closes_the_lan_side_and_polls_no_more(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=PENDING)
    c = client(w)
    fake = wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    s.cancel()
    s.cancel()
    assert s.wait().kind == "cancelled"
    assert fake.request_obj.calls.count("close") == 1
    assert [x for x in w.nearby_calls() if x["path"].endswith("/poll")] == []


def test_a_cancel_token_stops_the_wait(clock) -> None:
    import threading

    w = Fake(nearby_discovery(), start=START, poll=PENDING)
    c = client(w)
    wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    stop = threading.Event()
    stop.set()
    assert s.wait(cancel_token=stop).kind == "cancelled"


def test_a_timeout_raises_timeout_error(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=PENDING)
    c = client(w)
    wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    with pytest.raises(TimeoutError):
        s.wait(timeout=5)


def test_the_keyring_wrap_is_held_and_dropped_by_decline(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=PENDING)
    c = client(w)
    fake = wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    for fn in list(fake.request_obj._records):
        fn(SimpleNamespace(type=0x0031, body=b"other"))
        fn(SimpleNamespace(type=KEYRING_WRAP_RECORD, body=b"wrap-bytes"))
    assert s._wrap == b"wrap-bytes"
    assert "wrap-bytes" not in repr(s)
    s.decline_account()
    assert s._wrap is None and fake.request_obj.calls[-1] == "decline_account"


def test_identity_off_refuses_the_wait(clock) -> None:
    w = Fake(nearby_discovery(), start=START, poll=PENDING)
    c = client(w)
    wire(c)
    s = c.identity.sign_in.start(channel="nearby")
    c.core.set_services({"license": {"enabled": True}, "config": {"enabled": True}})
    with pytest.raises(UnsupportedError):
        s.wait(once=True)


def test_the_async_client_mirrors_the_session(clock) -> None:
    async def run() -> None:
        w = Fake(nearby_discovery(), start=START, poll=TOKEN)
        c = client(w)
        fake = wire(c)
        fake.request_obj.items = [approver()]
        a = AsyncClient(c)
        s = await a.identity.sign_in.start(channel="nearby")
        assert [x.id for x in s.approvers] == ["a1"]
        assert (await s.choose("a1")).code == "482 913"
        o = await s.wait()
        assert o.kind == "signed_in"
        await s.confirm_account()
        await s.close()
        assert fake.request_obj.calls == ["choose:a1", "confirm_account", "close"]

    asyncio.run(run())
