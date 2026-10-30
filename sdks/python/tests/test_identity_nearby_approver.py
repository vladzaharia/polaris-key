# @pkey-feature identity.nearby
"""``identity.nearby.on_request`` (I-47.9): the approver over a fake LAN half. No silent approval (``approve``
only from a ``pick()`` that matched, with exactly the verified request's handle, device id and keys; ``deny``
only after a matched code; a wrong code and "none match" call no route), every ``NearbyApproval`` step one
to one, the choose loop, the one 409 registration, the answer going to ``finish``, and no secret in a
``repr``. D and M joined for real over loopback are ``test_nearby_e2e.py``."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import httpx
import pytest

from polaris_key import PolarisError
from polaris_key.core.caps import UnsupportedError
from polaris_key.core.peer_nearby import FinishOutcome
from polaris_key.identity.nearby_approver import NearbyApprovalStep, NearbyAsk

from test_identity_nearby import HANDLE, Fake, client, nearby_discovery, queue
from test_transcripts import _FixtureKeys

D_ID = "D" * 32
CODES = ["111 111", "482 913", "777 777"]


class FakeApproval:
    """The LAN half's session (``cloud_connect.nearby``'s ``NearbyApproval``), by hand."""

    def __init__(self, request: Any, finish: Any = None) -> None:
        self.label = "New phone"
        self.platform = "linux"
        self.codes = list(CODES)
        self.request = request
        self.calls: List[Any] = []
        self.finishes: List[Any] = []
        self._finish = finish or (lambda a: FinishOutcome(sent="approved"))
        self.closed = False

    def pick(self, code: str) -> Any:
        self.calls.append(("pick", code))
        return self.request if code == "482 913" else "mismatch"

    def decline(self) -> None:
        self.calls.append("decline")

    def finish(self, answer: Any) -> Any:
        self.finishes.append(answer)
        return self._finish(answer)

    def close(self) -> None:
        self.closed = True


class FakeNearby:
    def __init__(self) -> None:
        self.handler: Any = None
        self.opts: Dict[str, Any] = {}
        self.handle = SimpleNamespace(stop=lambda: None)

    def on_request(self, handler: Any, **opts: Any) -> Any:
        self.handler, self.opts = handler, opts
        return self.handle


def request_for(c: Any) -> Any:
    k = _FixtureKeys("d-1").ensure()
    return SimpleNamespace(request=HANDLE, device_id=D_ID, sign_key=k.sign_key, agree_key=k.agree_key, label="New phone", platform="linux")


def wire(c: Any, supported: bool = True) -> FakeNearby:
    fake = FakeNearby()
    ident = c.identity
    ident._nearby_signer = lambda: (_FixtureKeys("m-1"), "M" * 32)
    ident._cloud_nearby = lambda: fake
    ident._nearby_runtime = (lambda role: True) if supported else None
    return fake


def make(w: Fake, **kw: Any) -> Any:
    """(client, ask, approval, collected asks) with the handler wired the way a host does."""
    c = client(w, token="pkeyt_m")
    fake = wire(c)
    asks: List[NearbyAsk] = []
    c.identity.nearby.on_request(asks.append, **kw)
    approval = FakeApproval(request_for(c))
    fake.handler(approval)
    return c, fake, approval, asks


def approves(w: Fake) -> List[Dict[str, Any]]:
    return [x for x in w.nearby_calls() if x["path"].endswith("/approve")]


def test_the_handler_gets_an_ask_with_the_device_the_platform_and_three_codes() -> None:
    w = Fake(nearby_discovery())
    c, fake, approval, asks = make(w, prompt=True, background=False)
    (ask,) = asks
    assert (ask.device, ask.platform, ask.codes) == ("New phone", "linux", CODES)
    assert fake.opts["prompt"] is True and fake.opts["background"] is False
    # This device's own name goes in the other device's list; the call's options pass through.
    assert "label" in fake.opts
    assert repr(ask) == "<NearbyAsk>"
    with pytest.raises(TypeError):
        import pickle

        pickle.dumps(ask)


def test_a_wrong_code_is_mismatch_and_calls_no_route() -> None:
    w = Fake(nearby_discovery(), approve=httpx.Response(200, json={"status": "approved"}))
    c, fake, approval, (ask,) = make(w)
    assert ask.pick("111 111").kind == "mismatch"
    assert approves(w) == [] and approval.finishes == []
    with pytest.raises(PolarisError):
        ask.pick("482 913")  # the session is over


def test_none_match_declines_the_session_and_calls_no_route() -> None:
    w = Fake(nearby_discovery())
    c, fake, approval, (ask,) = make(w)
    assert ask.deny().kind == "denied"
    assert approval.calls == ["decline"] and approves(w) == [] and approval.finishes == []


def test_the_right_code_approves_with_exactly_the_verified_requests_keys_and_finishes() -> None:
    w = Fake(nearby_discovery(), approve=httpx.Response(200, json={"status": "approved", "deviceLabel": "New phone"}))
    c, fake, approval, (ask,) = make(w)
    step = ask.pick("482 913")
    assert (step.kind, step.device_label) == ("approved", "New phone")
    (call,) = approves(w)
    k = _FixtureKeys("d-1").ensure()
    assert call["auth"] == "Bearer pkeyt_m"
    assert {x: call["body"][x] for x in ("request", "deviceId", "signKey", "agreeKey", "decision")} == {
        "request": HANDLE, "deviceId": D_ID, "signKey": k.sign_key, "agreeKey": k.agree_key, "decision": "approve",
    }
    (answer,) = approval.finishes
    assert (answer.http, answer.discovery_nearby) == (200, True)
    assert json.loads(answer.body)["status"] == "approved"
    with pytest.raises(PolarisError):
        ask.pick("482 913")  # answered


@pytest.mark.parametrize(
    "res,kind",
    [
        (httpx.Response(403, json={"error": {"code": "not_nearby"}}), "not-nearby"),
        (httpx.Response(403, json={"error": {"code": "device_limit"}}), "device-limit"),
        (httpx.Response(403, json={"error": {"code": "account_required"}}), "account-required"),
        (httpx.Response(429, json={"error": {"code": "rate_limited"}}, headers={"retry-after": "9"}), "rate-limited"),
        (httpx.Response(404, json={"error": {"code": "not_found"}}), "expired"),
        (httpx.Response(400, json={"error": {"code": "invalid_grant"}}), "expired"),
        (httpx.Response(503, json={"error": "unavailable"}), "expired"),
    ],
)
def test_every_refusal_is_one_approval_step(res: httpx.Response, kind: str) -> None:
    w = Fake(nearby_discovery(), approve=res)
    c, fake, approval, (ask,) = make(w)
    step = ask.pick("482 913")
    assert step.kind == kind
    if kind == "rate-limited":
        assert step.retry_after_seconds == 9
    # The vouch's finish step always hears the Worker's answer, as `{"code": …}` for a refusal.
    (answer,) = approval.finishes
    assert answer.http == res.status_code


def test_a_404_is_expired_only_while_a_fresh_discovery_still_names_nearby() -> None:
    w = Fake(nearby_discovery(), approve=httpx.Response(404, json={"error": {"code": "not_found"}}))
    c, fake, approval, (ask,) = make(w)
    c.identity.nearby.available(role="approver")  # discovery loaded: it names nearby
    gone = nearby_discovery()
    del gone["services"]["identity"]["nearby"]
    w.doc = gone
    assert ask.pick("482 913").kind == "expired"
    assert approval.finishes[0].discovery_nearby is False


def test_the_choose_loop_and_a_choice_then_approved() -> None:
    choices = {"state": "choose", "choices": [{"id": "lic_1"}, {"id": "lic_2"}]}
    w = Fake(
        nearby_discovery(),
        approve=queue(
            httpx.Response(200, json={"status": "choose", "choices": choices}),
            httpx.Response(200, json={"status": "approved", "deviceLabel": None}),
        ),
    )
    finishes = iter([FinishOutcome(wait="choice"), FinishOutcome(sent="approved")])
    c = client(w, token="pkeyt_m")
    fake = wire(c)
    asks: List[NearbyAsk] = []
    c.identity.nearby.on_request(asks.append)
    approval = FakeApproval(request_for(c), finish=lambda a: next(finishes))
    fake.handler(approval)
    step = asks[0].pick("482 913")
    assert step.kind == "choose" and step.choices == choices
    step = step.choose({"kind": "license", "licenseId": "lic_2"})
    assert step.kind == "approved"
    first, second = approves(w)
    assert "choice" not in first["body"] and second["body"]["choice"] == {"kind": "license", "licenseId": "lic_2"}
    assert [(a.http) for a in approval.finishes] == [200, 200]
    with pytest.raises(PolarisError):
        step.choose({"kind": "create"})  # not a choose step


def test_cancelling_the_choice_is_a_deny_after_the_matched_code() -> None:
    choices = {"state": "choose", "choices": [{"id": "lic_1"}]}
    w = Fake(
        nearby_discovery(),
        approve=queue(httpx.Response(200, json={"status": "choose", "choices": choices}), httpx.Response(204)),
    )
    finishes = iter([FinishOutcome(wait="choice"), FinishOutcome(sent="denied")])
    c = client(w, token="pkeyt_m")
    fake = wire(c)
    asks: List[NearbyAsk] = []
    c.identity.nearby.on_request(asks.append)
    approval = FakeApproval(request_for(c), finish=lambda a: next(finishes))
    fake.handler(approval)
    step = asks[0].pick("482 913")
    assert step.cancel().kind == "denied"
    assert [x["body"]["decision"] for x in approves(w)] == ["approve", "deny"]


def test_deny_after_a_matched_pick_sends_deny_for_the_requests_own_handle() -> None:
    w = Fake(nearby_discovery(), approve=httpx.Response(204))
    c = client(w, token="pkeyt_m")
    fake = wire(c)
    asks: List[NearbyAsk] = []
    c.identity.nearby.on_request(asks.append)
    approval = FakeApproval(request_for(c))
    fake.handler(approval)
    ask = asks[0]
    ask._request = approval.request  # as a matched pick leaves it
    assert ask.deny().kind == "denied"
    assert approves(w)[0]["body"]["decision"] == "deny" and approves(w)[0]["body"]["request"] == HANDLE


def test_a_409_registers_the_keys_once_and_the_machine_hears_it_so_a_second_one_closes() -> None:
    need = httpx.Response(409, json={"error": {"code": "device_keys_required"}})
    w = Fake(nearby_discovery(), approve=need)
    registered: List[str] = []
    c = client(w, token="pkeyt_m")
    fake = wire(c)
    c.identity._nearby_routes._register_keys = lambda creds: registered.append(creds.device_id)
    asks: List[NearbyAsk] = []
    c.identity.nearby.on_request(asks.append)
    outcomes = iter([FinishOutcome(wait="keys"), FinishOutcome(closed=True)])
    approval = FakeApproval(request_for(c), finish=lambda a: next(outcomes))
    fake.handler(approval)
    step = asks[0].pick("482 913")
    assert step.kind == "expired" and registered == ["M" * 32] and len(approves(w)) == 2
    # The machine heard `device_keys_required` once (the registration), then the final 409.
    assert [(a.http, json.loads(a.body)["code"]) for a in approval.finishes] == [
        (409, "device_keys_required"), (409, "device_keys_required"),
    ]


def test_no_credential_is_account_required_and_sends_nothing() -> None:
    w = Fake(nearby_discovery())
    c = client(w)  # no token
    fake = wire(c)
    asks: List[NearbyAsk] = []
    c.identity.nearby.on_request(asks.append)
    approval = FakeApproval(request_for(c))
    fake.handler(approval)
    assert asks[0].pick("482 913").kind == "account-required"
    assert approves(w) == [] and approval.closed


def test_no_answer_closes_the_session_and_is_expired() -> None:
    def down(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    w = Fake(nearby_discovery(), approve=down)
    c, fake, approval, (ask,) = make(w)
    assert ask.pick("482 913").kind == "expired" and approval.closed


def test_a_session_that_ended_under_the_person_is_expired() -> None:
    w = Fake(nearby_discovery())
    c, fake, approval, (ask,) = make(w)

    def gone(code: str) -> Any:
        from polaris_key.connect.errors import LanError

        raise LanError("closed", "The session is closed.")

    approval.pick = gone  # type: ignore[method-assign]
    assert ask.pick("482 913").kind == "expired" and approves(w) == []


def test_a_request_that_does_not_verify_is_expired_and_calls_no_route() -> None:
    w = Fake(nearby_discovery())
    c, fake, approval, (ask,) = make(w)
    approval.pick = lambda code: "invalid"  # type: ignore[method-assign]
    assert ask.pick("482 913").kind == "expired" and approves(w) == []


def test_on_request_is_the_typed_na_when_the_runtime_cannot_advertise_or_has_no_lan() -> None:
    c = client(Fake(nearby_discovery()), token="pkeyt_m")
    wire(c, supported=False)
    with pytest.raises(UnsupportedError) as e:
        c.identity.nearby.on_request(lambda a: None)
    assert e.value.code == "nearby-unsupported"
    c2 = client(Fake(nearby_discovery()), token="pkeyt_m")
    c2.identity._cloud_nearby = None
    c2.identity._nearby_runtime = lambda role: True
    with pytest.raises(UnsupportedError):
        c2.identity.nearby.on_request(lambda a: None)


def test_the_step_repr_holds_no_callbacks_or_secrets() -> None:
    step = NearbyApprovalStep("choose", choices={"x": 1}, _choose=lambda c: None, _cancel=lambda: None)
    assert "lambda" not in repr(step) and "_choose" not in repr(step)


def test_the_async_client_mirrors_available_and_on_request() -> None:
    import asyncio

    from polaris_key import AsyncClient

    async def run() -> None:
        c = client(Fake(nearby_discovery()), token="pkeyt_m")
        fake = wire(c)
        stopped: List[int] = []
        fake.handle = SimpleNamespace(stop=lambda: stopped.append(1), status=lambda: "x")
        a = AsyncClient(c)
        assert await a.identity.nearby.available(role="approver") is True
        h = await a.identity.nearby.on_request(lambda ask: None, prompt=True)
        await h.stop()
        assert stopped == [1]

    asyncio.run(run())


# ── The key ring wrap after approved (I-47.11) ───────────────────────────────────────────────


class FakeRing:
    """The key ring client's side of a wrap: a root held or not, and what ``wrap_to`` was asked."""

    def __init__(self, unlocked: bool = True, unlocks_to: bool = True, put: Optional[Exception] = None) -> None:
        self.unlocked = unlocked
        self._unlocks_to = unlocks_to
        self._put = put
        self.calls: List[Any] = []

    def unlock(self) -> Any:
        self.calls.append("unlock")
        self.unlocked = self._unlocks_to

    def wrap_to(self, device_id: str, agree_key: str) -> Any:
        self.calls.append(("wrap_to", device_id, agree_key))
        if self._put is not None:
            raise self._put
        return SimpleNamespace(channel_record=lambda: b"WRAP-RECORD")


