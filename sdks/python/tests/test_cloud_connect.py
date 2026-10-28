# @pkey-feature connect.app
"""``client.cloud_connect`` (CC-10.15; WIRE-CONTRACT-V5 §15): LAN first then relay, the relay's off switches
(host, product, no ticket endpoint: G21), inbound sessions with no listener (G9), the sign-out order (G18) and
the asyncio mirror. Two facades over a fake mDNS network and the in-process relay room; real TCP on 127.0.0.1.
Mirrors the facade half of Node's ``relay.test.ts`` and ``cloudConnect`` tests."""

from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest
from connect_relay_fake import FakeRoom, ManualSleep
from test_connect_lan import Network, World, run, until
from test_connect_peer_session import ID_A, ID_B, NOW

import polaris_key.connect.cloud_connect as cc_mod
from polaris_key.aio import _AsyncCloudConnect
from polaris_key.connect.channel import ConnectNotice
from polaris_key.connect.client import RingAdoption
from polaris_key.connect.cloud_connect import CloudConnect, CloudPeer, relay_wanted
from polaris_key.connect.errors import LanError, RelayError
from polaris_key.connect.loop import ConnectLoop
from polaris_key.core.errors import PolarisError

PING = 1000.0


class FakeConnect:
    """The slice of ``ConnectClient`` the facade uses."""

    def __init__(self, world: World, dev: Any, room: FakeRoom, *, fail_identity: Optional[Exception] = None) -> None:
        self._w = world
        self._dev = dev
        self.room = room
        self.fail_identity = fail_identity
        self.identity_calls = 0
        self.leaves = 0
        self.refreshed = 0

    def identity(self, *, refresh: bool = False) -> Any:
        if self.fail_identity is not None:
            raise self.fail_identity
        self.identity_calls += 1
        if refresh:
            self.refreshed += 1
        return SimpleNamespace(device_id=self._dev.id)

    def peer_source(self) -> Any:
        return self._w.source(self._dev).load()

    def adopt_ring(self, jws: str) -> RingAdoption:
        return RingAdoption(False, None, "stale")

    def relay_ticket(self) -> Any:
        return self.room.issue(self._dev.id)

    def list_devices(self) -> List[Any]:
        return [SimpleNamespace(device_id=ID_A), SimpleNamespace(device_id=ID_B)]

    def leave(self) -> None:
        self.leaves += 1


class Rig:
    def __init__(self, discovery: Any = None) -> None:
        self.world = World()
        self.room = FakeRoom({ID_A, ID_B})
        self.net = Network()
        self.discovery = discovery
        self.opener_calls: List[bool] = []
        self.all: List[CloudConnect] = []

        async def opener(url: str, protocols: List[str]) -> Any:
            self.opener_calls.append(bool(self.net.adverts))  # was the LAN already up?
            return await self.room.opener(url, protocols)

        self.opener = opener

    def make(self, dev: Any, **kw: Any) -> CloudConnect:
        fake = FakeConnect(self.world, dev, self.room, **{k: kw.pop(k) for k in list(kw) if k == "fail_identity"})
        cc = CloudConnect(fake, lambda: self.discovery, now=lambda: NOW)  # type: ignore[arg-type]
        cc.fake = fake  # type: ignore[attr-defined]
        self.all.append(cc)
        return cc

    def options(self, *, lan: Any = True, relay: Any = True, **extra: Any) -> Dict[str, Any]:
        o: Dict[str, Any] = dict(extra)
        o["lan"] = (
            False
            if lan is False
            else {
                "mdns": self.net,
                "host": "127.0.0.1",
                "allow_loopback": True,
                **(lan if isinstance(lan, dict) else {}),
            }
        )
        o["relay"] = (
            False
            if relay is False
            else {"opener": self.opener, "sleep": ManualSleep(), "random": lambda: 0.5, "ping_seconds": PING}
        )
        return o

    def __enter__(self) -> "Rig":
        return self

    def __exit__(self, *a: Any) -> None:
        for c in self.all:
            try:
                c.stop()
            except Exception:
                pass


