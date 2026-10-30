# @pkey-feature identity.nearby
"""The nearby sign-in route client (I-47.5; WIRE-CONTRACT-V5 §12.11.5): ``start`` and ``poll`` (D) and
``approve`` (M), proved against the six recorded ``nearby-*`` transcripts and by the rules the transcripts
cannot show: the bearer on ``start`` (Q8) and never on ``poll``, the poll signing with the key ``start``
sent, the one 409 retry, the token stored as a device-code sign-in stores it, a 404 read through a fresh
discovery (N11), the 503 that keeps the request, and no secret in a ``repr``.

The replay is held back from ``test_transcripts.py`` until the manifest claims ``identity.nearby`` (I-47.15),
so it runs here on its own."""

from __future__ import annotations

import copy
import dataclasses
import json
import pickle
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import httpx
import pytest

from polaris_key import PolarisError
from polaris_key.devices.store import InMemoryStore
from polaris_key.identity.nearby import (
    NearbyCredentials,
    NearbyPollResult,
    NearbyRefused,
    NearbyStarted,
    NearbyUnavailable,
    _GRANTS,
    _grant,
    _Vouch,
)

from helpers import BASE_URL, PRODUCT, make_client
from test_identity_account import BASE, SUBJECT, Worker, discovery, ok
from test_transcripts import TRANSCRIPTS, _FixtureKeys, replay

NEARBY = [t for t in TRANSCRIPTS if t["id"].startswith("nearby-")]
HANDLE = "nr_" + "A" * 22
TOKEN_ANSWER = {
    "access_token": "pkeyt_nearby_token",
    "token_type": "Bearer",
    "scope": "email",
    "schemaVersion": 1,
    "device": {"id": "D" * 32},
    "license": {"id": "lic_n1", "name": "Ada", "email": "ada@example.com"},
    "subject": SUBJECT,
}


def test_the_six_nearby_transcripts_are_present() -> None:
    assert sorted(t["id"] for t in NEARBY) == [
        "nearby-choose",
        "nearby-denied",
        "nearby-disabled",
        "nearby-errors",
        "nearby-gate-off",
        "nearby-happy",
    ]


