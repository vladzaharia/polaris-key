# @pkey-feature connect.transfer
"""Direct Transfer end to end (WIRE-CONTRACT-V5 §15.11): two real sessions wired in memory, each with the
host API (``Transfer``) and a partial-file store in a temp directory. Offer, accept, deliver; decline; consent
timeout; cancel from either side; resume after a dropped session; a hash mismatch; names that look like
paths; categories; the store's files, permissions and purge."""

from __future__ import annotations

import hashlib
import io
import os
import stat
import sys
from pathlib import Path
from typing import Any, Callable, List, Optional, Tuple

import pytest
from test_connect_peer_session import ID_A, ID_B, Dev, Side, _rnd

from polaris_key.connect.contacts import ContactRef
from polaris_key.connect.session import ConnectSession, SessionClosed
from polaris_key.connect.transfer import Accept, IncomingOffer, Transfer, TransferCancelled
from polaris_key.core.b64url import b64url_encode
from polaris_key.core.peer_session import Closed, Established

_POSIX = sys.platform != "win32"


def _content(n: int) -> bytes:
    return bytes(((i * 7 + 13) & 0xFF) for i in range(n))


class Clock:
    """A clock and a timer wheel for the hosts: nothing sleeps."""

    def __init__(self) -> None:
        self.t = 1_000_000.0
        self.timers: List[Tuple[float, Callable[[], None]]] = []

    def now(self) -> float:
        return self.t

    def timer(self, fn: Callable[[], None], seconds: float) -> Callable[[], None]:
        item = (self.t + seconds, fn)
        self.timers.append(item)
        return lambda: self.timers.remove(item) if item in self.timers else None

    def advance(self, dt: float) -> None:
        self.t += dt
        for item in sorted(self.timers, key=lambda x: x[0]):
            if item[0] <= self.t and item in self.timers:
                self.timers.remove(item)
                item[1]()


class FakeLink:
    """What ``session_handlers`` hands a transfer layer: the engine, its port and a close."""

    def __init__(self, side: Side) -> None:
        self.side = side
        self.channel = side.s

    def attach_xfer(self, on_record: Callable[[int, bytes], None]) -> Callable[[int, bytes], None]:
        return self.side.s.attach_xfer(on_record)

    def close(self, code: str = "peer_bye") -> None:
        self.side.s.close(code)

    def send_record(self, type_: int, body: bytes) -> None:
        self.side.s.send_record(type_, body)


class Host:
    def __init__(self, side: Side, tmp: Path, clock: Clock, contact: Optional[ContactRef] = None) -> None:
        self.side = side
        self.state = tmp
        self.hub = Transfer(lambda: str(tmp), now=clock.now, timer=clock.timer)
        self.link = FakeLink(side)
        est = side.of(Established)[0]
        self.session = ConnectSession(
            self.link, est.peer_device_id or "", est.caps, est.hello, "x", "mem", contact=contact
        )
        self.closed = False
        self.hub.attach(self.link, self.session, est)
        self.results: List[Any] = []
        self.hub.on_result(self.results.append)

    def settle(self) -> None:
        if not self.closed:
            for c in self.side.of(Closed):
                self.closed = True
                self.session.ended(SessionClosed(c.code, c.by_peer))


def connect(
    tmp_a: Path, tmp_b: Path, clock: Clock, devs: Any = None, cb: Optional[ContactRef] = None
) -> Tuple[Host, Host, Any]:
    A, B, k = devs or (Dev(ID_A), Dev(ID_B), _rnd())
    A.sign_key = b64url_encode(bytes([1]) * 32)
    B.sign_key = b64url_encode(bytes([2]) * 32)
    caps = ["app/1", "ring/1", "xfer/1"]
    a = Side("initiator", A, [k], caps=caps)
    b = Side("responder", B, [k], caps=caps)
    a.s.start()
    run(a, b)
    return Host(a, tmp_a, clock), Host(b, tmp_b, clock, contact=cb), (A, B, k)


def run(a: Side, b: Side, limit: int = 100_000) -> int:
    """Deliver in order until quiet or ``limit`` messages."""
    n = 0
    while (a.out or b.out) and n < limit:
        if a.out:
            b.s.receive(a.out.pop(0))
            n += 1
        if b.out and n < limit:
            a.s.receive(b.out.pop(0))
            n += 1
    return n


