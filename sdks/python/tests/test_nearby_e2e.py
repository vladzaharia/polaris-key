# @pkey-feature identity.nearby
"""Nearby sign-in, end to end in one process (I-47.9; WIRE-CONTRACT-V5 §12.11.5, §15.6.1): a signed-in
client M and a client D with no sign-in meet over loopback on the fake LAN through the real engines
(``client.cloud_connect.nearby``), and talk to ONE stub Worker that verifies every ``pkey-proof/1`` proof and
holds the key-binding rule. D starts, lists M, the person taps it, the codes match, M approves, and D's POLL
(never ``VOUCH_RESULT``) signs it in. Also: a wrong pick, "none match", a deny, the licence choice, M
registering its keys after a 409, ``not_nearby``, and sign-out stopping the approver. Connect is off."""

from __future__ import annotations

import json
import threading
from typing import Any, Dict, Iterator, List, Optional

import httpx
import pytest

from polaris_key import PolarisError
from polaris_key.core.device_proof import DeviceProof, verify_device_proof
from polaris_key.identity.nearby_approver import NearbyAsk
from polaris_key.identity.sign_in import SignedInIdentity

from helpers import BASE_URL, PRODUCT, make_client
from nearby_fixtures import memory_keys, until
from test_connect_lan import Network

BASE = f"{BASE_URL}/{PRODUCT}"
M_ID = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM"
D_ID = "NEARBYDEVICE".ljust(31, "0") + "D"
M_TOKEN = "pkeyt_" + "m" * 43
D_TOKEN = "pkeyt_" + "d" * 43
SUBJECT = "ps_" + "A" * 22
LOOP: Dict[str, Any] = {"host": "127.0.0.1", "allow_loopback": True}


