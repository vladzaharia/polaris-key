# @pkey-feature connect.local
"""The kit API of pairing with a code (CC-29.15; WIRE-CONTRACT-V5 §15.12): what a host needs to draw the "Pair
with a Code" screens. Two clients with no credential on 127.0.0.1 over an in-process mDNS network, with the
windows' clocks and random sources injected, cover the shower (the code's reason, expiry and failures, ``renew()``,
``on_interrupted``, ``on_end``, the renewal floor, ``stop()`` against a renewal), the joiner (the reason of a
``pairing-code-failed``, ``dials_left``, cancel, the reason of a ``peer-closed``, the wipe) and the list
(``on_change``, the gate, the stored platform, the cap, management that is never gated). Mirrors Node's
``test/connect/localLinksKit.test.ts``. No test waits on a wall-clock deadline: a clock a test needs is handed in
and every wait is on a condition."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, cast

import pytest
from helpers import make_client
from test_connect_lan import Network, run, until
from test_connect_local import LOOP, T0, World, dial, m_q, wrong_password
from test_connect_local import pair_up as _pair_up

from polaris_key.aio import AsyncPolarisKeyClient
from polaris_key.connect import local_pairing as lp
from polaris_key.connect.errors import LanError
from polaris_key.connect.local_common import LocalPairingError
from polaris_key.connect.local_links import reset_local_budgets
from polaris_key.connect.local_state import LOCAL_STATE_FILE, LocalRef, local_tag
from polaris_key.connect.session import SessionClosed
from polaris_key.constants_generated import PLATFORM_VALUES
from polaris_key.core.b64url import b64url_decode
from polaris_key.core.caps import UnsupportedError
from polaris_key.core.headers import canonical_platform
from polaris_key.core.peer_advert import advert_epoch, product_tag
from polaris_key.core.peer_frame import encode_frame
from polaris_key.core.peer_local import make_qr, pairing_instance
from polaris_key.core.peer_mdns import MdnsAdvert


@pytest.fixture(autouse=True)
def _fresh_budgets() -> Any:
    reset_local_budgets()
    yield
    reset_local_budgets()


@pytest.fixture
def world(tmp_path: Path) -> Any:
    w = World(tmp_path)
    yield w
    w.close()


class Slow(Network):
    """A network whose ``advertise`` waits while ``hold`` is set, so a window can be caught opening."""

    def __init__(self) -> None:
        super().__init__()
        self.hold: Any = None
        self.reached = 0

    async def advertise(self, a: MdnsAdvert) -> Any:
        if self.hold is not None:
            self.reached += 1
            await self.hold.wait()
        return await super().advertise(a)


def slow_world(w: World) -> Slow:
    net = Slow()
    w.net = net
    return net


def hold_next(w: World, net: Slow) -> None:
    net.hold = w.a.cloud_connect._read(lambda: asyncio.Event())
    net.reached = 0


def release(w: World, net: Slow) -> None:
    ev = net.hold
    net.hold = None
    w.a.cloud_connect._read(ev.set)


class Clock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


class HeldTimers:
    """A timer that holds the timers whose length ``held`` accepts and lets a test fire them on the loop."""

    def __init__(self, w: World, held: Callable[[float], bool]) -> None:
        self._w = w
        self._held = held
        self._all: List[List[Any]] = []

    def __call__(self, fn: Callable[[], None], seconds: float) -> Callable[[], None]:
        if self._held(seconds):
            t = [fn, True]
            self._all.append(t)

            def cancel() -> None:
                t[1] = False

            return cancel
        h = asyncio.get_event_loop().call_later(seconds, fn)
        return h.cancel

    def fire(self) -> None:
        for t in self._all:
            if t[1]:
                t[1] = False
                self._w.a.cloud_connect._read(t[0])
        self._all.clear()


class Shown:
    def __init__(self) -> None:
        self.codes: List[Any] = []
        self.offers: List[Any] = []
        self.linked: List[Any] = []
        self.failed: List[str] = []
        self.ends: List[str] = []
        self.interrupted: List[int] = []
        self.handle: Any = None


def show(w: World, c: Any, **kw: Any) -> Shown:
    s = Shown()
    o: Dict[str, Any] = {
        "categories": ["notes"],
        "label": "Ana",
        "mdns": w.net,
        "on_code": s.codes.append,
        "on_confirm": s.offers.append,
        "on_linked": s.linked.append,
        "on_failed": lambda f: s.failed.append(f.reason),
        "on_end": lambda e: s.ends.append(e.reason),
        "on_interrupted": s.interrupted.append,
        **LOOP,
    }
    o.update(kw)
    s.handle = c.cloud_connect.local_links.pair(o)
    w.handles.append(s.handle)
    return s


def pair_up(w: World, s: Shown, how: Dict[str, str]) -> Any:
    """One pairing to the end (the module's ``pair_up`` over this module's :class:`Shown`)."""
    return _pair_up(w, cast(Any, s), how)


def wrong_guess(w: World, fill: int = 7) -> None:
    """One counted wrong guess: the joiner hears ``wrong``, the window rotates."""
    qr = make_qr("djdl", m_q(w)[0].instance, bytes([fill]) * 16)
    with pytest.raises(LocalPairingError) as e:
        dial(w, w.b, {"qr": qr}).result(10)
    assert e.value.code == "pairing-code-failed" and e.value.reason == "wrong"


def junk(port: int) -> None:
    """A connection that sends a first message the window refuses; returns once the window has closed it."""
    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
        s.sendall(encode_frame(bytes([1, 2, 3])))
        try:
            s.recv(1)
        except OSError:
            pass


def exhaust(w: World, s: Shown) -> None:
    for i in range(5):
        until(lambda n=i: len(s.codes) == n + 1 or not s.handle.open)
        if not s.handle.open:
            break
        wrong_guess(w, i + 1)
    until(lambda: s.ends == ["too-many-tries"])


def dead_advert(w: World, nameplate: str, i: int) -> None:
    """A made-up advert at a port nothing listens on: a dial of it ends before the answer."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    tag = product_tag("djdl", advert_epoch(w.b.connect.local_source().now()))
    txt = ["v=1", "m=q", "h=" + tag, "n=" + nameplate]
    run(w.net.advertise(MdnsAdvert(pairing_instance(bytes([i + 1]) * 10), port, txt)))


