# @pkey-feature connect.lan
"""Nearby approval, end to end in one process (CC-15.P4; WIRE-CONTRACT-V5 §15.6.1): a signed-in client M and
a client D with no sign-in meet on a fake LAN through ``client.cloud_connect.nearby``. D lists M, the person
taps it, the codes match, D's ``VOUCH_REQ`` is verified, M "calls approve" on a fake that holds the
key-binding rule (the Worker half is I-40 and I-47's), ``approved`` reaches D and the wrap is delivered once
D's person confirms the account. Also: the gating by Identity discovery with Connect off, a wrong pick,
sign-out stopping the advert, and the races of a sign-out against a start. Mirrors Node's
``nearby.e2e.test.ts``."""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Iterator, List, Optional, Tuple

import httpx
import pytest
from helpers import PRODUCT, TOKEN, discovery_doc, make_client
from nearby_fixtures import REQUEST, SLUG, T0, FakeNearbyWorker, memory_keys, settle, until
from test_connect_lan import Network

from polaris_key.connect.nearby import CloudNearby, NearbyApproval, NearbyDeps
from polaris_key.core.caps import UnsupportedError
from polaris_key.core.errors import PolarisError
from polaris_key.core.peer_nearby import ApproveAnswerInput
from polaris_key.devices.keys import DeviceKeyStore, InMemoryDeviceKeyStorage
from polaris_key.devices.store import InMemoryStore
from polaris_key.identity.sign_in import SignedInIdentity

LOOP: Dict[str, Any] = {"host": "127.0.0.1", "allow_loopback": True}
D_ID = "NEARBYDEVICE".ljust(31, "0") + "D"
FRAGMENT = {
    "enabled": True,
    "configured": True,
    "nearby": True,
    "endpoints": {"nearbyStart": "u", "nearbyApprove": "u", "nearbyPoll": "u"},
}


class Device:
    """One side of the facade, with its client's reads faked."""

    def __init__(self, device_id: str, *, signed_in: bool, fragment: Optional[Dict[str, Any]] = FRAGMENT) -> None:
        self.keys = memory_keys()
        self.device_id = device_id
        self.signed_in = signed_in
        self.fragment = fragment
        self.identity_gate: Optional[threading.Event] = None
        self.reads = 0

        def identity(fresh: bool) -> Optional[Dict[str, Any]]:
            self.reads += 1
            if self.identity_gate is not None:
                self.identity_gate.wait(5)
            return self.fragment

        self.nearby = CloudNearby(
            NearbyDeps(
                slug=SLUG,
                now=lambda: T0,
                require_identity=lambda: None,
                identity=identity,
                signed_in=lambda: self.signed_in,
                signer=lambda: (self.keys, self.device_id),
            )
        )


class World:
    def __init__(self) -> None:
        self.net = Network()
        self.fake = FakeNearbyWorker()
        self.m = Device("MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM", signed_in=True)
        self.d = Device(D_ID, signed_in=False)
        self.handles: List[Any] = []
        self.requests: List[Any] = []
        self.approvals: List[NearbyApproval] = []

    def approve(self, dev: Optional[Device] = None, **kw: Any) -> Any:
        o: Dict[str, Any] = dict(prompt=True, label="Ana's laptop", mdns=self.net, **LOOP)
        o.update(kw)
        h = (dev or self.m).nearby.on_request(self.approvals.append, **o)
        self.handles.append(h)
        return h

    def ask(self) -> Any:
        self.fake.register(REQUEST, self.d.keys, self.d.device_id)
        r = self.d.nearby.request(
            REQUEST, label="New phone", mdns=self.net, allow_loopback=True  # type: ignore[arg-type]
        )
        self.requests.append(r)
        return r

    def adverts(self) -> List[Any]:
        return [a for a in list(self.net.adverts.values()) if "m=v" in a.txt]

    def close(self) -> None:
        for r in self.requests:
            try:
                r.close()
            except Exception:
                pass
        for h in self.handles:
            try:
                h.stop()
            except Exception:
                pass
        for dev in (self.m, self.d):
            dev.nearby.stop_all(1.0)


@pytest.fixture
def w() -> Iterator[World]:
    world = World()
    yield world
    world.close()


def showing(a: NearbyApproval, code: str) -> str:
    return next(c for c in a.codes if c.replace(" ", "") == code.replace(" ", ""))


# -- a full vouch ---------------------------------------------------------------------------------


