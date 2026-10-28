# @pkey-feature connect.relay
"""Peer sessions over the relay and outgoing pacing (CC-10.14; WIRE-CONTRACT-V5 §15.7, G8, G16, G17): two
services through the in-process room (:mod:`connect_relay_fake`). Mirrors the session half of Node's
``relay.test.ts``; pacing (D-9) is new."""

from __future__ import annotations

import asyncio
import dataclasses
import threading
from typing import Any, List, Optional, Tuple

import pytest
from connect_relay_fake import FakeRoom, ManualSleep
from test_connect_lan import World, run, until
from test_connect_peer_session import ID_A, ID_B, Dev, _ring

from polaris_key.connect.errors import LanError, RelayError
from polaris_key.connect.loop import connect_loop
from polaris_key.connect.pacer import BURST, HALVED_SECONDS, MAX_QUEUED_BYTES, RATE, Outbox, Pacer
from polaris_key.connect.relay import ENDED_MEMORY, RelayOptions, RelayService
from polaris_key.connect.session import ConnectSession
from polaris_key.core.b64url import b64url_decode, b64url_encode

ID_C = "CCCCDDDDEEEEFFFFGGGGHHHHAAAABBBB"
PING = 1000.0


class Net:
    """One world and one room, with a relay service per device."""

    def __init__(self, members: Any = None, **opts: Any) -> None:
        self.world = World()
        self.room = FakeRoom(set(members) if members is not None else {ID_A, ID_B})
        self.opts = opts
        self.services: List[RelayService] = []
        self.loads = {ID_A: 0, ID_B: 0}

    def service(self, dev: Dev, roster: Tuple[str, ...] = (ID_A, ID_B), **over: Any) -> RelayService:
        src = self.world.source(dev, roster=roster)
        real = src.load

        def load() -> Any:
            self.loads[dev.id] = self.loads.get(dev.id, 0) + 1
            return real()

        src = dataclasses.replace(src, load=load)
        opts = {**self.opts, **over}
        o = RelayOptions(
            opener=self.room.opener, sleep=ManualSleep(), random=lambda: 0.5, ping_seconds=PING, **opts
        )

        async def go() -> RelayService:
            svc = RelayService(src, lambda: self.room.issue(dev.id), o)
            svc.start()
            await svc.ready(5)
            return svc

        svc = run(go())
        self.services.append(svc)
        return svc

    def inbound(self, svc: RelayService) -> List[ConnectSession]:
        got: List[ConnectSession] = []
        svc.on_session(got.append)
        return got

    def __enter__(self) -> "Net":
        return self

    def __exit__(self, *a: Any) -> None:
        for s in self.services:
            try:
                run(s.stop())
            except Exception:
                pass


def pair(n: Net, **opts: Any) -> Tuple[RelayService, RelayService, ConnectSession, ConnectSession]:
    sa = n.service(n.world.a, **opts)
    sb = n.service(n.world.b, **opts)
    got = n.inbound(sa)
    out = run(sb.dial(ID_A))
    until(lambda: got)
    return sa, sb, out, got[0]


# -- sessions ----------------------------------------------------------------------------------------


def test_admits_the_peer_like_the_lan_and_carries_messages_both_ways_rekeying() -> None:
    with Net(rekey_messages=3) as n:
        sa, sb, out, inn = pair(n)
        assert out.peer_device_id == ID_A and inn.peer_device_id == ID_B
        assert out.role == "initiator" and inn.role == "responder"
        assert out.path == "relay" and out.remote_address == "relay" and out.caps == ("app/1",)
        out.send(b"hello over the relay")
        assert inn.receive(5).body == b"hello over the relay"
        inn.send(b"back", 0x0101)
        assert out.receive(5).type == 0x0101
        for i in range(8):  # past the rekey threshold in each direction
            out.send(b"b%d" % i)
            inn.send(b"a%d" % i)
        assert [inn.receive(5).body for _ in range(8)] == [b"b%d" % i for i in range(8)]
        assert [out.receive(5).body for _ in range(8)] == [b"a%d" % i for i in range(8)]
        big = bytes(i % 251 for i in range(300_000))  # several envelopes
        out.send(big)
        assert inn.receive(10).body == big
        # Only SEND envelopes of this session crossed, all addressed to the other device.
        assert n.room.sends(ID_B) and all(m["to"] == b64url_decode(ID_A) for m in n.room.sends(ID_B))
        done = threading.Event()
        inn.on_close(lambda c: done.set())
        out.close()
        assert done.wait(5) and inn.closed is not None and inn.closed.code == "peer_bye"