def dead_join(w: World) -> None:
    with pytest.raises(LocalPairingError) as e:
        dial(w, w.b, {"code": "4812 3456"}, cats=["notes"], browse_seconds=0.2).result(10)
    assert e.value.code == "pairing-not-found"


def scripted(first: List[int]) -> Callable[[int], bytes]:
    """Byte draws of one: the scripted nameplate bytes first. Everything else is real randomness."""
    import os

    left = list(first)

    def draw(n: int) -> bytes:
        return bytes([left.pop(0)]) if n == 1 and left else os.urandom(n)

    return draw


# -- the shower: the code, the window and renew() -----------------------------------------------------


def test_a_code_says_why_it_is_on_show_when_the_window_ends_and_how_many_guesses_were_counted(world: World) -> None:
    w = world
    src = w.a.connect.local_source()
    before = src.now()
    s = show(w, w.a)
    after = src.now()
    first = s.codes[0]
    assert (first.reason, first.failures) == ("opened", 0)
    assert before + 300 <= first.expires_at <= after + 300
    wrong_guess(w)
    until(lambda: len(s.codes) == 2)
    second = s.codes[1]
    assert (second.reason, second.failures) == ("wrong-code", 1)
    assert second.expires_at == first.expires_at
    # A decline at the consent: the next code says so, and the guess that opened was refunded.
    offers_b: List[Any] = []
    joined = dial(w, w.b, {"code": second.code}, offers_b)
    until(lambda: len(s.offers) == 1 and len(offers_b) == 1)
    s.offers[0].decline()
    with pytest.raises(LocalPairingError):
        joined.result(10)
    until(lambda: len(s.codes) == 3)
    assert (s.codes[2].reason, s.codes[2].failures) == ("declined", 1)
    # A code never holds a digit in its repr.
    assert s.codes[2].code not in repr(s.codes[2])



def test_renew_opens_a_window_that_is_new_in_every_respect_and_never_reuses_a_recent_nameplate(world: World) -> None:
    w = world
    s = show(w, w.a)
    first = s.codes[0]
    old_instance = m_q(w)[0].instance
    again = s.handle.renew()
    assert again.reason == "opened" and again.failures == 0
    assert s.codes == [first, again] and s.handle.code() == again
    assert again.nameplate != first.nameplate
    (advert,) = m_q(w)
    assert advert.instance != old_instance and "n=" + again.nameplate in advert.txt
    # The replaced window ends with no on_end; the handle follows the new one.
    assert s.ends == [] and s.handle.open is True
    # The old code no longer pairs: its advert is gone and the new window is a different one.
    with pytest.raises(LocalPairingError) as e:
        dial(w, w.b, {"code": first.code}, browse_seconds=0.2).result(10)
    assert e.value.code in ("pairing-not-found", "pairing-code-failed")
    # The nameplates of the windows that closed in the last 300 s are never drawn again while another is free.
    seen = {first.nameplate, again.nameplate}
    for _ in range(6):
        nxt = s.handle.renew()
        assert nxt.nameplate not in seen
        seen.add(nxt.nameplate)