def both(r: Rig, **kw: Any) -> "tuple[CloudConnect, CloudConnect]":
    a, b = r.make(r.world.a), r.make(r.world.b)
    a.start(r.options(**kw))
    b.start(r.options(**kw))
    return a, b


# -- start and the order ----------------------------------------------------------------------------


def test_lan_comes_up_before_the_relay_and_status_reports_both() -> None:
    with Rig() as r:
        a = r.make(r.world.a)
        assert not a.status().running and a.status().lan == "off" and a.status().relay == "off"
        a.start(r.options())
        until(lambda: a.status().relay == "open")
        s = a.status()
        assert s.running and s.lan == "on" and s.relay_error is None and s.relay_reason is None
        assert r.opener_calls and all(r.opener_calls)  # the LAN advert existed when the relay opened
        a.start(r.options())  # a second start is a no-op
        assert a.fake.identity_calls == 1  # type: ignore[attr-defined]


def test_start_raises_what_the_identity_raises_and_starts_nothing() -> None:
    with Rig() as r:
        a = r.make(r.world.a, fail_identity=PolarisError("no-token", "sign in first"))
        with pytest.raises(PolarisError) as e:
            a.start(r.options())
        assert e.value.code == "no-token"
        assert not a.status().running and r.net.adverts == {} and r.opener_calls == []


def test_a_lan_that_cannot_start_is_not_fatal_while_the_relay_is_on() -> None:
    class Boom(Network):
        async def browse(self, *a: Any, **k: Any) -> Any:
            raise RuntimeError("no multicast")

    with Rig() as r:
        r.net = Boom()
        a = r.make(r.world.a)
        a.start(r.options())
        until(lambda: a.status().relay == "open")
        s = a.status()
        assert s.lan == "failed" and isinstance(s.lan_error, RuntimeError) and s.running
        b = r.make(r.world.b)
        with pytest.raises(RuntimeError):
            b.start(r.options(relay=False))
        assert not b.status().running


def test_lan_options_pass_through_including_interfaces() -> None:
    with Rig() as r:
        a = r.make(r.world.a)
        a.start(r.options(lan={"interfaces": ["10.9.9.9"], "advertise": False}, relay=False))
        assert a._lan is not None and a._lan._o.interfaces == ["10.9.9.9"]  # type: ignore[attr-defined]


# -- the relay's off switches (G21) -----------------------------------------------------------------


@pytest.mark.parametrize(
    "discovery,reason",
    [
        (
            {"services": {"connect": {"enabled": True, "relay": False, "endpoints": {"ticket": "https://k/t"}}}},
            "product",
        ),
        ({"services": {"connect": {"enabled": True, "relay": True, "endpoints": {"ticket": None}}}}, "no_ticket"),
    ],
)
def test_discovery_turns_the_relay_off_with_no_socket_and_no_ticket(discovery: Any, reason: str) -> None:
    with Rig(discovery) as r:
        a = r.make(r.world.a)
        a.start(r.options())
        s = a.status()
        assert s.relay == "off" and s.relay_reason == reason and s.running and s.lan == "on"
        time.sleep(0.2)
        assert r.room.issued == 0 and r.room.offered == [] and r.opener_calls == []
        with pytest.raises(LanError) as e:
            a.open(ID_B)
        assert e.value.reason == "unknown_peer"


def test_the_host_can_turn_the_relay_off_and_a_missing_discovery_allows_it() -> None:
    assert relay_wanted(None) is None and relay_wanted({}) is None
    on = {"services": {"connect": {"enabled": True, "relay": True, "endpoints": {"ticket": "u"}}}}
    assert relay_wanted(on) is None
    assert relay_wanted({"services": {"connect": {"enabled": True}}}) is None
    with Rig() as r:
        a = r.make(r.world.a)
        a.start(r.options(relay=False))
        assert a.status().relay == "off" and a.status().relay_reason == "host" and r.room.issued == 0


