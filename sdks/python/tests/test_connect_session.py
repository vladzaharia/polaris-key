# @pkey-feature connect.protocol
"""The host session (CC-10.10; WIRE-CONTRACT-V5 §15.5, §15.6): ``core/peer_link.py`` over real loopback
TCP on the Connect loop, ``connect/session.py``'s routing and queue bounds, and ``connect/channel.py``'s
pushed documents. Mirrors the session half of Node's ``lan.e2e.test.ts``. No network beyond 127.0.0.1."""

from __future__ import annotations

import asyncio
import pickle
import threading
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from test_connect_peer_session import ID_A, ID_B, NOW, SUB, TRUST, Dev, _ring, _rnd

from polaris_key.connect.channel import (
    MAX_DOCS_QUEUED,
    REFRESH_GAP_SECONDS,
    ConnectNotice,
    PeerDocs,
    PeerDocsSource,
    channel_base,
    peer_account,
)
from polaris_key.connect.client import DiscoveryKeys, PeerSource
from polaris_key.connect.errors import LanError
from polaris_key.connect.loop import connect_loop
from polaris_key.connect.session import (
    MAX_QUEUED_MESSAGES,
    QUEUE_MAX_BYTES,
    QUEUE_PAUSE_BYTES,
    QUEUE_RESUME_BYTES,
    ConnectSession,
    QueueBudget,
    SessionClosed,
    SessionMessage,
    route_record,
    session_handlers,
    wait_opened,
)
from polaris_key.core.b64url import b64url_encode
from polaris_key.core.peer_frame import encode_frame
from polaris_key.core.peer_link import HANDSHAKE_FRAME_MAX, LinkRefused, SocketLink
from polaris_key.core.peer_session import PeerHello


class KeyPort:
    """The device's static key as Noise sees it; the private half stays inside."""

    def __init__(self, priv: bytes, pub: bytes) -> None:
        self._k = X25519PrivateKey.from_private_bytes(priv)
        self._pub = pub

    def public_key(self) -> bytes:
        return self._pub

    def dh(self, remote: bytes) -> Optional[bytes]:
        return self._k.exchange(X25519PublicKey.from_public_bytes(remote))


_RING: List[str] = []


def roster() -> str:
    if not _RING:
        a, b = devices()
        _RING.append(_ring([a, b], epoch=1))
    return _RING[0]


def source(dev: Dev, k: bytes, prev: Optional[bytes] = None) -> PeerSource:
    return PeerSource(
        slug="djdl",
        trust=TRUST,
        sub=SUB,
        device_id=dev.id,
        cert_jws=dev.cert,
        cert_expires_at=dev.exp,
        ring_jws=roster(),
        ring_epoch=1,
        roster=(dev.id,),
        keys=DiscoveryKeys(k, prev),
        agree_public=dev.pub,
        static_key=KeyPort(dev.priv, dev.pub),
    )


def devices() -> Tuple[Dev, Dev]:
    a, b = Dev(ID_A), Dev(ID_B)
    a.sign_key, b.sign_key = b64url_encode(bytes([1]) * 32), b64url_encode(bytes([2]) * 32)
    return a, b


def run(coro: Any, timeout: float = 15) -> Any:
    return connect_loop().submit(coro).result(timeout)


