# @pkey-feature connect.lan
"""The LAN service (CC-10.12; WIRE-CONTRACT-V5 §15.4 to §15.6): two services, a fake mDNS network and
real TCP on 127.0.0.1 (loopback allowed in these tests only). Mirrors Node's ``lan.e2e.test.ts``."""

from __future__ import annotations

import asyncio
import dataclasses
import pickle
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest
from test_connect_peer_session import ID_A, ID_B, NOW, SUB, TRUST, Dev, _ring, _rnd
from test_connect_session import KeyPort

from polaris_key.connect.client import DiscoveryKeys, PeerSource
from polaris_key.connect.errors import LanError
from polaris_key.connect.lan import (
    MAX_PENDING,
    MAX_PENDING_PER_ADDRESS,
    MAX_SESSIONS_PER_PEER,
    LanOptions,
    LanPeer,
    LanService,
    LanSource,
)
from polaris_key.connect.loop import connect_loop
from polaris_key.core.b64url import b64url_encode
from polaris_key.core.peer_advert import ADVERT_EPOCH_SECONDS, account_instance, advert_epoch
from polaris_key.core.peer_mdns import MdnsAdvert, MdnsFound, MdnsHandle

ID_C = "CCCCDDDDEEEEFFFFGGGGHHHHAAAABBBB"


def run(coro: Any, timeout: float = 15) -> Any:
    return connect_loop().submit(coro).result(timeout)


def until(cond: Callable[[], Any], timeout: float = 8) -> None:
    end = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > end:
            raise AssertionError("timed out")
        time.sleep(0.01)


class Network:
    """Every advert and browser on one fake LAN, all at 127.0.0.1."""

    def __init__(self) -> None:
        self.adverts: Dict[str, MdnsAdvert] = {}
        self.browsers: List[Tuple[Callable[[MdnsFound], None], Optional[Callable[[str], None]]]] = []
        self.log: List[str] = []

    def adapter(self) -> "Network":
        return self

    @staticmethod
    def _found(a: MdnsAdvert) -> MdnsFound:
        return MdnsFound(a.instance, "127.0.0.1", a.port, list(a.txt))

    async def advertise(self, a: MdnsAdvert) -> MdnsHandle:
        self.adverts[a.instance] = a
        self.log.append("up " + a.instance)
        for up, _ in list(self.browsers):
            up(self._found(a))

        async def stop() -> None:
            self.adverts.pop(a.instance, None)
            self.log.append("down " + a.instance)
            for _, down in list(self.browsers):
                if down:
                    down(a.instance)

        return MdnsHandle(stop)

    async def browse(
        self, on_up: Callable[[MdnsFound], None], on_down: Optional[Callable[[str], None]] = None
    ) -> MdnsHandle:
        b = (on_up, on_down)
        self.browsers.append(b)
        for a in list(self.adverts.values()):
            on_up(self._found(a))

        async def stop() -> None:
            self.browsers.remove(b)

        return MdnsHandle(stop)

    def inject(self, f: MdnsFound) -> None:
        async def go() -> None:
            for up, _ in list(self.browsers):
                up(f)

        run(go())


class World:
    def __init__(self, *, k: Optional[bytes] = None) -> None:
        self.a, self.b = Dev(ID_A), Dev(ID_B)
        self.a.sign_key, self.b.sign_key = b64url_encode(bytes([1]) * 32), b64url_encode(bytes([2]) * 32)
        self.k = k or _rnd()
        self.ring = _ring([self.a, self.b], epoch=1)
        self.now = NOW
        self.net = Network()
        self.services: List[LanService] = []

    def source(self, dev: Dev, **over: Any) -> LanSource:
        ps = PeerSource(
            slug="djdl",
            trust=TRUST,
            sub=SUB,
            device_id=dev.id,
            cert_jws=dev.cert,
            cert_expires_at=dev.exp,
            ring_jws=self.ring,
            ring_epoch=1,
            roster=(ID_A, ID_B),
            keys=DiscoveryKeys(self.k, None),
            agree_public=dev.pub,
            static_key=KeyPort(dev.priv, dev.pub),
        )
        ps = dataclasses.replace(ps, **over)
        return LanSource(load=lambda: ps, now=lambda: self.now)

    def start(self, dev: Dev, src: Optional[LanSource] = None, **opts: Any) -> LanService:
        o = LanOptions(mdns=self.net, host="127.0.0.1", allow_loopback=True, **opts)

        async def go() -> LanService:
            return await LanService.start(src or self.source(dev), o)

        svc = run(go())
        self.services.append(svc)
        return svc

    def close(self) -> None:
        for s in self.services:
            try:
                run(s.stop())
            except Exception:
                pass

    def __enter__(self) -> "World":
        return self

    def __exit__(self, *a: Any) -> None:
        self.close()