# -- peers and open ---------------------------------------------------------------------------------


def test_peers_report_the_paths_each_device_has() -> None:
    with Rig() as r:
        a, b = both(r)
        until(lambda: a.status().relay == "open" and b.status().relay == "open")
        until(lambda: a.refresh_peers() == [CloudPeer(ID_B, True, True)])
        assert b.refresh_peers() == [CloudPeer(ID_A, True, True)]
        # A leaves: B still lists it on neither path once the room and the advert say so.
        a.stop()
        until(lambda: b.refresh_peers() == [])


def test_open_takes_the_lan_when_the_device_was_seen_there() -> None:
    with Rig() as r:
        a, b = both(r)
        got: List[Any] = []
        a.on_channel(got.append)
        until(lambda: any(p.device_id == ID_A and p.lan for p in b.peers()))
        s = b.open(ID_A)
        until(lambda: got)
        assert s.path == "lan" and got[0].path == "lan" and s.peer_device_id == ID_A
        s.send(b"hi")
        assert got[0].receive(5).body == b"hi"


def test_open_goes_straight_to_the_relay_for_a_device_not_seen_on_the_lan() -> None:
    with Rig() as r:
        a = r.make(r.world.a)
        b = r.make(r.world.b)
        a.start(r.options(lan=False))
        b.start(r.options(lan=False))
        got: List[Any] = []
        a.on_channel(got.append)
        until(lambda: b.status().relay == "open" and a.status().relay == "open")
        b.refresh_peers()
        until(lambda: any(p.device_id == ID_A for p in b.peers()))
        s = b.open(ID_A)
        until(lambda: got)
        assert s.path == "relay" and got[0].path == "relay"
        s.send(b"over the room")
        assert got[0].receive(5).body == b"over the room"


def test_a_failed_lan_attempt_falls_back_to_the_relay_unless_the_host_said_no() -> None:
    with Rig() as r:
        a, b = both(r)
        got: List[Any] = []
        a.on_channel(got.append)
        until(lambda: any(p.device_id == ID_A and p.lan for p in b.peers()))
        b.refresh_peers()
        until(lambda: any(p.relay for p in b.peers()))
        # A's advert now points at a port nothing listens on.
        lan = b._lan  # type: ignore[attr-defined]
        for inst, (peer, name) in list(lan._peers.items()):
            lan._peers[inst] = (type(peer)(peer.device_id, peer.host, 1), name)
        s = b.open(ID_A)
        until(lambda: got)
        assert s.path == "relay"
        with pytest.raises(LanError) as e:
            b.open(ID_A, relay=False)
        assert e.value.reason == "connect_failed"


def test_a_lan_attempt_that_runs_out_of_time_goes_to_the_relay_and_a_late_session_is_closed() -> None:
    with Rig() as r:
        a, b = both(r)
        got: List[Any] = []
        a.on_channel(got.append)
        until(lambda: any(p.device_id == ID_A and p.lan for p in b.peers()))
        b.refresh_peers()
        until(lambda: any(p.relay for p in b.peers()))
        closed: List[bool] = []

        class Late:
            def close(self) -> None:
                closed.append(True)

        lan = b._lan  # type: ignore[attr-defined]

        async def slow(peer: Any) -> Any:
            await asyncio.sleep(0.5)
            return Late()

        lan.connect = slow
        s = b.open(ID_A, lan_attempt_seconds=0.1)
        assert s.path == "relay"
        until(lambda: closed)


def test_open_before_start_and_for_an_unknown_device() -> None:
    with Rig() as r:
        a = r.make(r.world.a)
        with pytest.raises(LanError) as e:
            a.open(ID_B)
        assert e.value.reason == "not_started"
        a.start(r.options())
        until(lambda: a.status().relay == "open")
        with pytest.raises(RelayError) as e2:
            a.open("CCCCDDDDEEEEFFFFGGGGHHHHAAAABBBB")
        assert e2.value.reason == "unknown_peer"
        assert [d.device_id for d in a.devices()] == [ID_A, ID_B]