def with_ring(w: Fake, ring: Optional[FakeRing]) -> Any:
    c = client(w, token="pkeyt_m")
    fake = wire(c)
    c.identity._keyring = (lambda: ring) if ring is not None else None
    asks: List[NearbyAsk] = []
    c.identity.nearby.on_request(asks.append)
    approval = FakeApproval(request_for(c))
    sent: List[Any] = []
    approval.send_record = lambda t, b: sent.append((t, b))  # type: ignore[attr-defined]
    fake.handler(approval)
    return c, approval, asks[0], sent


APPROVED = httpx.Response(200, json={"status": "approved", "deviceLabel": "New phone"})


def test_after_approved_the_root_is_wrapped_to_the_verified_requests_agree_key_and_sent_once() -> None:
    ring = FakeRing()
    c, approval, ask, sent = with_ring(Fake(nearby_discovery(), approve=APPROVED), ring)
    step = ask.pick("482 913")
    k = _FixtureKeys("d-1").ensure()
    assert step.kind == "approved" and step.wrap_sent is True
    assert ring.calls == [("wrap_to", D_ID, k.agree_key)]
    assert sent == [(0x0030, b"WRAP-RECORD")]
    assert ask._send_wrap() is False and len(sent) == 1  # once


def test_a_locked_ring_is_unlocked_first_and_with_no_root_no_wrap_is_sent() -> None:
    ring = FakeRing(unlocked=False, unlocks_to=True)
    c, approval, ask, sent = with_ring(Fake(nearby_discovery(), approve=APPROVED), ring)
    assert ask.pick("482 913").wrap_sent is True and ring.calls[0] == "unlock"
    ring = FakeRing(unlocked=False, unlocks_to=False)
    c, approval, ask, sent = with_ring(Fake(nearby_discovery(), approve=APPROVED), ring)
    step = ask.pick("482 913")
    assert (step.kind, step.wrap_sent) == ("approved", False) and sent == [] and ring.calls == ["unlock"]