class StubWorker:
    """The Worker's nearby routes, with the real proof checks (V5 §12.11.1, §12.11.5)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: Dict[str, Dict[str, Any]] = {}
        self.m_keys: Optional[str] = None  # M's registered signing key
        self.m_registered = False
        self.calls: List[str] = []
        self.approve_answer: Optional[httpx.Response] = None
        self.choose_first = False
        self.next_handle = 0
        self.proof_failures: List[str] = []

    def doc(self) -> Dict[str, Any]:
        return {
            "product": PRODUCT,
            "services": {
                "license": {"enabled": True},
                "config": {"enabled": True},
                "identity": {
                    "enabled": True,
                    "configured": True,
                    "account": True,
                    "nearby": True,
                    "endpoints": {
                        "subject": f"{BASE}/identity/subject",
                        "signout": f"{BASE}/identity/signout",
                        "nearbyStart": f"{BASE}/identity/nearby/start",
                        "nearbyApprove": f"{BASE}/identity/nearby/approve",
                        "nearbyPoll": f"{BASE}/identity/nearby/poll",
                    },
                },
            },
        }

    def _proof_ok(self, r: httpx.Request, body: Dict[str, Any], purpose: str, value: str, sign_key: Optional[str]) -> bool:
        p = DeviceProof(
            purpose=purpose,
            product=PRODUCT,
            device_id=r.headers["x-pkey-device"],
            value=value,
            token_hash="-",
            sign_key=sign_key or "",
            sig=str(body.get("proof")),
        )
        ok = verify_device_proof(p, now=None)
        if not ok:
            self.proof_failures.append(purpose)
        return ok

    def __call__(self, r: httpx.Request) -> httpx.Response:
        path = r.url.path
        if path.endswith("/.well-known/polaris.json"):
            return httpx.Response(200, json=self.doc())
        body: Dict[str, Any] = json.loads(r.content) if r.content else {}
        name = path.rsplit("/", 1)[-1]
        with self.lock:
            self.calls.append(f"{r.method} {name}")
            if path.endswith("/devices/keys") and r.method == "PUT":
                # M registers its keys (the `keys` proof is checked by its own route in the real Worker).
                self.m_keys = body["signKey"]
                self.m_registered = True
                return httpx.Response(200, json={"keySeq": 1})
            if name == "start":
                if not self._proof_ok(r, body, "nearby-start", f"{body['signKey']}.{body['agreeKey']}", body["signKey"]):
                    return httpx.Response(400, json={"error": {"code": "invalid_grant"}})
                self.next_handle += 1
                handle = "nr_" + str(self.next_handle).rjust(22, "x")
                self.requests[handle] = {
                    "device": r.headers["x-pkey-device"],
                    "signKey": body["signKey"],
                    "agreeKey": body["agreeKey"],
                    "label": body.get("deviceName"),
                    "state": "pending",
                    "bearer": r.headers.get("authorization"),
                }
                return httpx.Response(201, json={"request": handle, "expiresIn": 300, "interval": 3})
            if name == "poll":
                rec = self.requests.get(body.get("request", ""))
                if rec is None:
                    return httpx.Response(200, json={"status": "timeout"})
                if not self._proof_ok(r, body, "nearby-poll", body["request"], rec["signKey"]) or r.headers["x-pkey-device"] != rec["device"]:
                    return httpx.Response(400, json={"error": {"code": "invalid_grant"}})
                if rec["state"] == "denied":
                    return httpx.Response(200, json={"status": "error", "reason": "access_denied"})
                if rec["state"] == "approved":
                    rec["state"] = "collected"
                    return httpx.Response(
                        200,
                        json={
                            "access_token": D_TOKEN,
                            "token_type": "Bearer",
                            "scope": "email",
                            "schemaVersion": 1,
                            "device": {"id": rec["device"]},
                            "license": {"id": "lic_e2e", "name": "Ada", "email": "ada@example.com"},
                            "subject": SUBJECT,
                        },
                    )
                if rec["state"] == "collected":
                    return httpx.Response(200, json={"status": "timeout"})
                return httpx.Response(200, json={"status": "pending"})
            if name == "approve":
                return self._approve(r, body)
            if name == "signout":
                return httpx.Response(200, json={"released": False})
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    def _approve(self, r: httpx.Request, body: Dict[str, Any]) -> httpx.Response:
        if r.headers.get("authorization") != f"Bearer {M_TOKEN}":
            return httpx.Response(403, json={"error": {"code": "account_required"}})
        if not self.m_registered:
            return httpx.Response(409, json={"error": {"code": "device_keys_required"}})
        if not self._proof_ok(r, body, "nearby-approve", body["request"], self.m_keys):
            return httpx.Response(400, json={"error": {"code": "invalid_grant"}})
        rec = self.requests.get(body["request"])
        if (
            rec is None
            or rec["state"] not in ("pending",)
            or rec["device"] != body["deviceId"]
            or rec["signKey"] != body["signKey"]
            or rec["agreeKey"] != body["agreeKey"]
        ):
            return httpx.Response(404, json={"error": {"code": "not_found"}})
        if self.approve_answer is not None and body["decision"] == "approve":
            return self.approve_answer
        if body["decision"] == "deny":
            rec["state"] = "denied"
            return httpx.Response(204)
        if self.choose_first and "choice" not in body:
            return httpx.Response(
                200, json={"status": "choose", "choices": {"state": "choose", "choices": [{"id": "lic_a"}, {"id": "lic_b"}]}}
            )
        rec["state"] = "approved"
        return httpx.Response(200, json={"status": "approved", "deviceLabel": rec["label"]})


class WithOptions:
    """``client.cloud_connect.nearby`` with the fake LAN and loopback passed to every call (a test seam)."""

    def __init__(self, real: Any, net: Network) -> None:
        self._real = real
        self._opts: Dict[str, Any] = dict(mdns=net, **LOOP)

    def request(self, handle: str, **kw: Any) -> Any:
        o = {k: v for k, v in self._opts.items() if k != "host"}
        return self._real.request(handle, **kw, **o)

    def on_request(self, handler: Any, **kw: Any) -> Any:
        return self._real.on_request(handler, **kw, **self._opts)

    def stop_all(self, *a: Any, **k: Any) -> None:
        self._real.stop_all(*a, **k)


class World:
    def __init__(self) -> None:
        self.net = Network()
        self.worker = StubWorker()
        self.m = self._client(token=M_TOKEN, device_id=M_ID)
        self.d = self._client(token=None, device_id=D_ID)
        self.asks: List[NearbyAsk] = []
        self.handles: List[Any] = []
        self.sessions: List[Any] = []

    def _client(self, token: Optional[str], device_id: str) -> Any:
        from polaris_key.devices.store import InMemoryStore

        store = InMemoryStore(PRODUCT)
        if token:
            store.set_token(token)
        c = make_client(
            self.worker,
            store=store,
            expected_services=["license", "config", "identity"],
            device_keys=memory_keys(),
            allow_ephemeral_keys=True,
        )
        c.identity._deps.on_acquired = lambda: None
        c.identity._nearby_runtime = lambda role: True
        c.identity._cloud_nearby = lambda real=c.cloud_connect.nearby: WithOptions(real, self.net)
        if token:
            c.identity._identity = SignedInIdentity(name="Ana", email="ana@example.com")
        return c

    def register_m(self) -> None:
        """M's keys are already registered with the Worker."""
        port, _ = self.m.connect.nearby_signer()
        self.worker.m_keys = port.ensure().sign_key
        self.worker.m_registered = True

    def approve(self, **kw: Any) -> Any:
        h = self.m.identity.nearby.on_request(self.asks.append, prompt=True, label="Ana's laptop", **kw)
        self.handles.append(h)
        return h

    def adverts(self) -> List[Any]:
        return [a for a in list(self.net.adverts.values()) if "m=v" in a.txt]

    def start_d(self, name: str = "New phone") -> Any:
        s = self.d.identity.sign_in.start(channel="nearby", device_name=name)
        self.sessions.append(s)
        return s

    def tap(self, s: Any) -> str:
        """D lists M, the person taps it; return the code D shows once M holds the ask."""
        until(lambda: len(s.approvers) == 1)
        code = s.choose(s.approvers[0].id).code
        until(lambda: len(self.asks) >= 1)
        return code

    def close(self) -> None:
        for s in self.sessions:
            try:
                s.close()
            except Exception:
                pass
        for h in self.handles:
            try:
                h.stop()
            except Exception:
                pass
        for c in (self.m, self.d):
            try:
                c.close()
            except Exception:
                pass