def test_runs_a_full_vouch_with_connect_off_list_tap_codes_pick_approve_result_wrap(w: World) -> None:
    w.fake.m_has_keys = False
    w.approve()
    r = w.ask()
    until(lambda: len(r.approvers) == 1)
    assert r.approvers[0].label == "Ana's laptop"

    code = r.choose(r.approvers[0].id).code
    until(lambda: len(w.approvals) == 1)
    a = w.approvals[0]
    assert code.replace(" ", "") in [c.replace(" ", "") for c in a.codes]

    req = a.pick(showing(a, code))
    assert not isinstance(req, str)
    assert req.device_id == D_ID

    # The first approve answers device_keys_required: M registers its keys, then asks once more.
    http, body = w.fake.approve(req)
    assert http == 409
    assert a.finish(ApproveAnswerInput(http, body, True)).wait == "keys"
    w.fake.m_has_keys = True
    http, body = w.fake.approve(req)
    assert all(c[1] == D_ID for c in w.fake.calls)
    assert a.finish(ApproveAnswerInput(http, body, True)).sent == "approved"
    until(lambda: r.result == "approved")

    # The wrap is delivered only after D's person confirms the signed-in account.
    got: List[int] = []
    r.on_record(lambda x: got.append(x.type))
    a.send_record(0x0030, bytes([7]))
    settle()
    assert got == []
    r.confirm_account()
    assert got == [0x0030]
    assert w.fake.approved == [D_ID]


def test_a_wrong_pick_calls_no_route_and_delivers_nothing(w: World) -> None:
    w.approve()
    r = w.ask()
    until(lambda: len(r.approvers) == 1)
    code = r.choose(r.approvers[0].id).code
    until(lambda: len(w.approvals) == 1)
    a = w.approvals[0]
    decoy = next(c for c in a.codes if c.replace(" ", "") != code.replace(" ", ""))
    assert a.pick(decoy) == "mismatch"
    until(lambda: len(r.approvers) == 0 and r.result is None)
    assert w.fake.calls == [] and r.result is None


def test_sign_out_stops_the_advert_and_the_sessions(w: World) -> None:
    w.approve()
    assert len(w.adverts()) == 1
    r = w.ask()
    until(lambda: len(r.approvers) == 1)
    closes: List[str] = []
    r.on_close(closes.append)
    r.choose(r.approvers[0].id)
    until(lambda: len(w.approvals) == 1)
    w.m.nearby.stop_all()
    until(lambda: w.adverts() == [])
    until(lambda: len(closes) == 1)
    assert closes == ["peer_bye"]


# -- gating ---------------------------------------------------------------------------------------


def test_answers_the_typed_n_a_when_discovery_does_not_name_nearby(w: World) -> None:
    w.m.fragment = dict(FRAGMENT, nearby=None)
    w.d.fragment = None
    with pytest.raises(UnsupportedError) as e:
        w.approve()
    assert e.value.code == "service-unavailable" and e.value.feature == "identity.nearby"
    with pytest.raises(UnsupportedError) as e2:
        w.ask()
    assert e2.value.code == "service-unavailable" and e2.value.feature == "identity.nearby"


def test_a_missing_endpoint_is_the_same_n_a(w: World) -> None:
    w.m.fragment = dict(FRAGMENT, endpoints={"nearbyStart": "u"})
    with pytest.raises(UnsupportedError):
        w.approve()


def test_refuses_to_approve_while_signed_out(w: World) -> None:
    with pytest.raises(PolarisError) as e:
        w.approve(w.d)
    assert e.value.code == "account_required" or e.value.code == "account-required"


def test_a_client_with_no_nearby_deps_answers_nearby_unsupported() -> None:
    n = CloudNearby(None)
    with pytest.raises(UnsupportedError) as e:
        n.request(REQUEST)
    assert e.value.code == "nearby-unsupported" and e.value.reason == "runtime"
    n.stop_all()


def test_a_bad_request_is_refused_before_anything_starts(w: World) -> None:
    from polaris_key.connect.errors import LanError

    with pytest.raises(LanError) as e:
        w.d.nearby.request("nr_short", mdns=w.net, allow_loopback=True)  # type: ignore[arg-type]
    assert e.value.code == "invalid-argument"


# -- sign-out reaches every handle (B1, B2) -------------------------------------------------------


def test_a_stop_all_that_lands_while_on_request_is_still_starting_leaves_no_advert(w: World) -> None:
    gate = threading.Event()
    w.m.identity_gate = gate
    box: Dict[str, Any] = {}

    def go() -> None:
        try:
            box["h"] = w.m.nearby.on_request(w.approvals.append, prompt=True, mdns=w.net, **LOOP)
        except BaseException as e:  # noqa: BLE001
            box["e"] = e

    t = threading.Thread(target=go)
    t.start()
    until(lambda: w.m.reads >= 1)
    # The sign-out lands before the start resolved.
    w.m.nearby.stop_all()
    gate.set()
    t.join(5)
    assert "h" not in box and isinstance(box["e"], PolarisError)
    assert box["e"].code in ("account_required", "account-required") and w.adverts() == []