def test_no_key_ring_or_a_refused_put_sends_nothing_over_the_channel() -> None:
    c, approval, ask, sent = with_ring(Fake(nearby_discovery(), approve=APPROVED), None)
    assert ask.pick("482 913").wrap_sent is False and sent == []
    ring = FakeRing(put=PolarisError("keyring_conflict", "a wrap exists", status=409))
    c, approval, ask, sent = with_ring(Fake(nearby_discovery(), approve=APPROVED), ring)
    step = ask.pick("482 913")
    assert (step.kind, step.wrap_sent) == ("approved", False) and sent == []


def test_a_wrap_is_sent_only_after_approved_never_for_a_refusal_or_a_deny() -> None:
    ring = FakeRing()
    c, approval, ask, sent = with_ring(Fake(nearby_discovery(), approve=httpx.Response(403, json={"error": {"code": "not_nearby"}})), ring)
    assert ask.pick("482 913").kind == "not-nearby"
    ring2 = FakeRing()
    c, approval, ask, sent = with_ring(Fake(nearby_discovery(), approve=httpx.Response(204)), ring2)
    ask._request = approval.request
    assert ask.deny().kind == "denied"
    assert ring.calls == [] and ring2.calls == [] and sent == []


def test_a_session_that_ended_still_leaves_the_servers_copy() -> None:
    ring = FakeRing()
    c, approval, ask, sent = with_ring(Fake(nearby_discovery(), approve=APPROVED), ring)

    def gone(t: int, b: bytes) -> None:
        raise RuntimeError("closed")

    approval.send_record = gone  # type: ignore[attr-defined]
    assert ask.pick("482 913").wrap_sent is True and len(ring.calls) == 1