@pytest.fixture
def w() -> Iterator[World]:
    world = World()
    yield world
    world.close()


def match(ask: NearbyAsk, code: str) -> str:
    return next(c for c in ask.codes if c.replace(" ", "") == code.replace(" ", ""))


def poll_until(s: Any, kind: str = "signed_in") -> Any:
    out: List[Any] = []

    def done() -> bool:
        o = s.wait(once=True)
        if o.kind != "pending":
            out.append(o)
            return True
        return False

    until(done, timeout=10)
    assert out[0].kind == kind
    return out[0]


def test_a_full_nearby_sign_in_the_poll_signs_d_in(w: World) -> None:
    w.approve()
    s = w.start_d()
    until(lambda: len(s.approvers) == 1)
    assert s.approvers[0].label == "Ana's laptop"
    code = s.choose(s.approvers[0].id).code
    until(lambda: len(w.asks) == 1)
    ask = w.asks[0]
    assert (ask.device, code.replace(" ", "") in [c.replace(" ", "") for c in ask.codes]) == ("New phone", True)

    # M has registered no keys: the first approve is a 409, M registers once and the retry is approved.
    step = ask.pick(match(ask, code))
    assert step.kind == "approved" and step.device_label == "New phone"
    assert w.worker.calls.count("PUT keys") == 1 and w.worker.proof_failures == []
    until(lambda: s.result == "approved")

    # D is NOT signed in by VOUCH_RESULT: only the poll signs it in.
    assert w.d._tokens.current is None
    o = poll_until(s)
    assert (o.subject, o.identity.email) == (SUBJECT, "ada@example.com")
    assert w.d._tokens.current == D_TOKEN and w.d._tokens.provenance == "signin"
    assert w.d.identity._account.stored_subject() == SUBJECT
    # The handle is the Worker's and was never on the wire between the devices in a form D could misuse.
    assert w.worker.requests[next(iter(w.worker.requests))]["bearer"] is None


