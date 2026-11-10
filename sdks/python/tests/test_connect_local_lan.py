# @pkey-feature connect.local
"""Local links over the LAN, mode ``l`` (CC-29.9; WIRE-CONTRACT-V5 §15.5, §15.11, §15.12) end to end in one
process: two clients with no credential and a link between them, the shared listener with no account, the
``m=l`` adverts, ``open`` and ``on_link``, the gate's effects, ``remove`` and Direct Transfer under a link, the
listener that binds nothing until a link is held, the hourly last-seen, the gate's re-read and the single-flight,
cooled-down dial. Mirrors Node's ``localLinksLan.test.ts`` and ``localLinksOpen.test.ts``. Clocks and timers are
injected; a test waits on a condition, never on a deadline."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Callable, List, Tuple

import pytest
from test_connect_lan import until
from test_connect_local import LOOP, T0, World, dial, pair_up, show

from polaris_key.connect.errors import LanError
from polaris_key.connect.local_links import reset_local_budgets
from polaris_key.connect.transfer import Accept, IncomingOffer
from polaris_key.core.caps import UnsupportedError
from polaris_key.core.errors import PolarisError


@pytest.fixture(autouse=True)
def _fresh_budgets() -> Any:
    reset_local_budgets()
    yield
    reset_local_budgets()


@pytest.fixture
def world(tmp_path: Path) -> Any:
    w = World(tmp_path)
    yield w
    for c in w.clients:
        try:
            c.cloud_connect.stop()
        except Exception:
            pass
    w.close()


def opts(w: World) -> dict:
    return {"lan": {"mdns": w.net, "host": "127.0.0.1", "allow_loopback": True}, "relay": False}


def linked(w: World, cats: Tuple[str, ...] = ("notes", "docs")) -> Tuple[str, str]:
    """A link between a and b; returns each side's id for the other."""
    s = show(w, w.a, ["notes"])
    pair_up(w, s, {"code": s.codes[0].code})
    until(lambda: not s.handle.open)
    return w.a.cloud_connect.local_links.list()[0].id, w.b.cloud_connect.local_links.list()[0].id


def m_l(w: World) -> List[Any]:
    return [a for a in w.net.adverts.values() if "m=l" in a.txt]


def open_when_seen(c: Any, link: str) -> Any:
    out: List[Any] = []

    def go() -> bool:
        try:
            out.append(c.cloud_connect.local_links.open(link))
            return True
        except LanError:
            return False

    until(go)
    return out[0]


def test_adverts_are_m_l_for_the_reachable_links_with_exactly_v_and_m(world: World) -> None:
    w = world
    ida, idb = linked(w)
    assert m_l(w) == []  # nothing runs before start
    w.a.cloud_connect.start(opts(w))
    w.b.cloud_connect.start(opts(w))
    until(lambda: len(m_l(w)) == 2)
    for a in m_l(w):
        assert a.txt == ["v=1", "m=l"]
    assert not [a for a in w.net.adverts.values() if "m=a" in a.txt or "m=c" in a.txt]
    # Turning the link off withdraws its advert; on again brings it back.
    assert w.a.cloud_connect.local_links.set_reachable(ida, False) is True
    until(lambda: len(m_l(w)) == 1)
    assert w.a.cloud_connect.local_links.set_reachable(ida, True) is True
    until(lambda: len(m_l(w)) == 2)
    assert w.a.cloud_connect.local_links.set_reachable("x" * 16, True) is False


def test_a_session_opens_both_ways_with_the_stored_labels_and_categories_and_last_seen(world: World) -> None:
    w = world
    ida, idb = linked(w)
    w.a.cloud_connect.start(opts(w))
    w.b.cloud_connect.start(opts(w))
    inbound: List[Any] = []
    w.a.cloud_connect.local_links.on_link(inbound.append)
    s = open_when_seen(w.b, idb)
    until(lambda: inbound)
    assert s.path == "lan" and s.local is not None and s.local.id == idb and s.peer_device_id == ""
    assert s.local.label == "Ana" and s.local.categories == ("notes",) and s.contact is None
    assert inbound[0].local.id == ida and inbound[0].local.label == "Bo"
    s.send(b"hello")
    assert inbound[0].receive(5).body == b"hello"
    inbound[0].send(b"back")
    assert s.receive(5).body == b"back"
    # The last-seen time is written once an hour, coarsened to the hour.
    until(lambda: w.b.cloud_connect.local_links.list()[0].last_seen is not None)
    assert w.b.cloud_connect.local_links.list()[0].last_seen % 3600 == 0
    s.close()


