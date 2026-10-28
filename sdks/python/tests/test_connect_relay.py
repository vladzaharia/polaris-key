# @pkey-feature connect.relay
"""The relay socket (CC-10.13; WIRE-CONTRACT-V5 §15.7, G13 to G15): ticket offer, open, reconnect policy,
LIMIT and close codes, status, and the optional ``websockets`` dependency. The room is the in-process
:mod:`connect_relay_fake`; the default opener is covered against a real loopback WebSocket server when
``websockets`` is installed. Mirrors the socket half of Node's ``relay.test.ts``."""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import re
import sys
import time
from typing import Any, Callable, List, Optional

import pytest
from connect_relay_fake import FakeRoom, ManualSleep
from test_connect_lan import World, run, until
from test_connect_peer_session import ID_A, ID_B

from polaris_key.connect.errors import RelayError
from polaris_key.connect.relay import (
    RelayDependencyMissing,
    RelayOptions,
    RelayService,
    SocketClosed,
    assert_relay_mode,
    websockets_opener,
)
from polaris_key.core.b64url import b64url_decode
from polaris_key.core.peer_relay_codec import RELAY_MAX_MESSAGE

PING = 1000.0  # a ping interval no backoff delay can equal


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


class Rig:
    def __init__(self, device: str = ID_A, members: Any = None, **opts: Any) -> None:
        self.world = World()
        self.room = FakeRoom(set(members) if members is not None else {ID_A, ID_B})
        self.sleep = ManualSleep()
        self.clock = Clock()
        self.refreshes = 0
        self.errors: List[Exception] = []
        self.device = device
        self.opts = opts
        self.svc: Optional[RelayService] = None
        self.states: List[str] = []

    def _ticket(self) -> Any:
        if self.errors:
            raise self.errors.pop(0)
        return self.room.issue(self.device)

    def _refresh(self) -> None:
        self.refreshes += 1

    def start(self) -> RelayService:
        dev = self.world.a if self.device == ID_A else self.world.b
        src = dataclasses.replace(self.world.source(dev), refresh=self._refresh)
        o = RelayOptions(
            opener=self.room.opener,
            sleep=self.sleep,
            random=lambda: 0.5,
            clock=self.clock,
            ping_seconds=PING,
            **self.opts,
        )

        async def go() -> RelayService:
            svc = RelayService(src, self._ticket, o)
            svc.on_state(lambda s: self.states.append(s.state))
            svc.start()
            return svc

        self.svc = run(go())
        return self.svc

    def ready(self) -> RelayService:
        svc = self.svc or self.start()
        run(svc.ready(5))
        return svc

    def on_loop(self, fn: Callable[[], Any]) -> Any:
        async def go() -> Any:
            return fn()

        return run(go())

    def backoff_delays(self) -> List[float]:
        return [d for d in self.sleep.delays if d != PING]

    def wake(self) -> None:
        until(lambda: any(s != PING for s, _ in self.sleep.pending))
        assert self.on_loop(lambda: self.sleep.fire(lambda s: s != PING))

    def __enter__(self) -> "Rig":
        return self

    def __exit__(self, *a: Any) -> None:
        if self.svc is not None:
            run(self.svc.stop())


# -- the ticket and the open -------------------------------------------------------------------------


def test_the_socket_offers_the_protocol_then_the_ticket_and_a_new_ticket_each_connect() -> None:
    with Rig() as r:
        r.ready()
        proto, ticket = r.room.offered[0]
        assert proto == "pkey-relay.1" and re.fullmatch(r"pkeyrt_[A-Za-z0-9_-]{32}", ticket)
        assert r.room.ever[0].url == "wss://k.test/djdl/connect/relay"
        r.room.drop_all(None)
        r.wake()
        until(lambda: len(r.room.offered) == 2)
        assert r.room.offered[1][1] != ticket and r.room.issued == 2


def test_on_open_it_asks_for_the_members_and_reports_them() -> None:
    with Rig(members={ID_A, ID_B}) as r:
        svc = r.ready()
        assert r.states[-1] == "open" and svc.status.attempts == 0 and svc.status.error is None
        until(lambda: svc.members() == [ID_A])
        assert [m["op"] for d, m in r.room.received][:1] == ["list"]
        # A second device arrives: the room never pushes joins, so the device asks.
        r2 = Rig(device=ID_B)
        r2.room = r.room
        r2.ready()
        got = run(svc.refresh_members(3))
        assert sorted(got) == sorted([ID_A, ID_B])
        run(r2.svc.stop())  # type: ignore[union-attr]