def pair(w: World, la: LanService, lb: LanService) -> Tuple[Any, Any]:
    inbound: List[Any] = []
    la.on_session(inbound.append)
    until(lambda: any(p.device_id == ID_A for p in lb.peers()))
    out = run(lb.connect(ID_A))
    until(lambda: inbound)
    return out, inbound[0]


# -- discovery and sessions --------------------------------------------------------------------------


def test_two_services_find_each_other_handshake_exchange_rekey_and_close() -> None:
    with World() as w:
        la = w.start(w.a, rekey_messages=3)
        lb = w.start(w.b, rekey_messages=3)
        until(lambda: len(la.peers()) == 1 and len(lb.peers()) == 1)
        assert la.peers()[0].device_id == ID_B
        assert lb.peers()[0] == LanPeer(ID_A, "127.0.0.1", la.port)
        # The advert carries the account instance name and ``v=1``, ``m=a`` only.
        name = account_instance(w.k, advert_epoch(NOW), ID_A)
        assert w.net.adverts[name].port == la.port and list(w.net.adverts[name].txt) == ["v=1", "m=a"]
        assert la.port != lb.port

        out, inn = pair(w, la, lb)
        assert out.peer_device_id == ID_A and inn.peer_device_id == ID_B
        assert out.caps == ("app/1",) and out.role == "initiator" and out.path == "lan"
        out.send(b"hello from b")
        assert inn.receive(5).body == b"hello from b"
        inn.send(b"hello from a", 0x0101)
        assert out.receive(5).type == 0x0101
        for i in range(8):  # past the rekey threshold in each direction
            out.send(b"b%d" % i)
            inn.send(b"a%d" % i)
        assert [inn.receive(5).body for _ in range(8)] == [b"b%d" % i for i in range(8)]
        assert [out.receive(5).body for _ in range(8)] == [b"a%d" % i for i in range(8)]
        order: List[str] = []
        inn.on_close(lambda c: order.append("inn:%s:%s" % (c.code, c.by_peer)))
        out.on_close(lambda c: order.append("out:%s:%s" % (c.code, c.by_peer)))
        out.close()
        until(lambda: len(order) == 2)
        assert sorted(order) == ["inn:peer_bye:True", "out:peer_bye:False"]
        with pytest.raises(LanError) as e:
            out.send(b"x")
        assert e.value.reason == "closed"


def test_a_large_message_crosses_and_the_limits_hold() -> None:
    with World() as w:
        la, lb = w.start(w.a), w.start(w.b)
        out, inn = pair(w, la, lb)
        big = bytes(i % 251 for i in range(1_048_576))
        out.send(big)
        assert inn.receive(10).body == big
        with pytest.raises(LanError) as e:
            out.send(bytes(1_048_577))
        assert e.value.reason == "too_large"
        with pytest.raises(LanError) as e:
            out.send(b"x", 0x8100)
        assert e.value.reason == "bad_type"
        assert out.closed is None


def test_a_device_that_went_away_is_forgotten() -> None:
    with World() as w:
        la, lb = w.start(w.a), w.start(w.b)
        until(lambda: len(lb.peers()) == 1)
        run(la.stop())
        until(lambda: lb.peers() == [])