def test_renew_works_on_a_closed_handle_and_refuses_what_pair_refuses(world: World) -> None:
    w = world
    s = show(w, w.a)
    s.handle.stop()
    assert s.ends == ["person"] and s.handle.open is False
    assert s.handle.renew().reason == "opened"
    assert s.handle.open is True
    # A window another pair() opened: renew is refused (and keeps its handle closed).
    s.handle.stop()
    other = show(w, w.a)
    with pytest.raises(LanError) as e:
        s.handle.renew()
    assert e.value.reason == "bad_input"
    other.handle.stop()
    # The cap: 32 links.
    store = w.a.connect.local_store()
    for i in range(32):
        store.add(
            own_key=bytes([1]) * 32,
            own_public=bytes([2]) * 32,
            peer_key=bytes([i]) + bytes([9]) * 31,
            secret=bytes([4]) * 32,
            cats=[],
            now=T0,
        )
    with pytest.raises(LocalPairingError) as full:
        s.handle.renew()
    assert full.value.code == "local-links-full" and full.value.cap == "stored"


def test_renew_is_refused_with_the_typed_na_while_the_gate_is_off(world: World) -> None:
    w = world
    s = show(w, w.a)
    w.disco.local = False
    w.a.discover()
    until(lambda: s.ends == ["off"])
    with pytest.raises(UnsupportedError) as e:
        s.handle.renew()
    assert e.value.code == "local-pairing-off"


def test_on_interrupted_counts_connections_closed_without_a_guess_and_starts_again_with_a_code_or_a_consent(
    world: World,
) -> None:
    w = world
    clock = Clock()
    s = show(w, w.a, mono=clock)
    port = m_q(w)[0].port
    for i in range(3):
        junk(port)
        until(lambda n=i: len(s.interrupted) >= n + 1)
        clock.t += 1
    assert s.interrupted[:3] == [1, 2, 3]
    assert len(s.codes) == 1
    # A counted guess is not an interruption.
    seen = len(s.interrupted)
    wrong_guess(w)
    until(lambda: len(s.codes) == 2)
    assert len(s.interrupted) == seen
    # The next code starts the count again.
    junk(port)
    until(lambda: len(s.interrupted) == seen + 1)
    assert s.interrupted[-1] == 1
    # A consent does too (the window admits five first messages a minute: a minute later it takes the next).
    clock.t += 61
    offers_b: List[Any] = []
    joined = dial(w, w.b, {"code": s.codes[1].code}, offers_b)
    until(lambda: len(s.offers) == 1 and len(offers_b) == 1)
    junk(port)
    until(lambda: len(s.interrupted) == seen + 2)
    assert s.interrupted[-1] == 1
    s.offers[0].decline()
    with pytest.raises(LocalPairingError):
        joined.result(10)


def test_on_interrupted_is_told_at_most_once_a_second_while_the_count_goes_on(world: World) -> None:
    w = world
    clock = Clock()
    s = show(w, w.a, mono=clock)
    port = m_q(w)[0].port
    for _ in range(4):
        junk(port)
    until(lambda: len(s.interrupted) >= 1)
    # A flood inside one second: the first is told and the rest are counted.
    assert s.interrupted == [1]
    clock.t += 1
    junk(port)
    until(lambda: len(s.interrupted) == 2)
    assert s.interrupted == [1, 5]


def test_on_end_says_once_why_the_window_ended_person_too_many_tries_stored(world: World) -> None:
    w = world
    # person, and a second stop() says nothing more
    person = show(w, w.a)
    person.handle.stop()
    person.handle.stop()
    assert person.ends == ["person"]

    # too-many-tries: the fifth counted guess (the clock is injected: the renewal floor follows it)
    clock = Clock(1000.0)
    tries = show(w, w.a, mono=clock)
    exhaust(w, tries)
    assert tries.failed == ["too-many-tries"]

    # stored: a link was made
    clock.t += 100
    stored = show(w, w.a, mono=clock)
    pair_up(w, stored, {"code": stored.codes[0].code})
    until(lambda: stored.ends == ["stored"])