def test_a_ping_is_answered_and_listed_on_every_interval() -> None:
    with Rig() as r:
        r.ready()
        until(lambda: any(s == PING for s, _ in r.sleep.pending))
        n = len(r.room.received)
        assert r.on_loop(lambda: r.sleep.fire(lambda s: s == PING))
        until(lambda: len(r.room.received) >= n + 2)
        assert [m["op"] for _, m in r.room.received[n : n + 2]] == ["ping", "list"]
        assert len(r.room.received[n][1]["data"]) == 8


def test_members_changes_and_gone_are_reported() -> None:
    with Rig() as r:
        svc = r.ready()
        seen: List[List[str]] = []
        svc.on_members(seen.append)
        until(lambda: svc.members() == [ID_A])
        r.room.push(ID_A, {"op": "gone", "device": b64url_decode(ID_A)})
        until(lambda: svc.members() == [])
        assert seen[-1] == []


# -- reconnect and the typed stops -------------------------------------------------------------------


def test_reconnects_with_a_growing_jittered_backoff_that_resets_only_after_a_stable_open() -> None:
    with Rig() as r:
        svc = r.ready()
        r.room.drop_all(None)
        r.wake()
        until(lambda: len(r.room.offered) == 2)
        r.room.drop_all(None)
        r.wake()
        until(lambda: len(r.room.offered) == 3)
        r.room.drop_all(None)
        r.wake()
        until(lambda: len(r.room.offered) == 4)
        # Equal jitter at random() = 0.5: 0.75, 1.5, 3.0.
        assert r.backoff_delays()[:3] == [0.75, 1.5, 3.0]
        assert svc.status.attempts == 3
        # A socket that stays up for 30 seconds resets the backoff.
        until(lambda: svc.status.state == "open")
        r.clock.t += 31
        r.room.drop_all(None)
        r.wake()
        until(lambda: len(r.room.offered) == 5)
        assert r.backoff_delays()[3] == 0.75


def test_a_room_close_before_open_with_4001_gets_a_new_ticket_after_the_backoff() -> None:
    with Rig() as r:
        r.room.reject_with = 4001
        r.start()
        r.wake()
        run(r.svc.ready(5))  # type: ignore[union-attr]
        assert len(r.room.offered) == 2 and r.room.issued == 2


def test_a_dropped_socket_reconnects_and_ready_waits_for_it() -> None:
    with Rig() as r:
        svc = r.ready()
        r.room.drop_all(1006)
        until(lambda: svc.status.state == "backoff")
        r.wake()
        run(svc.ready(5))


def test_4009_stops_without_fighting_back() -> None:
    with Rig() as r:
        svc = r.ready()
        r.room.drop_all(4009)
        until(lambda: svc.status.state == "blocked")
        assert svc.status.error is not None and svc.status.error.reason == "replaced"
        assert svc.status.error.close_code == 4009
        with pytest.raises(RelayError) as e:
            run(svc.ready(1))
        assert e.value.reason == "replaced"
        time.sleep(0.1)
        assert len(r.room.offered) == 1


def test_the_third_socket_of_a_device_replaces_the_oldest_with_4009() -> None:
    with Rig() as r:
        svc = r.ready()
        other = Rig()
        other.room = r.room
        other.ready()
        third = Rig()
        third.room = r.room
        third.ready()
        until(lambda: svc.status.state == "blocked")
        assert svc.status.error is not None and svc.status.error.reason == "replaced"
        run(other.svc.stop())  # type: ignore[union-attr]
        run(third.svc.stop())  # type: ignore[union-attr]


@pytest.mark.parametrize("reason,scope", [("disabled", None), ("quota", "person"), ("quota", "product")])
def test_a_product_that_turned_the_relay_off_or_a_spent_quota_ends_the_loop(reason: str, scope: Optional[str]) -> None:
    with Rig() as r:
        r.errors.append(RelayError(reason, "no", scope=scope, status=403))
        svc = r.start()
        until(lambda: svc.status.state == "blocked")
        assert svc.status.error is not None and svc.status.error.reason == reason
        assert svc.status.error.scope == scope
        with pytest.raises(RelayError) as e:
            run(svc.ready(1))
        assert e.value.reason == reason
        assert r.room.offered == []  # no socket was opened


