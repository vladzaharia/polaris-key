"""Pairing with a code, with no account (CC-29.9; WIRE-CONTRACT-V5 §15.12): ``cloud_connect.local_links.pair``
shows a code and a QR and waits (the shower, the responder of mode ``q``), ``local_links.join`` types or scans
one (the joiner, the initiator). CPace turns the code into a key, mode ``q`` runs Noise over it, both people
confirm, and each side stores a link in ``pkey.connect.local.v1`` (:mod:`.local_state`). Mirrors
``packages/sdk-node/src/connect/localShower.ts``, ``localJoiner.ts`` and ``localCommon.ts``. A
:class:`LocalShower` and a :class:`LocalJoiner` live on the Connect loop (D-3).

Rules this module keeps:

- the shower has a listener of its own and an ``m=q`` advert (``v=1``, ``m=q``, the product tag ``h`` and the
  nameplate ``n``), for at most 300 s and only while the screen is open; it answers one CPace attempt at a time;
- the window's accounting is :class:`~polaris_key.core.peer_local.PairingWindow`'s: the session is given its
  ``begin_guess`` as the required permit, so a guess is counted before its tag is tried, and the session's
  :class:`~polaris_key.core.peer_session.Guess` event is the verdict; ``rotated`` is told only after the new
  password, the new QR secret and both generators exist;
- the password, the QR secret, the generators, the scalars, the link key and the ISK are wiped when the attempt
  or the window ends (a password is a short string and is dropped, not overwritten);
- the joiner makes at most 2 dials a join and, for a typed code, at most 2 per nameplate in 300 s across joins
  (the host's :class:`~polaris_key.core.peer_local.DialBudget`, spent when the dial is made). It never retries a
  failed code by itself, and a QR is never limited;
- a :class:`LocalOffer` is shown only once the session reached consent; its ``label`` and ``platform`` are
  display data from a device on the LAN that only proved the code, to be shown as "reported by the device";
- nothing is stored before both people confirm and both ``LOCAL_LINK`` records are read in order.
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
import sys
import time
from functools import partial
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

from ..constants_generated import ErrorCode
from ..core.errors import PolarisError
from ..core.peer_advert import advert_epoch, parse_txt, product_tag
from ..core.peer_cpace import (
    cpace_generator,
    cpace_isk,
    cpace_prs_code,
    cpace_prs_qr,
    cpace_psk,
    cpace_scalar,
    cpace_share,
    encode_c1,
    encode_c2,
    parse_c1,
    parse_c2,
)
from ..core.peer_frame import decode_frames, encode_frame
from ..core.peer_lan_gate import GatedProtocol, listen_socket
from ..core.peer_link import LinkHandlers, SocketLink
from ..core.peer_local import (
    LOCAL_ATTEMPT_SECONDS,
    LOCAL_JOIN_BROWSE_SECONDS,
    LOCAL_JOIN_CANDIDATES,
    LOCAL_PAIR_SECONDS,
    DialBudget,
    JoinPlan,
    PairingWindow,
    display_code,
    draw_nameplate,
    draw_password,
    make_qr,
    pairing_instance,
    parse_code,
    parse_qr,
)
from ..core.peer_mdns import MdnsAdapter, MdnsAdvert, MdnsFound, MdnsHandle, MulticastDnsAdapter
from ..core.peer_session import Closed, Established, Guess, LocalLinkMade, PairingOptions
from .dial import dial_race
from .errors import LanError
from .lan_judge import PendingLimiter, limiter_keys, socket_text, socket_verdict, text_verdict
from .local_common import (
    LocalCode,
    LocalPaired,
    LocalPairFailure,
    LocalSource,
    check_options,
    full,
    off,
    reachable_full,
)
from .session import SessionClosed

__all__ = [
    "LocalCode",
    "LocalJoiner",
    "LocalOffer",
    "LocalPairFailure",
    "LocalPairHandle",
    "LocalPaired",
    "LocalShower",
    "LocalSource",
    "check_options",
    "full",
    "off",
    "reachable_full",
    "sid_of",
]

#: Sessions waiting on a person at once (the shower holds one attempt at a time).
WAITING = 4
_INSTANCE = re.compile(r"p1-[a-z2-7]{16}\Z")


def sid_of(instance: str) -> Optional[bytes]:
    """The 10 bytes behind a ``p1-`` instance name, which are the window's CPace ``sid``; ``None`` for a name
    that is not 16 base32 characters."""
    if _INSTANCE.match(instance) is None:
        return None
    return base64.b32decode(instance[3:].upper())


def _guarded(fn: Callable[[], Any]) -> None:
    try:
        fn()
    except Exception:
        pass  # the host's bug is the host's; the module's own state is already settled


def _call_on(loop: "asyncio.AbstractEventLoop", fn: Callable[[], Any]) -> Any:
    """Run ``fn`` on the loop: inline from the loop's thread, else wait for it."""
    from .loop import connect_loop

    if connect_loop().in_loop():
        return fn()

    async def go() -> Any:
        return fn()

    return asyncio.run_coroutine_threadsafe(go(), loop).result(10)