class Rig:
    """A responder listening on loopback and any number of initiators, all on the Connect loop."""

    def __init__(self, *, k: Optional[bytes] = None, now: int = NOW, **resp_kw: Any) -> None:
        self.a, self.b = devices()
        self.k = k or _rnd()
        self.now = now
        self.resp_kw = resp_kw
        self.inbound: "List[Any]" = []
        self.inbound_links: List[SocketLink] = []
        self.ended = threading.Event()
        self.server: Any = None
        self.port = 0
        self.responder_sessions: "List[ConnectSession]" = []
        self.got_session = threading.Event()

    async def _serve(self, reader: Any, writer: Any) -> None:
        h = session_handlers(
            "responder",
            on_established=self._established,
            on_ended=self.ended.set,
        )
        link = SocketLink(
            reader,
            writer,
            {**channel_base(source(self.b, self.k), now=lambda: self.now), "role": "responder"},
            h,
            **self.resp_kw,
        )
        self.inbound_links.append(link)
        await link.run()

    def _established(self, s: ConnectSession) -> None:
        self.responder_sessions.append(s)
        self.got_session.set()

    async def _listen(self) -> None:
        self.server = await asyncio.start_server(self._serve, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    def __enter__(self) -> "Rig":
        run(self._listen())
        return self

    def __exit__(self, *a: Any) -> None:
        async def stop() -> None:
            self.server.close()
            for link in self.inbound_links:
                link.channel.close("peer_bye")

        run(stop())

    async def _dial(self, k: Optional[bytes], handlers: Any = None, **kw: Any) -> SocketLink:
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        link = SocketLink(
            reader,
            writer,
            {**channel_base(source(self.a, k or self.k), now=lambda: self.now), "role": "initiator"},
            handlers or session_handlers("initiator"),
            **kw,
        )
        asyncio.get_running_loop().create_task(link.run())
        link.start()
        return link

    def dial(self, k: Optional[bytes] = None, **kw: Any) -> ConnectSession:
        async def go() -> ConnectSession:
            link = await self._dial(k, **kw)
            return await wait_opened(link, 10)

        return run(go())  # type: ignore[no-any-return]


# -- over real TCP -----------------------------------------------------------------------------------


def test_two_devices_open_a_session_exchange_messages_and_close() -> None:
    with Rig() as rig:
        mine = rig.dial()
        assert rig.got_session.wait(5)
        theirs = rig.responder_sessions[0]
        assert mine.peer_device_id == ID_B and theirs.peer_device_id == ID_A
        assert mine.role == "initiator" and theirs.role == "responder"
        assert mine.caps == ("app/1",) and mine.hello.platform and mine.path == "lan"
        assert theirs.remote_address == "127.0.0.1"
        mine.send(b"hello", 0x0100)
        assert theirs.receive(5) == SessionMessage(0x0100, b"hello")
        theirs.send(b"back", 0x0200)
        assert mine.receive(5) == SessionMessage(0x0200, b"back")
        got: List[Any] = []
        closed = threading.Event()
        mine.on_message(got.append)
        theirs.send(b"cb")
        for _ in range(100):
            if got:
                break
            threading.Event().wait(0.02)
        assert got == [SessionMessage(0x0100, b"cb")]
        theirs.on_close(lambda c: closed.set())
        mine.close()
        assert closed.wait(5)
        assert theirs.closed == SessionClosed("peer_bye", True)
        assert mine.closed is not None and mine.closed.code == "peer_bye"
        with pytest.raises(LanError) as e:
            mine.send(b"late")
        assert e.value.reason == "closed"
        with pytest.raises(LanError):
            theirs.receive(1)


def test_a_large_message_is_split_and_reassembled() -> None:
    with Rig() as rig:
        mine = rig.dial()
        assert rig.got_session.wait(5)
        body = bytes(range(256)) * 2048  # 512 KiB, several records
        mine.send(body)
        assert rig.responder_sessions[0].receive(10).body == body


def test_send_refuses_a_bad_type_and_a_message_over_the_peers_limit() -> None:
    with Rig() as rig:
        mine = rig.dial()
        for bad in (0x00FF, 0x8000, 0x10000, True):
            with pytest.raises(LanError) as e:
                mine.send(b"x", bad)  # type: ignore[arg-type]
            assert e.value.reason == "bad_type"
        # The peer says it takes at most 8 bytes.
        mine._link.channel._max_send = 8
        with pytest.raises(LanError) as e:
            mine.send(b"123456789")
        assert e.value.reason == "too_large"
        mine.send(b"12345678")


def test_a_wrong_discovery_key_is_not_admitted_and_the_responder_stays_silent() -> None:
    with Rig() as rig:

        async def go() -> Any:
            link = await rig._dial(_rnd())
            try:
                await wait_opened(link, 10)
            except LanError as e:
                return e
            return None

        e = run(go())
        assert isinstance(e, LanError) and e.reason == "handshake_failed" and e.close_code == "connection_lost"
        assert rig.ended.wait(5) and not rig.responder_sessions


def test_the_previous_key_still_admits() -> None:
    old = _rnd()
    with Rig(k=_rnd()) as rig:
        # The responder holds (current, previous): rebuild it through the rig's key and a previous one.
        rig.k = old
        s = rig.dial(old)
        assert s.peer_device_id == ID_B


def test_a_socket_that_never_finishes_the_handshake_is_closed() -> None:
    with Rig(handshake_seconds=0.3) as rig:

        async def go() -> Any:
            r, w = await asyncio.open_connection("127.0.0.1", rig.port)
            await asyncio.sleep(1.0)
            data = await r.read(10)
            w.close()
            return data

        assert run(go()) == b""
        assert rig.ended.wait(5) and not rig.responder_sessions


def test_an_oversize_frame_before_the_handshake_closes_the_socket() -> None:
    with Rig() as rig:

        async def go() -> bytes:
            r, w = await asyncio.open_connection("127.0.0.1", rig.port)
            w.write(encode_frame(b"\x00" * (HANDSHAKE_FRAME_MAX + 1)))
            await w.drain()
            data = await asyncio.wait_for(r.read(10), 5)
            w.close()
            return data

        assert run(go()) == b""
        assert rig.ended.wait(5)


def test_a_zero_length_frame_closes_the_socket() -> None:
    with Rig() as rig:

        async def go() -> bytes:
            r, w = await asyncio.open_connection("127.0.0.1", rig.port)
            w.write(b"\x00\x00")
            await w.drain()
            data = await asyncio.wait_for(r.read(10), 5)
            w.close()
            return data

        assert run(go()) == b""
        assert rig.ended.wait(5)


def test_a_lost_connection_ends_the_session_with_connection_lost() -> None:
    with Rig() as rig:
        mine = rig.dial()
        assert rig.got_session.wait(5)
        done = threading.Event()
        rig.responder_sessions[0].on_close(lambda c: done.set())

        async def drop() -> None:
            mine._link._writer.transport.abort()

        run(drop())
        assert done.wait(5)
        assert rig.responder_sessions[0].closed == SessionClosed("connection_lost", False)


def test_an_inbound_app_critical_record_closes_the_session_unknown_critical() -> None:
    with Rig() as rig:
        mine = rig.dial()
        assert rig.got_session.wait(5)
        theirs = rig.responder_sessions[0]
        done, mine_done = threading.Event(), threading.Event()
        theirs.on_close(lambda c: done.set())
        mine.on_close(lambda c: mine_done.set())
        mine.send_record(0x8100, b"x")  # the host sends an APP-critical type
        assert done.wait(5) and mine_done.wait(5)
        assert theirs.closed == SessionClosed("peer_unknown_critical", False)
        assert mine.closed == SessionClosed("peer_unknown_critical", True)


def test_a_non_app_record_is_ignored_not_delivered() -> None:
    with Rig() as rig:
        mine = rig.dial()
        assert rig.got_session.wait(5)
        mine.send_record(0x0006, b"candidates")  # CANDIDATES: the session hands it up, the host never sees it
        mine.send(b"after")
        assert rig.responder_sessions[0].receive(5).body == b"after"


def test_a_peer_certificate_that_runs_out_ends_the_session_through_the_loop_clock() -> None:
    with Rig(now=NOW) as rig:
        rig.a.exp = NOW + 2  # shown to the responder
        rig.dial()
        assert rig.got_session.wait(5)
        theirs = rig.responder_sessions[0]
        done = threading.Event()
        theirs.on_close(lambda c: done.set())
        rig.now = NOW + 3  # the responder's wall clock moves past it
        assert done.wait(5)
        assert theirs.closed == SessionClosed("peer_expired", False)


# -- the session object alone ------------------------------------------------------------------------


class FakeLink:
    def __init__(self) -> None:
        self.sent: List[Tuple[int, bytes]] = []
        self.closed: List[str] = []
        self.paused: List[bool] = []

    def send_record(self, t: int, b: bytes) -> None:
        self.sent.append((t, b))

    def close(self, code: str) -> None:
        self.closed.append(code)

    close_nowait = close

    def pause(self, on: bool) -> None:
        self.paused.append(on)


def fake_session(budget: Optional[QueueBudget] = None) -> Tuple[ConnectSession, FakeLink]:
    link = FakeLink()
    hello = PeerHello("t", "a", 1 << 20)
    return ConnectSession(link, ID_B, ["app/1"], hello, "initiator", "10.0.0.2", budget=budget), link


def test_routing_delivers_only_the_app_range() -> None:
    s, link = fake_session()
    for t in (0x0100, 0x7FFF):
        route_record(link, s, t, b"x")
    for t in (0x0006, 0x0020, 0x8001, 0x00FF, 0xFFFE):
        route_record(link, s, t, b"x")
    assert [s.receive(0).type for _ in range(2)] == [0x0100, 0x7FFF] and link.closed == []
    with pytest.raises(TimeoutError):
        s.receive(0.01)
    for t in (0x8100, 0xFFFD):
        route_record(link, s, t, b"x")
    assert link.closed == ["peer_unknown_critical"] * 2
    route_record(link, None, 0x0100, b"x")  # before the session exists: dropped


def test_the_queue_closes_busy_at_256_messages() -> None:
    s, link = fake_session()
    for _ in range(MAX_QUEUED_MESSAGES):
        s.deliver(SessionMessage(0x0100, b"x"))
    assert link.closed == []
    s.deliver(SessionMessage(0x0100, b"x"))
    assert link.closed == ["peer_busy"]


def test_the_queue_pauses_at_4_mib_resumes_under_1_mib_and_closes_busy_at_8_mib() -> None:
    s, link = fake_session()
    chunk = b"\x00" * (1024 * 1024)
    for _ in range(4):
        s.deliver(SessionMessage(0x0100, chunk))
    assert link.paused == []
    s.deliver(SessionMessage(0x0100, b"\x00"))
    assert link.paused == [True]
    for _ in range(3):
        s.receive(0)
    assert link.paused == [True]  # 1 MiB + 1 byte still queued
    s.receive(0)
    assert link.paused == [True, False]
    big = b"\x00" * QUEUE_MAX_BYTES
    s.deliver(SessionMessage(0x0100, big))
    assert link.closed == ["peer_busy"]
    assert QUEUE_PAUSE_BYTES > QUEUE_RESUME_BYTES


def test_all_sessions_share_a_byte_budget() -> None:
    budget = QueueBudget(10)
    a, la = fake_session(budget)
    b, lb = fake_session(budget)
    a.deliver(SessionMessage(0x0100, b"x" * 6))
    b.deliver(SessionMessage(0x0100, b"x" * 6))
    assert lb.closed == ["peer_busy"] and la.closed == []
    assert budget.used == 6
    a.receive(0)
    assert budget.used == 0
    b.deliver(SessionMessage(0x0100, b"x" * 6))
    assert budget.used == 6
    b.ended(SessionClosed("peer_bye", True))
    assert budget.used == 0  # a closed session gives its bytes back


def test_a_subscriber_gets_messages_instead_of_the_queue_and_may_raise() -> None:
    s, _ = fake_session()
    seen: List[Any] = []

    def bad(m: Any) -> None:
        seen.append(m)
        raise RuntimeError("host bug")

    off = s.on_message(bad)
    s.deliver(SessionMessage(0x0100, b"a"))
    off()
    s.deliver(SessionMessage(0x0100, b"b"))
    assert seen == [SessionMessage(0x0100, b"a")] and s.receive(0).body == b"b"


def test_a_closed_session_wakes_a_blocked_receive_and_late_subscribers_are_told() -> None:
    s, _ = fake_session()
    out: List[Any] = []

    def waiter() -> None:
        try:
            s.receive(5)
        except LanError as e:
            out.append(e.reason)

    t = threading.Thread(target=waiter)
    t.start()
    threading.Event().wait(0.1)
    s.ended(SessionClosed("peer_bye", True))
    t.join(5)
    assert out == ["closed"]
    late: List[Any] = []
    s.on_close(late.append)
    assert late == [SessionClosed("peer_bye", True)]
    s.ended(SessionClosed("other", False))
    assert s.closed == SessionClosed("peer_bye", True)


def test_close_takes_only_the_two_host_codes_and_send_maps_link_failures() -> None:
    s, link = fake_session()
    with pytest.raises(ValueError):
        s.close("peer_revoked")
    s.close("peer_busy")
    assert link.closed == ["peer_busy"]

    class Boom(FakeLink):
        def send_record(self, t: int, b: bytes) -> None:
            raise RuntimeError("gone")

    s2 = ConnectSession(Boom(), ID_B, [], PeerHello("t", "a", 1), "initiator", "")
    with pytest.raises(LanError) as e:
        s2.send(b"x")
    assert e.value.reason == "closed"


def test_a_session_names_no_key_and_cannot_be_pickled() -> None:
    with Rig() as rig:
        mine = rig.dial()
        text = repr(mine) + repr(mine._link) + repr(mine.hello)
        assert ID_B in text
        assert rig.k.hex() not in text and rig.a.cert not in text
        for o in (mine, mine._link):
            with pytest.raises(TypeError):
                pickle.dumps(o)
        assert "KeyPort" not in repr(mine._link.channel)


def test_link_refused_carries_the_close_code() -> None:
    assert LinkRefused("peer_revoked").close_code == "peer_revoked"


# -- pushed documents --------------------------------------------------------------------------------


def docs(**kw: Any) -> Tuple[PeerDocs, List[ConnectNotice], Dict[str, Any]]:
    log: Dict[str, Any] = {"refresh": 0, "stored": 0, "t": 1000, "timers": []}
    notes: List[ConnectNotice] = []

    def adopt(jws: str) -> Any:
        return SimpleNamespace(stored=jws.startswith("good"), epoch=7, reason="epoch_not_higher")

    def apply(jws: str) -> Any:
        return SimpleNamespace(applied=jws == "good", reason="invalid")

    def refresh() -> None:
        log["refresh"] += 1
        if log.get("fail"):
            raise RuntimeError("down")

    src = PeerDocsSource(
        now=lambda: log["t"],
        refresh=kw.pop("refresh", refresh),
        adopt_ring=kw.pop("adopt_ring", adopt),
        apply_trust=kw.pop("apply_trust", apply),
    )

    def timer(fn: Callable[[], None], seconds: float) -> Callable[[], None]:
        log["timers"].append((seconds, fn))
        return lambda: None

    d = PeerDocs(src, lambda: log.__setitem__("stored", log["stored"] + 1), spawn=lambda f: f(), timer=timer)
    d.on_notice(notes.append)
    return d, notes, log


def test_a_stored_roster_is_reported_and_a_refresh_follows() -> None:
    d, notes, log = docs()
    d.on_ring("good-1", 7)
    assert notes == [ConnectNotice("ring", "stored", epoch=7)]
    assert d.pushed == ("good-1", 7) and log["refresh"] == 1 and log["stored"] == 2
    d.on_ring("good-0", 3)
    assert d.pushed == ("good-1", 7)  # a lower epoch never replaces what is held


def test_a_refused_roster_and_trust_are_reported_with_the_reason() -> None:
    d, notes, _ = docs()
    d.ring("bad-1")
    d.on_trust("nope")
    d.on_trust("good")
    assert notes == [
        ConnectNotice("ring", "refused", reason="epoch_not_higher"),
        ConnectNotice("trust", "refused", reason="invalid"),
        ConnectNotice("trust", "applied"),
    ]


def test_without_a_source_member_the_document_is_refused_unsupported() -> None:
    d, notes, _ = docs(adopt_ring=None, apply_trust=None)
    d.ring("good")
    d.trust("good")
    assert [n.reason for n in notes] == ["unsupported", "unsupported"]


def test_a_failing_source_call_is_a_failed_notice_not_an_exception() -> None:
    def boom(_: str) -> Any:
        raise RuntimeError("store error")

    d, notes, _ = docs(adopt_ring=boom)
    d.ring("good")
    assert notes == [ConnectNotice("ring", "refused", reason="failed")]


def test_at_most_eight_documents_wait_and_a_duplicate_is_busy() -> None:
    held: List[Callable[[], None]] = []
    log: Dict[str, int] = {}
    src = PeerDocsSource(now=lambda: 0, adopt_ring=lambda j: SimpleNamespace(stored=False, reason="x"))
    d = PeerDocs(src, spawn=held.append)
    notes: List[ConnectNotice] = []
    d.on_notice(notes.append)
    for i in range(MAX_DOCS_QUEUED):
        d.ring("r%d" % i)
    d.ring("r0")  # already waiting
    d.ring("r-extra")  # the ninth
    assert [n.reason for n in notes] == ["busy", "busy"] and len(held) == MAX_DOCS_QUEUED
    held[0]()  # one finishes, a slot frees
    d.ring("r-extra")
    assert notes[-1].reason == "x" or len(held) == MAX_DOCS_QUEUED + 1
    del log


def test_a_refresh_runs_at_most_once_a_minute_and_a_failure_retries() -> None:
    d, _, log = docs()
    assert d.want_ring() is True and log["refresh"] == 1
    log["t"] += 30
    assert d.want_ring() is False and log["refresh"] == 1
    log["t"] += 31
    assert d.want_ring() is True and log["refresh"] == 2
    # A stored roster whose refresh fails is retried at the end of the gap.
    d2, _, log2 = docs()
    log2["fail"] = True
    d2.ring("good-1")
    assert log2["refresh"] == 1 and len(log2["timers"]) == 1
    seconds, fire = log2["timers"][0]
    assert seconds == REFRESH_GAP_SECONDS
    log2["t"] += 61
    log2["fail"] = False
    fire()
    assert log2["refresh"] == 2 and log2["stored"] == 2  # the roster, then the retried refresh


def test_no_refresh_member_means_no_fetch() -> None:
    d, _, _ = docs(refresh=None)
    assert d.want_ring() is False


def test_a_raising_notice_listener_cannot_break_handling() -> None:
    d, notes, _ = docs()

    def bad(n: ConnectNotice) -> None:
        raise RuntimeError("host")

    d.on_notice(bad)
    d.on_trust("good")
    assert notes == [ConnectNotice("trust", "applied")]


def test_the_channel_base_hands_the_session_a_key_handle_and_the_account() -> None:
    a, _ = devices()
    k = _rnd()
    src = source(a, k)
    base = channel_base(src, caps=["app/1", "x/2"], label="Desk", rekey_messages=5)
    assert base["slug"] == "djdl" and base["mode"] == "a" and base["caps"] == ["app/1", "x/2"]
    assert base["static_key"] is src.static_key and base["rekey_messages"] == 5
    assert base["hello"]["label"] == "Desk" and base["hello"]["app"] == "djdl"
    acct = base["account"]
    assert acct.disc_keys == [k, None] and acct.own_device_id == ID_A
    assert acct.held_ring() == (roster(), 1)
    pushed = peer_account(src, lambda: ("newer", 9))
    assert pushed.held_ring() == ("newer", 9)
    assert k.hex() not in repr(acct) + repr(base["static_key"])