def go(a: Host, b: Host, limit: int = 100_000) -> None:
    run(a.side, b.side, limit)
    a.settle()
    b.settle()


@pytest.fixture
def world(tmp_path: Path) -> Any:
    clock = Clock()
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    (tmp_path / "out").mkdir()
    a, b, devs = connect(tmp_path / "a", tmp_path / "b", clock)
    return a, b, clock, tmp_path, devs


def _take(b: Host, dest: Path) -> List[IncomingOffer]:
    seen: List[IncomingOffer] = []

    def handler(o: IncomingOffer) -> Accept:
        seen.append(o)
        return Accept(str(dest))

    b.hub.on_offer(handler)
    return seen


def test_offer_accept_deliver(world: Any) -> None:
    a, b, _, tmp, _ = world
    dest = tmp / "out" / "got.bin"
    seen = _take(b, dest)
    data = _content(300_000)
    h = a.hub.send(a.session, data, name="report.bin", type="application/octet-stream", chunk=1000)
    go(a, b)
    r = h.wait(0)
    assert r.outcome == "delivered" and r.direction == "out"
    assert dest.read_bytes() == data
    assert [(o.name, o.type, o.size) for o in seen] == [("report.bin", "application/octet-stream", 300_000)]
    assert [(x.outcome, x.direction, x.path) for x in b.results] == [("delivered", "in", str(dest))]
    # the partial is gone; only the index remains
    assert sorted(os.listdir(tmp / "b" / "transfers")) == ["index.json"]
    if _POSIX:
        assert stat.S_IMODE(os.stat(tmp / "b" / "transfers").st_mode) == 0o700


def test_an_empty_transfer_delivers(world: Any) -> None:
    a, b, _, tmp, _ = world
    dest = tmp / "out" / "empty"
    _take(b, dest)
    h = a.hub.send(a.session, b"")
    go(a, b)
    assert h.wait(0).outcome == "delivered" and dest.read_bytes() == b""


def test_decline_and_no_handler(world: Any) -> None:
    a, b, _, tmp, _ = world
    h = a.hub.send(a.session, b"abc")
    go(a, b)
    r = h.wait(0)
    assert (r.outcome, r.reason) == ("cancelled", "declined")
    with pytest.raises(TransferCancelled) as e:
        r.raise_for_status()
    assert e.value.reason == "declined" and e.value.code == "transfer-cancelled"
    b.hub.on_offer(lambda o: "decline")
    h = a.hub.send(a.session, b"abc")
    go(a, b)
    assert h.wait(0).reason == "declined"
    # an unusable destination is a decline too
    b.hub.on_offer(lambda o: Accept(str(tmp / "missing" / "x")))
    h = a.hub.send(a.session, b"abc")
    go(a, b)
    assert h.wait(0).reason == "declined"
    # a handler that raises declines
    def boom(o: IncomingOffer) -> None:
        raise RuntimeError("x")

    b.hub.on_offer(boom)
    h = a.hub.send(a.session, b"abc")
    go(a, b)
    assert h.wait(0).reason == "declined"
    assert not os.path.exists(tmp / "out" / "x")


def test_an_answer_later(world: Any) -> None:
    a, b, _, tmp, _ = world
    asked: List[IncomingOffer] = []
    b.hub.on_offer(lambda o: asked.append(o))  # returns None: ask the person
    h = a.hub.send(a.session, _content(5000), name="x.bin", chunk=1000)
    go(a, b)
    assert not h.done and len(asked) == 1
    dest = tmp / "out" / "later.bin"
    asked[0].accept(str(dest))
    asked[0].accept(str(dest))  # a second answer is ignored
    go(a, b)
    assert h.wait(0).outcome == "delivered" and dest.read_bytes() == _content(5000)


def test_an_answer_later_can_decline(world: Any) -> None:
    a, b, _, tmp, _ = world
    asked: List[IncomingOffer] = []
    b.hub.on_offer(lambda o: asked.append(o))
    h = a.hub.send(a.session, b"abc")
    go(a, b)
    asked[0].decline()
    go(a, b)
    assert h.wait(0).reason == "declined"


