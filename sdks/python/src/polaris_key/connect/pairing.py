"""Pairing two devices of two accounts (CC-19.6; WIRE-CONTRACT-V5 §15.10): ``cloud_connect.links.pair``. Both
people open pairing; each device advertises a pair instance (``m=p``) and browses for the other's, the two
run mode ``p`` to the code (commit-reveal), each person confirms it, and the session's contact exchange
stores a link on both devices. Mirrors ``packages/sdk-node/src/connect/pairing.ts``. A :class:`LinkPairing`
lives on the Connect loop (D-3).

Rules this module keeps:

- the advert is ``p1-`` + 10 random bytes in base32 with ``v=1``, ``m=p`` and the product tag; it has a
  listener of its own, for at most 300 s and only while the screen is open (:meth:`LinkPairing.stop`);
- who dials: both sides advertise and browse, so the one whose instance name sorts lower dials and the other
  answers. Both apply the same rule, so a pair of devices opens one session;
- the code is the person's check. A :class:`LinkOffer` is shown only once the session reached the code; its
  ``label`` and ``platform`` are display data from a device on the LAN that nothing has authenticated, to be
  shown as "reported by the device", never as proof of who it is;
- nothing is stored before both people confirm and both ``CONTACT`` records are read in order; a session that
  ends first stores nothing on either side;
- the one-time static key is dropped when the handshake ends; the contact secret is handed to the store; no
  key, secret, nonce or handshake hash is in any message, ``repr`` or error;
- the sessions at once are bounded (4), per address (1 waiting) and by the approver limiter of §15.6 (5
  handshakes a minute, 4 waiting a code).
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from ..core.peer_advert import advert_epoch, base32_lower, parse_txt, product_tag
from ..core.peer_contact import MAX_CONTACT_CATS, contact_categories
from ..core.peer_link import LinkHandlers, SocketLink
from ..core.peer_mdns import MdnsAdapter, MdnsAdvert, MdnsFound, MdnsHandle, MulticastDnsAdapter
from ..core.peer_session import Closed, Contact, ContactOffer, Established, HandshakeLimiter, Sas
from .dial import dial_race
from .errors import LanError
from .lan import GatedProtocol, listen_socket
from .lan_judge import PendingLimiter, limiter_keys, socket_text, socket_verdict, text_verdict
from .session import SessionClosed

__all__ = [
    "LinkOffer",
    "LinkPairHandle",
    "LinkPairing",
    "PAIR_WINDOW_SECONDS",
    "PairFailure",
    "PairSource",
    "PairedLink",
]

#: The pairing window: it closes by itself after this many seconds (§15.4).
PAIR_WINDOW_SECONDS = 300.0
MAX_SESSIONS = 4
WAITING = 4
PER_MINUTE = 5
TRIES_PER_ADVERT = 2
LABEL_MAX = 64
_CAT = re.compile(r"[a-z0-9-]{1,32}\Z")


@dataclass(frozen=True)
class PairSource:
    """What pairing reads of the client. Every member is blocking; the service runs them on a worker thread."""

    slug: str
    #: Seconds since the epoch.
    now: Callable[[], int]
    #: This device's agreeKey, 43 base64url characters (a public key).
    agree_key: Callable[[], str]
    #: The agreeKey of every active contact (a peer in it is a re-pair, §15.10).
    held: Callable[[], List[str]]
    #: Store the contact the exchange produced: ``(agree_key, secret, cats, label)`` returns
    #: ``(stored, pending, id)``; ``stored`` False means the cap (``full``).
    store: Callable[[str, bytes, Sequence[str], Optional[str]], Tuple[bool, bool, str]]
    #: The cached discovery answer is still true: links stay on (§15.10 "Gates").
    allowed: Callable[[], bool]


@dataclass(frozen=True)
class PairedLink:
    """A link just made."""

    #: The link's id on this device (``links.list()`` has the rest).
    id: str
    label: Optional[str]
    #: The categories both people approved.
    categories: Tuple[str, ...]
    #: The peer was already linked: the new pairing waits for its first handshake.
    re_pair: bool


@dataclass(frozen=True)
class PairFailure:
    """``declined`` here, ``timeout`` the window or the exchange ran out, ``full`` at the cap, ``closed`` otherwise."""

    reason: str
    #: How the session ended, when it did.
    close: Optional[SessionClosed] = None


class _Live:
    def __init__(self, link: SocketLink) -> None:
        self.link = link
        self.hello: Any = None
        self.confirmed = False
        self.linked = False
        self.dead = False
        self.shown = False
        self.failure: Optional[str] = None
        self.closed: Optional[SessionClosed] = None
        self.closers: List[Callable[[SessionClosed], None]] = []
        self.slot: Optional[Callable[[], None]] = None


class LinkOffer:
    """A nearby device at the code stage. ``label`` is what the other device sent: unauthenticated display
    data (show it as "reported by the device" beside the code). ``code`` is like ``123 456``: the people
    compare it before anyone confirms. ``categories`` are the ones this app asked for: list them before the
    person confirms. Thread-safe: ``confirm`` and ``decline`` may be called from the host's thread."""

    def __init__(
        self,
        pairing: "LinkPairing",
        live: _Live,
        label: Optional[str],
        platform: str,
        code: str,
        categories: Tuple[str, ...],
    ) -> None:
        self._p = pairing
        self._live = live
        self.label = label
        self.platform = platform
        self.code = code
        self.categories = categories

    def __repr__(self) -> str:
        return "<LinkOffer>"

    def __reduce__(self) -> Any:
        raise TypeError("an offer cannot be pickled")

    def confirm(self) -> None:
        """The person confirmed the code on this device. The link is made when the other person does too."""
        self._p._call(lambda: self._p._confirm(self._live))

    def decline(self) -> None:
        """The person declined: the session closes and nothing is stored."""

        def go() -> None:
            self._live.failure = "declined"
            self._p._end(self._live, "peer_bye")

        self._p._call(go)

    def on_close(self, fn: Callable[[SessionClosed], None]) -> Callable[[], None]:
        """Called once when the session ends."""
        self._live.closers.append(fn)
        if self._live.closed is not None:
            _guarded(lambda: fn(self._live.closed))  # type: ignore[arg-type]

        def off() -> None:
            if fn in self._live.closers:
                self._live.closers.remove(fn)

        return off