def test_the_advert_rotates_at_the_epoch_boundary_and_drops_the_old_one() -> None:
    with World() as w:
        timers: List[Tuple[Callable[[], None], float]] = []

        def timer(fn: Callable[[], None], seconds: float) -> Callable[[], None]:
            timers.append((fn, seconds))
            return lambda: None

        svc = w.start(w.a, timer=timer, browse=False)
        first = account_instance(w.k, advert_epoch(NOW), ID_A)
        assert list(w.net.adverts) == [first]
        fn, secs = timers[-1]
        assert secs == (advert_epoch(NOW) + 1) * ADVERT_EPOCH_SECONDS - NOW
        w.now = (advert_epoch(NOW) + 1) * ADVERT_EPOCH_SECONDS
        connect_loop().call_soon(fn)
        second = account_instance(w.k, advert_epoch(w.now), ID_A)
        until(lambda: second in w.net.adverts and first not in w.net.adverts)
        assert w.net.log == ["up " + first, "up " + second, "down " + first]
        assert timers[-1][1] == ADVERT_EPOCH_SECONDS
        assert svc.port == w.net.adverts[second].port


def test_a_new_discovery_key_changes_the_advert_inside_the_epoch() -> None:
    with World() as w:
        box = {"k": w.k}
        holder: Dict[str, PeerSource] = {}

        def load() -> PeerSource:
            return dataclasses.replace(holder["ps"], keys=DiscoveryKeys(box["k"], None))

        holder["ps"] = w.source(w.a).load()
        svc = w.start(w.a, LanSource(load=load, now=lambda: w.now), browse=False)
        first = account_instance(w.k, advert_epoch(NOW), ID_A)
        assert first in w.net.adverts
        box["k"] = _rnd()
        svc._stored_from_worker()
        second = account_instance(box["k"], advert_epoch(NOW), ID_A)
        until(lambda: second in w.net.adverts and first not in w.net.adverts)


def test_forged_and_unrelated_adverts_are_dropped() -> None:
    with World() as w:
        la = w.start(w.a)
        right = account_instance(w.k, advert_epoch(NOW), ID_B)
        wrong_key = account_instance(bytes([7]) * 32, advert_epoch(NOW), ID_B)
        me = account_instance(w.k, advert_epoch(NOW), ID_A)

        def f(instance: str, host: str = "127.0.0.1", txt: Tuple[str, ...] = ("v=1", "m=a")) -> None:
            w.net.inject(MdnsFound(instance, host, 4000, list(txt)))

        f(wrong_key)
        f(me)  # this device's own advert is not a peer
        f(right, txt=("v=1", "m=v", "h=0123456789abcdef"))  # wrong mode
        f(right, txt=("v=2", "m=a"))
        f(right, txt=("v=1", "m=a", "v=1"))  # a repeated key
        f(right, host="8.8.8.8")  # not a LAN address
        f(right, host="169.254.1.1")
        f("not-an-instance")
        time.sleep(0.2)
        assert la.peers() == []
        f(right)
        until(lambda: len(la.peers()) == 1)
        assert la.peers()[0].device_id == ID_B and la.peers()[0].port == 4000


def test_a_peer_under_the_previous_epoch_or_the_previous_key_is_accepted() -> None:
    with World() as w:
        la = w.start(w.a)
        old_epoch = account_instance(w.k, advert_epoch(NOW) - 1, ID_B)
        w.net.inject(MdnsFound(old_epoch, "127.0.0.1", 4001, ["v=1", "m=a"]))
        until(lambda: len(la.peers()) == 1)


def test_a_forged_name_is_not_worked_out_twice() -> None:
    with World() as w:
        la = w.start(w.a)
        n = {"calls": 0}
        real = la._src.load

        def counting() -> PeerSource:
            n["calls"] += 1
            return real()

        la._src.load = counting
        la._id = None
        bogus = account_instance(bytes([3]) * 32, advert_epoch(NOW), ID_B)
        for _ in range(5):
            w.net.inject(MdnsFound(bogus, "127.0.0.1", 4000, ["v=1", "m=a"]))
            time.sleep(0.05)
        assert n["calls"] <= 1 and bogus in la._miss


def test_it_refuses_to_start_without_an_identity() -> None:
    w = World()

    def load() -> PeerSource:
        raise LanError("no_identity", "none")

    with pytest.raises(LanError) as e:
        run(LanService.start(LanSource(load=load, now=lambda: NOW), LanOptions(mdns=w.net)))
    assert e.value.reason == "no_identity"
    assert w.net.adverts == {}