def test_a_wrong_pick_calls_no_approve_and_d_stays_pending(w: World) -> None:
    w.approve()
    s = w.start_d()
    code = w.tap(s)
    ask = w.asks[0]
    decoy = next(c for c in ask.codes if c.replace(" ", "") != code.replace(" ", ""))
    assert ask.pick(decoy).kind == "mismatch"
    assert not any(c.endswith("approve") for c in w.worker.calls)
    assert s.wait(once=True).kind == "pending" and w.d._tokens.current is None


def test_none_match_closes_the_session_and_calls_no_route(w: World) -> None:
    w.approve()
    s = w.start_d()
    w.tap(s)
    assert w.asks[0].deny().kind == "denied"
    assert not any(c.endswith("approve") for c in w.worker.calls)
    assert s.wait(once=True).kind == "pending"


def test_a_deny_after_the_matched_code_makes_ds_poll_raise_sign_in_denied(w: World) -> None:
    w.register_m()
    w.approve()
    s = w.start_d()
    code = w.tap(s)
    ask = w.asks[0]
    ask._request = ask._approval.pick(match(ask, code))  # the matched pick, without approving
    assert ask.deny().kind == "denied"
    with pytest.raises(PolarisError) as e:
        until(lambda: s.wait(once=True).kind != "pending", timeout=10)
    assert e.value.code == "sign-in-denied" and w.d._tokens.current is None


def test_the_licence_choice_then_approved(w: World) -> None:
    w.register_m()
    w.worker.choose_first = True
    w.approve()
    s = w.start_d()
    code = w.tap(s)
    step = w.asks[0].pick(match(w.asks[0], code))
    assert step.kind == "choose" and [c["id"] for c in step.choices["choices"]] == ["lic_a", "lic_b"]
    step = step.choose({"kind": "license", "licenseId": "lic_b"})
    assert step.kind == "approved"
    poll_until(s)


def test_not_nearby_is_m_s_screen_and_d_hears_denied(w: World) -> None:
    w.register_m()
    w.worker.approve_answer = httpx.Response(403, json={"error": {"code": "not_nearby"}})
    w.approve()
    s = w.start_d()
    code = w.tap(s)
    assert w.asks[0].pick(match(w.asks[0], code)).kind == "not-nearby"
    until(lambda: s.result == "denied")
    assert s.wait(once=True).kind == "pending" and w.d._tokens.current is None


def test_cancel_closes_d_s_lan_side_so_m_s_session_ends(w: World) -> None:
    w.approve()
    s = w.start_d()
    w.tap(s)
    s.cancel()
    assert s.wait().kind == "cancelled"
    ask = w.asks[0]
    until(lambda: ask.pick(ask.codes[0]).kind in ("mismatch", "expired"))


def test_sign_out_stops_the_approver_and_its_advert(w: World) -> None:
    h = w.approve()
    until(lambda: len(w.adverts()) == 1)
    w.m.identity.sign_out()
    until(lambda: w.adverts() == [])
    assert h.status().state == "stopped"
    with pytest.raises(PolarisError) as e:
        w.approve()
    assert e.value.code in ("account_required", "account-required")


def test_no_secret_is_in_a_repr_on_either_side(w: World) -> None:
    w.approve()
    s = w.start_d()
    code = w.tap(s)
    ask = w.asks[0]
    texts = [repr(s), repr(s.code), repr(ask), repr(w.m.identity), repr(w.d.identity), repr(s.approvers)]
    for t in texts:
        assert code not in t and "nr_" not in t and D_TOKEN not in t and M_TOKEN not in t