def _default_timer(loop: "asyncio.AbstractEventLoop") -> Callable[[Callable[[], None], float], Callable[[], None]]:
    def timer(fn: Callable[[], None], seconds: float) -> Callable[[], None]:
        return loop.call_later(seconds, fn).cancel

    return timer


async def _read_frame(reader: Any, length: int, seconds: float) -> Optional[bytes]:
    """Read the one frame of ``length`` bytes (C1 or C2) within ``seconds``. ``None`` for anything else: a
    zero-length or longer frame, a second frame, bytes past the frame, a closed socket or a deadline."""
    buf = bytearray()

    async def go() -> Optional[bytes]:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                return None
            buf.extend(chunk)
            # A peer that sent past its frame before it had the answer: closed silently.
            if len(buf) > 2 + length:
                return None
            r = decode_frames(bytes(buf))
            if isinstance(r, str):
                return None
            frames, rest = r
            if len(frames) > 1 or (frames and rest):
                return None
            if frames:
                return frames[0]

    try:
        return await asyncio.wait_for(go(), max(0.001, seconds))
    except (asyncio.TimeoutError, OSError, asyncio.IncompleteReadError):
        return None


class _Attempt:
    """The connection of one attempt, on either side."""

    def __init__(self, writer: Any = None) -> None:
        self.id: Optional[int] = None
        self.writer = writer
        self.link: Optional[SocketLink] = None
        self.hello: Any = None
        self.phase = "c1"  # c1 | session | done
        self.shown = False
        self.linked = False
        self.declined = False
        #: The attempt was ended by this side (the window closed, the gate cleared).
        self.local = False
        self.failure: Optional[str] = None
        self.closed: Optional[SessionClosed] = None
        self.storing: "Optional[asyncio.Future[Any]]" = None
        #: This attempt's link private key: kept only while the attempt can store a link.
        self.link_key = bytearray()
        self.closers: List[Callable[[SessionClosed], None]] = []
        self.release: Optional[Callable[[], None]] = None

    def __repr__(self) -> str:
        return "<Attempt %s>" % self.phase


class LocalOffer:
    """The other device, at the consent step. ``label`` is what it sent: it proved the code, but nothing else
    about it is authenticated (show it as "reported by the device"). ``categories`` are the ones this app asked
    for: list them before the person confirms. Thread-safe: ``confirm`` and ``decline`` may be called from the
    host's thread."""

    def __init__(
        self, loop: "asyncio.AbstractEventLoop", attempt: _Attempt, categories: Sequence[str], hello: Any
    ) -> None:
        self._loop = loop
        self._a = attempt
        self.label: Optional[str] = getattr(hello, "label", None)
        self.platform: str = getattr(hello, "platform", "")
        self.categories: Tuple[str, ...] = tuple(categories)

    def __repr__(self) -> str:
        return "<LocalOffer>"

    def __reduce__(self) -> Any:
        raise TypeError("an offer cannot be pickled")

    def confirm(self) -> None:
        """Agree to the pairing. The link exists once the other person agrees too."""
        a = self._a

        def go() -> None:
            if a.link is not None and not a.local:
                a.link.confirm_pairing()

        _call_on(self._loop, go)

    def decline(self) -> None:
        """Say no: the session closes and this side stores nothing."""
        a = self._a

        def go() -> None:
            if a.link is None:
                return
            a.declined = True
            a.failure = "declined"
            a.link.decline_pairing()

        _call_on(self._loop, go)

    def on_close(self, fn: Callable[[SessionClosed], None]) -> Callable[[], None]:
        """Called once when the session ends. Returns the unsubscribe."""
        a = self._a
        a.closers.append(fn)
        if a.closed is not None:
            _guarded(lambda: fn(a.closed))  # type: ignore[arg-type]

        def off_() -> None:
            if fn in a.closers:
                a.closers.remove(fn)

        return off_


async def store_link(src: LocalSource, a: _Attempt, e: LocalLinkMade) -> Optional[LocalPaired]:
    """Store the link a session produced. ``None`` at the cap (the attempt's ``failure`` says ``full``); raises
    what the store raises."""
    loop = asyncio.get_running_loop()
    own_key = bytes(a.link_key)
    stored, lid = await loop.run_in_executor(
        None,
        lambda: src.store.add(
            own_key=own_key,
            own_public=e.own_key,
            peer_key=e.peer_key,
            secret=e.secret,
            cats=e.cats,
            now=src.now(),
            label=e.label,
        ),
    )
    if not stored:
        a.failure = "full"
        return None
    a.linked = True
    # The listener starts (a device that held no link) and the new link is advertised.
    src.notify()
    return LocalPaired(lid, e.label, tuple(e.cats))