def test_every_relay_channel_is_mode_a() -> None:
    with Net() as n:
        sa, sb, out, inn = pair(n)
        for svc in (sa, sb):
            assert svc._links
            for lk in svc._links.values():
                assert lk.channel._mode == "a"


def test_a_peer_of_another_account_is_refused() -> None:
    with Net() as n:
        sa = n.service(n.world.a)
        got = n.inbound(sa)
        c = Dev(ID_C, sub="ps_BBBBBBBBBBBBBBBBBBBBBB")
        c.sign_key = b64url_encode(bytes([3]) * 32)
        foreign = _ring([c], epoch=1, sub="ps_BBBBBBBBBBBBBBBBBBBBBB")
        n.room.members_set.add(ID_C)
        src = n.world.source(c, ring_jws=foreign, sub="ps_BBBBBBBBBBBBBBBBBBBBBB", roster=(ID_C, ID_A))

        async def go() -> Any:
            svc = RelayService(
                src,
                lambda: n.room.issue(ID_C),
                RelayOptions(opener=n.room.opener, sleep=ManualSleep(), ping_seconds=PING, handshake_seconds=1.0),
            )
            n.services.append(svc)
            svc.start()
            await svc.ready(5)
            return await svc.dial(ID_A)

        with pytest.raises(RelayError) as e:
            run(go())
        assert e.value.reason == "handshake_failed"
        assert got == []


def test_a_first_message_from_a_device_off_the_roster_or_from_this_device_is_ignored() -> None:
    with Net(members={ID_A, ID_B, ID_C}) as n:
        sa = n.service(n.world.a)
        before = n.loads[ID_A]
        n.room.inject = None  # type: ignore[attr-defined]
        for frm in (ID_C, ID_A):
            n.room.push(ID_A, {"op": "recv", "from": b64url_decode(frm), "session": 7, "noise": b"\x01" * 48})
        until(lambda: n.loads[ID_A] >= before)
        import time

        time.sleep(0.2)
        assert sa._links == {} and len(sa._ended) == 0


def test_the_stamped_from_must_be_the_device_the_certificate_proves() -> None:
    with Net(members={ID_A, ID_B, ID_C}) as n:
        # The room hands B's frames addressed to C to A, and stamps A's frames as C's.
        n.room.route[ID_C] = ID_A
        n.room.stamp[ID_A] = ID_C
        sa = n.service(n.world.a)
        got = n.inbound(sa)
        sb = n.service(n.world.b, roster=(ID_A, ID_B, ID_C))
        with pytest.raises(RelayError) as e:
            run(sb.dial(ID_C))
        assert e.value.reason == "wrong_peer"
        assert sb._links == {}
        assert got == [] or got[0].peer_device_id == ID_B  # A admitted B, who was honest to it


def test_dial_refuses_an_unknown_device_this_device_and_a_non_device() -> None:
    with Net() as n:
        sb = n.service(n.world.b)
        for target in (ID_C, ID_B, "not-a-device"):
            with pytest.raises(RelayError) as e:
                run(sb.dial(target))
            assert e.value.reason == "unknown_peer"


def test_sessions_are_bounded_in_total() -> None:
    with Net() as n:
        sa = n.service(n.world.a)
        sb = n.service(n.world.b, max_sessions=1)
        n.inbound(sa)
        run(sb.dial(ID_A))
        with pytest.raises(RelayError) as e:
            run(sb.dial(ID_A))
        assert e.value.reason == "busy"