def test_a_stop_all_that_lands_after_the_advert_started_still_stops_it(w: World) -> None:
    box: Dict[str, Any] = {}
    reads = [0]
    real = w.m.nearby._deps.signed_in  # type: ignore[union-attr]
    gate = threading.Event()

    def signed_in() -> bool:
        reads[0] += 1
        if reads[0] == 2:  # the read after the advert is up
            gate.wait(5)
        return real()

    w.m.nearby._deps.signed_in = signed_in  # type: ignore[union-attr]

    def go() -> None:
        try:
            box["h"] = w.m.nearby.on_request(w.approvals.append, prompt=True, mdns=w.net, **LOOP)
        except BaseException as e:  # noqa: BLE001
            box["e"] = e

    t = threading.Thread(target=go)
    t.start()
    until(lambda: reads[0] >= 2)
    until(lambda: len(w.adverts()) == 1)
    w.m.nearby.stop_all()
    gate.set()
    t.join(5)
    assert "e" in box and "h" not in box
    until(lambda: w.adverts() == [])


def test_a_stop_all_that_lands_while_request_is_starting_closes_the_request(w: World) -> None:
    gate = threading.Event()
    w.d.identity_gate = gate
    w.fake.register(REQUEST, w.d.keys, w.d.device_id)
    box: Dict[str, Any] = {}

    def go() -> None:
        try:
            box["r"] = w.d.nearby.request(REQUEST, mdns=w.net, allow_loopback=True)  # type: ignore[arg-type]
        except BaseException as e:  # noqa: BLE001
            box["e"] = e

    t = threading.Thread(target=go)
    t.start()
    until(lambda: w.d.reads >= 1)
    w.d.nearby.stop_all()
    gate.set()
    t.join(5)
    assert "r" not in box and "e" in box


def test_the_handle_of_a_stopped_approver_cannot_pause_or_resume_the_advert_back(w: World) -> None:
    h = w.approve()
    w.m.nearby.stop_all()
    until(lambda: w.adverts() == [])
    h.pause()
    h.resume()
    h.reopen()
    h.set_prompt(False)
    h.set_prompt(True)
    settle()
    assert w.adverts() == [] and h.status().state == "stopped"


def test_sign_out_closes_the_sessions_even_when_the_adverts_stop_hangs(w: World) -> None:
    base = w.net

    class Hanging:
        async def advertise(self, a: Any) -> Any:
            import asyncio

            await base.advertise(a)

            class H:
                async def stop(self) -> None:
                    called.append(1)
                    await asyncio.Event().wait()

            return H()

        async def browse(self, *a: Any, **k: Any) -> Any:
            return await base.browse(*a, **k)

    called: List[int] = []
    h = w.m.nearby.on_request(w.approvals.append, prompt=True, mdns=Hanging(), **LOOP)  # type: ignore[arg-type]
    w.handles.append(h)
    r = w.ask()
    until(lambda: len(r.approvers) == 1)
    closes: List[str] = []
    r.on_close(closes.append)
    r.choose(r.approvers[0].id)
    until(lambda: len(w.approvals) == 1)
    t0 = time.monotonic()
    w.m.nearby.stop_all(0.3)
    assert time.monotonic() - t0 < 3
    until(lambda: len(closes) == 1)
    assert h.status().state == "stopped"


def test_force_stop_works_from_another_thread_while_the_loop_is_held(w: World) -> None:
    w.approve()
    r = w.ask()
    until(lambda: len(r.approvers) == 1)
    r.choose(r.approvers[0].id)
    until(lambda: len(w.approvals) == 1)
    w.m.nearby.force_stop()
    w.d.nearby.force_stop()
    until(lambda: w.adverts() == [])


def test_a_blocking_call_from_a_callback_is_refused_not_deadlocked(w: World) -> None:
    errs: List[BaseException] = []

    def handler(a: NearbyApproval) -> None:
        try:
            a.decline()
        except BaseException as e:  # noqa: BLE001
            errs.append(e)

    h = w.m.nearby.on_request(handler, prompt=True, mdns=w.net, **LOOP)  # type: ignore[arg-type]
    w.handles.append(h)
    r = w.ask()
    until(lambda: len(r.approvers) == 1)
    r.choose(r.approvers[0].id)
    until(lambda: len(errs) == 1)
    assert isinstance(errs[0], RuntimeError)