def test_on_end_expired_comes_after_the_advert_is_withdrawn_when_the_window_runs_out(world: World) -> None:
    w = world
    timers = HeldTimers(w, lambda sec: sec == 299)
    at_end: List[int] = []
    s = show(w, w.a, seconds=299, timer=timers, on_end=lambda e: at_end.append(len(m_q(w))))
    timers.fire()
    until(lambda: at_end != [])
    assert at_end == [0] and s.handle.open is False and m_q(w) == []


def test_on_end_off_comes_after_the_advert_is_withdrawn_when_the_product_turns_pairing_off(world: World) -> None:
    w = world
    at_end: List[int] = []
    s = show(w, w.a, on_end=lambda e: at_end.append(len(m_q(w))))
    w.disco.local = False
    w.a.discover()
    until(lambda: at_end != [])
    assert at_end == [0] and s.handle.open is False


# -- stop() against a renewal, the floor, the draw -----------------------------------------------------


def test_stop_while_renew_is_opening_a_window_leaves_no_window_no_advert_and_no_code(world: World) -> None:
    w = world
    net = slow_world(w)
    s = show(w, w.a)
    hold_next(w, net)
    renewing = w.pool.submit(s.handle.renew)
    until(lambda: net.reached == 1)
    stopping = w.pool.submit(s.handle.stop)
    until(lambda: s.handle._renewing is not None and s.handle._renewing.stop)
    release(w, net)
    stopping.result(10)
    with pytest.raises(LanError) as e:
        renewing.result(10)
    assert "The window closed." in str(e.value)
    assert s.handle.open is False and s.handle.code() is None
    assert m_q(w) == []
    # The new window was never shown.
    assert len(s.codes) == 1
    assert s.ends == ["person"]


def test_no_code_is_shown_for_a_window_that_closes_off_while_it_opens(world: World) -> None:
    w = world
    net = slow_world(w)
    codes: List[Any] = []
    ends: List[str] = []
    hold_next(w, net)
    pairing = w.pool.submit(
        lambda: w.a.cloud_connect.local_links.pair(
            categories=["notes"],
            mdns=net,
            on_code=codes.append,
            on_confirm=lambda o: None,
            on_end=lambda e: ends.append(e.reason),
            **LOOP,
        )
    )
    until(lambda: net.reached == 1)
    w.disco.local = False
    w.a.discover()
    release(w, net)
    with pytest.raises(UnsupportedError) as e:
        pairing.result(10)
    assert e.value.code == "local-pairing-off"
    assert codes == [] and ends == ["off"] and m_q(w) == []


def test_after_too_many_tries_pair_and_renew_are_refused_for_30_s_with_cooldown(world: World) -> None:
    w = world
    clock = Clock()
    s = show(w, w.a, mono=clock)
    exhaust(w, s)
    clock.t += 10
    with pytest.raises(LocalPairingError) as e:
        s.handle.renew()
    assert (e.value.code, e.value.reason) == ("peer-closed", "cooldown")
    with pytest.raises(LocalPairingError) as e2:
        show(w, w.a, mono=clock)
    assert (e2.value.code, e2.value.reason) == ("peer-closed", "cooldown")
    assert m_q(w) == []
    clock.t += 19
    with pytest.raises(LocalPairingError):
        s.handle.renew()
    clock.t += 1
    assert s.handle.renew().reason == "opened"


def test_the_second_window_that_ends_after_a_wrong_guess_within_10_minutes_starts_the_cooldown_one_does_not(
    world: World,
) -> None:
    w = world
    clock = Clock()
    s = show(w, w.a, mono=clock)
    wrong_guess(w)
    until(lambda: len(s.codes) == 2)
    # The first such window: the renewal opens.
    clock.t += 100
    assert s.handle.renew().failures == 0
    wrong_guess(w, 8)
    until(lambda: len(s.codes) == 4)
    clock.t += 100
    # The second ends: the renewal is refused and the window is gone.
    with pytest.raises(LocalPairingError) as e:
        s.handle.renew()
    assert (e.value.code, e.value.reason) == ("peer-closed", "cooldown")
    assert s.handle.open is False
    clock.t += 30
    assert s.handle.renew().reason == "opened"