def test_a_failed_start_releases_what_it_opened() -> None:
    w = World()

    class Boom(Network):
        async def browse(self, *a: Any, **k: Any) -> MdnsHandle:
            raise RuntimeError("no socket")

    net = Boom()
    o = LanOptions(mdns=net, host="127.0.0.1", allow_loopback=True)
    with pytest.raises(RuntimeError):
        run(LanService.start(w.source(w.a), o))
    assert net.adverts == {}  # the advert it had made is withdrawn


def test_it_does_not_dial_an_unknown_device_or_an_address_off_the_lan() -> None:
    with World() as w:
        la = w.start(w.a)
        for target in (
            ID_C,
            LanPeer(ID_B, "8.8.8.8", 9),
            LanPeer(ID_B, "169.254.1.1", 9),
            LanPeer(ID_B, "100.64.0.1", 9),
        ):
            with pytest.raises(LanError) as e:
                run(la.connect(target))
            assert e.value.reason == "unknown_peer"


def test_loopback_is_not_dialled_unless_the_caller_allows_it() -> None:
    w = World()

    async def go() -> Any:
        svc = await LanService.start(
            w.source(w.a), LanOptions(mdns=w.net, host="127.0.0.1", advertise=False, browse=False)
        )
        try:
            await svc.connect(LanPeer(ID_B, "127.0.0.1", 9))
        finally:
            await svc.stop()

    with pytest.raises(LanError) as e:
        run(go())
    assert e.value.reason == "unknown_peer"


def test_a_refused_connect_is_connect_failed() -> None:
    with World() as w:
        la = w.start(w.a, advertise=False, browse=False)
        # A port nothing listens on.
        with pytest.raises(LanError) as e:
            run(la.connect(LanPeer(ID_B, "127.0.0.1", 1)))
        assert e.value.reason == "connect_failed"


def test_the_device_that_answers_must_be_the_one_dialled() -> None:
    with World() as w:
        la = w.start(w.a)
        lb = w.start(w.b, advertise=False, browse=False)
        # B dials A's port believing it is device C.
        with pytest.raises(LanError) as e:
            run(lb.connect(LanPeer(ID_C, "127.0.0.1", la.port)))
        assert e.value.reason == "wrong_peer"
        # Refused inside the handshake: the dialling side never registered a session for it.
        assert not lb._sessions


def test_one_device_cannot_hold_more_than_its_share_of_the_open_sessions() -> None:
    assert MAX_SESSIONS_PER_PEER == 4
    with World() as w:
        la = w.start(w.a, max_sessions_per_peer=2)
        lb = w.start(w.b, advertise=False, browse=False)
        inbound: List[Any] = []
        la.on_session(inbound.append)
        peer = LanPeer(ID_A, "127.0.0.1", la.port)
        first = [run(lb.connect(peer)) for _ in range(2)]
        until(lambda: len(inbound) == 2)
        # The dialler finishes its handshake first; the full side ends it with peer_busy and never
        # registers or announces it.
        third = run(lb.connect(peer))
        ended: List[Any] = []
        third.on_close(ended.append)
        until(lambda: ended)
        assert ended[0].code == "peer_busy" and ended[0].by_peer
        assert len(inbound) == 2 and len(la._sessions) == 2
        # A closed session frees a place.
        first[0].close()
        until(lambda: len(la._sessions) == 1)
        run(lb.connect(peer))
        until(lambda: len(inbound) == 3)


def test_stop_closes_open_sessions_and_the_listener() -> None:
    with World() as w:
        la, lb = w.start(w.a), w.start(w.b)
        out, inn = pair(w, la, lb)
        gone = threading.Event()
        inn.on_close(lambda c: gone.set())
        port = la.port
        run(la.stop())
        assert gone.wait(5)
        run(la.stop())  # twice is fine
        with pytest.raises(LanError) as e:
            run(la.connect(ID_B))
        assert e.value.reason == "not_listening"

        async def probe() -> bool:
            try:
                await asyncio.open_connection("127.0.0.1", port)
            except OSError:
                return True
            return False

        assert run(probe())