def test_a_session_nobody_takes_is_closed_peer_bye(world: World) -> None:
    w = world
    _ida, idb = linked(w)
    w.a.cloud_connect.start(opts(w))
    w.b.cloud_connect.start(opts(w))
    # A has no on_link subscriber and no Direct Transfer handler.
    s = open_when_seen(w.b, idb)
    closed: List[Any] = []
    s.on_close(closed.append)
    until(lambda: closed)
    assert closed[0].code in ("peer_bye", "connection_lost")


def test_remove_from_the_loop_thread_drops_the_link_before_it_returns(world: World) -> None:
    from polaris_key.connect.loop import connect_loop

    w = world
    ida, _idb = linked(w)
    w.a.cloud_connect.start(opts(w))
    lan = w.a.cloud_connect._lan
    assert lan is not None and any(x.id == ida for x in lan._locals)
    seen: List[Any] = []

    async def inside() -> None:
        w.a.cloud_connect.local_links.remove(ida)
        seen.append(any(x.id == ida for x in lan._locals))

    connect_loop().submit(inside()).result(10)
    assert seen == [False]


def test_a_gate_that_clears_withdraws_the_adverts_ends_the_sessions_and_serves_nothing(world: World) -> None:
    w = world
    ida, idb = linked(w)
    w.a.cloud_connect.start(opts(w))
    w.b.cloud_connect.start(opts(w))
    inbound: List[Any] = []
    w.a.cloud_connect.local_links.on_link(inbound.append)
    s = open_when_seen(w.b, idb)
    until(lambda: inbound)
    closed: List[Any] = []
    s.on_close(closed.append)
    w.disco.local = False
    w.a.discover()
    w.b.discover()
    until(lambda: closed)
    assert closed[0].code in ("peer_bye", "connection_lost")
    until(lambda: m_l(w) == [])
    # The typed N/A, and the listing and the rename still work.
    with pytest.raises(UnsupportedError) as e:
        w.b.cloud_connect.local_links.open(idb)
    assert e.value.code == "local-pairing-off"
    assert len(w.b.cloud_connect.local_links.list()) == 1
    assert w.b.cloud_connect.local_links.rename(idb, "Neighbour") is True
    # Back on: the adverts are published again, and a session opens.
    # (b first, and a only once b's own advert shows its list is loaded: a name announced while a side's
    # list is empty is not announced again on this fake network, as a real browse would ask again.)
    w.disco.local = True
    w.b.discover()
    until(lambda: len(m_l(w)) == 1)
    w.a.discover()
    until(lambda: len(m_l(w)) == 2)
    open_when_seen(w.b, idb).close()


def test_remove_ends_the_sessions_peer_revoked_and_the_peers_next_dial_is_refused(world: World) -> None:
    w = world
    ida, idb = linked(w)
    w.a.cloud_connect.start(opts(w))
    w.b.cloud_connect.start(opts(w))
    inbound: List[Any] = []
    w.a.cloud_connect.local_links.on_link(inbound.append)
    s = open_when_seen(w.b, idb)
    until(lambda: inbound)
    ca: List[Any] = []
    inbound[0].on_close(ca.append)
    store = w.a.connect.local_store()
    row = store.rows()[0]
    assert w.a.cloud_connect.local_links.remove(ida) is True
    until(lambda: ca)
    assert ca[0].code == "peer_revoked"
    # Its keys left the record before remove returned, and its advert is gone.
    assert store.rows() == [] and row.secret not in repr(store.rows())
    until(lambda: len(m_l(w)) == 1)
    s.close()
    # The peer still holds the link; its dial now finds nobody answering under it.
    with pytest.raises(LanError):
        w.b.cloud_connect.local_links.open(idb)


def test_rename_is_local_only_and_a_dial_right_after_remove_is_refused(world: World) -> None:
    w = world
    ida, idb = linked(w)
    w.a.cloud_connect.start(opts(w))
    w.b.cloud_connect.start(opts(w))
    open_when_seen(w.b, idb).close()
    assert w.b.cloud_connect.local_links.remove(idb) is True
    with pytest.raises(LanError) as e:
        w.b.cloud_connect.local_links.open(idb)
    # The link is gone at once; with it the last link's listener (which waits for the next link) may be too.
    assert e.value.reason in ("unknown_peer", "not_started")


