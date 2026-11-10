# @pkey-feature connect.local
"""Pairing with a code, with no account (CC-29.9; WIRE-CONTRACT-V5 §15.12) end to end in one process: two clients
with no credential on 127.0.0.1 over a fake mDNS network, a discovery that says ``localPairing``, the shower's
window (``pair``) and the joiner (``join``), the gate, the cap and the store. Mirrors Node's
``test/connect/localLinks.test.ts``. The window's accounting runs on the pure machine's own monotonic clock; no
test waits on a wall-clock deadline (a test that needs a timer to fire hands one in)."""

from __future__ import annotations

import json
import os
import stat
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import pytest
from helpers import make_client
from test_connect_lan import Network, until

from polaris_key.connect.errors import LanError
from polaris_key.connect.local_links import reset_local_budgets
from polaris_key.connect.local_state import LOCAL_STATE_FILE
from polaris_key.core.caps import UnsupportedError
from polaris_key.core.errors import PolarisError
from polaris_key.core.peer_local import make_qr

LOOP: Dict[str, Any] = {"host": "127.0.0.1", "allow_loopback": True}
T0 = 1_700_000_000


class Disco:
    """The Worker's discovery answer, which a test turns on and off."""

    def __init__(self, local: bool = True) -> None:
        self.local = local
        self.status = 200

    def handler(self, r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("/.well-known/polaris.json"):
            if self.status != 200:
                return httpx.Response(self.status)
            doc = {
                "product": "djdl",
                "protocolVersion": 5,
                "services": {"connect": {"enabled": True, "localPairing": self.local}},
            }
            return httpx.Response(200, json=doc)
        return httpx.Response(404)


@pytest.fixture(autouse=True)
def _fresh_budgets() -> Any:
    reset_local_budgets()
    yield
    reset_local_budgets()


class World:
    def __init__(self, tmp_path: Path, local: bool = True) -> None:
        self.disco = Disco(local)
        self.tmp = tmp_path
        self.clients: List[Any] = []
        self.handles: List[Any] = []
        self.pool = ThreadPoolExecutor(max_workers=4)
        self.net = Network()
        self.a = self.device("a")
        self.b = self.device("b")

    def device(self, name: str, discover: bool = True) -> Any:
        c = make_client(self.disco.handler, state_dir=str(self.tmp / name))
        self.clients.append(c)
        if discover:
            c.discover()
        return c

    def close(self) -> None:
        for h in self.handles:
            try:
                h.stop()
            except Exception:
                pass
        for c in self.clients:
            try:
                c.close()
            except Exception:
                pass
        self.pool.shutdown(wait=False, cancel_futures=True)


@pytest.fixture
def world(tmp_path: Path) -> Any:
    w = World(tmp_path)
    yield w
    w.close()


class Shower:
    def __init__(self) -> None:
        self.codes: List[Any] = []
        self.offers: List[Any] = []
        self.linked: List[Any] = []
        self.failed: List[str] = []
        self.handle: Any = None


def show(w: World, c: Any, cats: List[str], label: str = "Ana", **kw: Any) -> Shower:
    s = Shower()
    s.handle = c.cloud_connect.local_links.pair(
        categories=cats,
        label=label,
        mdns=w.net,
        on_code=s.codes.append,
        on_confirm=s.offers.append,
        on_linked=s.linked.append,
        on_failed=lambda f: s.failed.append(f.reason),
        **LOOP,
        **kw,
    )
    w.handles.append(s.handle)
    return s


def dial(
    w: World,
    c: Any,
    how: Dict[str, str],
    offers: Optional[List[Any]] = None,
    cats: Optional[List[str]] = None,
    **extra: Any,
) -> "Future[Any]":
    sink = offers if offers is not None else []
    return w.pool.submit(
        lambda: c.cloud_connect.local_links.join(
            categories=cats if cats is not None else ["notes", "docs"],
            label="Bo",
            mdns=w.net,
            on_confirm=sink.append,
            **LOOP,
            **how,
            **extra,
        )
    )


def pair_up(w: World, s: Shower, how: Dict[str, str]) -> Any:
    """One pairing to the end: the joiner dials, both people agree, both sides store the link."""
    offers_b: List[Any] = []
    joined = dial(w, w.b, how, offers_b)
    until(lambda: len(s.offers) == 1 and len(offers_b) == 1)
    s.offers[0].confirm()
    offers_b[0].confirm()
    mine = joined.result(10)
    until(lambda: len(s.linked) == 1)
    return mine


def wrong_password(code: str) -> str:
    digits = code.replace(" ", "")
    return digits[:-1] + ("1" if digits.endswith("0") else "0")


def m_q(w: World) -> List[Any]:
    return [a for a in w.net.adverts.values() if "m=q" in a.txt]


def test_a_typed_code_pairs_both_confirm_both_store_the_link_the_window_closes(world: World) -> None:
    w = world
    s = show(w, w.a, ["photos", "notes"])
    assert len(s.codes) == 1
    assert len(s.codes[0].code) == 9 and s.codes[0].code[4] == " "
    assert "n=" + s.codes[0].nameplate in m_q(w)[0].txt
    # The advert carries the version, the mode, the product tag and the nameplate, and nothing else.
    assert sorted(t.split("=")[0] for t in m_q(w)[0].txt) == ["h", "m", "n", "v"]

    offers_b: List[Any] = []
    joined = dial(w, w.b, {"code": s.codes[0].code}, offers_b)
    until(lambda: len(s.offers) == 1 and len(offers_b) == 1)
    # HELLO is shown at consent, after the code was proven.
    assert s.offers[0].label == "Bo" and offers_b[0].label == "Ana"
    assert s.offers[0].categories == ("photos", "notes")
    s.offers[0].confirm()
    offers_b[0].confirm()
    lb = joined.result(10)
    until(lambda: len(s.linked) == 1)
    assert lb.label == "Ana" and lb.categories == ("notes",)
    assert s.linked[0].label == "Bo" and s.linked[0].categories == ("notes",)
    # The window closed on the stored link: the advert is withdrawn.
    until(lambda: not s.handle.open)
    until(lambda: m_q(w) == [])

    # Each side holds the other's link key and one secret both derived.
    (ra,) = w.a.connect.local_store().rows()
    (rb,) = w.b.connect.local_store().rows()
    assert ra.secret == rb.secret and ra.peer_key == rb.own_public and rb.peer_key == ra.own_public
    assert ra.own_key != rb.own_key
    # A new link is reachable already (§15.12), and the listing carries no key and no secret.
    listing = w.a.cloud_connect.local_links.list()
    assert len(listing) == 1 and listing[0].reachable is True
    text = repr(listing) + json.dumps([vars(x) for x in listing], default=str)
    assert ra.secret not in text and ra.own_key not in text
    assert "secret" not in repr(ra) and ra.secret not in repr(ra)
    # No Cloud Connect identity was ever made: this is not account data.
    assert w.a.connect.contact_rows() == []


def test_a_qr_pairs_and_the_qr_of_another_app_is_refused_with_that_reason(world: World) -> None:
    w = world
    s = show(w, w.a, ["notes"])
    pair_up(w, s, {"qr": s.codes[0].qr.lower()})
    other = s.codes[0].qr.replace("PKP1:DJDL", "PKP1:OTHER")
    with pytest.raises(PolarisError) as e:
        dial(w, w.b, {"qr": other}).result(10)
    assert e.value.code == "pairing-code-failed" and "another app" in e.value.message


def test_a_wrong_guess_rotates_the_code_the_new_code_pairs(world: World) -> None:
    w = world
    s = show(w, w.a, ["notes"])
    first = s.codes[0]
    # A wrong QR secret is a wrong guess with no dial budget: the joiner answers code-failed.
    bad = make_qr("djdl", m_q(w)[0].instance, bytes([7]) * 16)
    with pytest.raises(PolarisError) as e:
        dial(w, w.b, {"qr": bad}).result(10)
    assert e.value.code == "pairing-code-failed"
    # The failed guess rotated the password and the QR secret together; the nameplate stays.
    until(lambda: len(s.codes) == 2)
    assert s.codes[1].code != first.code and s.codes[1].qr != first.qr and s.codes[1].nameplate == first.nameplate
    # The new code works: the rotation finished before the window took this attempt.
    pair_up(w, s, {"code": s.codes[1].code})


def test_the_fifth_failed_guess_closes_the_window_and_its_host_hears_too_many_tries(world: World) -> None:
    w = world
    s = show(w, w.a, ["notes"])
    instance = m_q(w)[0].instance
    for i in range(5):
        # Wait for the rotation of the last failure: until then the window is busy and counts nothing.
        until(lambda n=i: len(s.codes) == n + 1 or not s.handle.open)
        if not s.handle.open:
            break
        bad = make_qr("djdl", instance, bytes([i + 1]) * 16)
        with pytest.raises(PolarisError):
            dial(w, w.b, {"qr": bad}).result(10)
    until(lambda: not s.handle.open)
    assert s.failed == ["too-many-tries"]
    assert s.handle.code() is None
    until(lambda: m_q(w) == [])
    assert w.a.cloud_connect.local_links.list() == []


def test_a_typed_codes_dials_are_counted_across_joins_the_third_join_browses_nothing(world: World) -> None:
    w = world
    s = show(w, w.a, ["notes"])
    bad = wrong_password(s.codes[0].code)
    browses = [0]
    real = w.net.browse

    async def counting(*a: Any, **k: Any) -> Any:
        browses[0] += 1
        return await real(*a, **k)

    w.net.browse = counting  # type: ignore[method-assign]
    for i in range(2):
        until(lambda n=i: len(s.codes) == n + 1)
        with pytest.raises(PolarisError) as e:
            dial(w, w.b, {"code": bad}, cats=["notes"], browse_seconds=0.2).result(10)
        assert e.value.code == "pairing-code-failed"
    # The window's own browse is not counted: it ran before the patch. Two joins browsed.
    assert browses[0] == 2
    # Two dials spent on this nameplate in 300 s: the third join answers at once, with the hint.
    with pytest.raises(PolarisError) as e2:
        dial(w, w.b, {"code": bad}, cats=["notes"]).result(10)
    assert e2.value.code == "pairing-code-failed" and "Wait" in e2.value.message
    assert browses[0] == 2
    # A QR is not limited.
    until(lambda: len(s.codes) == 3)
    pair_up(w, s, {"qr": s.codes[2].qr})


def test_the_budget_is_per_product_for_the_process_not_per_client(world: World) -> None:
    w = world
    s = show(w, w.a, ["notes"])
    bad = wrong_password(s.codes[0].code)
    for i in range(2):
        until(lambda n=i: len(s.codes) == n + 1)
        with pytest.raises(PolarisError):
            dial(w, w.b, {"code": bad}, cats=["notes"], browse_seconds=0.2).result(10)
    # A new client of the same product meets the spent budget.
    fresh = w.device("c")
    with pytest.raises(PolarisError) as e:
        dial(w, fresh, {"code": bad}, cats=["notes"]).result(10)
    assert e.value.code == "pairing-code-failed" and "Wait" in e.value.message


def test_a_code_that_does_not_parse_browses_nothing_and_no_advert_is_pairing_not_found(world: World) -> None:
    w = world
    with pytest.raises(PolarisError) as e:
        dial(w, w.b, {"code": "1234 567"}, cats=["notes"]).result(10)
    assert e.value.code == "pairing-code-failed" and w.net.browsers == []
    # The browse runs out: the joiner's timer fires at once.
    with pytest.raises(PolarisError) as e2:
        dial(w, w.b, {"code": "1234 5678"}, cats=["notes"], timer=lambda fn, s: (fn(), lambda: None)[1]).result(10)
    assert e2.value.code == "pairing-not-found"


def test_a_decline_stores_nothing_on_either_side_and_the_window_stays_for_another_try(world: World) -> None:
    w = world
    s = show(w, w.a, ["notes"])
    offers_b: List[Any] = []
    joined = dial(w, w.b, {"code": s.codes[0].code}, offers_b)
    until(lambda: len(s.offers) == 1 and len(offers_b) == 1)
    s.offers[0].decline()
    with pytest.raises(PolarisError) as e:
        joined.result(10)
    assert e.value.code == "peer-closed"
    until(lambda: len(s.failed) == 1)
    assert s.failed == ["declined"]
    assert w.a.cloud_connect.local_links.list() == [] and w.b.cloud_connect.local_links.list() == []
    # The session reached the transport and ended with no link: no failure counted, the code rotated.
    until(lambda: len(s.codes) == 2)
    assert s.handle.open is True


def test_one_window_per_device_and_a_second_pair_is_refused(world: World) -> None:
    w = world
    show(w, w.a, ["notes"])
    with pytest.raises(LanError) as e:
        show(w, w.a, ["notes"])
    assert e.value.reason == "bad_input"


def test_bad_options_are_refused(world: World) -> None:
    w = world
    for cats in (["Photos"], ["a", "a"], ["c%d" % i for i in range(9)]):
        with pytest.raises(LanError):
            show(w, w.a, cats)
    with pytest.raises(LanError):
        w.a.cloud_connect.local_links.pair(categories=[], on_code=lambda c: None)  # no on_confirm
    with pytest.raises(LanError):
        w.a.cloud_connect.local_links.join(categories=[], on_confirm=lambda o: None)  # neither code nor qr
    with pytest.raises(LanError):
        w.a.cloud_connect.local_links.join(categories=[], on_confirm=lambda o: None, code="1", qr="2")


# -- the gate and the cap ------------------------------------------------------------------------------


def test_the_gate_is_off_with_no_cached_document_and_while_discovery_says_false(tmp_path: Path) -> None:
    w = World(tmp_path, local=False)
    try:
        with pytest.raises(UnsupportedError) as e:
            show(w, w.a, [])
        assert e.value.code == "local-pairing-off"
        with pytest.raises(UnsupportedError) as e2:
            dial(w, w.b, {"code": "1234 5678"}, cats=[]).result(10)
        assert e2.value.code == "local-pairing-off"
        assert w.net.adverts == {}
        # A client that never discovered has no cached document: off.
        w.disco.local = True
        fresh = w.device("c", discover=False)
        assert fresh.cloud_connect.local_links.local_pairing() is False
        with pytest.raises(UnsupportedError):
            fresh.cloud_connect.local_links.join(categories=[], code="1234 5678", on_confirm=lambda o: None)
        w.a.discover()
        assert w.a.cloud_connect.local_links.local_pairing() is True
    finally:
        w.close()


def test_a_read_that_clears_the_answer_closes_the_open_window_an_error_read_changes_nothing(world: World) -> None:
    w = world
    s = show(w, w.a, ["notes"])
    # An unreachable read leaves a cached true alone (local links serve LANs with no internet).
    w.disco.status = 503
    w.a.discover()
    assert s.handle.open is True and w.a.cloud_connect.local_links.local_pairing() is True
    # The product turned it off: the window closes and the advert is withdrawn.
    w.disco.status = 200
    w.disco.local = False
    w.a.discover()
    until(lambda: not s.handle.open)
    assert w.a.cloud_connect.local_links.local_pairing() is False
    until(lambda: m_q(w) == [])


def test_a_read_that_cleared_the_answer_cancels_a_join_before_it_dials(world: World) -> None:
    w = world
    offers: List[Any] = []
    joined = dial(w, w.b, {"code": "1234 5678"}, offers, cats=["notes"])
    until(lambda: len(w.net.browsers) == 1)
    w.disco.local = False
    w.b.discover()
    with pytest.raises(PolarisError):
        joined.result(10)


def test_a_device_that_holds_32_links_answers_local_links_full_before_anything_is_advertised(world: World) -> None:
    w = world
    store = w.a.connect.local_store()
    for i in range(32):
        ok, _id = store.add(
            own_key=bytes([1]) * 32,
            own_public=bytes([2]) * 32,
            peer_key=bytes([i]) + bytes([9]) * 31,
            secret=bytes([4]) * 32,
            cats=[],
            now=T0,
        )
        assert ok
    with pytest.raises(PolarisError) as e:
        show(w, w.a, [])
    assert e.value.code == "local-links-full"
    with pytest.raises(PolarisError) as e2:
        dial(w, w.a, {"code": "1234 5678"}, cats=[]).result(10)
    assert e2.value.code == "local-links-full"
    assert w.net.adverts == {}
    # The 33rd is refused by the store itself, under its lock.
    ok, _id = store.add(
        own_key=bytes([1]) * 32, own_public=bytes([2]) * 32, peer_key=bytes([99]) * 32, secret=bytes([4]) * 32,
        cats=[], now=T0,
    )
    assert not ok and store.count() == 32


# -- the store -----------------------------------------------------------------------------------------


def test_the_store_is_one_file_0600_with_the_links_in_held_order_and_a_damaged_file_is_not_replaced(
    world: World,
) -> None:
    w = world
    s = show(w, w.a, ["notes"])
    pair_up(w, s, {"code": s.codes[0].code})
    path = Path(w.a.core.dirs.state) / LOCAL_STATE_FILE
    assert path.exists()
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    doc = json.loads(path.read_text())
    assert doc["schema"] == "pkey.connect.local.v1" and doc["product"] == "djdl" and len(doc["links"]) == 1
    # A record that exists but is unusable is an error, never silently replaced.
    path.write_text('{"schema":"other"}')
    with pytest.raises(PolarisError) as e:
        w.a.cloud_connect.local_links.list()
    assert e.value.code == "store-failed"
    assert path.read_text() == '{"schema":"other"}'
    assert w.a.connect.live_locals() == []


def test_the_store_judges_the_cap_under_its_lock_when_threads_add_together(world: World) -> None:
    w = world
    store = w.a.connect.local_store()
    results: List[Any] = []

    def add(i: int) -> None:
        results.append(
            store.add(
                own_key=bytes([1]) * 32, own_public=bytes([2]) * 32, peer_key=bytes([i]) + bytes([5]) * 31,
                secret=bytes([4]) * 32, cats=[], now=T0,
            )[0]
        )

    futs = [w.pool.submit(add, i) for i in range(40)]
    for f in futs:
        f.result(20)
    assert store.count() == 32 and sum(1 for r in results if r) == 32


def test_the_listing_is_not_gated_and_a_label_is_renamed_on_this_device_only(world: World) -> None:
    w = world
    s = show(w, w.a, ["notes"])
    pair_up(w, s, {"code": s.codes[0].code})
    (info,) = w.a.cloud_connect.local_links.list()
    assert info.label == "Bo"
    w.disco.local = False
    w.a.discover()
    # Managing links is never gated.
    assert len(w.a.cloud_connect.local_links.list()) == 1
    assert w.a.cloud_connect.local_links.rename(info.id, "  Roommate‮ ") is True
    assert w.a.cloud_connect.local_links.list()[0].label == "Roommate"
    assert w.a.cloud_connect.local_links.rename("x" * 16, "Nobody") is False
    with pytest.raises(LanError):
        w.a.cloud_connect.local_links.rename(info.id, "​  ")
    with pytest.raises(LanError):
        w.a.cloud_connect.local_links.rename(info.id, "x" * 65)
    # The peer's own record is untouched.
    assert w.b.cloud_connect.local_links.list()[0].label == "Ana"
    assert w.a.cloud_connect.local_links.remove(info.id) is True
    assert w.a.cloud_connect.local_links.remove(info.id) is False
    assert w.a.cloud_connect.local_links.list() == []


# -- the gate's read order, and a window that is still opening --------------------------------------------


def test_the_gate_is_applied_before_the_stores_and_an_older_read_never_overwrites_a_newer_one(world: World) -> None:
    from polaris_key.discovery import DiscoveryNotFound, DiscoveryOk

    w = world
    # A store that throws on discovery must not leave a cleared gate on.
    s = show(w, w.a, ["notes"])
    w.a.presentation_source.accept = lambda manifest: (_ for _ in ()).throw(RuntimeError("store"))  # type: ignore[method-assign]
    w.disco.local = False
    w.a.discover()
    assert w.a.cloud_connect.local_links.local_pairing() is False
    until(lambda: not s.handle.open)
    # Reads apply in the order they began: the answer of read 2 is not undone by a slow read 1.
    c = w.b
    doc = {"services": {"connect": {"enabled": True, "localPairing": True}}}
    ok = DiscoveryOk(manifest=doc, services=None)  # type: ignore[arg-type]
    c._read_local_gate(5, ok)
    assert c.cloud_connect.local_links.local_pairing() is True
    c._read_local_gate(4, DiscoveryNotFound())
    assert c.cloud_connect.local_links.local_pairing() is True
    c._read_local_gate(6, DiscoveryNotFound())
    assert c.cloud_connect.local_links.local_pairing() is False


def test_a_gate_clearing_read_while_a_window_is_still_opening_closes_it_before_anyone_sees_a_code(
    tmp_path: Path,
) -> None:
    import asyncio

    class Held(Network):
        hold: Any = None

        async def browse(self, *a: Any, **k: Any) -> Any:
            if self.hold is not None:
                await self.hold.wait()
            return await super().browse(*a, **k)

    w = World(tmp_path)
    try:
        net = Held()
        w.net = net
        net.hold = w.a.cloud_connect._read(lambda: asyncio.Event())
        codes: List[Any] = []
        errs: List[BaseException] = []

        def go() -> None:
            try:
                show(w, w.a, ["notes"])
            except BaseException as e:  # noqa: BLE001 - the test reads it
                errs.append(e)

        t = w.pool.submit(go)
        until(lambda: w.a.cloud_connect.local_links._starting is not None)
        # The slot is taken: a second pair meets it while the first is still opening.
        with pytest.raises(LanError):
            w.a.cloud_connect.local_links.pair(categories=[], on_code=codes.append, on_confirm=lambda o: None)
        w.disco.local = False
        w.a.discover()
        w.a.cloud_connect._read(net.hold.set)
        t.result(10)
        assert errs and isinstance(errs[0], UnsupportedError) and errs[0].code == "local-pairing-off"
        assert codes == [] and w.a.cloud_connect.local_links._shower is None
        until(lambda: m_q(w) == [])
    finally:
        w.close()