# -- the real client ------------------------------------------------------------------------------


def _client(*, nearby: bool, signed_in: bool) -> Any:
    doc = discovery_doc(identity=True)
    ident: Dict[str, Any] = {"enabled": True, "configured": True}
    if nearby:
        ident["nearby"] = True
    ident["endpoints"] = {
        "nearbyStart": "https://key.example/%s/identity/nearby/start" % PRODUCT,
        "nearbyApprove": "https://key.example/%s/identity/nearby/approve" % PRODUCT,
        "nearbyPoll": "https://key.example/%s/identity/nearby/poll" % PRODUCT,
    }
    doc["services"]["identity"] = ident

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/.well-known/polaris.json"):
            return httpx.Response(200, json=doc)
        return httpx.Response(404, json={"code": "not_found"})

    st = InMemoryStore(PRODUCT)
    if signed_in:
        st.set_token(TOKEN)
    c = make_client(
        handler,
        store=st,
        device_keys=DeviceKeyStore(InMemoryDeviceKeyStorage()),
        allow_ephemeral_keys=True,
    )
    if signed_in:
        c.identity._store_identity(SignedInIdentity(name="Ana", email="ana@example.test"))
    return c


def test_the_real_client_runs_nearby_with_connect_off_and_the_sign_out_hook_stops_it() -> None:
    net = Network()
    m, d = _client(nearby=True, signed_in=True), _client(nearby=True, signed_in=False)
    try:
        assert m.core.enabled("connect") is False
        approvals: List[NearbyApproval] = []
        h = m.cloud_connect.nearby.on_request(approvals.append, prompt=True, label="Ana", mdns=net, **LOOP)
        assert h.status().state == "advertising"
        fake = FakeNearbyWorker()
        keys, device_id = d.connect.nearby_signer()
        fake.register(REQUEST, keys, device_id)
        r = d.cloud_connect.nearby.request(REQUEST, label="New phone", mdns=net, allow_loopback=True)
        until(lambda: len(r.approvers) == 1)
        r.choose(r.approvers[0].id)
        until(lambda: len(approvals) == 1)
        # The before-sign-out hook (G18): Connect first, then the nearby adverts and requests.
        m._stop_cloud_connect()
        until(lambda: [a for a in list(net.adverts.values()) if "m=v" in a.txt] == [])
        assert h.status().state == "stopped"
        d.close()
        until(lambda: r.closed)
    finally:
        m.close()
        d.close()


def test_the_real_client_answers_the_typed_n_a_when_discovery_names_no_nearby() -> None:
    net = Network()
    m = _client(nearby=False, signed_in=True)
    try:
        with pytest.raises(UnsupportedError) as e:
            m.cloud_connect.nearby.on_request(lambda a: None, prompt=True, mdns=net, **LOOP)
        assert e.value.code == "service-unavailable" and e.value.feature == "identity.nearby"
    finally:
        m.close()


def test_the_real_client_refuses_a_signed_out_approver() -> None:
    net = Network()
    d = _client(nearby=True, signed_in=False)
    try:
        with pytest.raises(PolarisError) as e:
            d.cloud_connect.nearby.on_request(lambda a: None, prompt=True, mdns=net, **LOOP)
        assert e.value.code in ("account_required", "account-required")
    finally:
        d.close()


def test_the_async_client_mirrors_nearby_as_coroutines() -> None:
    import asyncio

    from polaris_key.aio import AsyncPolarisKeyClient

    async def go() -> Tuple[str, int]:
        net = Network()
        m = _client(nearby=True, signed_in=True)
        d = _client(nearby=True, signed_in=False)
        am, ad = AsyncPolarisKeyClient(m), AsyncPolarisKeyClient(d)
        approvals: List[NearbyApproval] = []
        h = await am.cloud_connect.nearby.on_request(approvals.append, prompt=True, mdns=net, **LOOP)
        keys, device_id = d.connect.nearby_signer()
        fake = FakeNearbyWorker()
        fake.register(REQUEST, keys, device_id)
        r = await ad.cloud_connect.nearby.request(REQUEST, mdns=net, allow_loopback=True)
        for _ in range(200):
            if r.approvers:
                break
            await asyncio.sleep(0.02)
        choice = await r.choose(r.approvers[0].id)
        await h.stop()
        await r.close()
        await asyncio.to_thread(m.close)
        await asyncio.to_thread(d.close)
        return choice.code, len(approvals)

    code, _n = asyncio.run(go())
    assert len(code.replace(" ", "")) == 6