def test_direct_transfer_rides_a_local_link_with_the_category_rule(world: World, tmp_path: Path) -> None:
    w = world
    ida, idb = linked(w)
    w.a.cloud_connect.start(opts(w))
    w.b.cloud_connect.start(opts(w))
    dest = tmp_path / "got.bin"
    asked: List[IncomingOffer] = []

    def handler(o: IncomingOffer) -> Accept:
        asked.append(o)
        return Accept(str(dest))

    w.a.cloud_connect.transfer.on_offer(handler)
    link_b = w.b.cloud_connect.local_links.list()[0]
    until(lambda: bool(w.b.cloud_connect.local_links.has(idb)) and len(m_l(w)) == 2)
    data = bytes(((i * 7 + 13) & 0xFF) for i in range(100_000))

    def send(cat: str) -> Any:
        end = [None]

        def go() -> bool:
            try:
                end[0] = w.b.cloud_connect.transfer.send(link_b, data, name="d.bin", cat=cat)
                return True
            except LanError:
                return False

        until(go)
        return end[0]

    res = send("notes").wait(20)
    assert res.outcome == "delivered", res
    assert dest.read_bytes() == data
    # The offer came over the local link: its id names it, and it names no device.
    assert asked[0].local_id == ida and asked[0].peer_device_id == "" and asked[0].contact_id is None
    # A category the link does not hold is refused before the person is asked.
    before = len(asked)
    assert send("music").wait(20).reason in ("category", "declined", "refused")
    assert len(asked) == before


def test_a_start_with_no_account_binds_no_listener_until_a_link_is_held(world: World) -> None:
    w = world
    w.a.cloud_connect.start(opts(w))
    st = w.a.cloud_connect.status()
    assert st.running is True and st.lan == "off" and w.net.adverts == {}
    # The first link brings the listener up, the last one forgotten takes it down.
    s = show(w, w.a, ["notes"])
    pair_up(w, s, {"code": s.codes[0].code})
    until(lambda: w.a.cloud_connect.status().lan == "on")
    until(lambda: len(m_l(w)) >= 1)
    (info,) = w.a.cloud_connect.local_links.list()
    assert w.a.cloud_connect.local_links.remove(info.id) is True
    until(lambda: w.a.cloud_connect.status().lan == "off")
    until(lambda: m_l(w) == [])


def test_a_start_with_no_account_and_the_gate_off_is_still_no_token(tmp_path: Path) -> None:
    w = World(tmp_path, local=False)
    try:
        with pytest.raises(PolarisError) as e:
            w.a.cloud_connect.start(opts(w))
        assert e.value.code == "no-token"
        assert w.a.cloud_connect.status().running is False
    finally:
        w.close()


def test_new_links_are_reachable_by_default_while_fewer_than_eight_are_and_a_ninth_is_refused(world: World) -> None:
    w = world
    store = w.a.connect.local_store()
    for i in range(9):
        ok, _id = store.add(
            own_key=bytes([1]) * 32, own_public=bytes([2]) * 32, peer_key=bytes([i + 1]) + bytes([9]) * 31,
            secret=bytes([4]) * 32, cats=[], now=T0,
        )
        assert ok
    infos = w.a.cloud_connect.local_links.list()
    assert [x.reachable for x in infos] == [True] * 8 + [False]
    with pytest.raises(PolarisError) as e:
        w.a.cloud_connect.local_links.set_reachable(infos[8].id, True)
    assert e.value.code == "local-links-full"
    assert w.a.cloud_connect.local_links.set_reachable(infos[0].id, False) is True
    assert w.a.cloud_connect.local_links.set_reachable(infos[8].id, True) is True


# -- the gate's re-read ---------------------------------------------------------------------------------


class _Timers:
    def __init__(self) -> None:
        self.armed: List[Tuple[Callable[[], None], float]] = []
        self.cancelled = 0

    def __call__(self, fn: Callable[[], None], seconds: float) -> Any:
        self.armed.append((fn, seconds))
        me = self

        class T:
            def cancel(self) -> None:
                me.cancelled += 1

        return T()