class LocalPairHandle:
    """The open pairing window. ``stop()`` closes the advert, the listener and every session."""

    def __init__(self, shower: "LocalShower") -> None:
        self._s = shower

    def __repr__(self) -> str:
        return "<LocalPairHandle open=%s>" % self._s.open

    @property
    def open(self) -> bool:
        """The window is still open."""
        return self._s.open

    def code(self) -> Optional[LocalCode]:
        """The code on show now; ``None`` once the window has closed."""
        return self._s.code()

    def stop(self) -> None:
        """Close the window. Safe to call twice and after the window closed by itself."""
        self._s.stop_blocking()


# -- the shower -------------------------------------------------------------------------------------------


class LocalShower:
    def __init__(self, src: LocalSource, o: Dict[str, Any], on_end: Callable[[], None]) -> None:
        self._src = src
        self._o = o
        self._on_end = on_end
        self._loop = asyncio.get_running_loop()
        self._cats: Tuple[str, ...] = tuple(o["categories"])
        self._mdns: MdnsAdapter = o.get("mdns") or MulticastDnsAdapter(
            allow_loopback=bool(o.get("allow_loopback")), interfaces=o.get("interfaces")
        )
        self._random: Callable[[int], bytes] = o.get("random") or os.urandom
        self._mono: Callable[[], float] = o.get("mono") or time.monotonic
        self._timer = o.get("timer") or _default_timer(self._loop)
        self._window = PairingWindow()
        self._attempts: Set[_Attempt] = set()
        self._in_use: Dict[str, str] = {}
        self._sid = self._random(10)
        self._instance = pairing_instance(self._sid)
        self._ci = _prologue(src.slug)
        self._nameplate = ""
        self._password: Optional[str] = None
        self._qr_secret: Optional[bytearray] = None
        self._gens: Optional[Dict[str, bytes]] = None
        self._shown: Optional[LocalCode] = None
        self._server: Any = None
        self._limit = PendingLimiter(WAITING * 2, 1, 2)
        self._slots: Dict[Any, Callable[[], None]] = {}
        self._adv: Optional[MdnsHandle] = None
        self._browse: Optional[MdnsHandle] = None
        self._cancel: Optional[Callable[[], None]] = None
        self._stopped = False
        self._tasks: "Set[asyncio.Future[Any]]" = set()
        self._on_code: Callable[[LocalCode], None] = o["on_code"]
        self._on_confirm: Callable[[LocalOffer], None] = o["on_confirm"]
        self._on_linked: Optional[Callable[[LocalPaired], None]] = o.get("on_linked")
        self._on_failed: Optional[Callable[[LocalPairFailure], None]] = o.get("on_failed")

    def __repr__(self) -> str:
        return "<LocalPairing open=%s>" % (not self._stopped)

    def __reduce__(self) -> Any:
        raise TypeError("a pairing cannot be pickled")

    @classmethod
    async def start(cls, src: LocalSource, o: Dict[str, Any], on_end: Callable[[], None]) -> "LocalShower":
        s = cls(src, o, on_end)
        try:
            await s._open()
        except BaseException:
            try:
                await s.stop()
            except Exception:
                pass
            raise
        return s

    @property
    def open(self) -> bool:
        return not self._stopped

    def code(self) -> Optional[LocalCode]:
        return None if self._stopped else self._shown

    def _spawn(self, coro: Any) -> "asyncio.Future[Any]":
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        t.add_done_callback(lambda f: f.cancelled() or f.exception())
        return t

    def _draw(self, n: int) -> Optional[bytes]:
        return self._random(n)

    async def _open(self) -> None:
        o = self._o
        self._window.open(self._mono())
        # The nameplates other windows of this product are using on the link: best effort, from what the
        # browse has seen so far.
        tags = self._tags()
        self._browse = await self._mdns.browse(lambda f: self._seen(f, tags), self._gone)
        np = draw_nameplate(self._draw, list(self._in_use.values()))
        if np is None:
            raise LanError("bad_input", "No random source.")
        self._nameplate = np
        self._renew()
        sock = listen_socket(o.get("host"), 0)
        try:
            self._server = await self._loop.create_server(self._protocol, sock=sock)
        except BaseException:
            sock.close()
            raise
        port = int(sock.getsockname()[1])
        self._adv = await self._mdns.advertise(
            MdnsAdvert(self._instance, port, ["v=1", "m=q", "h=" + self._tags()[0], "n=" + self._nameplate])
        )
        seconds = min(float(o.get("seconds") or LOCAL_PAIR_SECONDS), LOCAL_PAIR_SECONDS)
        self._cancel = self._timer(self._expire, seconds)
        self._show()

    def _tags(self) -> List[str]:
        epoch = advert_epoch(self._src.now())
        return [product_tag(self._src.slug, e) for e in (epoch, epoch - 1)]

    def _gone(self, instance: str) -> None:
        self._in_use.pop(instance, None)

    def _seen(self, f: MdnsFound, tags: Sequence[str]) -> None:
        if self._stopped or f.instance == self._instance:
            return
        txt = parse_txt(f.txt)
        if not txt["ok"] or txt["mode"] != "q" or txt["h"] not in tags:
            return
        if len(self._in_use) < 64:
            self._in_use[f.instance] = txt["n"]

    def _renew(self) -> None:
        """A new password and QR secret, and both generators made from them."""
        password = draw_password(self._draw)
        secret = bytearray(self._random(16))
        if password is None:
            raise LanError("bad_input", "No random source.")
        gens = {
            "code": cpace_generator(cpace_prs_code(password), self._ci, self._sid),
            "qr": cpace_generator(cpace_prs_qr(bytes(secret)), self._ci, self._sid),
        }
        # Stopped while the generators were made: nothing new is kept.
        if self._stopped:
            _zero(secret)
            return
        if self._qr_secret is not None:
            _zero(self._qr_secret)
        self._password = password
        self._qr_secret = secret
        self._gens = gens

    def _show(self) -> None:
        if self._stopped or self._password is None or self._qr_secret is None:
            return
        c = LocalCode(
            display_code(self._nameplate, self._password),
            make_qr(self._src.slug, self._instance, bytes(self._qr_secret)),
            self._nameplate,
        )
        self._shown = c
        _guarded(lambda: self._on_code(c))

    async def _rotate(self) -> None:
        """Make the next code, then tell the window. ``rotated`` comes only after the new password, the new QR
        secret and both generators exist; until then a C1 meets a busy window."""
        try:
            self._renew()
        except Exception:
            await self.stop()
            return
        if self._stopped:
            return
        self._show()
        self._window.rotated(self._mono())

    def _apply(self, out: Dict[str, Any]) -> None:
        if out.get("rotate"):
            self._spawn(self._rotate())
        if out.get("result") == "too-many-tries":
            fn = self._on_failed
            if fn is not None:
                _guarded(lambda: fn(LocalPairFailure("too-many-tries")))
            self._spawn(self._shutdown(False))

    def _expire(self) -> None:
        # The window's 300 s: the advert and the listener go, a session past the transport runs on.
        self._spawn(self._shutdown(True))

    async def stop(self) -> None:
        await self._shutdown(False)

    def stop_blocking(self) -> None:
        from .loop import connect_loop

        if connect_loop().in_loop():
            self._spawn(self.stop())
            return
        try:
            asyncio.run_coroutine_threadsafe(self.stop(), self._loop).result(10)
        except Exception:
            pass

    async def _shutdown(self, keep_sessions: bool) -> None:
        """Close the window: the advert, the listener and the connections (``keep_sessions`` spares those past
        the transport)."""
        if self._stopped:
            return
        self._stopped = True
        if self._cancel is not None:
            self._cancel()
            self._cancel = None
        self._window.close(self._mono())
        srv, self._server = self._server, None
        if srv is not None:
            srv.close()
        for t in list(self._slots):
            _abort(t)
        for a in list(self._attempts):
            if not keep_sessions or a.phase != "session":
                self._end(a, "peer_bye")
        for h in (self._adv, self._browse):
            if h is not None:
                try:
                    await h.stop()
                except Exception:
                    pass
        self._adv = self._browse = None
        # The code, the QR secret and the generators are of no use to anyone now.
        if self._qr_secret is not None:
            _zero(self._qr_secret)
        self._qr_secret = None
        self._gens = None
        self._password = None
        self._shown = None
        self._in_use.clear()
        _guarded(self._on_end)

    # -- connections ------------------------------------------------------------------------------------

    def _protocol(self) -> "asyncio.StreamReaderProtocol":
        reader = asyncio.StreamReader(loop=self._loop)
        return GatedProtocol(reader, self._accept, self._gate, self._loop)

    def _gate(self, transport: Any) -> bool:
        try:
            v = socket_verdict(
                socket_text(transport.get_extra_info("peername")),
                socket_text(transport.get_extra_info("sockname")),
                bool(self._o.get("allow_loopback")),
            )
            if not v.dial or v.key is None or self._stopped or not self._src.allowed():
                return False
            release = self._limit.take(transport, limiter_keys(v.key))
        except Exception:
            return False
        if release is None:
            return False
        self._slots[transport] = release
        return True

    async def _accept(self, reader: Any, writer: Any) -> None:
        release = self._slots.pop(writer.transport, None)
        if release is None:
            _abort(writer)
            return
        a = _Attempt(writer)
        a.release = release
        self._attempts.add(a)
        at = self._mono()
        try:
            frame = await _read_frame(reader, 34, LOCAL_ATTEMPT_SECONDS)
            if frame is None:
                _abort(writer)
                return
            await self._c1(a, reader, writer, frame, at)
        except asyncio.CancelledError:
            _abort(writer)
            raise
        except Exception:
            _abort(writer)
        finally:
            # Closed before a session took the socket: a permitted guess has none, so nothing is counted unless
            # the attempt's own C1 was admitted (then the window frees it).
            if a.link is None:
                self._over(a, True)
            if a.release is not None:
                a.release()
                a.release = None

    async def _c1(self, a: _Attempt, reader: Any, writer: Any, frame: bytes, at: float) -> None:
        v = parse_c1(frame)
        out = self._window.c1(self._mono(), bool(v["ok"]))
        # Closed, busy, limited and refused: closed silently; none of them counts a failure.
        if out.get("result") != "attempt" or not v["ok"]:
            _abort(writer)
            return
        a.id = out["id"]
        gens = self._gens
        if gens is None:
            _abort(writer)
            return
        g = gens["code"] if v["kind"] == "code" else gens["qr"]
        y = cpace_scalar(self._random)
        yb = cpace_share(y, g)
        if yb is None or writer.is_closing():
            _abort(writer)
            return
        writer.write(encode_frame(encode_c2(yb)))
        isk = cpace_isk(self._sid, y, v["share"], yb, "responder")
        if isk is None or writer.is_closing():
            _abort(writer)
            return
        psk = cpace_psk(isk, self._src.slug)
        held = await self._loop.run_in_executor(None, self._src.store.count)
        if writer.is_closing() or self._stopped:
            _abort(writer)
            return
        a.link_key = bytearray(self._random(32))
        ident = a.id
        elapsed = self._mono() - at
        o = self._o
        label = o.get("label")
        opts: Dict[str, Any] = {
            "mode": "q",
            "role": "responder",
            "slug": self._src.slug,
            "static_key": bytes(a.link_key),
            "caps": [],
            "pair": PairingOptions(
                bytearray(psk),
                bytearray(isk),
                held,
                list(self._cats),
                label,
                elapsed,
                # The required permit: it counts the guess before the tag is tried.
                permit=lambda: self._window.begin_guess(ident, self._mono()),
            ),
            "hello": {"label": label, "platform": sys.platform, "app": self._src.slug},
        }
        a.link = SocketLink(
            reader,
            writer,
            opts,
            LinkHandlers(on_event=partial(self._event, a), on_closed=lambda c: self._closed(a, c)),
            handshake_seconds=max(0.001, LOCAL_ATTEMPT_SECONDS - elapsed),
        )
        await a.link.run()

    def _event(self, a: _Attempt, e: Any) -> None:
        if isinstance(e, Guess):
            t = self._mono()
            # The verdict of the permitted guess: opened (the count is refunded and the attempt is the
            # session) or failed (the code rotates).
            out = None
            if a.id is not None:
                out = self._window.guess_opened(a.id, t) if e.opens else self._window.guess_failed(a.id, t)
            a.phase = "session" if e.opens else "done"
            if out is not None:
                self._apply(out)
        elif isinstance(e, Established):
            if a.release is not None:
                a.release()
                a.release = None
            a.hello = e.hello
            self._offer(a)
        elif isinstance(e, LocalLinkMade):
            a.storing = self._spawn(self._store(a, e))

    def _offer(self, a: _Attempt) -> None:
        if a.shown or self._stopped or a.hello is None:
            return
        a.shown = True
        offer = LocalOffer(self._loop, a, self._cats, a.hello)
        _guarded(lambda: self._on_confirm(offer))

    async def _store(self, a: _Attempt, e: LocalLinkMade) -> None:
        try:
            paired = await store_link(self._src, a, e)
            fn = self._on_linked
            if paired is not None and fn is not None:
                _guarded(lambda: fn(paired))
        except Exception:
            a.failure = "closed"

    def _closed(self, a: _Attempt, c: Closed) -> None:
        self._spawn(self._closed_async(a, SessionClosed(c.code, c.by_peer)))

    async def _closed_async(self, a: _Attempt, c: SessionClosed) -> None:
        if a.closed is not None:
            return
        a.closed = c
        # The store runs beside the close: judge the window on its result.
        if a.storing is not None:
            await asyncio.gather(a.storing, return_exceptions=True)
        t = self._mono()
        out: Dict[str, Any] = {"rotate": False}
        if a.phase == "session":
            out = self._window.session_end(t, a.linked)
        elif a.id is not None and a.phase != "done":
            # A permitted guess that has no verdict is a failed guess; one that never reached its guess
            # counts nothing.
            out = self._window.abandon(a.id, t)
        self._over(a, False)
        for f in list(a.closers):
            _guarded(partial(f, c))
        fn = self._on_failed
        if a.shown and not a.linked and not self._stopped and fn is not None:
            reason = a.failure or ("timeout" if c.code == "peer_timeout" else "closed")
            _guarded(lambda: fn(LocalPairFailure(reason, c)))
        if a.linked:
            await self._shutdown(False)
        else:
            self._apply(out)

    def _over(self, a: _Attempt, pre: bool) -> None:
        """The attempt is over: its key and its place go; ``pre`` is a socket that closed before its session
        began."""
        self._attempts.discard(a)
        _zero(a.link_key)
        if pre and a.id is not None and a.phase == "c1":
            self._apply(self._window.abandon(a.id, self._mono()))

    def _end(self, a: _Attempt, code: str) -> None:
        a.local = True
        if a.link is not None:
            try:
                a.link.close_nowait(code)
            except Exception:
                pass
        elif a.writer is not None:
            _abort(a.writer)