def test_consent_timeout(world: Any) -> None:
    a, b, clock, tmp, _ = world
    asked: List[IncomingOffer] = []
    b.hub.on_offer(lambda o: asked.append(o))
    h = a.hub.send(a.session, b"abc")
    go(a, b)
    clock.advance(119)
    go(a, b)
    assert not h.done
    clock.advance(2)
    go(a, b)
    r = h.wait(0)
    assert (r.outcome, r.reason) == ("cancelled", "timeout")
    assert asked[0].withdrawn is True
    asked[0].accept(str(tmp / "out" / "late"))  # too late: nothing happens
    go(a, b)
    assert not (tmp / "out" / "late").exists()


def test_the_sender_cancels_while_the_person_is_asked(world: Any) -> None:
    a, b, _, tmp, _ = world
    asked: List[IncomingOffer] = []
    b.hub.on_offer(lambda o: asked.append(o))
    h = a.hub.send(a.session, b"abc")
    go(a, b)
    h.cancel()
    go(a, b)
    assert h.wait(0).reason == "cancelled" and asked[0].withdrawn is True


def test_the_sender_cancels_mid_transfer(world: Any) -> None:
    a, b, _, tmp, _ = world
    dest = tmp / "out" / "c.bin"
    _take(b, dest)
    h = a.hub.send(a.session, _content(200_000), chunk=1000)
    go(a, b, limit=12)
    assert not h.done
    h.cancel()
    go(a, b)
    assert h.wait(0).reason == "cancelled"
    assert [(r.outcome, r.reason) for r in b.results] == [("cancelled", "cancelled")]
    assert not dest.exists()
    assert sorted(os.listdir(tmp / "b" / "transfers")) == ["index.json"]  # a cancelled partial is not kept


def test_the_receiver_cancels_mid_transfer(world: Any) -> None:
    a, b, _, tmp, _ = world
    dest = tmp / "out" / "r.bin"
    seen = _take(b, dest)
    h = a.hub.send(a.session, _content(200_000), chunk=1000)
    go(a, b, limit=12)
    assert not h.done
    b.hub.cancel(seen[0].id)
    go(a, b)
    assert h.wait(0).reason == "cancelled"
    assert not dest.exists()


def test_resume_after_a_dropped_session(world: Any) -> None:
    a, b, clock, tmp, devs = world
    dest = tmp / "out" / "resume.bin"
    _take(b, dest)
    data = _content(200_000)
    h = a.hub.send(a.session, data, chunk=1000)
    go(a, b, limit=30)
    assert not h.done
    a.side.s.close()  # the session drops
    go(a, b)
    assert [r.outcome for r in a.results] == ["closed"] and h.wait(0).outcome == "closed"
    parts = [n for n in os.listdir(tmp / "b" / "transfers") if n != "index.json"]
    assert len(parts) == 1 and len(parts[0]) == 64
    kept = os.path.getsize(tmp / "b" / "transfers" / parts[0])
    assert 0 < kept < len(data)
    # a new session between the same two devices; the same transfer id and content resume
    a2, b2, _ = connect(tmp / "a", tmp / "b", clock, devs)
    _take(b2, dest)
    h2 = a2.hub.send(a2.session, data, chunk=1000, id=h.id)
    go(a2, b2)
    assert h2.wait(0).outcome == "delivered" and dest.read_bytes() == data
    assert [n for n in os.listdir(tmp / "b" / "transfers")] == ["index.json"]


def test_a_different_content_does_not_resume(world: Any) -> None:
    a, b, clock, tmp, devs = world
    dest = tmp / "out" / "d.bin"
    _take(b, dest)
    h = a.hub.send(a.session, _content(200_000), chunk=1000)
    go(a, b, limit=30)
    a.side.s.close()
    go(a, b)
    a2, b2, _ = connect(tmp / "a", tmp / "b", clock, devs)
    _take(b2, dest)
    other = bytes(reversed(_content(200_000)))
    h2 = a2.hub.send(a2.session, other, chunk=1000, id=h.id)
    go(a2, b2)
    assert h2.wait(0).outcome == "delivered" and dest.read_bytes() == other


class _Lies(io.BytesIO):
    """Hashes as one content and reads as another."""

    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.reads = 0

    def read(self, n: Optional[int] = -1) -> bytes:
        b = super().read(n)
        self.reads += 1
        return b