def test_the_gate_is_read_again_every_one_to_four_hours_while_it_is_on(world: World) -> None:
    w = world
    t = _Timers()
    w.a._local_timer = t
    w.a._local_after = t  # the wait itself, without the clock's checks
    w.a.discover()
    assert len(t.armed) >= 1
    lo, hi = 3600.0, 4 * 3600.0
    assert all(lo <= secs < hi for _f, secs in t.armed)
    # The timer fires: discovery is read again and the next read armed; the jitter is the injected function's.
    w.a._local_reread_s = lambda: 5000.0
    before = len(t.armed)
    t.armed[-1][0]()
    assert len(t.armed) == before + 1 and t.armed[-1][1] == 5000.0
    # Off clears it: nothing is armed once the gate is off.
    w.disco.local = False
    before = len(t.armed)
    t.armed[-1][0]()
    assert len(t.armed) == before
    assert w.a.cloud_connect.local_links.local_pairing() is False


def test_the_wait_before_a_read_runs_on_a_clock_that_counts_a_sleep(world: World) -> None:
    w = world
    t = _Timers()
    now = [1000.0]
    w.a._local_timer = t
    w.a._local_clock = lambda: now[0]
    w.a._local_reread_s = lambda: 5000.0
    w.a.discover()
    # The wait is a deadline: the timer that fires is a short check, not the whole wait.
    assert t.armed[-1][1] == w.a._local_check_s
    w.disco.local = False
    # A check before the deadline reads nothing and arms the next one.
    armed = len(t.armed)
    t.armed[-1][0]()
    assert len(t.armed) == armed + 1
    assert w.a.cloud_connect.local_links.local_pairing() is True
    # The machine slept through the wait (no timer ran, the clock moved): the next check reads discovery.
    now[0] += 5001.0
    t.armed[-1][0]()
    assert w.a.cloud_connect.local_links.local_pairing() is False


def test_a_read_that_says_nothing_is_read_again_in_5_then_10_then_every_15_minutes(world: World) -> None:
    w = world
    t = _Timers()
    w.a._local_timer = t
    w.a._local_after = t  # the wait itself, without the clock's checks
    w.a.discover()
    w.disco.status = 503
    seen: List[float] = []
    for _ in range(4):
        w.a._local_retry = None
        w.a.discover()
        seen.append([s for f, s in t.armed if s < 3600][-1])
    assert seen == [300.0, 600.0, 900.0, 900.0]
    assert w.a.cloud_connect.local_links.local_pairing() is True


# -- the dial ---------------------------------------------------------------------------------------------


class _Sess:
    local = None

    def __init__(self) -> None:
        self.closers: List[Callable[[Any], None]] = []

    def on_close(self, fn: Callable[[Any], None]) -> Callable[[], None]:
        self.closers.append(fn)
        return lambda: None

    def close(self, code: str = "peer_bye") -> None:
        return None


class _FakeLan:
    def __init__(self) -> None:
        self.calls = 0
        self.release: Any = None
        self.error: Any = None
        self.session = _Sess()

    def on_local_session(self, fn: Callable[[Any], None]) -> Callable[[], None]:
        return lambda: None

    async def connect_local(self, link_id: str) -> Any:
        self.calls += 1
        if self.release is not None:
            await self.release.wait()
        if self.error is not None:
            raise self.error
        return self.session


def _fake_dialler(w: World) -> Tuple[Any, _FakeLan, str, List[float]]:
    """The links facade on a fake LAN service, with a held link, a clock and a jitter in the test's hands."""
    c = w.a
    links = c.cloud_connect.local_links
    ok, lid = c.connect.local_store().add(
        own_key=bytes([1]) * 32, own_public=bytes([2]) * 32, peer_key=bytes([3]) * 32, secret=bytes([4]) * 32,
        cats=[], now=T0,
    )
    assert ok
    clock = [100.0]
    links._mono = lambda: clock[0]
    links._rand = lambda: 0.5
    lan = _FakeLan()
    c.cloud_connect._read(lambda: links.attach(lan))  # type: ignore[arg-type]
    return links, lan, lid, clock