# -- inbound sessions (G9) and notices --------------------------------------------------------------


def test_an_inbound_session_with_no_listener_is_closed() -> None:
    with Rig() as r:
        a, b = both(r)
        until(lambda: any(p.device_id == ID_A and p.lan for p in b.peers()))
        s = b.open(ID_A)  # A has no on_channel listener
        done = threading.Event()
        s.on_close(lambda c: done.set())
        assert done.wait(5)
        assert s.closed is not None and s.closed.code == "peer_bye" and s.closed.by_peer


def test_a_listener_can_be_removed_and_a_raising_one_does_not_end_the_session() -> None:
    with Rig() as r:
        a, b = both(r)
        got: List[Any] = []

        def boom(s: Any) -> None:
            raise RuntimeError("host bug")

        off = a.on_channel(boom)
        a.on_channel(got.append)
        until(lambda: any(p.device_id == ID_A and p.lan for p in b.peers()))
        s = b.open(ID_A)
        until(lambda: got)
        assert s.closed is None
        off()


def test_a_callback_cannot_call_a_blocking_method() -> None:
    with Rig() as r:
        a, b = both(r)
        seen: List[BaseException] = []
        a.on_channel(lambda s: seen.append(_try(a.stop)))
        until(lambda: any(p.device_id == ID_A and p.lan for p in b.peers()))
        b.open(ID_A)
        until(lambda: seen)
        assert isinstance(seen[0], RuntimeError)
        assert a.status().running  # peers() and status() are fine from a callback


def _try(fn: Any) -> BaseException:
    try:
        fn()
    except BaseException as e:  # noqa: BLE001
        return e
    return AssertionError("did not raise")


def test_pushed_document_notices_reach_the_host() -> None:
    with Rig() as r:
        a = r.make(r.world.a)
        a.start(r.options(relay=False))
        seen: List[ConnectNotice] = []
        a.on_notice(seen.append)

        async def push() -> None:
            a._lan._docs.ring("x")  # type: ignore[attr-defined]

        run(push())
        until(lambda: seen)
        assert seen[0].type == "ring" and seen[0].outcome == "refused" and seen[0].reason == "stale"


# -- stop -------------------------------------------------------------------------------------------


def test_stop_closes_sessions_the_relay_and_the_lan_and_is_safe_twice() -> None:
    with Rig() as r:
        a, b = both(r)
        got: List[Any] = []
        a.on_channel(got.append)
        until(lambda: any(p.device_id == ID_A and p.lan for p in b.peers()))
        s = b.open(ID_A)
        until(lambda: got)
        port = a._lan.port  # type: ignore[attr-defined]
        done = threading.Event()
        s.on_close(lambda c: done.set())
        a.stop()
        assert done.wait(5)
        st = a.status()
        assert not st.running and st.lan == "off" and st.relay == "off"
        assert a.peers() == []
        a.stop()

        async def probe() -> bool:
            try:
                await asyncio.open_connection("127.0.0.1", port)
            except OSError:
                return True
            return False

        assert run(probe())
        a.start(r.options())  # and it can start again
        assert a.status().running


def test_stop_before_start_starts_no_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    fresh = ConnectLoop()
    monkeypatch.setattr(cc_mod, "connect_loop", lambda: fresh)
    r = Rig()
    a = r.make(r.world.a)
    a.stop()
    a.stop()
    assert not fresh.running


# -- the client wiring ------------------------------------------------------------------------------


def test_the_client_owns_a_facade_and_signing_out_stops_connect_before_leaving() -> None:
    from helpers import make_client

    c = make_client(_no_network)
    try:
        assert isinstance(c.cloud_connect, CloudConnect)
        hooks = [h for h in c.identity._before_sign_out._hooks]
        names = [getattr(h, "__func__", h) for h in hooks]
        stop_at = names.index(type(c)._stop_cloud_connect)
        leave_at = names.index(type(c.connect).leave)
        assert stop_at < leave_at
    finally:
        c.close()