def test_resume_after_a_block_tries_again() -> None:
    with Rig() as r:
        r.errors.append(RelayError("quota", "spent", scope="person"))
        svc = r.start()
        until(lambda: svc.status.state == "blocked")
        r.on_loop(svc.resume)
        run(svc.ready(5))
        assert svc.status.error is None


def test_a_paused_relay_waits_for_retry_after_capped_at_an_hour() -> None:
    with Rig() as r:
        r.errors.append(RelayError("paused", "paused", retry_after_seconds=300, status=503))
        r.errors.append(RelayError("paused", "paused", retry_after_seconds=10**9, status=503))
        svc = r.start()
        until(lambda: any(s != PING for s, _ in r.sleep.pending))
        assert r.backoff_delays() == [300]
        r.wake()
        until(lambda: len(r.backoff_delays()) == 2)
        assert r.backoff_delays()[1] == 3600
        r.wake()
        run(svc.ready(5))


def test_a_limit_for_the_product_then_4008_is_a_typed_quota_stop() -> None:
    with Rig() as r:
        svc = r.ready()
        r.room.push(ID_A, {"op": "limit", "reason": 3})
        until(lambda: svc.status.error is not None and svc.status.error.reason == "quota")
        assert svc.status.error is not None and svc.status.error.scope == "product"
        r.room.drop_all(4008)
        until(lambda: svc.status.state == "blocked")
        assert svc.status.error is not None and svc.status.error.scope == "product"
        assert svc.status.error.close_code == 4008


def test_a_4008_after_a_rate_limit_or_with_no_limit_backs_off_instead() -> None:
    with Rig() as r:
        svc = r.ready()
        r.room.push(ID_A, {"op": "limit", "reason": 1})
        until(lambda: svc.status.error is not None and svc.status.error.reason == "rate_limited")
        r.room.drop_all(4008)
        until(lambda: svc.status.state == "backoff")
        r.wake()
        run(svc.ready(5))
        assert svc.status.error is None  # the last LIMIT is cleared on reopen
        r.room.drop_all(4008)
        until(lambda: svc.status.state == "backoff")


def test_a_paused_limit_is_reported_and_the_socket_stays() -> None:
    with Rig() as r:
        svc = r.ready()
        r.room.push(ID_A, {"op": "limit", "reason": 4})
        until(lambda: svc.status.error is not None and svc.status.error.reason == "paused")
        assert svc.status.state == "open"


def test_4003_fetches_the_roster_and_stops_after_three_in_a_row() -> None:
    with Rig(members=set()) as r:
        svc = r.start()
        for n in range(1, 3):
            until(lambda n=n: len(r.room.offered) == n)
            until(lambda: svc.status.state == "backoff" and r.sleep.pending)
            r.wake()
        until(lambda: svc.status.state == "blocked")
        assert svc.status.error is not None and svc.status.error.reason == "not_member"
        until(lambda: r.refreshes >= 1)


def test_five_attempts_that_never_open_make_the_relay_unavailable_and_slow_the_retries() -> None:
    with Rig() as r:
        for _ in range(7):
            r.errors.append(RelayError("unavailable", "down"))
        svc = r.start()
        for n in range(1, 5):
            until(lambda n=n: svc.status.attempts == n and r.sleep.pending)
            assert svc.status.state == "backoff"
            r.wake()
        until(lambda: svc.status.attempts == 5 and svc.status.state == "unavailable")
        assert r.backoff_delays()[-1] >= 300
        r.wake()
        until(lambda: svc.status.attempts == 6)
        assert r.backoff_delays()[-1] >= 300 and svc.status.state == "unavailable"


# -- refused envelopes ------------------------------------------------------------------------------


def test_an_envelope_that_does_not_match_its_layout_closes_1002_and_nothing_is_answered() -> None:
    for bad in (b"\xff\x00", b"\x82\x05\x00", b"", "text frame", b"\x81" + b"\x00" * RELAY_MAX_MESSAGE):
        with Rig() as r:
            svc = r.ready()
            until(lambda svc=svc: svc.members() == [ID_A])
            n = len(r.room.received)
            sock = r.room.sockets[0]
            r.room.push(ID_A, bad)
            until(lambda sock=sock: sock.closed)
            assert sock.close_code == 1002
            time.sleep(0.05)
            assert len(r.room.received) == n
            until(lambda svc=svc: svc.status.state == "backoff")