def test_open_is_single_flight_per_link_and_callers_share_the_session(world: World) -> None:
    w = world
    links, lan, lid, _clock = _fake_dialler(w)
    lan.release = w.a.cloud_connect._read(lambda: asyncio.Event())
    f1, f2 = w.pool.submit(links.open, lid), w.pool.submit(links.open, lid)
    until(lambda: lan.calls >= 1)
    w.a.cloud_connect._read(lan.release.set)
    assert f1.result(10) is f2.result(10) is lan.session
    assert lan.calls == 1


def test_a_failed_dial_is_held_off_with_backoff_and_a_success_clears_it(world: World) -> None:
    w = world
    links, lan, lid, clock = _fake_dialler(w)
    lan.error = LanError("handshake_failed", "no")
    with pytest.raises(LanError) as e:
        links.open(lid)
    assert e.value.reason == "handshake_failed"
    # 3 s plus the jitter (here 1 s): the same dial again at once is refused as busy.
    with pytest.raises(LanError) as e2:
        links.open(lid)
    assert e2.value.reason == "busy" and e2.value.code == "peer_busy" and lan.calls == 1
    clock[0] += 3.9
    with pytest.raises(LanError) as e3:
        links.open(lid)
    assert e3.value.reason == "busy"
    clock[0] += 0.2
    with pytest.raises(LanError) as e4:
        links.open(lid)
    assert e4.value.reason == "handshake_failed" and lan.calls == 2
    # The second failure in a row doubles the wait: 8 s.
    clock[0] += 7.9
    with pytest.raises(LanError) as e5:
        links.open(lid)
    assert e5.value.reason == "busy"
    clock[0] += 0.2
    lan.error = None
    assert links.open(lid) is lan.session
    # A success clears it: the next dial after a failure waits the base again.
    lan.error = LanError("connect_failed", "no")
    with pytest.raises(LanError):
        links.open(lid)
    clock[0] += 4.1
    lan.error = None
    assert links.open(lid) is lan.session


def test_a_link_not_seen_yet_is_no_attempt_and_is_not_held_off(world: World) -> None:
    w = world
    links, lan, lid, _clock = _fake_dialler(w)
    lan.error = LanError("unknown_peer", "not seen")
    for _ in range(3):
        with pytest.raises(LanError) as e:
            links.open(lid)
        assert e.value.reason == "unknown_peer"
    assert lan.calls == 3


def test_the_cooldown_is_per_link(world: World) -> None:
    w = world
    links, lan, lid, _clock = _fake_dialler(w)
    ok, other = w.a.connect.local_store().add(
        own_key=bytes([1]) * 32, own_public=bytes([2]) * 32, peer_key=bytes([8]) * 32, secret=bytes([4]) * 32,
        cats=[], now=T0,
    )
    lan.error = LanError("handshake_failed", "no")
    with pytest.raises(LanError):
        links.open(lid)
    with pytest.raises(LanError) as e:
        links.open(other)
    assert e.value.reason == "handshake_failed" and lan.calls == 2


def test_a_dial_for_an_id_that_is_no_link_or_before_start_is_typed(world: World) -> None:
    w = world
    with pytest.raises(LanError) as e:
        w.a.cloud_connect.local_links.open("x" * 16)
    assert e.value.reason == "not_started"
    links, _lan, _lid, _clock = _fake_dialler(w)
    with pytest.raises(LanError) as e2:
        links.open("y" * 16)
    assert e2.value.reason == "unknown_peer"


def test_a_session_whose_link_was_forgotten_while_it_dialled_is_closed_not_adopted(world: World) -> None:
    w = world
    links, lan, lid, _clock = _fake_dialler(w)
    lan.release = w.a.cloud_connect._read(lambda: asyncio.Event())

    class Held(_Sess):
        def __init__(self, ref: Any) -> None:
            super().__init__()
            self.local = ref
            self.closed: List[str] = []

        def close(self, code: str = "peer_bye") -> None:
            self.closed.append(code)

    from polaris_key.connect.local_state import LocalRef

    sess = Held(LocalRef(lid, None, (), "A" * 43, "tag-that-is-not-held"))
    lan.session = sess  # type: ignore[assignment]
    f = w.pool.submit(links.open, lid)
    until(lambda: lan.calls == 1)
    w.a.cloud_connect._read(lan.release.set)
    with pytest.raises(LanError) as e:
        f.result(10)
    assert e.value.reason == "unknown_peer" and sess.closed == ["peer_revoked"]