def test_a_window_with_no_failed_guess_never_starts_the_cooldown(world: World) -> None:
    w = world
    clock = Clock()
    s = show(w, w.a, mono=clock)
    for _ in range(4):
        clock.t += 1
        s.handle.renew()
    assert s.handle.open is True


def test_the_nameplate_draw_ignores_adverts_other_windows_show(world: World) -> None:
    w = world
    tag = product_tag("djdl", advert_epoch(w.a.connect.local_source().now()))
    run(w.net.advertise(MdnsAdvert("p1-0123456789abcdef", 9, ["v=1", "m=q", "h=" + tag, "n=48"])))
    s = show(w, w.a, random=scripted([48]))
    assert s.codes[0].nameplate == "48"


def test_the_floor_and_the_memory_are_the_products_for_the_process_not_the_clients(world: World) -> None:
    w = world
    clock = Clock()
    s = show(w, w.a, mono=clock)
    exhaust(w, s)
    # A new client of the same product meets the same floor.
    fresh = w.device("c")
    with pytest.raises(LocalPairingError) as e:
        show(w, fresh, mono=clock)
    assert e.value.reason == "cooldown"


def test_renew_from_a_callback_on_the_connect_thread_does_not_deadlock(world: World) -> None:
    w = world
    got: List[BaseException] = []

    def on_end(_e: Any) -> None:
        try:
            s.handle.renew()
        except BaseException as err:  # noqa: BLE001 - the test reads it
            got.append(err)

    s = show(w, w.a, on_end=on_end)
    s.handle.stop()
    until(lambda: got != [])
    # A blocking call from the Connect thread is refused, never waited on; a thread of the host's own renews.
    assert isinstance(got[0], RuntimeError)
    assert w.pool.submit(s.handle.renew).result(10).reason == "opened"


# -- the joiner: reasons, dials_left and cancel --------------------------------------------------------


def reason_of(w: World, how: Dict[str, str], **kw: Any) -> Optional[str]:
    with pytest.raises(LocalPairingError) as e:
        dial(w, w.b, how, cats=["notes"], **kw).result(10)
    assert e.value.code == "pairing-code-failed"
    return e.value.reason  # type: ignore[no-any-return]


def test_pairing_code_failed_carries_why_invalid_other_app_spent_wrong(world: World) -> None:
    w = world
    links = w.b.cloud_connect.local_links
    assert reason_of(w, {"code": "1234 567"}) == "invalid"
    other = make_qr("other", pairing_instance(bytes([3]) * 10), bytes([5]) * 16)
    assert reason_of(w, {"qr": other}) == "other-app"
    s = show(w, w.a)
    bad = wrong_password(s.codes[0].code)
    # A dial that ended after the other device answered.
    assert reason_of(w, {"code": bad}, browse_seconds=0.05) == "wrong"
    until(lambda: len(s.codes) == 2)
    assert links.dials_left(bad) == 1
    assert reason_of(w, {"code": wrong_password(s.codes[1].code)}, browse_seconds=0.05) == "wrong"
    # Both dials are spent: the next join answers at once.
    assert links.dials_left(bad) == 0
    assert reason_of(w, {"code": bad}) == "spent"


def test_a_dial_stopped_by_the_budget_in_the_middle_of_a_join_is_spent(world: World) -> None:
    w = world
    links = w.b.cloud_connect.local_links
    dead_advert(w, "48", 0)
    # One dial of 48 spent, nothing answered.
    dead_join(w)
    assert links.dials_left("48") == 1
    # Two candidates now: the first dial spends the last one, the second is stopped by the budget.
    dead_advert(w, "48", 1)
    assert reason_of(w, {"code": "4812 3456"}, browse_seconds=5) == "spent"
    assert links.dials_left("48") == 0


def test_dials_left_reads_two_digits_keeps_nothing_and_spends_nothing(world: World) -> None:
    w = world
    links = w.b.cloud_connect.local_links
    for text in ("", "4", "4 -", "ab12", "４８", None, 48):
        assert links.dials_left(text) is None  # type: ignore[arg-type]
    assert links.dials_left("48") == 2
    assert links.dials_left("4-8 12") == 2
    assert links.dials_left(" 48 1234 56") == 2
    for _ in range(5):
        links.dials_left("48")
    assert links.dials_left("48") == 2
    dead_advert(w, "48", 0)
    dead_join(w)
    # The budget is the nameplate's: it is the same for every text that starts with 48.
    assert links.dials_left("48") == 1
    assert links.dials_left("4812 3456") == 1
    assert links.dials_left("49") == 2
    # Another client of the product meets the same budget.
    assert w.a.cloud_connect.local_links.dials_left("48") == 1


