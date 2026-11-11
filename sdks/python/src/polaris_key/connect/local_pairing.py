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
- the nameplate of a window that closes goes into the product's :class:`~polaris_key.core.peer_local.NameplateMemory`
  and the next window's draw skips it for 300 s (a renewed window is new in every respect); ``on_end`` is told
  once per window, after the advert is withdrawn, and a window a ``renew()`` replaces ends silently;
- the joiner makes at most 2 dials a join and, for a typed code, at most 2 per nameplate in 300 s across joins
  (the host's :class:`~polaris_key.core.peer_local.DialBudget`, spent when the dial is made). It never retries a
  failed code by itself, and a QR is never limited;
- a :class:`LocalOffer` is shown only once the session reached consent; its ``label`` and ``platform`` are
  display data from a device on the LAN that only proved the code, to be shown as "reported by the device";
- the joiner wipes the scalar, the generator, the ISK and the PSK of a dial when the join ends, a cancel
  included, and at once when it is made after the join ended (the Python ``bytes`` copies the cryptographic
  calls make internally are not reachable);
- nothing is stored before both people confirm and both ``LOCAL_LINK`` records are read in order.
"""

from __future__ import annotations

import asyncio
import base64
import math
import os
import re
import sys
import time
from functools import partial
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Set, Tuple

from ..constants_generated import ErrorCode
from ..core.errors import PolarisError
from ..core.headers import canonical_platform
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
    NameplateMemory,
    PairingWindow,
    display_code,
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
    LocalPairEnd,
    LocalPairFailure,
    LocalPairingError,
    LocalSource,
    cancelled,
    check_options,
    full,
    off,
    platform_of,
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
    "LocalPairingError",
    "LocalShower",
    "LocalSource",
    "check_options",
    "full",
    "off",
    "pairing_hello",
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


def pairing_hello(slug: str, label: Optional[str]) -> Dict[str, Any]:
    """The ``HELLO`` of a pairing with a code (mode ``q``): the platform as its canonical ``X-PKey-Platform``
    spelling (``macos``, not ``darwin``) so the other device, which keeps only such a spelling (§15.12), can show
    a glyph. A platform with no spelling goes as the OS reports it."""
    return {"label": label, "platform": canonical_platform(sys.platform) or sys.platform, "app": slug}


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
        #: The shower's permit for this attempt's guess was given: a close without a verdict is a failed guess.
        self.permitted = False
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
    blocked = [False]

    def gate() -> bool:
        # Read again inside the store call, under the store's lock: a pairing already storing when the gate clears
        # writes nothing.
        ok = src.allowed()
        if not ok:
            blocked[0] = True
        return ok

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
            platform=platform_of(getattr(a.hello, "platform", None)),
            allowed=gate,
        ),
    )
    if not stored:
        a.failure = "closed" if blocked[0] else "full"
        return None
    a.linked = True
    # The listener starts (a device that held no link) and the new link is advertised.
    src.notify()
    return LocalPaired(lid, e.label, tuple(e.cats))


class _Renewal:
    """A renewal in flight: ``stop`` is set by a ``stop()`` that came while it was opening."""

    def __init__(self) -> None:
        self.stop = False
        self.run: "Optional[asyncio.Future[LocalCode]]" = None


class LocalPairHandle:
    """The open pairing window. ``stop()`` closes the advert, the listener and every session; ``renew()`` closes
    it and opens the next. It follows the window that is current and holds no secret of its own."""

    def __init__(
        self,
        first: "LocalShower",
        again: "Callable[[LocalShower], Awaitable[LocalShower]]",
        run: Callable[..., Any],
    ) -> None:
        self._cur = first
        self._again = again
        self._run = run
        self._renewing: Optional[_Renewal] = None

    def __repr__(self) -> str:
        return "<LocalPairHandle open=%s>" % self.open

    @property
    def open(self) -> bool:
        """The window is still open."""
        return self._cur.open

    def code(self) -> Optional[LocalCode]:
        """The code on show now; ``None`` once the window has closed."""
        return self._cur.code()

    def stop(self) -> None:
        """Close the window. Safe to call twice and after the window closed by itself. A renewal in flight is told
        to stop: the window it opens is closed before anyone sees a code, and the renewal raises ``closed``."""
        from .loop import connect_loop

        if connect_loop().in_loop():
            asyncio.ensure_future(self._stop()).add_done_callback(lambda f: f.cancelled() or f.exception())
            return
        try:
            self._run(self._stop(), 10)
        except Exception:
            pass

    async def _stop(self) -> None:
        job = self._renewing
        if job is not None:
            job.stop = True
            if job.run is not None:
                await asyncio.gather(asyncio.shield(job.run), return_exceptions=True)
        await self._cur.stop()

    def renew(self) -> LocalCode:
        """Close the window and open a new one with the same options: a new nameplate (never one a window of
        this app closed with in the last 300 s while another is free), a new code and QR, 300 s and no failures.
        The old window ends with no ``on_end``. Works on a closed handle; refuses what ``pair`` refuses (the
        gate, the cap, another window) and, for 30 s after a window ended ``too-many-tries`` or after the second
        window within 10 minutes that ended after a failed guess, ``peer-closed`` with reason ``cooldown`` (so
        does ``pair``). Returns the first code of the new window. It blocks, so it cannot be called from a
        callback on the Connect thread (hand it to a thread; the new code also reaches ``on_code``)."""
        return self._run(self._renew())  # type: ignore[no-any-return]

    async def _renew(self) -> LocalCode:
        """Two calls at once share one new window."""
        job = self._renewing
        if job is None:
            job = self._renewing = _Renewal()
            job.run = asyncio.ensure_future(self._renew_job(job))
            job.run.add_done_callback(lambda f: f.cancelled() or f.exception())
        assert job.run is not None
        return await asyncio.shield(job.run)

    async def _renew_job(self, job: _Renewal) -> LocalCode:
        try:
            nxt = await self._again(self._cur)
            self._cur = nxt
            if job.stop:
                await nxt.stop()
                raise LanError("closed", "The window closed.")
            nxt.reveal()
            c = nxt.code()
            if c is None:
                raise LanError("closed", "The window closed.")
            return c
        finally:
            self._renewing = None


# -- the shower -------------------------------------------------------------------------------------------


class LocalShower:
    def __init__(
        self,
        src: LocalSource,
        o: Dict[str, Any],
        memory: NameplateMemory,
        on_closed: "Callable[[Optional[str], float], None]",
    ) -> None:
        self._src = src
        self._o = o
        self._memory = memory
        self._on_closed = on_closed
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
        self._sid = self._random(10)
        self._instance = pairing_instance(self._sid)
        self._ci = _prologue(src.slug)
        self._expires_at = 0
        #: Connections closed without counting a guess since the code last changed (``on_interrupted``).
        self._interrupted = 0
        #: When ``on_interrupted`` was last called (monotonic seconds): at most one call a second.
        self._interrupted_at = float("-inf")
        self._nameplate = ""
        self._password: Optional[str] = None
        self._qr_secret: Optional[bytearray] = None
        self._gens: Optional[Dict[str, bytes]] = None
        self._shown: Optional[LocalCode] = None
        self._server: Any = None
        self._limit = PendingLimiter(WAITING * 2, 1, 2)
        self._slots: Dict[Any, Callable[[], None]] = {}
        self._adv: Optional[MdnsHandle] = None
        self._cancel: Optional[Callable[[], None]] = None
        self._stopped = False
        self._tasks: "Set[asyncio.Future[Any]]" = set()
        self._on_code: Callable[[LocalCode], None] = o["on_code"]
        self._on_confirm: Callable[[LocalOffer], None] = o["on_confirm"]
        self._on_linked: Optional[Callable[[LocalPaired], None]] = o.get("on_linked")
        self._on_failed: Optional[Callable[[LocalPairFailure], None]] = o.get("on_failed")
        self._on_interrupted: Optional[Callable[[int], None]] = o.get("on_interrupted")
        self._on_end: Optional[Callable[[LocalPairEnd], None]] = o.get("on_end")

    def __repr__(self) -> str:
        return "<LocalPairing open=%s>" % (not self._stopped)

    def __reduce__(self) -> Any:
        raise TypeError("a pairing cannot be pickled")

    @classmethod
    async def start(
        cls,
        src: LocalSource,
        o: Dict[str, Any],
        memory: NameplateMemory,
        on_closed: "Callable[[Optional[str], float], None]",
    ) -> "LocalShower":
        s = cls(src, o, memory, on_closed)
        try:
            await s._open()
        except BaseException:
            try:
                await s.close(None)
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
        # Two tiers, from this device's own memory only: the adverts of other windows are not authenticated, so
        # they do not steer the draw.
        np = self._memory.draw(self._draw, self._mono())
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
        self._expires_at = int(math.floor(self._src.now() + seconds))

    def reveal(self) -> None:
        """Show the first code (``on_code``, reason ``opened``): the caller does so once the gate has been
        checked."""
        self._show("opened")

    def _tags(self) -> List[str]:
        epoch = advert_epoch(self._src.now())
        return [product_tag(self._src.slug, e) for e in (epoch, epoch - 1)]

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

    def _show(self, reason: str) -> None:
        if self._stopped or self._password is None or self._qr_secret is None:
            return
        c = LocalCode(
            display_code(self._nameplate, self._password),
            make_qr(self._src.slug, self._instance, bytes(self._qr_secret)),
            self._nameplate,
            reason,
            self._expires_at,
            int(self._window.state["failures"]),
        )
        self._shown = c
        self._interrupted = 0
        self._interrupted_at = float("-inf")
        _guarded(lambda: self._on_code(c))

    async def _rotate(self, why: str) -> None:
        """Make the next code, then tell the window. ``rotated`` comes only after the new password, the new QR
        secret and both generators exist; until then a C1 meets a busy window."""
        try:
            self._renew()
        except Exception:
            await self.close("person")
            return
        if self._stopped:
            return
        self._show(why)
        self._window.rotated(self._mono())

    def _apply(self, out: Dict[str, Any], why: str) -> None:
        """``why`` is the reason the next code carries when the outcome rotates it."""
        if out.get("rotate"):
            self._spawn(self._rotate(why))
        if out.get("result") == "too-many-tries":
            fn = self._on_failed
            if fn is not None:
                _guarded(lambda: fn(LocalPairFailure("too-many-tries")))
            self._spawn(self._shutdown(False, "too-many-tries"))

    def _interrupt(self) -> None:
        """A connection closed without counting a guess."""
        if self._stopped:
            return
        self._interrupted += 1
        t = self._mono()
        # Counted every time, told at most once a second: a flood does not flood the host.
        if t - self._interrupted_at < 1:
            return
        self._interrupted_at = t
        fn = self._on_interrupted
        n = self._interrupted
        if fn is not None:
            _guarded(lambda: fn(n))

    def _expire(self) -> None:
        # The window's 300 s: the advert and the listener go, a session past the transport runs on.
        self._spawn(self._shutdown(True, "expired"))

    async def stop(self) -> None:
        await self._shutdown(False, "person")

    async def close(self, end: Optional[str]) -> None:
        """Close the window, telling ``on_end`` why (``None``: tell no one, for a window a renewal replaces). The
        nameplate, the secrets and the advert go either way."""
        await self._shutdown(False, end)

    async def _shutdown(self, keep_sessions: bool, end: Optional[str]) -> None:
        """Close the window: the advert, the listener and the connections (``keep_sessions`` spares those past
        the transport)."""
        if self._stopped:
            return
        self._stopped = True
        if self._cancel is not None:
            self._cancel()
            self._cancel = None
        t = self._mono()
        # For the SDK's renewal floor: how this window ended, and whether it had counted a failed guess.
        failures = int(self._window.state["failures"])
        self._window.close(t)
        # The next window of this product does not draw this nameplate for 300 s.
        if self._nameplate != "":
            self._memory.shown(self._nameplate, t)
        srv, self._server = self._server, None
        if srv is not None:
            srv.close()
        for tr in list(self._slots):
            _abort(tr)
        for a in list(self._attempts):
            if not keep_sessions or a.phase != "session":
                self._end(a, "peer_bye")
        adv, self._adv = self._adv, None
        # The code, the QR secret and the generators are of no use to anyone now.
        if self._qr_secret is not None:
            _zero(self._qr_secret)
        self._qr_secret = None
        self._gens = None
        self._password = None
        self._shown = None
        flow: Optional[str] = None
        if end == "too-many-tries":
            flow = "too-many-tries"
        elif end != "stored" and failures > 0:
            flow = "wrong-code"
        _guarded(lambda: self._on_closed(flow, t))
        # The host hears the end once the advert is withdrawn and the listener has stopped.
        if adv is not None:
            try:
                await adv.stop()
            except Exception:
                pass
        fn = self._on_end
        if end is not None and fn is not None:
            _guarded(lambda: fn(LocalPairEnd(end)))

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
                self._interrupt()
                return False
            release = self._limit.take(transport, limiter_keys(v.key))
        except Exception:
            self._interrupt()
            return False
        if release is None:
            self._interrupt()
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
            self._interrupt()
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
                permit=lambda: self._permit(a, ident),
            ),
            "hello": pairing_hello(self._src.slug, label),
        }
        a.link = SocketLink(
            reader,
            writer,
            opts,
            LinkHandlers(on_event=partial(self._event, a), on_closed=lambda c: self._closed(a, c)),
            handshake_seconds=max(0.001, LOCAL_ATTEMPT_SECONDS - elapsed),
        )
        await a.link.run()

    def _permit(self, a: _Attempt, ident: Optional[int]) -> bool:
        ok = bool(ident is not None and self._window.begin_guess(ident, self._mono()))
        if ok:
            a.permitted = True
        return ok

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
                self._apply(out, "wrong-code")
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
        self._interrupted = 0
        self._interrupted_at = float("-inf")
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
        # What the next code says when this end rotates it (``LocalCode.reason``).
        why = "wrong-code"
        reason = a.failure or ("timeout" if c.code == "peer_timeout" else "closed")
        if a.phase == "session":
            out = self._window.session_end(t, a.linked)
            why = reason if reason in ("declined", "timeout") else "closed"
        elif a.id is not None and a.phase != "done":
            # A permitted guess that has no verdict is a failed guess; one that never reached its guess
            # counts nothing.
            out = self._window.abandon(a.id, t)
            if not a.permitted:
                self._interrupt()
        self._over(a, False)
        for f in list(a.closers):
            _guarded(partial(f, c))
        fn = self._on_failed
        if a.shown and not a.linked and not self._stopped and fn is not None:
            _guarded(lambda: fn(LocalPairFailure(reason, c)))
        if a.linked:
            await self._shutdown(False, "stored")
        else:
            self._apply(out, why)

    def _over(self, a: _Attempt, pre: bool) -> None:
        """The attempt is over: its key and its place go; ``pre`` is a socket that closed before its session
        began."""
        self._attempts.discard(a)
        _zero(a.link_key)
        if pre and a.id is not None and a.phase == "c1":
            self._apply(self._window.abandon(a.id, self._mono()), "wrong-code")
            self._interrupt()

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
        self._qr_gen: Optional[bytearray] = None
        self._password: Optional[str] = None
        self._nameplate: Optional[str] = None
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
        #: Key material of the dial in flight (the scalar, the generator, the ISK, the PSK): wiped when the join
        #: ends.
        self._secrets: List[bytearray] = []
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
                inp = {"kind": "other-app"}
        self._plan = JoinPlan(inp)

    def _spawn(self, coro: Any) -> "asyncio.Future[Any]":
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        t.add_done_callback(lambda f: f.cancelled() or f.exception())
        return t

    def cancel(self, why: str = "closed") -> None:
        """Stop the join: ``cancelled`` is the host's ``cancel`` event, ``closed`` the gate going off."""
        self._finish(
            cancelled()
            if why == "cancelled"
            else LocalPairingError(ErrorCode.PEER_CLOSED, "The pairing was closed.", reason="closed")
        )

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
            self._plan.start_spent()
            self._finish(self._failed("pairing-code-failed"))
            return await fut
        try:
            # A QR's generator is made before anything is dialled.
            if self._qr is not None:
                sid = sid_of(self._qr[0])
                assert sid is not None
                self._qr_gen = bytearray(cpace_generator(cpace_prs_qr(self._qr[1]), self._ci, sid))
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

    def _failed(self, code: str) -> LocalPairingError:
        """The error of a code that did not work, with the plan's reason; or of no device found."""
        if code == "pairing-not-found":
            return LocalPairingError(ErrorCode.PAIRING_NOT_FOUND, "The other device was not found on this network.")
        reason = self._plan.reason() or "wrong"
        msg = (
            "This code is for another app."
            if reason == "other-app"
            else "That code did not work. Wait a few minutes, or ask the other device for a new code."
            if reason == "spent"
            else "That code did not work."
        )
        return LocalPairingError(ErrorCode.PAIRING_CODE_FAILED, msg, reason=reason)

    @staticmethod
    def _close_reason(a: _Attempt, c: SessionClosed) -> str:
        """Why a session that reached the transport ended without a link (``peer-closed``'s reason): this person
        said no, or the other device did (a ``peer_bye`` before any link was exchanged)."""
        if a.declined or (c.by_peer and c.code == "peer_bye"):
            return "declined"
        return "timeout" if c.code == "peer_timeout" else "closed"

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
                self._end_dial("budget")
                self._browse_over = True
                return
            self._budget.spend(self._nameplate, t, 1)
        sid = sid_of(instance)
        if sid is None:
            return self._end_dial("before-c2")
        # A typed code's map runs now, once per dial and at most twice per code in 300 s.
        gen: bytearray
        if self._qr_gen is not None:
            gen = self._qr_gen
        else:
            assert self._password is not None
            gen = bytearray(cpace_generator(cpace_prs_code(self._password), self._ci, sid))
        # A join cancelled while the generator was being made wipes what it made at once.
        y = cpace_scalar(self._random)
        self._keep(y)
        if self._qr_gen is None:
            self._keep(gen)
        if self._done:
            return
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
        isk_b = cpace_isk(sid, y, ya, reply["share"], "initiator")
        isk = None if isk_b is None else bytearray(isk_b)
        if isk is not None:
            self._keep(isk)
        if isk is None or self._done:
            _abort(writer)
            return self._end_dial("before-c2")
        psk = bytearray(cpace_psk(bytes(isk), self._src.slug))
        self._keep(psk)
        held = await self._loop.run_in_executor(None, self._src.store.count)
        if self._done:
            _abort(writer)
            return
        await self._session(reader, writer, psk, isk, held, self._mono() - at)

    async def _session(
        self, reader: Any, writer: Any, psk: bytearray, isk: bytearray, held: int, elapsed: float
    ) -> None:
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
            "hello": pairing_hello(self._src.slug, label),
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
            reason = self._close_reason(a, c)
            self._finish(
                full()
                if a.failure == "full"
                else LocalPairingError(
                    ErrorCode.PEER_CLOSED,
                    "The pairing was declined." if reason == "declined" else "The pairing ended before it finished.",
                    reason=reason,
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

    def _keep(self, *secrets: bytearray) -> None:
        """Hold a secret until the join ends; one made after it ended is wiped at once."""
        if self._done:
            for k in secrets:
                _zero(k)
        else:
            self._secrets.extend(secrets)

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
        if self._qr_gen is not None:
            _zero(self._qr_gen)
        secrets, self._secrets = self._secrets, []
        for k in secrets:
            _zero(k)
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