@pytest.mark.parametrize("t", NEARBY, ids=[t["id"] for t in NEARBY])
def test_replay(t: Dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    replay(t, monkeypatch)


# ── The rules the transcripts cannot show ───────────────────────────────────────────


def nearby_discovery(start: bool = True, approve: bool = True, poll: bool = True) -> Dict[str, Any]:
    doc = discovery()
    ident = doc["services"]["identity"]
    ident["nearby"] = True
    ident["endpoints"] = dict(ident["endpoints"])  # the account tests share the module's dict
    for name, on, path in (
        ("nearbyStart", start, "start"),
        ("nearbyApprove", approve, "approve"),
        ("nearbyPoll", poll, "poll"),
    ):
        if on:
            ident["endpoints"][name] = f"{BASE}/identity/nearby/{path}"
    return doc


class Fake(Worker):
    """The mock Worker, with the nearby routes answered from queues."""

    def __init__(self, doc: Dict[str, Any], **answers: Any) -> None:
        super().__init__(doc, **answers)

    def nearby_calls(self) -> List[Dict[str, Any]]:
        return [c for c in self.calls if "/nearby/" in c["path"]]


def queue(*answers: httpx.Response) -> Any:
    items: List[httpx.Response] = list(answers)
    return lambda r: items.pop(0) if len(items) > 1 else items[0]


def client(worker: Worker, token: Optional[str] = None, **kw: Any) -> Any:
    store = InMemoryStore(PRODUCT)
    if token is not None:
        store.set_token(token)
    c = make_client(worker, store=store, expected_services=["license", "config", "identity"], **kw)
    c.identity._deps.on_acquired = lambda: None  # the acquisition sync is the sync tests' business
    return c


def creds(c: Any, label: str = "d-1", token: Optional[str] = None, device: Optional[str] = None) -> NearbyCredentials:
    return NearbyCredentials(device or c.core.device_id, _FixtureKeys(label), token)  # type: ignore[arg-type]


def routes(c: Any) -> Any:
    return c.identity._nearby_routes


def started_by(c: Any, d: NearbyCredentials, **kw: Any) -> NearbyStarted:
    k = d.keys.ensure()
    return NearbyStarted(HANDLE, 300, 3, k.sign_key, k.agree_key, d.device_id, **kw)


def test_start_carries_the_bearer_when_the_device_holds_one_and_the_label() -> None:
    w = Fake(nearby_discovery(), start=httpx.Response(201, json=dict(request=HANDLE, expiresIn=300, interval=3)))
    c = client(w, token="pkeyt_held")
    r = routes(c).start(creds(c, token="pkeyt_held"), device_name="Living-room console")
    assert r.kind == "started" and (r.expires_in, r.interval) == (300, 3)
    call = w.nearby_calls()[0]
    assert call["auth"] == "Bearer pkeyt_held"
    assert call["body"]["deviceName"] == "Living-room console"
    assert set(call["body"]) == {"signKey", "agreeKey", "deviceName", "proof"}


def test_start_without_a_credential_sends_no_bearer_and_no_name_when_none() -> None:
    w = Fake(nearby_discovery(), start=httpx.Response(201, json=dict(request=HANDLE, expiresIn=300, interval=3)))
    c = client(w, device_name="")
    assert routes(c).start(creds(c)).kind == "started"
    call = w.nearby_calls()[0]
    assert call["auth"] is None
    assert "deviceName" not in call["body"]


def test_the_handle_and_the_proof_are_not_in_a_repr() -> None:
    w = Fake(nearby_discovery(), start=httpx.Response(201, json=dict(request=HANDLE, expiresIn=300, interval=3)))
    c = client(w)
    r = routes(c).start(creds(c))
    assert HANDLE not in repr(r)
    d = creds(c, token="pkeyt_secret_token")
    assert "pkeyt_secret_token" not in repr(d)
    assert "nearby" not in repr(routes(c)).lower().replace("nearbyroutes", "")


def test_nothing_is_sent_when_discovery_names_no_nearby_or_not_the_endpoint() -> None:
    off = nearby_discovery()
    del off["services"]["identity"]["nearby"]
    for doc in (off, nearby_discovery(start=False), nearby_discovery(poll=False)):
        w = Fake(doc)
        c = client(w)
        assert isinstance(routes(c).start(creds(c)), NearbyUnavailable)
        assert w.nearby_calls() == []
    w = Fake(nearby_discovery(approve=False))
    c = client(w)
    r = routes(c).approve(
        creds(c, token="pkeyt_m"),
        vouch(device_id="D" * 32, sign_key=_FixtureKeys("d").ensure().sign_key, agree_key=_FixtureKeys("d").ensure().agree_key),
    )
    assert r.kind == "unavailable" and w.nearby_calls() == []


def test_an_endpoint_outside_this_product_is_not_followed() -> None:
    doc = nearby_discovery()
    doc["services"]["identity"]["endpoints"]["nearbyStart"] = "https://evil.test/nearby/start"
    w = Fake(doc)
    c = client(w)
    assert isinstance(routes(c).start(creds(c)), NearbyUnavailable)
    assert w.calls and all("evil.test" not in str(x["path"]) for x in w.calls)


def test_start_404_is_unavailable_and_sticks_for_a_later_404() -> None:
    nf = httpx.Response(404, json={"error": {"code": "not_found"}})
    w = Fake(nearby_discovery(), start=nf, approve=nf, poll=nf)
    c = client(w)
    d = creds(c)
    assert routes(c).start(d).reason == "gate"
    k = d.keys.ensure()
    r = routes(c).approve(
        creds(c, "m-1", "pkeyt_m", "M" * 32),
        vouch(device_id=d.device_id, sign_key=k.sign_key, agree_key=k.agree_key),
    )
    assert r.kind == "unavailable" and r.answer.http == 404
    assert isinstance(routes(c).poll(d, started_by(c, d)), NearbyUnavailable)


def test_a_404_without_that_is_a_refusal_and_finish_reads_discovery_afresh() -> None:
    nf = httpx.Response(404, json={"error": {"code": "not_found"}})
    w = Fake(nearby_discovery(), approve=nf)
    c = client(w)
    k = _FixtureKeys("d").ensure()
    r = routes(c).approve(
        creds(c, "m-1", "pkeyt_m", "M" * 32),
        vouch(device_id="D" * 32, sign_key=k.sign_key, agree_key=k.agree_key),
    )
    assert (r.kind, r.status, r.code) == ("refused", 404, "not_found")
    # The finish step reads `{"code": …}` whatever the Worker's spelling, and the 404 against fresh discovery.
    a = routes(c).answer_for_finish(r)
    assert (a.http, a.discovery_nearby) == (404, True)
    assert json.loads(a.body or "{}") == {"code": "not_found"}
    # The gate went off: a fresh discovery no longer names nearby.
    gone = nearby_discovery()
    del gone["services"]["identity"]["nearby"]
    w.doc = gone
    assert routes(c).answer_for_finish(r).discovery_nearby is False


def test_a_fresh_read_that_fails_is_not_read_as_still_named() -> None:
    nf = httpx.Response(404, json={"error": {"code": "not_found"}})
    w = Fake(nearby_discovery(), approve=nf)
    c = client(w)
    c.identity._nearby_routes._refresh = lambda: None
    k = _FixtureKeys("d").ensure()
    r = routes(c).approve(
        creds(c, "m-1", "pkeyt_m", "M" * 32),
        vouch(device_id="D" * 32, sign_key=k.sign_key, agree_key=k.agree_key),
    )
    assert routes(c).answer_for_finish(r).discovery_nearby is False


def test_poll_never_sends_a_bearer_and_signs_with_the_key_start_sent() -> None:
    w = Fake(nearby_discovery(), poll=ok(status="pending"))
    c = client(w, token="pkeyt_held")
    d = creds(c, token="pkeyt_held")
    s = started_by(c, d)
    assert routes(c).poll(d, s).kind == "pending"
    assert w.nearby_calls()[0]["auth"] is None
    # D's keys changed since start: refused locally, nothing sent.
    other = NearbyCredentials(d.device_id, _FixtureKeys("rotated"), d.token)
    before = len(w.nearby_calls())
    with pytest.raises(PolarisError) as e:
        routes(c).poll(other, s)
    assert e.value.code == "invalid-options" and len(w.nearby_calls()) == before


def test_a_malformed_handle_is_refused_before_any_request() -> None:
    w = Fake(nearby_discovery())
    c = client(w)
    d = creds(c)
    with pytest.raises(PolarisError) as e:
        routes(c).poll(d, started_by(c, d).__class__("nr_short", 300, 3, "a" * 43, "b" * 43, d.device_id))
    assert e.value.code == "invalid-options" and w.nearby_calls() == []


def test_poll_answers_slow_down_and_a_503_keeps_the_request() -> None:
    w = Fake(
        nearby_discovery(),
        poll=queue(
            httpx.Response(429, json={"status": "slow_down", "interval": 6}),
            httpx.Response(429, json={}),
            httpx.Response(503, json={"error": "unavailable"}, headers={"retry-after": "7"}),
            httpx.Response(400, json={"error": {"code": "invalid_grant"}}),
            httpx.Response(200, json={"status": "timeout"}),
            httpx.Response(200, json={"status": "error", "reason": "access_denied"}),
        ),
    )
    c = client(w)
    d = creds(c)
    s = started_by(c, d)
    r = routes(c).poll(d, s)
    assert (r.kind, r.interval) == ("slow_down", 6)
    assert routes(c).poll(d, s).interval == 8  # no interval: the current one plus five
    r = routes(c).poll(d, s)
    assert (r.kind, r.retry_after_seconds) == ("retry", 7)
    r = routes(c).poll(d, s)
    assert isinstance(r, NearbyRefused) and (r.status, r.code) == (400, "invalid_grant")
    assert routes(c).poll(d, s).kind == "timeout"
    r = routes(c).poll(d, s)
    assert (r.kind, r.reason) == ("denied", "access_denied")


def test_a_token_is_stored_as_a_device_code_sign_in_stores_it(tmp_path: Any) -> None:
    w = Fake(nearby_discovery(), poll=ok(**TOKEN_ANSWER))
    events: List[Any] = []
    c = client(w, state_dir=str(tmp_path))
    c.events.subscribe(lambda e: events.append((e.get("change"), e.get("subject"))), ["identity"])
    c.identity.sign_out()  # the person signed out earlier: the flag is up
    events.clear()
    assert c._tokens.explicit_sign_out is True
    d = creds(c)
    acquired: List[int] = []
    c.identity._deps.on_acquired = lambda: acquired.append(1)
    r = routes(c).poll(d, started_by(c, d))
    assert isinstance(r, NearbyPollResult) and (r.kind, r.subject, r.scope, r.license_id) == (
        "signed_in", SUBJECT, "email", "lic_n1",
    )
    assert c._tokens.current == "pkeyt_nearby_token"
    assert c._tokens.provenance == "signin" and c._tokens.explicit_sign_out is False
    assert c.identity._account.stored_subject() == SUBJECT
    assert acquired == [1]
    assert events == [("signed_in", SUBJECT)]
    assert "pkeyt_nearby_token" not in repr(r)


def test_a_malformed_token_answer_stores_nothing() -> None:
    w = Fake(nearby_discovery(), poll=ok(access_token="pkeyt_x", scope="email"))
    c = client(w)
    d = creds(c)
    with pytest.raises(PolarisError) as e:
        routes(c).poll(d, started_by(c, d))
    assert e.value.code == "bad_response" and c._tokens.current is None


def test_a_transport_failure_raises_network_error() -> None:
    def boom(r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("polaris.json"):
            return httpx.Response(200, json=nearby_discovery())
        raise httpx.ConnectError("down")

    c = make_client(boom, expected_services=["license", "config", "identity"])
    d = creds(c)
    with pytest.raises(PolarisError) as e:
        routes(c).poll(d, started_by(c, d))
    assert e.value.code == "network-error"


def approve_args(c: Any) -> Dict[str, Any]:
    k = _FixtureKeys("d-1").ensure()
    return dict(request=HANDLE, device_id="D" * 32, sign_key=k.sign_key, agree_key=k.agree_key)


def vouch(**kw: Any) -> Any:
    """The permit a matched pick earns (nearby_approver.py makes it there; no route offers one, so the
    tests make it the same way)."""
    base = dict(request=HANDLE, device_id="D" * 32, sign_key="", agree_key="")
    base.update(kw)
    return _grant(SimpleNamespace(**base))


def test_approve_sends_m_s_id_bearer_and_exactly_the_requests_keys() -> None:
    w = Fake(nearby_discovery(), approve=ok(status="approved", deviceLabel="Console"))
    c = client(w)
    m = creds(c, "m-1", "pkeyt_m", "M" * 32)
    r = routes(c).approve(m, vouch(**approve_args(c)))
    assert (r.kind, r.device_label) == ("approved", "Console")
    call = w.nearby_calls()[0]
    assert call["auth"] == "Bearer pkeyt_m"
    k = _FixtureKeys("d-1").ensure()
    assert {x: call["body"][x] for x in ("request", "deviceId", "signKey", "agreeKey", "decision")} == {
        "request": HANDLE, "deviceId": "D" * 32, "signKey": k.sign_key, "agreeKey": k.agree_key, "decision": "approve",
    }
    assert "choice" not in call["body"]


def test_approve_choose_deny_and_the_choice() -> None:
    choices = {"state": "choose", "choices": [{"id": "lic_1"}]}
    w = Fake(
        nearby_discovery(),
        approve=queue(ok(status="choose", choices=choices), ok(status="approved", deviceLabel=None), httpx.Response(204)),
    )
    c = client(w)
    m = creds(c, "m-1", "pkeyt_m", "M" * 32)
    r = routes(c).approve(m, vouch(**approve_args(c)))
    assert (r.kind, r.choices) == ("choose", choices)
    r = routes(c).approve(m, vouch(**approve_args(c)), choice={"kind": "license", "licenseId": "lic_1"})
    assert (r.kind, r.device_label) == ("approved", None)
    assert w.nearby_calls()[1]["body"]["choice"] == {"kind": "license", "licenseId": "lic_1"}
    r = routes(c).approve(m, vouch(**approve_args(c)), decision="deny")
    assert r.kind == "denied" and w.nearby_calls()[2]["body"]["decision"] == "deny"


@pytest.mark.parametrize("code", ["not_nearby", "device_limit", "account_required", "invalid_grant"])
def test_approve_refusals_are_results_and_the_finish_body_is_flat(code: str) -> None:
    w = Fake(nearby_discovery(), approve=httpx.Response(403, json={"error": {"code": code}}))
    c = client(w)
    r = routes(c).approve(creds(c, "m-1", "pkeyt_m", "M" * 32), vouch(**approve_args(c)))
    assert (r.kind, r.status, r.code) == ("refused", 403, code)
    assert json.loads(r.answer.body or "{}") == {"code": code}
    assert routes(c).answer_for_finish(r).discovery_nearby is True  # only a 404 reads it


def test_a_409_device_keys_required_registers_once_and_retries_once() -> None:
    need = httpx.Response(409, json={"error": {"code": "device_keys_required"}})
    registered: List[str] = []
    w = Fake(nearby_discovery(), approve=queue(need, ok(status="approved", deviceLabel="Console")))
    c = client(w)
    routes(c)._register_keys = lambda creds_: registered.append(creds_.device_id)
    m = creds(c, "m-1", "pkeyt_m", "M" * 32)
    r = routes(c).approve(m, vouch(**approve_args(c)))
    assert r.kind == "approved" and r.answer.keys_retried is True
    assert registered == ["M" * 32] and len(w.nearby_calls()) == 2


def test_a_second_409_is_the_answer_and_never_loops() -> None:
    need = httpx.Response(409, json={"error": {"code": "device_keys_required"}})
    registered: List[str] = []
    w = Fake(nearby_discovery(), approve=need)
    c = client(w)
    routes(c)._register_keys = lambda creds_: registered.append(creds_.device_id)
    r = routes(c).approve(creds(c, "m-1", "pkeyt_m", "M" * 32), vouch(**approve_args(c)))
    assert (r.kind, r.status, r.code) == ("refused", 409, "device_keys_required")
    assert r.answer.keys_retried is True and len(registered) == 1 and len(w.nearby_calls()) == 2


def test_a_409_with_no_way_to_register_is_just_the_answer() -> None:
    need = httpx.Response(409, json={"error": {"code": "device_keys_required"}})
    w = Fake(nearby_discovery(), approve=need)
    c = client(w)
    routes(c)._register_keys = None
    r = routes(c).approve(creds(c, "m-1", "pkeyt_m", "M" * 32), vouch(**approve_args(c)))
    assert r.kind == "refused" and r.answer.keys_retried is False and len(w.nearby_calls()) == 1


def test_approve_needs_a_credential_and_well_formed_inputs() -> None:
    w = Fake(nearby_discovery())
    c = client(w)
    no_token = creds(c, "m-1", None, "M" * 32)
    with pytest.raises(PolarisError) as e:
        routes(c).approve(no_token, vouch(**approve_args(c)))
    assert e.value.code == "no-token"
    m = creds(c, "m-1", "pkeyt_m", "M" * 32)
    for bad in (
        dict(approve_args(c), request="nr_x"),
        dict(approve_args(c), sign_key="short"),
        dict(approve_args(c), agree_key=""),
        dict(approve_args(c), device_id=""),
        dict(approve_args(c), decision="maybe"),
    ):
        decision = bad.pop("decision", "approve")
        with pytest.raises(PolarisError) as e:
            routes(c).approve(m, vouch(**bad), decision=decision)
        assert e.value.code == "invalid-options"
    assert w.nearby_calls() == []


def test_approve_takes_only_the_permit_of_a_matched_pick() -> None:
    """V5 15.6.1 rule 10: loose ids and keys, a forged object, a copy and None are refused, sending nothing."""
    w = Fake(nearby_discovery(), approve=ok(status="approved", deviceLabel="Console"))
    c = client(w)
    m = creds(c, "m-1", "pkeyt_m", "M" * 32)
    granted = vouch(**approve_args(c))
    loose = SimpleNamespace(**approve_args(c))
    forged = _Vouch(**approve_args(c))
    assert forged not in _GRANTS
    for v in (None, {}, approve_args(c), loose, forged, dataclasses.replace(granted), "nr_" + "A" * 22):
        with pytest.raises(PolarisError) as e:
            routes(c).approve(m, v)
        assert e.value.code == "invalid-options", v
    # Loose ids as keywords (the old signature) are not accepted either.
    with pytest.raises(TypeError):
        routes(c).approve(m, **approve_args(c))  # type: ignore[call-arg]
    # A permit cannot be copied or pickled into another.
    for dup in (copy.copy, copy.deepcopy, pickle.dumps):
        with pytest.raises(TypeError):
            dup(granted)
    assert w.nearby_calls() == []
    assert routes(c).approve(m, granted).kind == "approved"
    assert len(w.nearby_calls()) == 1
    # What is sent is what was granted: and the permit shows nothing of it.
    assert HANDLE not in repr(granted)