class LinkPairHandle:
    """The open pairing window. ``stop()`` closes the advert, the listener and every session."""

    def __init__(self, pairing: "LinkPairing") -> None:
        self._p = pairing

    def __repr__(self) -> str:
        return "<LinkPairHandle open=%s>" % self._p.open

    @property
    def open(self) -> bool:
        """Still advertising."""
        return self._p.open

    def stop(self) -> None:
        """Close the window. Safe to call twice and after the window closed by itself."""
        self._p._stop_blocking()


def _guarded(fn: Callable[[], Any]) -> None:
    try:
        fn()
    except Exception:
        pass  # the host's bug is the host's; the module's own state is already settled


class LinkPairing:
    def __init__(self, src: PairSource, o: Dict[str, Any]) -> None:
        self._src = src
        self._o = o
        self._loop = asyncio.get_running_loop()
        self._cats: Tuple[str, ...] = tuple(o["categories"])
        self._mdns: MdnsAdapter = o.get("mdns") or MulticastDnsAdapter(
            allow_loopback=bool(o.get("allow_loopback")), interfaces=o.get("interfaces")
        )
        self._random: Callable[[int], bytes] = o.get("random") or os.urandom
        self._live: List[_Live] = []
        self._candidates: Dict[str, Dict[str, Any]] = {}
        self._dialing: set = set()  # type: ignore[type-arg]
        self._limit = PendingLimiter(WAITING * 2, int(o.get("max_pending_per_address", 1)), 2)
        self._limiter = HandshakeLimiter(PER_MINUTE, WAITING)
        self._slots: Dict[Any, Callable[[], None]] = {}
        self._server: Any = None
        self._instance = ""
        self._adv: Optional[MdnsHandle] = None
        self._browse: Optional[MdnsHandle] = None
        self._cancel: Optional[asyncio.TimerHandle] = None
        self._stopped = False
        self._agree = ""
        self._held: List[str] = []
        self._tasks: "set[asyncio.Future[Any]]" = set()
        self._on_code: Callable[[LinkOffer], None] = o["on_code"]
        self._on_linked: Optional[Callable[[PairedLink], None]] = o.get("on_linked")
        self._on_failed: Optional[Callable[[PairFailure], None]] = o.get("on_failed")

    def __repr__(self) -> str:
        return "<LinkPairing open=%s>" % (not self._stopped)

    def __reduce__(self) -> Any:
        raise TypeError("a pairing cannot be pickled")

    @property
    def open(self) -> bool:
        return not self._stopped

    # -- start and stop -----------------------------------------------------------------------------

    @staticmethod
    def check(o: Dict[str, Any]) -> None:
        """Validate the options. Raises :class:`LanError` ``bad_input`` for ones that break a rule."""

        def bad(m: str) -> None:
            raise LanError("bad_input", m)

        if not callable(o.get("on_code")):
            bad("on_code is required.")
        c = o.get("categories")
        if (
            not isinstance(c, (list, tuple))
            or len(c) > MAX_CONTACT_CATS
            or not all(isinstance(x, str) and _CAT.match(x) for x in c)
            or len(set(c)) != len(c)
        ):
            bad("categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters).")
        lab = o.get("label")
        if lab is not None and (not isinstance(lab, str) or len(lab) > LABEL_MAX):
            bad("The label is not valid.")
        sec = o.get("seconds")
        if sec is not None and (isinstance(sec, bool) or not isinstance(sec, (int, float)) or not sec > 0):
            bad("seconds must be above 0.")

    @classmethod
    async def start(cls, src: PairSource, o: Dict[str, Any]) -> "LinkPairing":
        cls.check(o)
        p = cls(src, o)
        p._agree = await p._loop.run_in_executor(None, src.agree_key)
        p._held = list(await p._loop.run_in_executor(None, src.held))
        try:
            await p._advertise()
            p._browse = await p._mdns.browse(p._found_later, p._gone)
        except BaseException:
            await p.stop()
            raise
        seconds = min(float(o.get("seconds") or PAIR_WINDOW_SECONDS), PAIR_WINDOW_SECONDS)
        p._cancel = p._loop.call_later(seconds, p._window_over)
        return p

    def _window_over(self) -> None:
        self._spawn(self.stop())

    def _spawn(self, coro: Any) -> "asyncio.Future[Any]":
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        t.add_done_callback(lambda f: f.cancelled() or f.exception())
        return t

    def _call(self, fn: Callable[[], Any]) -> Any:
        """Run ``fn`` on the loop: inline from the loop's thread, else wait for it."""
        from .loop import connect_loop

        if connect_loop().in_loop():
            return fn()

        async def go() -> Any:
            return fn()

        return asyncio.run_coroutine_threadsafe(go(), self._loop).result(10)

    def _stop_blocking(self) -> None:
        from .loop import connect_loop

        if connect_loop().in_loop():
            self._spawn(self.stop())
            return
        try:
            asyncio.run_coroutine_threadsafe(self.stop(), self._loop).result(10)
        except Exception:
            pass

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self._cancel is not None:
            self._cancel.cancel()
            self._cancel = None
        srv, self._server = self._server, None
        if srv is not None:
            srv.close()
        for w in list(self._slots):
            try:
                w.abort()
            except Exception:
                pass
        for lv in list(self._live):
            self._end(lv, "peer_bye")
        for h in (self._adv, self._browse):
            if h is not None:
                try:
                    await h.stop()
                except Exception:
                    pass
        self._adv = self._browse = None
        self._candidates.clear()

    # -- advert and browse --------------------------------------------------------------------------

    async def _advertise(self) -> None:
        o = self._o
        sock = listen_socket(o.get("host"), 0)
        try:
            self._server = await self._loop.create_server(self._protocol, sock=sock)
        except BaseException:
            sock.close()
            raise
        port = int(sock.getsockname()[1])
        self._instance = "p1-" + base32_lower(self._random(10))
        h = product_tag(self._src.slug, advert_epoch(self._src.now()))
        self._adv = await self._mdns.advertise(MdnsAdvert(self._instance, port, ["v=1", "m=p", "h=" + h]))

    def _protocol(self) -> "asyncio.StreamReaderProtocol":
        reader = asyncio.StreamReader(loop=self._loop)
        return GatedProtocol(reader, self._accept, self._gate, self._loop)

    def _gate(self, transport: Any) -> bool:
        v = socket_verdict(
            socket_text(transport.get_extra_info("peername")),
            socket_text(transport.get_extra_info("sockname")),
            bool(self._o.get("allow_loopback")),
        )
        if (
            not v.dial
            or v.key is None
            or self._stopped
            or not self._src.allowed()
            or len(self._live) >= MAX_SESSIONS
        ):
            return False
        release = self._limit.take(transport, limiter_keys(v.key))
        if release is None:
            return False
        self._slots[transport] = release
        return True

    def _found_later(self, f: MdnsFound) -> None:
        self._spawn(self._found(f))

    def _gone(self, instance: str) -> None:
        self._candidates.pop(instance, None)

    async def _found(self, f: MdnsFound) -> None:
        if self._stopped or f.instance == self._instance:
            return
        txt = parse_txt(f.txt)
        if not txt["ok"] or txt["mode"] != "p":
            return
        # The product tag of this epoch or the last: a pair advert of another product is not ours.
        epoch = advert_epoch(self._src.now())
        tags = [product_tag(self._src.slug, e) for e in (epoch, epoch - 1)]
        if txt.get("h") not in tags:
            return
        allow = bool(self._o.get("allow_loopback"))
        hosts = [h for h in (f.hosts or (f.host,)) if text_verdict(h, allow)]
        if not hosts:
            return
        had = self._candidates.get(f.instance)
        self._candidates[f.instance] = {
            "instance": f.instance,
            "hosts": hosts,
            "port": f.port,
            "tries": had["tries"] if had else 0,
        }
        self._pump()

    def _pump(self) -> None:
        """Dial the adverts that sort above this device's own (the other side dials the rest)."""
        if self._stopped or not self._src.allowed():
            return
        for c in list(self._candidates.values()):
            if len(self._live) + len(self._dialing) >= MAX_SESSIONS:
                return
            if self._instance >= c["instance"]:
                continue
            if c["instance"] in self._dialing or c["tries"] >= TRIES_PER_ADVERT:
                continue
            c["tries"] += 1
            self._dialing.add(c["instance"])
            self._spawn(self._dial(c))

    async def _dial(self, c: Dict[str, Any]) -> None:
        try:
            try:
                sock, _host = await dial_race(
                    c["hosts"], c["port"], bool(self._o.get("allow_loopback")), timeout=float(self._o.get("dial_seconds", 10))
                )
                reader, writer = await asyncio.open_connection(sock=sock)
            except OSError:
                return
            if self._stopped:
                writer.close()
                return
            live = self._make_live(reader, writer, "initiator")
            live.link.start()
            self._spawn(live.link.run())
        finally:
            self._dialing.discard(c["instance"])

    # -- sessions -----------------------------------------------------------------------------------

    async def _accept(self, reader: Any, writer: Any) -> None:
        release = self._slots.pop(writer.transport, None)
        if release is None:
            try:
                writer.transport.abort()
            except Exception:
                pass
            return
        live = self._make_live(reader, writer, "responder")
        live.slot = release
        # An unauthenticated socket lives for the handshake window and no longer (SocketLink's deadline).
        try:
            await live.link.run()
        finally:
            release()

    def _make_live(self, reader: Any, writer: Any, role: str) -> _Live:
        o = self._o
        key = os.urandom(32)
        box: List[Optional[_Live]] = [None]

        def on_event(e: Any) -> None:
            if box[0] is not None:
                self._event(box[0], e)

        def on_closed(c: Closed) -> None:
            if box[0] is not None:
                self._closed(box[0], SessionClosed(c.code, c.by_peer))

        opts: Dict[str, Any] = {
            "mode": "p",
            "role": role,
            "slug": self._src.slug,
            "static_key": key,
            "caps": [],
            "exchange": ContactOffer(self._agree, list(self._cats), list(self._held), o.get("label")),
            "hello": {"label": o.get("label"), "platform": sys.platform, "app": self._src.slug},
        }
        if role == "responder":
            opts["admission"] = self._limiter
        link = SocketLink(
            reader,
            writer,
            opts,
            LinkHandlers(on_event=on_event, on_closed=on_closed),
            handshake_seconds=float(o.get("handshake_seconds", 30.0)),
        )
        live = _Live(link)
        box[0] = live
        self._live.append(live)
        return live

    def _event(self, live: _Live, e: Any) -> None:
        if isinstance(e, Established):
            live.hello = e.hello
        elif isinstance(e, Sas):
            self._show(live, e.display)
        elif isinstance(e, Contact):
            self._spawn(self._store(live, e))

    def _show(self, live: _Live, code: str) -> None:
        if live.shown or self._stopped:
            return
        live.shown = True
        h = live.hello
        offer = LinkOffer(
            self,
            live,
            getattr(h, "label", None),
            getattr(h, "platform", ""),
            code,
            self._cats,
        )
        _guarded(lambda: self._on_code(offer))

    def _confirm(self, live: _Live) -> None:
        if live.dead or live.confirmed:
            return
        live.confirmed = True
        # One link per window: the other devices that reached the code are closed.
        for other in list(self._live):
            if other is not live and not other.confirmed:
                self._end(other, "peer_bye")
        live.link.channel.confirm_sas()

    async def _store(self, live: _Live, e: Contact) -> None:
        loop = self._loop
        try:
            cats = contact_categories(self._cats, e.cats)
            ok, pending, cid = await loop.run_in_executor(
                None, self._src.store, e.agree_key, bytes(e.secret), cats, e.label
            )
            if not ok:
                live.failure = "full"
                self._end(live, "peer_not_allowed")
                return
            live.linked = True
            fn = self._on_linked
            if fn is not None:
                _guarded(lambda: fn(PairedLink(cid, e.label, tuple(cats), pending)))
            # Both CONTACTs are in: the exchange is over (§15.10).
            self._end(live, "peer_bye")
        except Exception:
            live.failure = "closed"
            self._end(live, "peer_bye")

    def _closed(self, live: _Live, c: SessionClosed) -> None:
        if live.dead:
            return
        live.dead = True
        live.closed = c
        if live in self._live:
            self._live.remove(live)
        if live.slot is not None:
            live.slot()
            live.slot = None
        for f in list(live.closers):
            _guarded(lambda f=f: f(c))
        if live.shown and not live.linked and not self._stopped and self._on_failed is not None:
            reason = live.failure or ("timeout" if c.code == "peer_timeout" else "closed")
            fn = self._on_failed
            _guarded(lambda: fn(PairFailure(reason, c)))
        if live.linked and not self._stopped:
            self._spawn(self.stop())
        else:
            self._pump()

    def _end(self, live: _Live, code: str) -> None:
        try:
            live.link.close_nowait(code)
        except Exception:
            pass