def test_cancel_an_event_that_is_set_rejects_with_peer_closed_cancelled_a_cancel_refunds_no_dial(world: World) -> None:
    w = world
    links = w.b.cloud_connect.local_links
    done = threading.Event()
    done.set()
    with pytest.raises(LocalPairingError) as e:
        dial(w, w.b, {"code": "4812 3456"}, cats=["notes"], cancel=done).result(10)
    assert (e.value.code, e.value.reason) == ("peer-closed", "cancelled")
    assert links.dials_left("48") == 2

    # While browsing: no advert, a long browse, the event ends it at once.
    during = threading.Event()
    waiting = dial(w, w.b, {"code": "4812 3456"}, cats=["notes"], cancel=during)
    until(lambda: len(w.net.browsers) == 1)
    during.set()
    with pytest.raises(LocalPairingError) as e2:
        waiting.result(5)
    assert (e2.value.code, e2.value.reason) == ("peer-closed", "cancelled")
    # The event must be a threading.Event.
    with pytest.raises(LanError):
        links.join(categories=[], on_confirm=lambda o: None, code="1234 5678", cancel=object())


def test_a_cancel_at_the_consent_spends_the_dial_wipes_what_the_join_made_and_stores_nothing(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = world
    s = show(w, w.a)
    kept: List[Tuple[bytearray, bytes]] = []
    real = lp.LocalJoiner._keep

    def spy(self: Any, *secrets: bytearray) -> None:
        kept.extend((k, bytes(k)) for k in secrets)
        real(self, *secrets)

    monkeypatch.setattr(lp.LocalJoiner, "_keep", spy)
    cancel = threading.Event()
    offers_b: List[Any] = []
    joined = dial(w, w.b, {"code": s.codes[0].code}, offers_b, cancel=cancel)
    until(lambda: len(offers_b) == 1)
    # The scalar, the generator, the key (64 bytes) and the pre-shared key were made and are held.
    assert [len(c) for _k, c in kept] == [32, 32, 64, 32] and all(any(c) for _k, c in kept)
    cancel.set()
    with pytest.raises(LocalPairingError) as e:
        joined.result(10)
    assert (e.value.code, e.value.reason) == ("peer-closed", "cancelled")
    until(lambda: all(not any(k) for k, _c in kept))
    assert w.b.cloud_connect.local_links.dials_left(s.codes[0].code) == 1
    assert w.b.cloud_connect.local_links.list() == []


def test_a_secret_made_after_the_join_ended_is_wiped_at_once(world: World) -> None:
    w = world
    src = w.b.connect.local_source()

    async def go() -> bytearray:
        j = lp.LocalJoiner(
            src, lp.DialBudget(), {"code": "1234 5678", "categories": [], "on_confirm": lambda o: None}
        )
        j._finish(LocalPairingError("peer-closed", "x"))
        late = bytearray(b"\x07" * 32)
        j._keep(late)
        return late

    assert not any(run(go()))


def test_a_peer_closed_carries_why_declined_by_the_other_device_by_this_person_timeout_closed(world: World) -> None:
    w = world
    # The other device declined: its window sent peer_bye before any link.
    s = show(w, w.a)
    offers_b: List[Any] = []
    joined = dial(w, w.b, {"code": s.codes[0].code}, offers_b)
    until(lambda: len(s.offers) == 1 and len(offers_b) == 1)
    s.offers[0].decline()
    with pytest.raises(LocalPairingError) as e:
        joined.result(10)
    assert (e.value.code, e.value.reason) == ("peer-closed", "declined")
    until(lambda: len(s.codes) == 2)
    # This person declined.
    offers_b = []
    joined = dial(w, w.b, {"code": s.codes[1].code}, offers_b)
    until(lambda: len(offers_b) == 1)
    offers_b[0].decline()
    with pytest.raises(LocalPairingError) as e2:
        joined.result(10)
    assert (e2.value.code, e2.value.reason) == ("peer-closed", "declined")
    # The other two ends, by the rule that maps a close to its reason.
    a = lp._Attempt()
    assert lp.LocalJoiner._close_reason(a, SessionClosed("peer_timeout", False)) == "timeout"
    assert lp.LocalJoiner._close_reason(a, SessionClosed("connection_lost", False)) == "closed"
    assert lp.LocalJoiner._close_reason(a, SessionClosed("peer_bye", False)) == "closed"
    assert lp.LocalJoiner._close_reason(a, SessionClosed("peer_bye", True)) == "declined"


def test_a_pairing_hello_sends_the_canonical_platform_not_the_os_name() -> None:
    import sys

    h = lp.pairing_hello("djdl", "Ana")
    assert h == {"label": "Ana", "platform": canonical_platform(sys.platform) or sys.platform, "app": "djdl"}
    assert h["platform"] in PLATFORM_VALUES or canonical_platform(sys.platform) is None


# -- the list: on_change, the gate, the platform, the cap ---------------------------------------------


def test_on_change_fires_after_a_pairing_is_stored_rename_set_reachable_a_sighting_and_remove_not_after_unsubscribing(
    world: World,
) -> None:
    w = world
    links = w.a.cloud_connect.local_links
    n = [0]
    off = links.on_change(lambda: n.__setitem__(0, n[0] + 1))
    s = show(w, w.a)
    pair_up(w, s, {"code": s.codes[0].code})
    assert n[0] >= 1
    (row,) = links.list()
    n[0] = 0
    assert links.rename(row.id, "Roommate") is True
    assert n[0] == 1
    n[0] = 0
    assert links.set_reachable(row.id, False) is True
    assert n[0] == 1
    # A name that matches no link changes nothing.
    n[0] = 0
    assert links.rename("x" * 16, "Nobody") is False
    assert n[0] == 0
    # A sighting writes the last-seen hour: the list shows it.
    (full,) = w.a.connect.local_store().rows()
    ref = LocalRef(row.id, row.label, row.categories, full.peer_key, tag=local_tag(b64url_decode(full.secret)))
    n[0] = 0
    w.a.connect.touch_local(ref)
    assert n[0] == 1
    w.a.connect.touch_local(ref)
    assert n[0] == 1
    n[0] = 0
    assert links.remove(row.id) is True
    assert n[0] >= 1
    off()
    n[0] = 0
    s2 = show(w, w.a)
    s2.handle.stop()
    store = w.a.connect.local_store()
    store.add(
        own_key=bytes([1]) * 32, own_public=bytes([2]) * 32, peer_key=bytes([5]) * 32, secret=bytes([4]) * 32,
        cats=[], now=T0,
    )
    w.a.connect.notify_locals()
    assert n[0] == 0


def test_the_gate_is_readable_and_every_flip_is_an_event_in_both_directions(world: World) -> None:
    w = world
    links = w.a.cloud_connect.local_links
    n = [0]
    links.on_change(lambda: n.__setitem__(0, n[0] + 1))
    assert links.local_pairing() is True
    w.disco.local = False
    w.a.discover()
    assert links.local_pairing() is False and n[0] == 1
    w.a.discover()
    # The same answer again is no flip.
    assert n[0] == 1
    w.disco.local = True
    w.a.discover()
    assert links.local_pairing() is True and n[0] == 2


def test_a_link_keeps_the_other_devices_platform_and_only_a_known_spelling(world: World) -> None:
    w = world
    s = show(w, w.a)
    pair_up(w, s, {"code": s.codes[0].code})
    (a_row,) = w.a.cloud_connect.local_links.list()
    (b_row,) = w.b.cloud_connect.local_links.list()
    import sys

    expected = canonical_platform(sys.platform)
    assert a_row.platform == expected and b_row.platform == expected
    assert a_row.platform is None or a_row.platform in PLATFORM_VALUES
    # An unknown spelling in the record is dropped on read, never an error; unknown members are ignored.
    path = Path(w.a.core.dirs.state) / LOCAL_STATE_FILE
    doc = json.loads(path.read_text())
    doc["links"][0]["platform"] = "Darwin"
    doc["links"][0]["somethingNew"] = 1
    path.write_text(json.dumps(doc))
    assert w.a.cloud_connect.local_links.list()[0].platform is None
    doc["links"][0]["platform"] = "linux"
    path.write_text(json.dumps(doc))
    assert w.a.cloud_connect.local_links.list()[0].platform == "linux"
    store = w.a.connect.local_store()
    ok, lid = store.add(
        own_key=bytes([1]) * 32, own_public=bytes([2]) * 32, peer_key=bytes([8]) * 32, secret=bytes([4]) * 32,
        cats=[], now=T0, platform="Plan9",
    )
    assert ok and next(r for r in store.rows() if r.id == lid).platform is None


def test_local_links_full_names_the_cap_stored_at_32_reachable_at_8(world: World) -> None:
    w = world
    store = w.a.connect.local_store()
    links = w.a.cloud_connect.local_links
    ids: List[str] = []
    for i in range(9):
        ok, lid = store.add(
            own_key=bytes([1]) * 32, own_public=bytes([2]) * 32, peer_key=bytes([i]) + bytes([9]) * 31,
            secret=bytes([4]) * 32, cats=[], now=T0,
        )
        assert ok
        ids.append(lid)
    # The ninth is stored switched off (8 are reachable already); turning it on names the cap.
    assert [x.reachable for x in links.list()] == [True] * 8 + [False]
    with pytest.raises(LocalPairingError) as e:
        links.set_reachable(ids[8], True)
    assert (e.value.code, e.value.cap) == ("local-links-full", "reachable")
    for i in range(9, 32):
        store.add(
            own_key=bytes([1]) * 32, own_public=bytes([2]) * 32, peer_key=bytes([i]) + bytes([9]) * 31,
            secret=bytes([4]) * 32, cats=[], now=T0,
        )
    with pytest.raises(LocalPairingError) as e2:
        show(w, w.a)
    assert (e2.value.code, e2.value.cap) == ("local-links-full", "stored")
    with pytest.raises(LocalPairingError) as e3:
        dial(w, w.a, {"code": "1234 5678"}, cats=[]).result(10)
    assert e3.value.cap == "stored"


def test_list_rename_remove_and_set_reachable_are_never_gated_with_the_gate_off_or_no_cached_document(
    tmp_path: Path,
) -> None:
    w = World(tmp_path)
    try:
        s = show(w, w.a)
        pair_up(w, s, {"code": s.codes[0].code})
        (row,) = w.a.cloud_connect.local_links.list()
        w.disco.local = False
        w.a.discover()
        links = w.a.cloud_connect.local_links
        assert links.local_pairing() is False
        assert [r.id for r in links.list()] == [row.id]
        assert links.rename(row.id, "Roommate") is True
        assert links.set_reachable(row.id, False) is True
        assert w.a.cloud_connect.local_links.list()[0].label == "Roommate"
        with pytest.raises(UnsupportedError):
            show(w, w.a)
        assert m_q(w) == []
        assert links.remove(row.id) is True
        # No cached document at all: a client of the same directory that never discovered still manages links.
        fresh = make_client(w.disco.handler, state_dir=str(tmp_path / "b"))
        w.clients.append(fresh)
        assert fresh.cloud_connect.local_links.local_pairing() is False
        held = fresh.cloud_connect.local_links.list()
        assert len(held) == 1
        assert fresh.cloud_connect.local_links.rename(held[0].id, "Kept") is True
        assert fresh.cloud_connect.local_links.set_reachable(held[0].id, False) is True
        assert fresh.cloud_connect.local_links.remove(held[0].id) is True
        assert fresh.cloud_connect.local_links.list() == []
        assert m_q(w) == []
    finally:
        w.close()


# -- the async client ---------------------------------------------------------------------------------


def test_the_async_client_mirrors_the_kit_api_and_cancelling_the_join_task_cancels_the_join(world: World) -> None:
    w = world
    s = show(w, w.a)
    bad = wrong_password(s.codes[0].code)

    async def main() -> Tuple[Optional[int], Any, bool, str]:
        b = AsyncPolarisKeyClient(w.b)
        a = AsyncPolarisKeyClient(w.a)
        links = b.cloud_connect.local_links
        left = links.dials_left("48")
        calls: List[int] = []
        links.on_change(lambda: calls.append(1))
        task = asyncio.ensure_future(
            links.join(categories=["notes"], code=bad, mdns=w.net, on_confirm=lambda o: None, **LOOP)
        )
        await asyncio.sleep(0)
        task.cancel()
        cancelled_ok = False
        try:
            await task
        except asyncio.CancelledError:
            cancelled_ok = True
        handle = await a.cloud_connect.local_links.pair(
            categories=["notes"], mdns=w.net, on_code=lambda c: None, on_confirm=lambda o: None, **LOOP
        )
        w.handles.append(handle._target)
        renewed = await handle.renew()
        await handle.stop()
        return left, handle.open, cancelled_ok, renewed.reason

    # The window the sync side showed holds the slot of the first client only; the async one is client a.
    s.handle.stop()
    left, still_open, cancelled_ok, reason = asyncio.run(main())
    assert left == 2 and still_open is False and cancelled_ok is True and reason == "opened"