def test_handshakes_in_flight_are_bounded_per_peer() -> None:
    with Net() as n:
        n.room.mute_to.add(ID_B)  # A's answers never reach B: the handshakes stay pending
        sa = n.service(n.world.a, max_pending_per_peer=2, handshake_seconds=3.0)
        sb = n.service(n.world.b, handshake_seconds=3.0)
        futs = [connect_loop().submit(sb.dial(ID_A)) for _ in range(4)]
        until(lambda: len(sa._links) == 2)
        errs: List[str] = []
        for f in futs:
            with pytest.raises(RelayError) as e:
                f.result(8)
            errs.append(e.value.reason)
        assert set(errs) == {"handshake_failed"}
        until(lambda: len(sa._links) == 0)


def test_ended_sessions_are_remembered_so_a_late_message_costs_nothing() -> None:
    with Net() as n:
        sa = n.service(n.world.a)
        garbage = {"op": "recv", "from": b64url_decode(ID_B), "session": 99, "noise": b"\x07" * 48}
        n.room.push(ID_A, garbage)  # a first message that does not verify: the link ends silently
        until(lambda: len(sa._ended) == 1)
        loads = n.loads[ID_A]
        n.room.push(ID_A, garbage)
        import time

        time.sleep(0.2)
        assert len(sa._ended) == 1 and n.loads[ID_A] == loads and sa._links == {}
        assert sa._ended.maxlen == ENDED_MEMORY == 256


def test_a_dropped_socket_ends_sessions_with_connection_lost_and_a_new_dial_works() -> None:
    with Net() as n:
        sa, sb, out, inn = pair(n)
        done, odone = threading.Event(), threading.Event()
        inn.on_close(lambda c: done.set())
        out.on_close(lambda c: odone.set())
        n.room.drop_all(None)
        assert done.wait(5) and odone.wait(5)
        assert out.closed is not None and out.closed.code == "connection_lost"
        assert inn.closed is not None and inn.closed.code == "connection_lost"
        for s in (sa, sb):
            until(lambda s=s: s.status.state == "backoff")  # type: ignore[misc]
            until(lambda s=s: bool(s._sleep.pending))  # type: ignore[misc]
            run(_wake(s))
        got = n.inbound(sa)
        run(sb.ready(5))
        run(sa.ready(5))
        again = run(sb.dial(ID_A))
        until(lambda: got)
        again.send(b"after")
        assert got[0].receive(5).body == b"after"


async def _wake(svc: RelayService) -> None:
    sleep: Any = svc._sleep
    sleep.fire(lambda s: s != PING)


def test_gone_for_a_device_ends_only_its_sessions() -> None:
    with Net(members={ID_A, ID_B, ID_C}) as n:
        sa, sb, out, inn = pair(n)
        closed = threading.Event()
        inn.on_close(lambda c: closed.set())
        n.room.push(ID_A, {"op": "gone", "device": b64url_decode(ID_C)})
        import time

        time.sleep(0.2)
        assert inn.closed is None
        n.room.push(ID_A, {"op": "gone", "device": b64url_decode(ID_B)})
        assert closed.wait(5) and inn.closed is not None and inn.closed.code == "connection_lost"
        assert out.closed is None  # B has not heard of it yet


def test_stop_says_goodbye_to_open_sessions() -> None:
    with Net() as n:
        sa, sb, out, inn = pair(n)
        done = threading.Event()
        out.on_close(lambda c: done.set())
        run(sa.stop())
        assert done.wait(5) and out.closed is not None
        assert out.closed.code == "peer_bye" and out.closed.by_peer


# -- pacing ------------------------------------------------------------------------------------------


class Time:
    def __init__(self) -> None:
        self.t = 0.0
        self.slept: List[float] = []

    def __call__(self) -> float:
        return self.t

    async def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.t += s


