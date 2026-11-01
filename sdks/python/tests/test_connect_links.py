# @pkey-feature connect.links
"""Inter-account links end to end in one process (CC-19.6; WIRE-CONTRACT-V5 section 15.10): two clients of two
accounts on 127.0.0.1 over a fake mDNS network pair, hold a link, and open a mode-c session on the LAN.
Mirrors Node's ``test/connect/links.test.ts`` (the gate, pairing, the LAN session, revocation)."""

from __future__ import annotations

import time
from typing import Any, List

import pytest
from helpers import make_client
from test_connect_identity import FakeWorker, _tokened
from test_connect_lan import Network, until

from polaris_key.core.caps import UnsupportedError


def _dev(w: FakeWorker, tmp_path: Any, name: str, inter: bool) -> Any:

    st = _tokened()
    c = make_client(w, store=st, state_dir=str(tmp_path / name), expected_services=["license", "config", "connect"])
    c._discovery_doc = {"services": {"connect": {"enabled": True, "interAccount": inter}}}
    c.connect.identity()
    return c


@pytest.fixture
def world(tmp_path: Any) -> Any:
    now = int(time.time())
    wa, wb = FakeWorker(now=now), FakeWorker(now=now)
    wb.sub = "ps_ZyXwVuTsRqPoNmLkJiHgFe"
    a, b = _dev(wa, tmp_path, "a", True), _dev(wb, tmp_path, "b", True)
    yield a, b, Network()
    for c in (a, b):
        try:
            c.close()
        except Exception:
            pass


def _pair(a: Any, b: Any, net: Network) -> Any:
    offers: List[Any] = [[], []]
    linked: List[Any] = [[], []]
    handles = []
    for i, (c, cats, label) in enumerate(((a, ["photos", "notes"], "Ana"), (b, ["notes", "docs"], "Bo"))):
        handles.append(
            c.cloud_connect.links.pair(
                categories=cats,
                label=label,
                mdns=net,
                host="127.0.0.1",
                allow_loopback=True,
                on_code=offers[i].append,
                on_linked=linked[i].append,
            )
        )
    until(lambda: offers[0] and offers[1])
    assert offers[0][0].code == offers[1][0].code
    assert offers[0][0].label == "Bo" and offers[0][0].categories == ("photos", "notes")
    assert a.cloud_connect.links.list() == []  # nothing is stored before both confirm
    offers[0][0].confirm()
    offers[1][0].confirm()
    until(lambda: linked[0] and linked[1])
    return linked


def test_the_gate_is_a_typed_na_and_nothing_is_advertised(tmp_path: Any) -> None:
    now = int(time.time())
    c = _dev(FakeWorker(now=now), tmp_path, "g", False)
    try:
        assert c.cloud_connect.links.inter_account() is False
        with pytest.raises(UnsupportedError) as e:
            c.cloud_connect.links.pair(categories=[], on_code=lambda o: None)
        assert e.value.code == "connect_links_disabled"
        with pytest.raises(UnsupportedError):
            c.cloud_connect.links.open("x" * 16)
        assert c.cloud_connect.links.list() == []
    finally:
        c.close()


def test_bad_categories_are_refused(world: Any) -> None:
    from polaris_key.connect.errors import LanError

    a, _b, _n = world
    for cats in (["Photos"], ["a", "a"], ["c%d" % i for i in range(9)]):
        with pytest.raises(LanError):
            a.cloud_connect.links.pair(categories=cats, on_code=lambda o: None)


def test_pair_stores_a_link_on_both_devices_and_a_mode_c_session_opens_on_the_lan(world: Any) -> None:
    a, b, net = world
    linked = _pair(a, b, net)
    la, lb = a.cloud_connect.links.list(), b.cloud_connect.links.list()
    assert la[0].label == "Bo" and la[0].categories == ("notes",) and la[0].reachable and not la[0].re_pair_pending
    assert lb[0].label == "Ana"
    assert linked[0][0].id == la[0].id and linked[0][0].re_pair is False
    # The record holds the secret; the listing hands out none.
    assert "secret" not in repr(la[0]) and not hasattr(la[0], "secret")

    opts = {"lan": {"mdns": net, "host": "127.0.0.1", "allow_loopback": True}, "relay": False}
    a.cloud_connect.start(opts)
    b.cloud_connect.start(opts)
    inbound: List[Any] = []
    a.cloud_connect.links.on_link(inbound.append)
    out: List[Any] = []

    def dial() -> bool:
        try:
            out.append(b.cloud_connect.links.open(lb[0].id))
            return True
        except Exception:
            return False

    until(dial)
    until(lambda: inbound)
    s = out[0]
    assert s.path == "lan" and s.contact is not None and s.contact.id == lb[0].id and s.peer_device_id == ""
    s.send(b"across accounts")
    assert inbound[0].receive(5).body == b"across accounts"

    # Deleting the contact ends the open session peer_revoked on both ends.
    closed: List[Any] = []
    inbound[0].on_close(closed.append)
    assert b.cloud_connect.links.remove(lb[0].id) is True
    assert b.cloud_connect.links.remove(lb[0].id) is False
    until(lambda: closed)
    assert closed[0].code == "peer_revoked"
    assert b.cloud_connect.links.list() == []