def test_a_bad_room_message_is_not_a_crash_for_the_next_socket() -> None:
    with Rig() as r:
        svc = r.ready()
        r.room.push(ID_A, b"\xff")
        until(lambda: svc.status.state == "backoff")
        r.wake()
        run(svc.ready(5))


# -- pushed documents -------------------------------------------------------------------------------


def test_a_relay_ring_above_the_held_epoch_fetches_the_roster_and_one_at_it_does_not() -> None:
    with Rig() as r:
        svc = r.ready()
        until(lambda: svc.members() == [ID_A])
        r.room.push_ring(1)  # the held epoch is 1
        time.sleep(0.3)
        assert r.refreshes == 0
        r.room.push_ring(2)
        until(lambda: r.refreshes == 1)


# -- stopping and the surface -----------------------------------------------------------------------


def test_stop_closes_the_socket_and_ready_then_raises_stopped() -> None:
    r = Rig()
    svc = r.ready()
    sock = r.room.sockets[0]
    run(svc.stop())
    assert sock.closed and sock.close_code == 1000
    assert svc.status.state == "stopped" and svc.members() == []
    with pytest.raises(RelayError) as e:
        run(svc.ready(1))
    assert e.value.reason == "stopped"
    run(svc.stop())  # twice is fine


def test_ready_times_out_with_not_connected_when_nothing_opens() -> None:
    async def never(url: str, protocols: List[str]) -> Any:
        await asyncio.sleep(3600)

    with Rig() as r:
        r.opts = {}
        src = r.world.source(r.world.a)

        async def go() -> None:
            svc = RelayService(src, r._ticket, RelayOptions(opener=never, sleep=r.sleep, open_seconds=0.2))
            r.svc = svc
            await svc.ready(0.3)

        with pytest.raises(RelayError) as e:
            run(go())
        assert e.value.reason == "not_connected"


def test_only_mode_a_may_cross_the_relay() -> None:
    assert assert_relay_mode("a") == "a"
    for mode in ("v", "p", "c", ""):
        with pytest.raises(RelayError) as e:
            assert_relay_mode(mode)
        assert e.value.reason == "mode_not_allowed"


def test_a_service_does_not_leak_through_repr_or_pickle() -> None:
    import pickle

    with Rig() as r:
        svc = r.ready()
        ticket = r.room.offered[0][1]
        assert ticket not in repr(svc) and ticket not in repr(svc.status)
        with pytest.raises(TypeError):
            pickle.dumps(svc)


# -- the optional dependency ------------------------------------------------------------------------


def test_without_the_extra_the_relay_is_off_with_reason_dependency() -> None:
    async def missing(url: str, protocols: List[str]) -> Any:
        raise RelayDependencyMissing("websockets is not installed")

    w = World()

    async def go() -> RelayService:
        svc = RelayService(w.source(w.a), lambda: FakeRoom({ID_A}).issue(ID_A), RelayOptions(opener=missing))
        svc.start()
        return svc

    svc = run(go())
    until(lambda: svc.status.state == "off")
    assert svc.status.reason == "dependency"
    with pytest.raises(RelayError):
        run(svc.ready(1))
    run(svc.stop())


def test_the_default_opener_reports_a_missing_websockets_package(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "websockets", None)
    monkeypatch.setitem(sys.modules, "websockets.asyncio", None)
    monkeypatch.setitem(sys.modules, "websockets.asyncio.client", None)
    with pytest.raises(RelayDependencyMissing):
        run(websockets_opener()("wss://k.test/x", ["pkey-relay.1", "pkeyrt_" + "A" * 32]))