def test_pair_and_join_take_the_gate_synchronously_and_a_second_pair_meets_the_first(world: World) -> None:
    w = world
    with pytest.raises(UnsupportedError):
        # No discovery for this client: off, before anything is advertised.
        fresh = w.device("z", discover=False)
        fresh.cloud_connect.local_links.pair(categories=[], on_code=lambda c: None, on_confirm=lambda o: None)
    s = show(w, w.a, ["notes"])
    assert s.handle.open is True
    with pytest.raises(LanError):
        show(w, w.a, ["notes"])
    # A join with the other client for a code that is not there ends in not-found, never a hang.
    j = dial(w, w.b, {"code": "9999 9999"}, cats=["notes"], timer=lambda fn, s: (fn(), lambda: None)[1])
    with pytest.raises(PolarisError) as e:
        j.result(10)
    assert e.value.code == "pairing-not-found"
    assert LOOP["allow_loopback"] is True


# -- an account and a sign-out --------------------------------------------------------------------------


def test_the_shared_listener_with_an_account_and_a_sign_out_that_keeps_the_link_reachable(
    world: World, tmp_path: Path
) -> None:
    import time

    from helpers import make_client
    from test_connect_identity import FakeWorker, _tokened

    w = world
    a2 = make_client(
        FakeWorker(now=int(time.time())),
        store=_tokened(),
        state_dir=str(tmp_path / "acct"),
        expected_services=["license", "config", "connect"],
    )
    w.clients.append(a2)
    a2._discovery_doc = {"services": {"connect": {"enabled": True, "localPairing": True, "interAccount": False}}}
    a2._local_gate.read_ok(a2._discovery_doc)
    s = show(w, a2, ["notes"])
    pair_up(w, s, {"code": s.codes[0].code})
    until(lambda: not s.handle.open)
    idb = w.b.cloud_connect.local_links.list()[0].id
    a2.cloud_connect.start(opts(w))
    w.b.cloud_connect.start(opts(w))
    until(lambda: any("m=a" in a.txt for a in w.net.adverts.values()) and len(m_l(w)) == 2)
    inbound: List[Any] = []
    a2.cloud_connect.local_links.on_link(inbound.append)
    open_when_seen(w.b, idb).close()
    until(lambda: inbound)
    # Signing out stops the account half and brings the local-only service back up with the link reachable.
    a2.identity._before_sign_out.run()
    until(lambda: not any("m=a" in a.txt for a in w.net.adverts.values()))
    until(lambda: len(m_l(w)) == 2)
    assert a2.cloud_connect.status().running is True and a2.cloud_connect.status().lan == "on"
    assert a2.cloud_connect.local_links.list()[0].reachable is True
    got: List[Any] = []
    a2.cloud_connect.local_links.on_link(got.append)
    open_when_seen(w.b, idb).close()
    until(lambda: got)
    # A host that stopped Connect itself is not brought back by a sign-out.
    a2.cloud_connect.stop()
    a2.identity._before_sign_out.run()
    assert a2.cloud_connect.status().running is False


# -- admission for a listener with no account key -------------------------------------------------------


def test_junk_from_one_source_group_spends_its_budget_before_any_secret_is_tried(world: World) -> None:
    import socket

    from polaris_key.core.peer_frame import encode_frame

    w = world
    ida, idb = linked(w)
    w.a.cloud_connect.start(opts(w))
    w.b.cloud_connect.start(opts(w))
    lan = w.a.cloud_connect._lan
    assert lan is not None
    # The link works first: B has seen A, and a session opens (a trial that opens refunds its group's count).
    open_when_seen(w.b, idb).close()
    # One message 1 that opens nothing, a few times, from this host: the group's budget is two a minute.
    for _ in range(2):
        with socket.create_connection(("127.0.0.1", lan.port), timeout=5) as sk:
            sk.sendall(encode_frame(bytes(range(48))))
            sk.settimeout(5)
            try:
                sk.recv(1)  # the listener closes without a word
            except OSError:
                pass
    # The group has spent its two: a real dial from the same source meets a silent refusal, whatever it holds.
    with pytest.raises(LanError) as e:
        w.b.cloud_connect.local_links.open(idb)
    assert e.value.reason in ("handshake_failed", "connect_failed")