def _prologue(slug: str) -> bytes:
    from ..core.peer_noise import peer_prologue

    return peer_prologue(slug, "q")


def _zero(b: bytearray) -> None:
    for i in range(len(b)):
        b[i] = 0


def _abort(w: Any) -> None:
    try:
        t = getattr(w, "transport", w)
        t.abort()
    except Exception:
        pass


# -- the joiner -------------------------------------------------------------------------------------------


class LocalJoiner:
    """Type or scan the other device's code (the initiator). :meth:`run` resolves with the link when both
    people confirmed and both devices stored it."""

    def __init__(self, src: LocalSource, budget: DialBudget, o: Dict[str, Any]) -> None:
        self._src = src
        self._budget = budget
        self._o = o
        self._loop = asyncio.get_running_loop()
        self._mdns: MdnsAdapter = o.get("mdns") or MulticastDnsAdapter(
            allow_loopback=bool(o.get("allow_loopback")), interfaces=o.get("interfaces")
        )
        self._random: Callable[[int], bytes] = o.get("random") or os.urandom
        self._mono: Callable[[], float] = o.get("mono") or time.monotonic
        self._timer = o.get("timer") or _default_timer(self._loop)
        self._ci = _prologue(src.slug)
        self._cats: Tuple[str, ...] = tuple(o["categories"])
        self._cands: Dict[str, Tuple[List[str], int]] = {}
        self._qr: Optional[Tuple[str, bytes]] = None
        self._qr_gen: Optional[bytes] = None
        self._password: Optional[str] = None
        self._nameplate: Optional[str] = None
        self._qr_invalid_detail: Optional[str] = None
        #: A code whose dials are spent answers with the hint to wait or ask for a new code.
        self._budget_spent = False
        self._browse: Optional[MdnsHandle] = None
        self._cancel_timer: Optional[Callable[[], None]] = None
        self._busy = False
        self._dials = 0
        self._dial_ended = False
        self._browse_over = False
        self._done = False
        self._current: Optional[_Attempt] = None
        self._writer: Any = None
        self._fut: "Optional[asyncio.Future[LocalPaired]]" = None
        self._tasks: "Set[asyncio.Future[Any]]" = set()
        inp: Dict[str, Any] = {"kind": "invalid"}
        if o.get("code") is not None:
            c = parse_code(o["code"])
            if c["ok"]:
                inp = {"kind": "code", "nameplate": c["nameplate"]}
                self._password = c["password"]
                self._nameplate = c["nameplate"]
        else:
            q = parse_qr(o["qr"], src.slug)
            if q["result"] == "ok":
                inp = {"kind": "qr", "instance": q["instance"]}
                self._qr = (q["instance"], q["secret"])
            elif q["result"] == "other-app":
                self._qr_invalid_detail = "This code is for another app."
        self._plan = JoinPlan(inp)

    def _spawn(self, coro: Any) -> "asyncio.Future[Any]":
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        t.add_done_callback(lambda f: f.cancelled() or f.exception())
        return t

    def cancel(self) -> None:
        self._finish(PolarisError(ErrorCode.PEER_CLOSED, "The pairing was closed."))

    async def run(self) -> LocalPaired:
        fut: "asyncio.Future[LocalPaired]" = self._loop.create_future()
        # A rejection nobody awaits (a cancelled join) must not warn.
        fut.add_done_callback(lambda f: f.cancelled() or f.exception())
        self._fut = fut
        if not self._plan.browses:
            self._finish(self._failed("pairing-code-failed"))
            return await fut
        # A code whose dials are spent answers at once and browses nothing; a QR is never limited.
        if self._nameplate is not None and not self._budget.check(self._nameplate, self._mono())["allowed"]:
            self._budget_spent = True
            self._finish(self._failed("pairing-code-failed"))
            return await fut
        try:
            # A QR's generator is made before anything is dialled.
            if self._qr is not None:
                sid = sid_of(self._qr[0])
                assert sid is not None
                self._qr_gen = cpace_generator(cpace_prs_qr(self._qr[1]), self._ci, sid)
            tags = self._tags()
            self._browse = await self._mdns.browse(lambda f: self._found(f, tags), self._gone)
        except Exception as e:
            self._finish(e)
            return await fut
        if self._done:
            return await fut
        browse_s = min(float(self._o.get("browse_seconds") or LOCAL_JOIN_BROWSE_SECONDS), LOCAL_JOIN_BROWSE_SECONDS)
        self._cancel_timer = self._timer(self._browse_timeout, browse_s)
        return await fut

    def _tags(self) -> List[str]:
        epoch = advert_epoch(self._src.now())
        return [product_tag(self._src.slug, e) for e in (epoch, epoch - 1)]

    def _gone(self, instance: str) -> None:
        self._cands.pop(instance, None)

    def _browse_timeout(self) -> None:
        self._browse_over = True
        self._stop_browse()
        self._maybe_end()

    def _stop_browse(self) -> None:
        h, self._browse = self._browse, None
        if h is not None:
            self._spawn(_quiet(h.stop()))

    def _failed(self, code: str) -> PolarisError:
        if code == "pairing-code-failed":
            msg = self._qr_invalid_detail or (
                "That code did not work. Wait a few minutes, or ask the other device for a new code."
                if self._budget_spent
                else "That code did not work."
            )
            return PolarisError(ErrorCode.PAIRING_CODE_FAILED, msg)
        return PolarisError(ErrorCode.PAIRING_NOT_FOUND, "The other device was not found on this network.")

    def _maybe_end(self) -> None:
        """Browse over and nothing is dialling: the answer is the plan's."""
        if self._done or self._busy or not self._browse_over:
            return
        r = self._plan.result()
        self._finish(self._failed("pairing-not-found" if r == "pairing-not-found" else "pairing-code-failed"))

    def _found(self, f: MdnsFound, tags: Sequence[str]) -> None:
        if self._done or self._browse_over:
            return
        txt = parse_txt(f.txt)
        if not txt["ok"] or txt["mode"] != "q":
            return
        allow = bool(self._o.get("allow_loopback"))
        hosts = [h for h in (f.hosts or (f.host,)) if text_verdict(h, allow)]
        if not hosts:
            return
        if self._plan.see(f.instance, txt["h"] in tags, txt["n"]):
            self._cands[f.instance] = (hosts, f.port)
        self._pump()

    def _pump(self) -> None:
        if self._done or self._busy:
            return
        name = self._plan.next()
        if name is None:
            return self._maybe_end()
        c = self._cands.get(name)
        if c is None:
            return
        if not self._src.allowed():
            return self.cancel()
        self._busy = True
        self._spawn(self._dial_task(name, c))

    async def _dial_task(self, instance: str, c: Tuple[List[str], int]) -> None:
        self._dial_ended = False
        try:
            await self._dial(instance, c)
        except Exception:
            pass
        finally:
            # A dial that ends without saying how ended before C2.
            self._end_dial("before-c2")
            self._busy = False
            # No dial is left: the answer is the plan's, without waiting out the browse. A QR names one
            # instance, so one dial is all there can be.
            if self._dials >= LOCAL_JOIN_CANDIDATES or self._qr is not None:
                self._browse_over = True
            if not self._done:
                self._pump()
            self._maybe_end()

    def _end_dial(self, outcome: str) -> None:
        if not self._dial_ended:
            self._dial_ended = True
            self._plan.ended(outcome)

    async def _dial(self, instance: str, c: Tuple[List[str], int]) -> None:
        """One dial. It ends the plan's turn as ``before-c2``, ``after-c2`` or ``transport``."""
        self._dials += 1
        t = self._mono()
        if self._nameplate is not None:
            # Spent when the dial is made, so joins that overlap cannot multiply the dials.
            if not self._budget.check(self._nameplate, t)["allowed"]:
                self._budget_spent = True
                self._end_dial("before-c2")
                self._browse_over = True
                return
            self._budget.spend(self._nameplate, t, 1)
        sid = sid_of(instance)
        if sid is None:
            return self._end_dial("before-c2")
        # A typed code's map runs now, once per dial and at most twice per code in 300 s.
        if self._qr_gen is not None:
            gen = self._qr_gen
        else:
            assert self._password is not None
            gen = cpace_generator(cpace_prs_code(self._password), self._ci, sid)
        y = cpace_scalar(self._random)
        ya = cpace_share(y, gen)
        if ya is None:
            return self._end_dial("before-c2")
        try:
            sock, _host = await dial_race(
                c[0], c[1], bool(self._o.get("allow_loopback")), timeout=float(self._o.get("dial_seconds", 10))
            )
            reader, writer = await asyncio.open_connection(sock=sock)
        except OSError:
            return self._end_dial("before-c2")
        if self._done:
            _abort(writer)
            return
        self._writer = writer
        at = self._mono()
        writer.write(encode_frame(encode_c1("qr" if self._qr is not None else "code", ya)))
        frame = await _read_frame(reader, 33, LOCAL_ATTEMPT_SECONDS)
        reply = parse_c2(frame) if frame is not None else None
        if reply is None or not reply["ok"]:
            _abort(writer)
            return self._end_dial("before-c2")
        isk = cpace_isk(sid, y, ya, reply["share"], "initiator")
        if isk is None or self._done:
            _abort(writer)
            return self._end_dial("before-c2")
        psk = cpace_psk(isk, self._src.slug)
        held = await self._loop.run_in_executor(None, self._src.store.count)
        await self._session(reader, writer, psk, isk, held, self._mono() - at)

    async def _session(self, reader: Any, writer: Any, psk: bytes, isk: bytes, held: int, elapsed: float) -> None:
        a = _Attempt(writer)
        self._current = a
        a.link_key = bytearray(self._random(32))
        up = [False]
        o = self._o
        label = o.get("label")
        done: "asyncio.Future[None]" = self._loop.create_future()

        def on_event(e: Any) -> None:
            if isinstance(e, Established):
                up[0] = True
                # The first session that reaches the transport ends the dial.
                self._end_dial("transport")
                a.hello = e.hello
                a.shown = True
                offer = LocalOffer(self._loop, a, self._cats, e.hello)
                _guarded(lambda: o["on_confirm"](offer))
            elif isinstance(e, LocalLinkMade):
                a.storing = self._spawn(self._store(a, e))

        def on_closed(c: Closed) -> None:
            self._spawn(self._closed(a, SessionClosed(c.code, c.by_peer), up[0], done))

        opts: Dict[str, Any] = {
            "mode": "q",
            "role": "initiator",
            "slug": self._src.slug,
            "static_key": bytes(a.link_key),
            "caps": [],
            "pair": PairingOptions(bytearray(psk), bytearray(isk), held, list(self._cats), label, elapsed),
            "hello": {"label": label, "platform": sys.platform, "app": self._src.slug},
        }
        link = SocketLink(
            reader,
            writer,
            opts,
            LinkHandlers(on_event=on_event, on_closed=on_closed),
            handshake_seconds=max(0.001, LOCAL_ATTEMPT_SECONDS - elapsed),
        )
        a.link = link
        link.start()
        self._spawn(link.run())
        await done

    async def _closed(self, a: _Attempt, c: SessionClosed, up: bool, done: "asyncio.Future[None]") -> None:
        a.closed = c
        if a.storing is not None:
            await asyncio.gather(a.storing, return_exceptions=True)
        _zero(a.link_key)
        for f in list(a.closers):
            _guarded(partial(f, c))
        if not up:
            self._end_dial("after-c2")
        if not a.linked and not self._done and up:
            self._finish(
                full()
                if a.failure == "full"
                else PolarisError(
                    ErrorCode.PEER_CLOSED,
                    "The pairing was declined." if a.declined else "The pairing ended before it finished.",
                )
            )
        if not done.done():
            done.set_result(None)

    async def _store(self, a: _Attempt, e: LocalLinkMade) -> None:
        try:
            paired = await store_link(self._src, a, e)
            if paired is not None:
                self._finish(None, paired)
        except Exception as err:
            a.failure = "closed"
            self._finish(err)

    def _finish(self, err: Optional[BaseException] = None, ok: Optional[LocalPaired] = None) -> None:
        if self._done:
            return
        self._done = True
        if self._cancel_timer is not None:
            self._cancel_timer()
            self._cancel_timer = None
        self._stop_browse()
        if self._qr is not None:
            self._qr = (self._qr[0], b"")
        fut = self._fut
        if fut is None:
            return
        if ok is not None:
            if not fut.done():
                fut.set_result(ok)
            return
        if not fut.done():
            fut.set_exception(err or PolarisError(ErrorCode.PEER_CLOSED, "pairing failed"))
        # A connection still in flight is closed; a stored link has closed itself.
        a = self._current
        if a is not None and a.link is not None and not a.linked:
            try:
                a.link.close_nowait("peer_bye")
            except Exception:
                pass
        if self._writer is not None:
            _abort(self._writer)


async def _quiet(aw: Any) -> None:
    try:
        await aw
    except Exception:
        pass