def test_a_refresh_that_says_false_withdraws_the_adverts(world: Any) -> None:
    a, b, net = world
    _pair(a, b, net)
    opts = {"lan": {"mdns": net, "host": "127.0.0.1", "allow_loopback": True}, "relay": False}
    a.cloud_connect.start(opts)
    until(lambda: any("m=c" in x.txt for x in net.adverts.values()))
    a._discovery_doc = {"services": {"connect": {"enabled": True, "interAccount": False}}}
    a.connect.notify_contacts()
    until(lambda: not any("m=c" in x.txt for x in net.adverts.values()))


# -- a handshake in flight when the footing goes; the cached gate; promotion by secret ---------------------


def _hold_after_first_send(monkeypatch: Any) -> Any:
    """Hold every send after a link's first (handshake message 3 and later) until ``release()``."""
    import threading

    from polaris_key.core.peer_link import SocketLink

    orig = SocketLink._send
    state: Any = {"held": 0, "queue": [], "open": False, "lock": threading.Lock()}

    def send(self: Any, noise: bytes) -> None:
        n = getattr(self, "_hold_n", 0) + 1
        self._hold_n = n
        if n >= 2 and not state["open"]:
            with state["lock"]:
                if n == 2:
                    state["held"] += 1
                state["queue"].append((self, noise))
            return
        orig(self, noise)

    def release() -> None:
        state["open"] = True
        for link, noise in list(state["queue"]):
            link._loop.call_soon_threadsafe(orig, link, noise)

    monkeypatch.setattr(SocketLink, "_send", send)
    state["release"] = release
    return state


def _in_flight(world: Any, monkeypatch: Any, then: Any) -> List[Any]:
    import threading

    a, b, net = world
    _pair(a, b, net)
    ida, idb = a.cloud_connect.links.list()[0].id, b.cloud_connect.links.list()[0].id
    opts = {"lan": {"mdns": net, "host": "127.0.0.1", "allow_loopback": True}, "relay": False}
    a.cloud_connect.start(opts)
    b.cloud_connect.start(opts)
    inbound: List[Any] = []
    a.cloud_connect.links.on_link(inbound.append)
    hold = _hold_after_first_send(monkeypatch)

    def dial() -> None:
        for _ in range(100):
            if hold["held"]:
                return
            try:
                b.cloud_connect.links.open(idb, relay=False, lan_attempt_seconds=20)
                return
            except Exception:
                time.sleep(0.01)

    t = threading.Thread(target=dial, daemon=True)
    t.start()
    until(lambda: hold["held"] == 1)
    then(a, ida)
    hold["release"]()
    t.join(10)
    time.sleep(0.5)
    return inbound


def test_remove_before_a_handshake_completes_delivers_no_session(world: Any, monkeypatch: Any) -> None:
    def then(a: Any, ida: str) -> None:
        assert a.cloud_connect.links.remove(a.cloud_connect.links.list()[0].id) is True

    assert _in_flight(world, monkeypatch, then) == []


def test_a_gate_flip_before_a_handshake_completes_delivers_no_session(world: Any, monkeypatch: Any) -> None:
    def then(a: Any, _ida: str) -> None:
        a._discovery_doc = {"services": {"connect": {"enabled": True, "interAccount": False}}}
        a.connect.notify_contacts()
        time.sleep(0.2)

    assert _in_flight(world, monkeypatch, then) == []


def test_a_discovery_answer_older_than_a_day_no_longer_counts(world: Any) -> None:
    a, _b, _net = world
    assert a.cloud_connect.links.inter_account() is True
    a._links_until = a.core.now() + 60
    assert a.cloud_connect.links.inter_account() is True
    a._links_until = a.core.now() - 1
    assert a.cloud_connect.links.inter_account() is False


def test_a_failed_discovery_closes_the_gate(world: Any, monkeypatch: Any) -> None:
    import polaris_key.client as pc
    from polaris_key.discovery import DiscoveryNotFound

    a, b, net = world
    _pair(a, b, net)
    opts = {"lan": {"mdns": net, "host": "127.0.0.1", "allow_loopback": True}, "relay": False}
    a.cloud_connect.start(opts)
    until(lambda: any("m=c" in x.txt for x in net.adverts.values()))
    a._links_until = a.core.now() + 3600
    monkeypatch.setattr(pc, "discover_product", lambda **_kw: DiscoveryNotFound())
    monkeypatch.setattr(a.core, "http", lambda: None)
    a.discover()
    assert a.cloud_connect.links.inter_account() is False
    until(lambda: not any("m=c" in x.txt for x in net.adverts.values()))


def test_promotion_follows_the_secret_not_the_peer_key() -> None:
    from polaris_key.connect.contacts import promote_row, secret_tag
    from polaris_key.connect.state import ContactRow
    from polaris_key.core.b64url import b64url_encode

    key = "A" * 43
    s1, s2 = bytes([1]) * 32, bytes([2]) * 32

    def row(secret: bytes, pending: Any = None) -> Any:
        return ContactRow(
            agree_key=key, secret=b64url_encode(secret), cats=("notes",), created_at=1, reachable=True,
            pending_since=pending,
        )

    rows = [row(s1), row(s2, 5)]
    assert promote_row(rows, key, secret_tag(s1)) == rows
    assert [r.secret for r in promote_row(rows, key, secret_tag(s2))] == [b64url_encode(s2)]
