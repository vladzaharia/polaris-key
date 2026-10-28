# @pkey-feature connect.relay
"""Cloud Connect's client side (CC-10.4; WIRE-CONTRACT-V5 §15.3, §15.7): the relay ticket and its grant
checks, the error taxonomy, the peer source snapshot, pushed rosters (``adopt_ring``, ``keys_stale``) and
the private loop. A fake Worker signs real documents with the test product key. No network."""

from __future__ import annotations

import json
import pickle
import sys
import threading
from typing import Any, Dict, Optional

import httpx
import pytest
from helpers import PRODUCT, make_client
from test_connect_identity import FakeWorker, _b, _tokened, other_device

from polaris_key import PolarisError
from polaris_key.connect.errors import LAN_CODE, RELAY_CODE, LanError, RelayError
from polaris_key.connect.loop import ConnectLoop
from polaris_key.connect.state import ConnectStateRecord, keys_after_ring, parse_connect_state
from polaris_key.constants_generated import ERROR_CODE_VALUES

TICKET = "pkeyrt_" + "A" * 32


class RelayWorker(FakeWorker):
    """The identity Worker plus ``POST connect/relay/ticket``."""

    def __init__(self, *, now: int) -> None:
        super().__init__(now=now)
        self.mode = "ok"
        self.url = "wss://key.example/" + PRODUCT + "/connect/relay"
        self.body_override: Optional[Any] = None
        self.asked = 0

    def __call__(self, r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("/connect/relay/ticket"):
            self.requests.append(r)
            self.asked += 1
            m = self.mode
            if m == "disabled":
                return httpx.Response(403, json={"error": {"code": "relay_disabled"}})
            if m == "paused":
                return httpx.Response(503, json={"error": {"code": "relay_paused"}}, headers={"retry-after": "300"})
            if m in ("quota-person", "quota-product"):
                return httpx.Response(
                    429, json={"error": {"code": "relay_quota_exceeded"}, "scope": m.split("-")[1]}
                )
            if m == "invalid":
                return httpx.Response(401, json={"error": {"code": "relay_ticket_invalid"}})
            if m == "boom":
                return httpx.Response(500, json={"error": {"code": "misconfigured"}})
            body = self.body_override or {
                "ticket": TICKET,
                "url": self.url,
                "protocol": "pkey-relay.1",
                "expiresAt": self.now + 60,
            }
            return httpx.Response(200, json=body)
        return super().__call__(r)


@pytest.fixture
def worker() -> RelayWorker:
    import time

    return RelayWorker(now=int(time.time()))


def device(w: RelayWorker, tmp_path, **kw: Any):
    kw.setdefault("store", _tokened())
    kw.setdefault("state_dir", str(tmp_path))
    kw.setdefault("expected_services", ["license", "config", "connect"])
    return make_client(w, **kw)


# ── The ticket ───────────────────────────────────────────────────────────────────────────────


def test_the_ticket_is_a_pkeyrt_for_the_workers_own_wss_host(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    g = c.connect.relay_ticket()
    assert g.url == f"wss://key.example/{PRODUCT}/connect/relay" and g.protocol == "pkey-relay.1"
    assert g.ticket == TICKET and g.expires_at == worker.now + 60
    req = [r for r in worker.requests if r.url.path.endswith("/relay/ticket")][0]
    assert req.method == "POST" and req.headers["authorization"].startswith("Bearer ")
    # Every call asks for a new ticket.
    c.connect.relay_ticket()
    assert worker.asked == 2


def test_the_ticket_is_in_no_repr_or_pickle(worker, tmp_path) -> None:
    g = device(worker, tmp_path).connect.relay_ticket()
    assert TICKET not in repr(g) and TICKET not in str(g)
    with pytest.raises(TypeError):
        pickle.dumps(g)


@pytest.mark.parametrize(
    "url",
    [
        "wss://evil.test/djdl/connect/relay",
        "ws://key.example/djdl/connect/relay",
        "https://key.example/djdl/connect/relay",
        "wss://key.example:444/djdl/connect/relay",
        "not a url",
    ],
)
def test_a_grant_for_another_host_or_scheme_is_refused(worker, tmp_path, url) -> None:
    worker.url = url
    with pytest.raises(RelayError) as e:
        device(worker, tmp_path).connect.relay_ticket()
    assert e.value.reason == "ticket_invalid" and e.value.code == "relay_ticket_invalid"
    assert TICKET not in str(e.value)


@pytest.mark.parametrize(
    "patch",
    [
        {"ticket": "pkeyrt_short"},
        {"ticket": "nope_" + "A" * 32},
        {"ticket": "pkeyrt_" + "A" * 33},
        {"ticket": 5},
        {"protocol": "pkey-relay.2"},
        {"expiresAt": "soon"},
        {"expiresAt": True},
        {"expiresAt": 1.5},
        {"url": None},
    ],
)
def test_a_grant_not_in_the_contract_shape_is_refused(worker, tmp_path, patch) -> None:
    worker.body_override = {
        "ticket": TICKET,
        "url": worker.url,
        "protocol": "pkey-relay.1",
        "expiresAt": worker.now + 60,
        **patch,
    }
    with pytest.raises(RelayError) as e:
        device(worker, tmp_path).connect.relay_ticket()
    assert e.value.reason == "ticket_invalid"


def test_a_body_that_is_not_an_object_is_refused(worker, tmp_path) -> None:
    worker.body_override = ["x"]
    with pytest.raises(RelayError):
        device(worker, tmp_path).connect.relay_ticket()


def test_the_refusals_are_typed(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    worker.mode = "disabled"
    with pytest.raises(RelayError) as e:
        c.connect.relay_ticket()
    assert (e.value.reason, e.value.code, e.value.status) == ("disabled", "relay_disabled", 403)
    worker.mode = "paused"
    with pytest.raises(RelayError) as e:
        c.connect.relay_ticket()
    assert (e.value.reason, e.value.code, e.value.retry_after_seconds, e.value.status) == (
        "paused",
        "relay_paused",
        300,
        503,
    )
    for scope in ("person", "product"):
        worker.mode = "quota-" + scope
        with pytest.raises(RelayError) as e:
            c.connect.relay_ticket()
        assert (e.value.reason, e.value.scope, e.value.code) == ("quota", scope, "relay_quota_exceeded")
    worker.mode = "invalid"
    with pytest.raises(RelayError) as e:
        c.connect.relay_ticket()
    assert e.value.reason == "ticket_invalid"
    # Any other failure is the SDK's ordinary error, not a RelayError.
    worker.mode = "boom"
    with pytest.raises(PolarisError) as e2:
        c.connect.relay_ticket()
    assert not isinstance(e2.value, RelayError) and e2.value.code == "server-error"


def test_no_token_refuses_before_any_request(worker, tmp_path) -> None:
    from polaris_key.devices.store import InMemoryStore

    c = device(worker, tmp_path, store=InMemoryStore(PRODUCT, device_id="NOTOKENDEVICE" + "0" * 19))
    with pytest.raises(PolarisError) as e:
        c.connect.relay_ticket()
    assert e.value.code == "no-token" and worker.asked == 0


# ── The taxonomy ─────────────────────────────────────────────────────────────────────────────


def test_every_reason_carries_a_registered_code() -> None:
    for table in (LAN_CODE, RELAY_CODE):
        for reason, code in table.items():
            assert code in ERROR_CODE_VALUES, (reason, code)
    assert LanError("wrong_peer", "x").code == "peer-cert-invalid"
    assert RelayError("not_connected", "x").code == "connect-unavailable"
    assert isinstance(LanError("closed", "x"), PolarisError) and isinstance(RelayError("stopped", "x"), PolarisError)
    with pytest.raises(ValueError):
        LanError("nope", "x")
    with pytest.raises(ValueError):
        RelayError("nope", "x")


def test_the_errors_survive_a_pickle() -> None:
    e = pickle.loads(pickle.dumps(RelayError("quota", "m", scope="person", retry_after_seconds=3, status=429)))
    assert (e.reason, e.scope, e.retry_after_seconds, e.status, e.code) == ("quota", "person", 3, 429, e.code)
    assert pickle.loads(pickle.dumps(LanError("closed", "m", close_code="peer_bye"))).close_code == "peer_bye"


# ── The peer source ──────────────────────────────────────────────────────────────────────────


def test_peer_source_needs_an_identity(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    with pytest.raises(LanError) as e:
        c.connect.peer_source()
    assert e.value.reason == "no_identity" and e.value.code == "not-configured"


def test_peer_source_is_a_snapshot_of_the_held_identity(worker, tmp_path) -> None:
    worker.others = [other_device(2)]
    worker.disc = [_b(1), _b(2)]
    c = device(worker, tmp_path)
    ident = c.connect.identity()
    src = c.connect.peer_source()
    assert src.slug == PRODUCT and src.sub == ident.sub and src.device_id == ident.device_id
    assert src.cert_jws == ident.certificate and src.ring_jws == ident.ring and src.ring_epoch == ident.epoch
    assert src.cert_expires_at == ident.certificate_expires_at
    assert set(src.roster) == {d.device_id for d in ident.devices} and len(src.roster) == 2
    assert src.keys.previous is not None and src.keys.current != src.keys.previous
    mine = [d for d in ident.devices if d.device_id == ident.device_id][0]
    from polaris_key.core.b64url import b64url_encode

    assert b64url_encode(src.agree_public) == mine.agree_key
    assert src.static_key.public_key() == src.agree_public
    # The static key works as a Noise static: a DH with a peer's public key, the private half unseen.
    peer = other_device(3)
    from polaris_key.core.b64url import b64url_decode

    out = src.static_key.dh(b64url_decode(peer["agreeKey"]))
    assert out is not None and len(out) == 32


def test_peer_source_has_no_repr_or_pickle_of_secrets(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    ident = c.connect.identity()
    src = c.connect.peer_source()
    for text in (repr(src), str(src), repr(src.keys), repr(src.static_key)):
        assert ident.certificate not in text and ident.ring not in text and worker.disc[0] not in text
    for obj in (src, src.keys, src.static_key):
        with pytest.raises(TypeError):
            pickle.dumps(obj)


# ── Pushed rosters ───────────────────────────────────────────────────────────────────────────


def _pushed(worker: RelayWorker, c: Any, epoch: int, others: Any = ()) -> str:
    """The roster the Worker would sign at ``epoch`` with these other devices, for this device."""
    held = c.connect.current()
    me = (held if held is not None else c.connect.identity()).device_id
    saved = (worker.epoch, worker.others)
    worker.epoch, worker.others = epoch, list(others)
    try:
        return worker.ring(me)
    finally:
        worker.epoch, worker.others = saved


def test_adopt_ring_without_an_identity(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    r = c.connect.adopt_ring("x.y.z")
    assert (r.stored, r.reason) == (False, "no_identity")


def test_a_higher_epoch_roster_is_stored_and_a_join_keeps_the_previous_key(worker, tmp_path) -> None:
    worker.disc = [_b(1), _b(2)]
    c = device(worker, tmp_path)
    c.connect.identity()
    jws = _pushed(worker, c, 2, [other_device(2)])
    r = c.connect.adopt_ring(jws)
    assert (r.stored, r.epoch) == (True, 2)
    ident = c.connect.current()
    assert ident is not None and ident.epoch == 2 and len(ident.devices) == 2
    keys = c.connect.discovery_keys()
    assert keys is not None and keys.previous is not None
    # Nothing was fetched for it, and the held certificate (at epoch 1) is still the one stored.
    assert worker.count("GET", "/connect/identity") == 1


def test_a_stale_foreign_or_unverified_roster_is_refused_and_nothing_changes(worker, tmp_path) -> None:
    worker.epoch = 5
    c = device(worker, tmp_path)
    c.connect.identity()
    before = c.connect.current()
    assert before is not None
    for jws, why in (
        (_pushed(worker, c, 5), "epoch-not-higher"),
        (_pushed(worker, c, 4), "epoch-not-higher"),
        ("a.b.c", "new-rejected"),
    ):
        r = c.connect.adopt_ring(jws)
        assert (r.stored, r.reason) == (False, why)
    worker.sub = "ps_ZyXwVuTsRqPoNmLkJiHgFe"
    r = c.connect.adopt_ring(_pushed(worker, c, 9))
    assert r.stored is False and r.reason == "other-product-or-subject"
    after = c.connect.current()
    assert after is not None and after.ring == before.ring and after.epoch == 5


def test_a_roster_that_drops_this_device_is_refused(worker, tmp_path) -> None:
    c = device(worker, tmp_path)
    c.connect.identity()
    me = c.connect.current().device_id  # type: ignore[union-attr]
    worker.skip_self_in_ring = True
    worker.others = [other_device(2)]
    worker.epoch = 2
    r = c.connect.adopt_ring(worker.ring(me))
    assert (r.stored, r.reason) == (False, "device_not_in_roster")


def test_a_roster_without_a_device_marks_k_disc_stale_until_a_fetch(worker, tmp_path) -> None:
    d1, d2 = other_device(1), other_device(2, "p" * 32)
    worker.others = [d1, d2]
    worker.disc = [_b(1), _b(2)]
    c = device(worker, tmp_path)
    c.connect.identity()
    assert c.connect.discovery_keys() is not None
    r = c.connect.adopt_ring(_pushed(worker, c, 2, [d1]))
    assert r.stored is True
    # The previous key went with the device, and the copy is not used until a fetch.
    assert c.connect.discovery_keys() is None
    with pytest.raises(LanError) as e:
        c.connect.peer_source()
    assert e.value.reason == "no_keys"
    # The stale mark stays through a second pushed roster, and survives a reload from disk.
    assert c.connect.adopt_ring(_pushed(worker, c, 3, [d1])).stored is True
    assert c.connect.discovery_keys() is None
    # identity() fetches again even though the held identity looks fresh, and clears the mark.
    worker.epoch, worker.others, worker.disc = 4, [d1], [_b(3)]
    n = worker.count("GET", "/connect/identity")
    assert c.connect.identity().epoch == 4
    assert worker.count("GET", "/connect/identity") == n + 1
    assert c.connect.discovery_keys() is not None
    c.connect.peer_source()


def test_the_state_record_round_trips_keys_stale() -> None:
    rec = ConnectStateRecord("p", "d", "r", "c", ["A" * 43], None, 1, ("s", "a"), 5, keys_stale=True)
    assert json.loads(rec.to_bytes())["keysStale"] is True
    parsed = parse_connect_state(rec.to_bytes())
    assert parsed is not None and parsed.keys_stale is True
    plain = ConnectStateRecord("p", "d", "r", "c", ["A" * 43], None, 1, None, 5)
    assert "keysStale" not in json.loads(plain.to_bytes())
    parsed = parse_connect_state(plain.to_bytes())
    assert parsed is not None and parsed.keys_stale is False


def test_keys_after_ring() -> None:
    class D:
        def __init__(self, i: str, s: str = "s", a: str = "a") -> None:
            self.device_id, self.sign_key, self.agree_key = i, s, a

    class R:
        def __init__(self, *d: D) -> None:
            self.devices = d

    keys = ["k1", "k2"]
    assert keys_after_ring(keys, R(D("1")), R(D("1"), D("2"))) == keys
    assert keys_after_ring(keys, R(D("1"), D("2")), R(D("1"))) == ["k1"]
    assert keys_after_ring(keys, R(D("1")), R(D("1", s="other"))) == ["k1"]
    assert keys_after_ring(["k1"], R(D("1")), R()) == ["k1"]


# ── The loop ─────────────────────────────────────────────────────────────────────────────────


def test_importing_connect_starts_no_thread_and_no_loop() -> None:
    import subprocess

    code = (
        "import threading, sys\n"
        "import polaris_key.connect.loop as m\n"
        "assert 'asyncio' not in sys.modules\n"
        "assert threading.active_count() == 1\n"
        "assert not m.connect_loop().running\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True)


def test_the_loop_runs_a_coroutine_on_one_daemon_thread_and_closes() -> None:
    import asyncio

    loop = ConnectLoop()
    assert not loop.running

    async def who() -> str:
        await asyncio.sleep(0)
        return threading.current_thread().name

    names = {loop.submit(who()).result(5) for _ in range(3)}
    assert names == {"polaris-key-connect"} and loop.running
    t = loop._thread  # this loop's own thread (the shared loop may be running too)
    assert t is not None
    assert t.daemon

    async def boom() -> None:
        raise ValueError("x")

    with pytest.raises(ValueError):
        loop.submit(boom()).result(5)
    seen: Dict[str, str] = {}
    done = threading.Event()

    def cb() -> None:
        seen["t"] = threading.current_thread().name
        done.set()

    loop.call_soon(cb)
    assert done.wait(5) and seen["t"] == "polaris-key-connect"
    loop.close()
    assert not loop.running and not t.is_alive()
    loop.close()
    # A closed loop starts a fresh thread on the next use.
    assert loop.submit(who()).result(5) == "polaris-key-connect"
    loop.close()


def test_closing_cancels_what_is_still_running() -> None:
    import asyncio

    loop = ConnectLoop()
    cancelled = threading.Event()

    async def forever() -> None:
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    loop.submit(forever())
    import time

    time.sleep(0.05)
    loop.close()
    assert cancelled.is_set()