def _no_network(request: Any) -> Any:
    import httpx

    return httpx.Response(404)


def test_applying_a_peer_trust_manifest_follows_the_hosts_trust_refresh_switch() -> None:
    from helpers import make_client

    c = make_client(_no_network)
    try:
        c.core.trust_refresh_enabled = False
        r = c._apply_peer_trust("x.y.z")
        assert (r.applied, r.reason) == (False, "trust_refresh_off")
        c.core.trust_refresh_enabled = True
        r = c._apply_peer_trust("not-a-jws")
        assert r.applied is False and r.reason == "invalid"
    finally:
        c.close()


def test_a_peer_trust_install_and_its_cache_write_are_one_step_under_the_trust_lock() -> None:
    import threading

    from helpers import make_client

    c = make_client(_no_network)
    try:
        done = threading.Event()
        with c._trust.lock:
            t = threading.Thread(target=lambda: (c._apply_peer_trust("not-a-jws"), done.set()), daemon=True)
            t.start()
            assert not done.wait(0.3)  # a refresh holding the lock keeps the install and write out
        assert done.wait(5)
    finally:
        c.close()


# -- asyncio ----------------------------------------------------------------------------------------


def test_the_async_client_mirrors_the_facade_as_coroutines() -> None:
    with Rig() as r:
        cc = r.make(r.world.a)
        b = r.make(r.world.b)
        b.start(r.options())
        a = _AsyncCloudConnect(cc)

        async def flow() -> List[CloudPeer]:
            await a.start(r.options())
            off = a.on_channel(lambda s: None)
            assert callable(off) and a.status().running
            await asyncio.sleep(0.3)
            peers = await a.peers()
            await a.stop()
            return peers  # type: ignore[no-any-return]

        peers = asyncio.run(flow())
        assert isinstance(peers, list)
        assert not cc.status().running


def test_stop_force_cancels_after_the_bound_when_a_host_callback_blocks_the_connect_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import time

    from polaris_key.connect.loop import connect_loop

    monkeypatch.setattr(cc_mod, "STOP_SECONDS", 0.3)
    with Rig() as r:
        a = r.make(r.world.a)
        a.start(r.options())
        lan, relay = a._lan, a._relay
        assert lan is not None and relay is not None

        async def blocker() -> None:
            time.sleep(1.5)  # a host callback holding the loop's thread

        connect_loop().submit(blocker())
        time.sleep(0.1)
        t0 = time.monotonic()
        a.stop()  # D-12: does not raise and does not wait past the bound
        assert time.monotonic() - t0 < 1.2
        # Nothing graceful is left to wait for: the services are over and the discovery state is gone.
        assert not a.status().running and a._lan is None and a._relay is None
        assert lan._stopped and lan._tab is None and relay._stopped
        # Once the callback lets go, the cancelled transports close without a graceful pass.
        for _ in range(100):
            if lan._server is None or not lan._server.is_serving():
                break
            time.sleep(0.05)
        assert lan._server is None or not lan._server.is_serving()
        # And the next start works on a fresh loop.
        a.start(r.options())
        assert a.status().running
        a.stop()


def test_signing_out_is_not_held_by_a_blocked_stop_and_a_stuck_session_close_is_quiet() -> None:
    from helpers import make_client

    from polaris_key.connect.errors import LanError
    from polaris_key.connect.session import ConnectSession

    c = make_client(_no_network)
    try:

        def stuck() -> None:
            raise LanError("closed", "blocked")

        c.cloud_connect.stop = stuck  # type: ignore[method-assign]
        c._stop_cloud_connect()  # does not raise: leave() and the sign-out go on

        class Link:
            def close(self, code: str) -> None:
                raise TimeoutError()

        sess = ConnectSession.__new__(ConnectSession)
        sess._link = Link()  # type: ignore[assignment]
        sess.close()
    finally:
        c.close()