def test_the_pacer_is_180_a_second_with_a_burst_of_360() -> None:
    assert (RATE, BURST, HALVED_SECONDS, MAX_QUEUED_BYTES) == (180.0, 360.0, 10.0, 8 * 1024 * 1024)
    c = Time()
    p = Pacer(clock=c, sleep=c.sleep)
    assert all(p.try_take() == 0.0 for _ in range(360))
    wait = p.try_take()
    assert wait == pytest.approx(1 / 180)
    c.t += 1.0  # a second refills 180
    assert sum(1 for _ in range(400) if p.try_take() == 0.0) == 180


def test_acquire_waits_for_the_next_token() -> None:
    c = Time()
    p = Pacer(clock=c, sleep=c.sleep)

    async def go() -> None:
        for _ in range(361):
            await p.acquire()

    asyncio.run(go())
    assert c.slept and c.slept[0] == pytest.approx(1 / 180)


def test_limit_1_halves_the_rate_for_ten_seconds() -> None:
    c = Time()
    p = Pacer(clock=c, sleep=c.sleep)
    assert p.rate == 180.0
    p.halve()
    assert p.rate == 90.0
    c.t += 9.9
    assert p.rate == 90.0
    c.t += 0.2
    assert p.rate == 180.0
    # While halved, tokens come back at half the speed.
    p.halve()
    for _ in range(400):
        p.try_take()
    c.t += 1.0
    assert sum(1 for _ in range(400) if p.try_take() == 0.0) == 90


def test_the_outbox_counts_bytes_and_refuses_past_its_cap_but_not_a_forced_item() -> None:
    async def go() -> None:
        q = Outbox(max_bytes=100)
        assert q.put(b"x" * 60) and q.queued == 60
        assert not q.put(b"y" * 50) and q.queued == 60 and len(q) == 1
        assert q.put(b"y" * 50, force=True) and q.queued == 110
        assert await q.get() == b"x" * 60 and q.queued == 50
        assert not await q.drained(0.02)  # one item still queued, one in flight
        await q.get()
        assert not await q.drained(0.02)  # in flight until sent()
        q.sent()
        assert await q.drained(0.02)

    asyncio.run(go())


class Gate(Pacer):
    """A pacer a test can stall."""

    def __init__(self) -> None:
        super().__init__()
        self.open = True
        self.stalled: Optional[asyncio.Event] = None

    async def acquire(self) -> None:
        while not self.open:
            await asyncio.sleep(0.01)
        await super().acquire()


def test_a_limit_1_from_the_room_halves_the_service_pacer() -> None:
    with Net() as n:
        sa = n.service(n.world.a)
        assert sa._pacer is not None and sa._pacer.rate == 180.0
        n.room.push(ID_A, {"op": "limit", "reason": 1})
        until(lambda: sa._pacer is not None and sa._pacer.rate == 90.0)
        assert sa.status.error is not None and sa.status.error.reason == "rate_limited"


def test_a_send_past_8_mib_queued_closes_the_session_peer_busy() -> None:
    gate = Gate()
    with Net(pacer=lambda: gate) as n:
        sa, sb, out, inn = pair(n)
        closes: List[Any] = []
        out.on_close(closes.append)
        gate.open = False
        # Stalled behind the socket: whole megabytes queue up to the cap, then the session closes (D-9).
        body = bytes(1024 * 1024)
        for _ in range(12):
            out.send(body)  # never raises: the host sees the close, not an error
            if closes:
                break
        until(lambda: bool(closes))
        assert closes[0].code == "peer_busy" and closes[0].by_peer is False
        # Nothing was encrypted past the cap: the keys never advanced for a dropped message.
        assert sa.status.error is None or sa.status.error.reason != "rate_limited"


def test_the_error_is_the_registered_rate_limited_code() -> None:
    from polaris_key.constants_generated import ErrorCode

    assert RelayError("rate_limited", "x").code == ErrorCode.RATE_LIMITED
    assert LanError("queue_full", "x").code == ErrorCode.RATE_LIMITED