def test_a_service_does_not_leak_secrets_through_repr_or_pickle() -> None:
    with World() as w:
        la = w.start(w.a)
        assert w.k.hex() not in repr(la) and "<LanService" in repr(la)
        with pytest.raises(TypeError):
            pickle.dumps(la)


# -- admission refusals -------------------------------------------------------------------------------


def _dial_refused(w: World, src_b: LanSource) -> None:
    la = w.start(w.a)
    seen: List[Any] = []
    la.on_session(seen.append)
    lb = w.start(w.b, src_b, advertise=False, browse=False)
    with pytest.raises(LanError) as e:
        run(lb.connect(LanPeer(ID_A, "127.0.0.1", la.port)))
    assert e.value.reason == "handshake_failed"
    time.sleep(0.1)
    assert seen == []


def test_a_wrong_discovery_key_is_refused_without_a_session() -> None:
    with World() as w:
        _dial_refused(w, w.source(w.b, keys=DiscoveryKeys(bytes([9]) * 32, None)))


def test_an_expired_certificate_is_refused() -> None:
    with World() as w:
        w.b.exp = NOW - 5
        _dial_refused(w, w.source(w.b, cert_expires_at=NOW - 5))


def test_a_device_of_another_subject_is_refused() -> None:
    with World() as w:
        c = Dev(ID_C, sub="ps_BBBBBBBBBBBBBBBBBBBBBB")
        c.sign_key = b64url_encode(bytes([3]) * 32)
        foreign = _ring([c], epoch=1, sub="ps_BBBBBBBBBBBBBBBBBBBBBB")
        _dial_refused(
            w,
            w.source(c, ring_jws=foreign, sub="ps_BBBBBBBBBBBBBBBBBBBBBB", roster=(ID_C,)),
        )


# -- the listener's bounds ----------------------------------------------------------------------------


class Raw:
    """A raw TCP client on the Connect loop: what the listener sent, and whether it closed."""

    def __init__(self, port: int) -> None:
        self.received = 0
        self.closed = threading.Event()
        self.writer: Any = None
        self._ready = threading.Event()
        run(self._open(port))

    async def _open(self, port: int) -> None:
        r, self.writer = await asyncio.open_connection("127.0.0.1", port)
        asyncio.ensure_future(self._read(r))

    async def _read(self, r: Any) -> None:
        try:
            while True:
                d = await r.read(4096)
                if not d:
                    break
                self.received += len(d)
        except OSError:
            pass
        self.closed.set()

    def write(self, data: bytes) -> None:
        async def go() -> None:
            self.writer.write(data)

        run(go())

    def drop(self) -> None:
        async def go() -> None:
            self.writer.transport.abort()

        run(go())


def test_the_limits_are_32_unauthenticated_sockets_and_4_per_address() -> None:
    assert (MAX_PENDING, MAX_PENDING_PER_ADDRESS) == (32, 4)
    o = LanOptions()
    assert (o.max_pending, o.max_pending_per_address, o.handshake_seconds) == (32, 4, 30.0)


def test_garbage_and_oversized_and_empty_first_frames_close_without_a_word() -> None:
    with World() as w:
        la = w.start(w.a)
        g = Raw(la.port)
        g.write(bytes([0, 48]) + bytes([1]) * 48)
        assert g.closed.wait(5) and g.received == 0
        big = Raw(la.port)
        big.write(bytes([0xFF, 0xFF]) + bytes([2]) * 65535)
        assert big.closed.wait(5) and big.received == 0
        zero = Raw(la.port)
        zero.write(bytes([0, 0]))
        assert zero.closed.wait(5) and zero.received == 0


def test_sockets_that_have_not_handshaken_are_capped_per_address() -> None:
    with World() as w:
        la = w.start(w.a, max_pending_per_address=2)
        socks = [Raw(la.port) for _ in range(4)]
        until(lambda: sum(1 for s in socks if s.closed.is_set()) == 2)
        time.sleep(0.1)
        assert sum(1 for s in socks if s.closed.is_set()) == 2
        assert all(s.received == 0 for s in socks)
        # A closed pending socket frees its slot.
        open_ = [s for s in socks if not s.closed.is_set()]
        open_[0].drop()
        until(lambda: len(la._pending) == 1)
        extra = Raw(la.port)
        time.sleep(0.2)
        assert not extra.closed.is_set()