def test_importing_the_relay_module_does_not_import_websockets() -> None:
    import subprocess

    out = subprocess.run(
        [sys.executable, "-c", "import sys, polaris_key.connect.relay; print('websockets' in sys.modules)"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert out == "False"


# -- the default opener against a real loopback server ----------------------------------------------

import importlib.util  # noqa: E402

needs_ws = pytest.mark.skipif(
    importlib.util.find_spec("websockets") is None, reason="the connect extra is not installed"
)


def _serve(handler: Any, subprotocols: Any = ("pkey-relay.1",)) -> Any:
    from websockets.asyncio.server import serve

    async def go() -> Any:
        server = await serve(handler, "127.0.0.1", 0, subprotocols=list(subprotocols), max_size=None)
        return server, server.sockets[0].getsockname()[1]

    return run(go())


@needs_ws
def test_the_default_opener_negotiates_the_protocol_and_carries_binary_messages(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen: List[Any] = []
    ticket = "pkeyrt_" + "Z" * 32

    async def handler(ws: Any) -> None:
        seen.append((ws.subprotocol, ws.request.headers.get("Sec-WebSocket-Protocol")))
        m = await ws.recv()
        await ws.send(m[::-1])
        await ws.close(4008)

    server, port = _serve(handler)

    async def go() -> Any:
        sock = await websockets_opener(5)("ws://127.0.0.1:%d/x" % port, ["pkey-relay.1", ticket])
        await sock.send(b"abc")
        got = await sock.recv()
        with pytest.raises(SocketClosed) as e:
            await sock.recv()
        return got, e.value.code

    with caplog.at_level(logging.DEBUG):
        got, code = run(go())
    assert got == b"cba" and code == 4008
    assert seen[0][0] == "pkey-relay.1" and ticket in seen[0][1]
    client_logs = [r for r in caplog.records if not r.name.startswith("websockets.server")]
    assert all(ticket not in r.getMessage() for r in client_logs)
    assert not [r for r in client_logs if r.name.startswith("websockets.client")]
    run(_close(server))


async def _close(server: Any) -> None:
    server.close()
    await server.wait_closed()


@needs_ws
def test_the_default_opener_refuses_a_server_that_does_not_echo_the_protocol() -> None:
    async def handler(ws: Any) -> None:
        await asyncio.sleep(1)

    from websockets.asyncio.server import serve

    async def start() -> Any:
        s = await serve(handler, "127.0.0.1", 0)  # no subprotocol offered back
        return s, s.sockets[0].getsockname()[1]

    server, port = run(start())
    with pytest.raises(SocketClosed):
        run(websockets_opener(5)("ws://127.0.0.1:%d/x" % port, ["pkey-relay.1", "pkeyrt_" + "A" * 32]))
    run(_close(server))


@needs_ws
def test_the_default_opener_refuses_an_oversize_message_and_an_unreachable_host() -> None:
    async def handler(ws: Any) -> None:
        await ws.send(b"x" * (RELAY_MAX_MESSAGE + 1))

    server, port = _serve(handler)

    async def go() -> Optional[int]:
        sock = await websockets_opener(5)("ws://127.0.0.1:%d/x" % port, ["pkey-relay.1", "pkeyrt_" + "A" * 32])
        try:
            await sock.recv()
        except SocketClosed as e:
            return e.code
        return -1

    assert run(go()) == 1009
    run(_close(server))
    with pytest.raises(SocketClosed) as e:
        run(websockets_opener(2)("ws://127.0.0.1:1/x", ["pkey-relay.1", "pkeyrt_" + "A" * 32]))
    assert e.value.code is None


@needs_ws
def test_the_default_opener_never_follows_a_redirect_so_the_ticket_stays_on_one_host() -> None:
    # G13: websockets 15+ follows a 3xx to another origin and re-sends Sec-WebSocket-Protocol (the ticket).
    hits: List[str] = []

    async def go() -> Any:
        async def second(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
            hits.append((await r.read(4096)).decode("latin-1"))
            w.close()

        s2 = await asyncio.start_server(second, "127.0.0.1", 0)
        p2 = s2.sockets[0].getsockname()[1]

        async def first(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
            await r.readuntil(b"\r\n\r\n")
            head = "HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:%d/y\r\nContent-Length: 0\r\n" % p2
            w.write((head + "Connection: close\r\n\r\n").encode())
            await w.drain()
            w.close()

        s1 = await asyncio.start_server(first, "127.0.0.1", 0)
        p1 = s1.sockets[0].getsockname()[1]
        try:
            with pytest.raises(SocketClosed) as e:
                await websockets_opener(5)("ws://127.0.0.1:%d/x" % p1, ["pkey-relay.1", "pkeyrt_" + "A" * 32])
            await asyncio.sleep(0.1)
            return e.value.code
        finally:
            s1.close()
            s2.close()

    assert run(go()) is None
    assert hits == []