def test_a_hash_mismatch_is_cancelled_and_deleted(world: Any) -> None:
    a, b, _, tmp, _ = world
    dest = tmp / "out" / "bad.bin"
    _take(b, dest)
    src = _Lies(_content(5000))
    h = a.hub.send(a.session, src, chunk=1000)
    src.seek(0)
    good = src.getvalue()
    # after the hashing pass, serve other bytes
    bad = bytearray(good)
    bad[2500] ^= 0xFF
    src.truncate(0)
    src.write(bytes(bad))
    go(a, b)
    r = h.wait(0)
    assert (r.outcome, r.reason) == ("cancelled", "hash")
    assert not dest.exists()
    assert [(x.outcome, x.reason) for x in b.results] == [("cancelled", "hash")]
    assert os.listdir(tmp / "b" / "transfers") == ["index.json"]


def test_a_failing_source_cancels_without_done(world: Any) -> None:
    a, b, _, tmp, _ = world
    dest = tmp / "out" / "f.bin"
    _take(b, dest)
    src = io.BytesIO(_content(5000))
    h = a.hub.send(a.session, src, chunk=1000)
    src.truncate(1500)  # the file shrank after it was hashed
    go(a, b)
    assert h.wait(0).reason == "cancelled"
    assert not dest.exists()


def test_a_name_is_display_data_only(world: Any) -> None:
    a, b, _, tmp, _ = world
    dest = tmp / "out" / "safe.bin"
    seen = _take(b, dest)
    for name in ("../../etc/passwd", "/abs/path\u202e.exe", "C:\\x\\..\\y", "a\u0000b"):
        h = a.hub.send(a.session, b"x", name=name)
        go(a, b)
        assert h.wait(0).outcome == "delivered"
        dest.unlink()
    assert seen[0].name == "../../etc/passwd"
    # nothing but the host's destination was written, and no partial is named by a name
    assert sorted(p.name for p in tmp.rglob("*") if p.is_file()) == ["index.json"]
    for d in ("a", "b"):
        assert not (tmp / d / "etc").exists() and not (tmp.parent / "etc").exists()


def test_a_link_checks_the_category_before_asking(tmp_path: Path) -> None:
    clock = Clock()
    for d in ("a", "b", "out"):
        (tmp_path / d).mkdir()
    ref = ContactRef("0123456789abcdef", "Pal", ("photos",), "x" * 43, False)
    a, b, _ = connect(tmp_path / "a", tmp_path / "b", clock, cb=ref)
    a.session.contact = ref
    asked: List[IncomingOffer] = []

    def handler(o: IncomingOffer) -> Accept:
        asked.append(o)
        return Accept(str(tmp_path / "out" / "p.bin"))

    b.hub.on_offer(handler)
    h = a.hub.send(a.session, b"x")  # no category
    go(a, b)
    assert h.wait(0).reason == "category"
    h = a.hub.send(a.session, b"x", cat="docs")
    go(a, b)
    assert h.wait(0).reason == "category" and asked == []
    h = a.hub.send(a.session, b"x", cat="photos")
    go(a, b)
    assert h.wait(0).outcome == "delivered" and len(asked) == 1 and asked[0].cat == "photos"


def test_purge_deletes_the_kept_partials(world: Any) -> None:
    a, b, _, tmp, _ = world
    _take(b, tmp / "out" / "p.bin")
    a.hub.send(a.session, _content(100_000), chunk=1000)
    go(a, b, limit=20)
    a.side.s.close()
    go(a, b)
    d = tmp / "b" / "transfers"
    assert len([n for n in os.listdir(d) if n != "index.json"]) == 1
    b.hub.purge()
    assert os.listdir(d) == ["index.json"]


def test_arguments_are_checked(world: Any) -> None:
    a, _, _, _, _ = world
    with pytest.raises(ValueError):
        a.hub.send(a.session, b"x", cat="Bad Cat")
    with pytest.raises(ValueError):
        a.hub.send(a.session, b"x", type="nope")
    with pytest.raises(ValueError):
        a.hub.send(a.session, b"x", id="short")
    with pytest.raises(ValueError):
        a.hub.send(a.session, b"x", name="n" * 300)
    with pytest.raises(TypeError):
        a.hub.send(a.session, 12)  # type: ignore[arg-type]
    assert hashlib.sha256  # silence the unused import in minimal builds