def test_sockets_that_have_not_handshaken_are_capped_in_total() -> None:
    with World() as w:
        la = w.start(w.a, max_pending=3, max_pending_per_address=50)
        socks = [Raw(la.port) for _ in range(5)]
        until(lambda: sum(1 for s in socks if s.closed.is_set()) == 2)
        assert len(la._pending) == 3


def test_a_socket_that_stalls_in_the_handshake_is_dropped() -> None:
    with World() as w:
        la = w.start(w.a, handshake_seconds=0.3)
        s = Raw(la.port)
        assert s.closed.wait(3) and s.received == 0
        until(lambda: la._pending == set() and la._per_address == {})


def test_an_admitted_session_stops_counting_as_pending() -> None:
    with World() as w:
        la, lb = w.start(w.a), w.start(w.b)
        pair(w, la, lb)
        until(lambda: len(la._pending) == 0 and la._per_address == {})


def test_a_source_off_the_lan_is_refused_at_accept() -> None:
    w = World()

    async def go() -> bool:
        svc = await LanService.start(
            w.source(w.a), LanOptions(mdns=w.net, host="127.0.0.1", advertise=False, browse=False)
        )  # loopback not allowed: every 127.0.0.1 source is off the LAN
        try:
            r, wr = await asyncio.open_connection("127.0.0.1", svc.port)
            data = await asyncio.wait_for(r.read(10), 5)
            wr.close()
            return data == b"" and not svc._pending
        finally:
            await svc.stop()

    assert run(go())


def test_a_pushed_roster_is_reported_as_a_notice() -> None:
    with World() as w:
        la = w.start(w.a)
        notices: List[Any] = []
        la.on_notice(notices.append)
        la._docs.ring(w.ring)
        until(lambda: notices)
        assert notices[0].type == "ring" and notices[0].outcome == "refused" and notices[0].reason == "unsupported"


def test_forged_names_cost_nothing_after_the_expected_names_are_worked_out_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import polaris_key.core.peer_advert as adv

    with World() as w:
        la = w.start(w.a)
        real = adv.account_instance
        calls = {"n": 0}

        def counting(*a: Any, **k: Any) -> str:
            calls["n"] += 1
            return real(*a, **k)

        la._tab = None
        monkeypatch.setattr(adv, "account_instance", counting)
        for i in range(200):
            name = account_instance(bytes([3]) * 32, advert_epoch(NOW), "%032d" % i)
            w.net.inject(MdnsFound(name, "127.0.0.1", 4000, ["v=1", "m=a"]))
        until(lambda: len(la._miss) >= 200)
        first = calls["n"]
        assert 0 < first <= 512  # one table, not 512 per name
        la._miss.clear()
        for i in range(200, 400):
            name = account_instance(bytes([3]) * 32, advert_epoch(NOW), "%032d" % i)
            w.net.inject(MdnsFound(name, "127.0.0.1", 4000, ["v=1", "m=a"]))
        until(lambda: len(la._miss) >= 200)
        assert calls["n"] == first  # the table is reused: a forged name is a dict miss


def test_a_device_with_a_wrong_first_address_is_reached_by_falling_through_the_list() -> None:
    with World() as w:
        la = w.start(w.a)
        lb = w.start(w.b, advertise=False, browse=False)
        inbound: List[Any] = []
        la.on_session(inbound.append)
        # The first address answers nothing (a neighbour that spoofed it); the second is the device.
        peer = LanPeer(ID_A, "127.0.0.1", la.port, ("127.0.0.1",))
        dead = LanPeer(ID_A, "127.0.0.1", 1)
        with pytest.raises(LanError) as e:
            run(lb.connect(dead))
        assert e.value.reason == "connect_failed"  # one address and nothing to fall through to
        s = run(lb.connect(peer._replace(host="127.0.0.2", alt_hosts=("127.0.0.1",))))
        assert s.peer_device_id == ID_A
        until(lambda: inbound)
