"""Nearby approval (CC-15; WIRE-CONTRACT-V5 §15.4, §15.6.1): the approver half. Mirrors
``packages/sdk-node/src/connect/nearbyApprover.ts`` as it stands after its red-team fix round.

A signed-in device (M) advertises under a random instance, lets a nearby device (D) with no sign-in
connect in mode ``v``, shows three codes and, when the person picks the one D shows, hands the verified
``VOUCH_REQ`` to the host. The host calls ``nearby/approve`` and gives the answer back; this module maps
it to ``VOUCH_RESULT``. It calls no route.

Everything here runs on the Connect loop (D-3): build with ``await NearbyApprover.start(...)`` there. Its
methods are coroutines (or plain calls that return an awaitable once the synchronous part is done); the
facade (``client.cloud_connect.nearby``) marshals the host's blocking calls onto the loop. A host
callback (the handler, ``on_notice``, ``on_stopped``, ``on_close``) runs on the loop: keep it short.

Rules this module keeps:

- the advert is ``p1-`` + 10 random bytes in base32 with ``v=1``, ``m=v`` and the product tag; it has a
  listener of its own, and the instance and the port are both new at every listen and every 300 s (the old
  listener closes at once; a session past the transport stays);
- it stands only while the device is signed in, discovery names ``nearby`` and ``nearbyApprove``, and the
  host opened the prompt or allowed background approval (``background=True``, required with
  ``prompt=False``); it stops on ``pause()``, on ``stop()``, when the device signs out, when discovery
  loses ``nearby``, when a renewal fails and when the failure budget is spent (two prompted failures in 10
  minutes). ``stop()``, a sign-out, a lost discovery and a failed renewal are final: no later call brings
  the advert back. A budget stop is cleared by ``reopen()`` or ``set_prompt(True)`` only; ``pause()``
  works from ``advertising`` only, and ``resume()`` only from the host's own pause, after sign-in and
  discovery are read again;
- ``stop()`` and the sign-out do not wait for a renewal or a queued call: the state, the listener, the
  advert and the sessions go down at once, and ``destroy()`` drops the sockets;
- accept is the mode-a gate (:func:`polaris_key.connect.lan.admit_transport`): the same verdict on the
  socket's own addresses, the same pending limits, and here one waiting session per source address;
- one prompt at a time, held until the picked session finishes or closes. A session that reaches the code
  stage meanwhile waits with no code shown and its 120 s deadline running. With the prompt closed a
  session only raises a notice. A prompt that was shown and whose peer then closes before the person
  answered counts as a failure;
- the host's callbacks are called inside a guard: a throw cannot skip the cleanup that follows;
- a wrong pick, "None of these match", the host's close and the deadline end the session before
  ``VOUCH_REQ`` is delivered, and no route is called;
- ``finish()`` is refused unless the person picked the right code on this session and ``VOUCH_REQ``
  verified (no silent approval); records for Sync go out only after ``approved``;
- the request handle, ``sig``, ``h``, the nonces and the one-time keys are in no message, repr or error;
  the one-time static key is wiped when the handshake ends.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Set, Union

from ..connect.errors import LanError
from ..connect.lan import Admitted, GatedProtocol, admit_transport, listen_socket
from ..connect.lan_judge import PendingLimiter
from ..constants_generated import ErrorCode
from .peer_advert import advert_epoch, product_tag
from .peer_frame import RECORD
from .peer_link import LinkHandlers, SocketLink
from .peer_mdns import MdnsAdapter, MdnsAdvert, MdnsHandle, MulticastDnsAdapter
from .peer_noise import NoisePorts
from .peer_sas import sas_display
from .peer_session import Closed, Established, HandshakeLimiter, PeerHello, Record, Sas
from .peer_vouch import (
    VOUCH_REQ_MAX,
    ApproveAnswer,
    VouchFailureBudget,
    VouchFlow,
    VouchHello,
    VouchRecord,
    VouchRequest,
    approver_instance,
    build_vouch_result,
    decoy_codes,
    finish_map,
    verify_vouch_request,
)

__all__ = [
    "ApprovalNotice",
    "ApproveAnswerInput",
    "ApproverSource",
    "FinishOutcome",
    "NearbyApproval",
    "NearbyApprover",
    "NearbyApproverOptions",
    "NearbyApproverStatus",
    "NearbyStopReason",
    "nearby_hello",
]

_Timer = Callable[[Callable[[], None], float], Callable[[], None]]
_Random = Callable[[int], bytes]

HELD_REQUEST_SECONDS = 30.0
KEEP_OPEN_SECONDS = 300.0
RENEW_SECONDS = 300.0
#: The most a renewal waits on the host's sign-in or discovery read.
CHECK_SECONDS = 15.0
#: Waiting sessions from one link, /24 or /64 (§15.6.1 rule 2).
PER_GROUP = 2
MAX_SESSIONS = 8
#: Waiting sessions at once, and handshakes a minute (§15.6.1 rule 2).
WAITING = 4
PER_MINUTE = 5
HANDSHAKE_SECONDS = 30.0
#: The longest label either end puts in a ``HELLO`` (display data).
LABEL_MAX = 256

#: Why an advert stopped: ``budget``, ``signed-out``, ``discovery`` or ``host``.
NearbyStopReason = str


def nearby_hello(slug: str, label: Optional[str] = None) -> Dict[str, Any]:
    """The ``HELLO`` a mode-v end sends: the optional label, this platform and the product slug."""
    return {"label": label, "platform": sys.platform, "app": slug}


def guarded(fn: Callable[[], Any]) -> None:
    """Call a host callback so that a throw cannot skip the cleanup that follows it (nearby approval: the
    callbacks are the host's, and a bug there must not leave a session or an advert up)."""
    try:
        fn()
    except Exception:
        pass  # the host's bug is the host's; the module's own state is already settled


def _call_guarded(fn: Callable[[Any], Any], arg: Any) -> None:
    """``fn(arg)`` inside :func:`guarded`."""
    guarded(lambda: fn(arg))


def _default_timer(fn: Callable[[], None], seconds: float) -> Callable[[], None]:
    return asyncio.get_running_loop().call_later(seconds, fn).cancel


def _wipe(b: Optional[bytearray]) -> None:
    if b is not None:
        b[:] = bytes(len(b))


_CODE_DIGITS = re.compile(r"[0-9]{6}\Z")


def _code_value(code: Any) -> Optional[int]:
    """A code the person picked: ``123 456``, ``123456`` or the number; ``None`` when it is none of those."""
    if isinstance(code, bool):
        return None
    if isinstance(code, int):
        return code if 0 <= code < 1_000_000 else None
    if not isinstance(code, str):
        return None
    digits = "".join(code.split())
    return int(digits) if _CODE_DIGITS.match(digits) is not None and digits.isascii() else None


@dataclass
class ApproverSource:
    """What the approver reads of the client, at start and at each renewal. ``signed_in`` and
    ``nearby_served`` are coroutine functions (the facade runs the client's blocking reads off the loop);
    ``now`` is epoch seconds."""

    slug: str
    now: Callable[[], int]
    #: This device is signed in on the product.
    signed_in: Callable[[], Awaitable[bool]]
    #: A fresh read of discovery: it names ``nearby`` and ``nearbyApprove`` (§12.11.6).
    nearby_served: Callable[[], Awaitable[bool]]


@dataclass(frozen=True)
class ApprovalNotice:
    label: Optional[str]
    platform: str


@dataclass
class NearbyApproverOptions:
    """``prompt``: the "Approve a nearby device" screen is open; without it a session raises ``on_notice``
    only. ``background``: the person allowed background approval (and the system permission is granted);
    required with ``prompt=False``, and without it closing the screen (``set_prompt(False)``) pauses the
    advert. ``label`` is this device's label in ``HELLO`` (display data, shown on the other device): name
    the device (``"Ana's laptop"``); never use an account identifier (an email address, a user id).
    ``on_notice(ApprovalNotice)`` hears a session that wants approval while the prompt is closed (no code,
    no pick); ``on_stopped(reason)`` hears an advert that stopped on its own (everything but the host's
    own ``pause``/``stop``). ``allow_loopback`` is for tests and same-host use only."""

    prompt: bool
    background: bool = False
    label: Optional[str] = None
    on_notice: Optional[Callable[[ApprovalNotice], None]] = None
    on_stopped: Optional[Callable[[str], None]] = None
    mdns: Optional[MdnsAdapter] = None
    #: Where to listen. Default ``::`` (both families on one port), or 0.0.0.0.
    host: Optional[str] = None
    allow_loopback: bool = False
    handshake_seconds: float = HANDSHAKE_SECONDS
    #: Seconds between advert renewals (default 300).
    renew_seconds: float = RENEW_SECONDS
    #: Seconds a session stays open after the person's pick (default 300, rule 8).
    keep_open_seconds: float = KEEP_OPEN_SECONDS
    #: Seconds to wait for ``VOUCH_REQ`` after the right pick (default 30).
    request_wait_seconds: float = HELD_REQUEST_SECONDS
    #: The most a renewal or a restart waits on the host's sign-in or discovery read (default 15).
    check_seconds: float = CHECK_SECONDS
    #: Sessions at once (default 8).
    max_sessions: int = MAX_SESSIONS
    #: Waiting sessions from one source address (default 1, rule 2). For tests that share one.
    max_pending_per_address: int = 1
    #: Schedule ``fn`` after ``seconds``; returns the cancel. Default: the running loop's ``call_later``.
    timer: Optional[_Timer] = None
    #: Monotonic seconds (limiter, failure budget, the sessions' deadlines).
    mono: Optional[Callable[[], float]] = None
    #: CSPRNG bytes (instance, decoys, one-time keys).
    random: Optional[_Random] = None
    #: The session engine's randomness (SAS nonces, ephemeral keys); a test's seam.
    ports: Optional[NoisePorts] = None


class NearbyApproverStatus(NamedTuple):
    #: ``advertising``, ``paused`` or ``stopped``.
    state: str
    #: Why it stopped, when it did.
    reason: Optional[str]
    prompt: bool


@dataclass(frozen=True)
class ApproveAnswerInput:
    """The answer of ``nearby/approve`` as the host read it (§15.6.1 rule 6)."""

    #: The HTTP status, or ``None`` when there was no answer.
    http: Optional[int]
    #: The body text, or ``None``.
    body: Optional[str]
    #: The host's fresh read of discovery: does it still name ``nearby`` and ``nearbyApprove``?
    discovery_nearby: bool


class FinishOutcome(NamedTuple):
    """``sent``: ``VOUCH_RESULT`` went out with this status (after ``approved`` the session stays open for
    records). ``wait``: nothing sent yet, show the choice (``choice``) or register this device's keys
    (``keys``), then call ``finish`` again. ``closed``: nothing sent; the session closed ``peer_bye``."""

    sent: Optional[str] = None
    wait: Optional[str] = None
    closed: bool = False


class _Slot:
    """An accepted socket's place in the pre-handshake limiter, and its handshake window."""

    def __init__(self, gen: "_Generation", writer: Any, admitted: Admitted, window: float) -> None:
        self.gen = gen
        self.writer = writer
        self.address = admitted.address
        self._release: Optional[Callable[[], None]] = admitted.release
        self.up = False
        loop = asyncio.get_running_loop()
        self._window: Optional[asyncio.TimerHandle] = loop.call_later(window, _abort, writer)
        gen.pending.add(self)

    def established(self) -> None:
        """The transport is up: the handshake window ends, the slot is kept."""
        self.up = True
        if self._window is not None:
            self._window.cancel()
            self._window = None

    def settle(self) -> None:
        """Release the slot and end the window. Also runs when the socket closes."""
        if self._window is not None:
            self._window.cancel()
            self._window = None
        self.gen.pending.discard(self)
        release, self._release = self._release, None
        if release is not None:
            release()


def _abort(writer: Any) -> None:
    try:
        t = getattr(writer, "transport", writer)
        t.abort()
    except Exception:
        pass


class _Generation:
    """One listener, its advert and its limits."""

    def __init__(self, limit: PendingLimiter, limiter: HandshakeLimiter) -> None:
        self.limit = limit
        self.limiter = limiter
        self.server: Any = None
        self.adv: Optional[MdnsHandle] = None
        self.retired = False
        #: Transports the gate admitted that have not reached the accept callback yet.
        self.slots: Dict[Any, Admitted] = {}
        #: Sockets holding a slot.
        self.pending: Set[_Slot] = set()

    def destroy_pending(self, keep_up: bool = False) -> None:
        """Abort every transport that still holds a slot; ``keep_up`` spares those past the transport."""
        for t in list(self.slots):
            _abort(t)
        self.slots.clear()
        for s in list(self.pending):
            if not keep_up or not s.up:
                _abort(s.writer)


class _Live:
    """One inbound session of the approver."""

    def __init__(self, link: SocketLink, slot: _Slot, key: bytearray, flow: VouchFlow[Any]) -> None:
        self.link = link
        self.slot = slot
        self.key = key
        self.flow = flow
        self.hello: Optional[PeerHello] = None
        self.sas: Optional[int] = None
        self.noticed = False
        self.shown = False
        self.picked = False
        self.keys_retried = False
        self.dead = False
        #: This module ended the session (a pick, a close, the host, a pause): not the peer's doing.
        self.local = False
        self.pick: Optional["asyncio.Future[Any]"] = None
        self.request: "asyncio.Future[Any]" = asyncio.get_running_loop().create_future()
        self.closers: List[Callable[[Closed], None]] = []
        self.cancels: List[Callable[[], None]] = []
        self.closed: Optional[Closed] = None


def _resolve(fut: "asyncio.Future[Any]", value: Any) -> None:
    if not fut.done():
        fut.set_result(value)


class NearbyApproval:
    """One session asking for approval, as the host's handler sees it. Its methods are coroutines for the
    Connect loop; ``client.cloud_connect.nearby`` hands the host blocking forms of them."""

    def __init__(self, owner: "NearbyApprover", live: _Live, codes: List[str]) -> None:
        self._owner = owner
        self._live = live
        #: What D's ``HELLO`` showed. Unauthenticated display data: any device on the network can send any
        #: label, and the cleaning leaves some invisible blanks, so a label can look empty or like another
        #: device's. Show it as "reported by the device" beside the platform and the codes, never as proof
        #: of who is asking; the person's pick of the matching code is the only check.
        self.label: Optional[str] = live.hello.label if live.hello is not None else None
        self.platform: str = live.hello.platform if live.hello is not None else ""
        #: The three codes, in the order to show them, each like ``123 456``.
        self.codes: List[str] = list(codes)

    def __repr__(self) -> str:
        return "<NearbyApproval>"

    def __reduce__(self) -> Any:
        raise TypeError("a nearby approval cannot be pickled")

    async def pick(self, code: Any) -> Union[VouchRequest, str]:
        """The person picked this code. The right one delivers D's ``VOUCH_REQ``, which is verified here:
        the result is exactly what ``nearby/approve`` gets. A wrong code closes the session, calls no
        route and answers ``"mismatch"``; a request that does not verify closes it and answers
        ``"invalid"``."""
        live = self._live
        if live.pick is None:
            live.pick = asyncio.ensure_future(self._owner._pick(live, code))
        return await asyncio.shield(live.pick)  # type: ignore[no-any-return]

    async def decline(self) -> None:
        """"None of these match": the session closes, nothing is delivered and no route is called."""
        await self._owner._decline(self._live)

    async def finish(self, answer: ApproveAnswerInput) -> FinishOutcome:
        """Give the answer of ``nearby/approve`` back; sends ``VOUCH_RESULT`` (rule 6)."""
        return await self._owner._finish(self._live, answer)

    async def send_record(self, type_: int, body: bytes) -> None:
        """After ``approved``: a Sync record (``0x0030`` to ``0x003F``) to D."""
        await self._owner._send(self._live, type_, bytes(body))

    async def close(self) -> None:
        """The host leaves: the session closes ``peer_bye``. Before a pick this counts for nothing."""
        self._owner._end(self._live, ErrorCode.PEER_BYE)

    def on_close(self, fn: Callable[[Closed], None]) -> Callable[[], None]:
        """Called once when the session ends (at once when it already has)."""
        live = self._live
        live.closers.append(fn)
        if live.closed is not None:
            guarded(lambda: fn(live.closed))  # type: ignore[arg-type]

        def off() -> None:
            if fn in live.closers:
                live.closers.remove(fn)

        return off


class NearbyApprover:
    """The advert, the listener and the sessions of one "Approve a nearby device" feature."""

    def __init__(
        self,
        src: ApproverSource,
        handler: Callable[[NearbyApproval], None],
        o: NearbyApproverOptions,
    ) -> None:
        self._src = src
        self._handler = handler
        self._o = o
        self._loop = asyncio.get_running_loop()
        self._prompt = o.prompt
        self._background = o.background is True
        self._random: _Random = o.random or os.urandom
        self._timer: _Timer = o.timer or _default_timer
        self._mono: Callable[[], float] = o.mono or time.monotonic
        self._budget = VouchFailureBudget(self._mono)
        self._mdns: MdnsAdapter = o.mdns or MulticastDnsAdapter(allow_loopback=o.allow_loopback)
        self._live: Set[_Live] = set()
        self._queue: List[_Live] = []
        self._active: Optional[_Live] = None
        self._gen: Optional[_Generation] = None
        self._cancel_renew: Optional[Callable[[], None]] = None
        self._state = "stopped"
        self._reason: Optional[str] = None
        self._lock = asyncio.Lock()
        #: A stop that nothing undoes: ``stop()``, a sign-out, lost discovery, a failed renewal.
        self._final = False
        #: Bumped by every halt; an ``_advertise`` or a check that began before it gives up.
        self._epoch = 0
        self._tasks: Set["asyncio.Future[Any]"] = set()

    def __repr__(self) -> str:
        return "<NearbyApprover state=%s>" % self._state

    def __reduce__(self) -> Any:
        raise TypeError("a nearby approver cannot be pickled")

    @classmethod
    async def start(
        cls,
        src: ApproverSource,
        handler: Callable[[NearbyApproval], None],
        options: NearbyApproverOptions,
    ) -> "NearbyApprover":
        """Start advertising. The caller has checked that the device is signed in and that discovery names
        ``nearby``; both are read again at every renewal."""
        if not options.prompt and options.background is not True:
            raise LanError("bad_input", "Without the prompt, background approval must be allowed (background=True).")
        if options.label is not None and (not isinstance(options.label, str) or len(options.label) > LABEL_MAX):
            raise LanError("bad_input", "The label is not valid.")
        a = cls(src, handler, options)
        await a._advertise()
        return a

    def status(self) -> NearbyApproverStatus:
        return NearbyApproverStatus(self._state, self._reason, self._prompt)

    # -- the handle ---------------------------------------------------------------------------------

    def stop(self) -> "asyncio.Future[None]":
        """Final, and not queued: the state, the listener, the advert and the sessions go down at once, so a
        renewal that hangs on the host's reads cannot hold a sign-out back. The result completes when the
        advert is withdrawn."""
        self._final = True
        return self._halt("stopped", "host")

    def destroy(self) -> None:
        """Drop everything now, with no goodbye (the sign-out bound's force path)."""
        self._final = True
        fut = self._halt("stopped", "host")
        fut.add_done_callback(lambda f: f.cancelled() or f.exception())
        for live in list(self._live):
            live.link.destroy()
        for t in list(self._tasks):
            t.cancel()

    async def pause(self) -> None:
        """Stop advertising and close live sessions until :meth:`resume`. Works from ``advertising`` only."""

        async def go() -> None:
            if self._final or self._state != "advertising":
                return
            await self._halt("paused", "host")

        await self._serial(go)

    async def resume(self) -> None:
        """Start again after the host's own :meth:`pause`. It reads sign-in and discovery again first, and
        does nothing after a stop, a sign-out or a spent budget."""

        async def go() -> None:
            if self._final or self._state != "paused" or self._reason != "host":
                return
            await self._restart()

        await self._serial(go)

    async def set_prompt(self, open_: bool) -> None:
        """The "Approve a nearby device" screen opens (``True``) or closes (``False``). Opening it also counts
        the failure budget from zero and starts a stopped (budget) or paused advert again; closing it ends
        the prompt that is showing and, without ``background``, pauses the advert."""

        async def go() -> None:
            if self._final or open_ == self._prompt:
                return
            self._prompt = open_
            if not open_:
                # The screen closed: the prompt that is showing ends, and the others go passive.
                live = self._active
                self._active = None
                if live is not None and not live.picked:
                    self._end(live, ErrorCode.PEER_BYE)
                for queued in self._queue:
                    queued.noticed = False
                # Without background approval nothing stands for a closed screen.
                if not self._background and self._state == "advertising":
                    await self._halt("paused", "host")
                self._pump()
                return
            self._budget.reopen()
            if (self._state == "stopped" and self._reason == "budget") or (
                self._state == "paused" and self._reason == "host"
            ):
                await self._restart()
            self._pump()

        await self._serial(go)

    async def reopen(self) -> None:
        """Count the failure budget from zero and start a budget-stopped advert again."""

        async def go() -> None:
            if self._final:
                return
            self._budget.reopen()
            if self._state == "stopped" and self._reason == "budget":
                await self._restart()

        await self._serial(go)

    async def _serial(self, fn: Callable[[], Awaitable[Any]]) -> Any:
        async with self._lock:
            return await fn()

    def _spawn(self, coro: Awaitable[Any]) -> "asyncio.Future[Any]":
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        t.add_done_callback(lambda f: f.cancelled() or f.exception())
        return t

    async def _check(self, read: Callable[[], Awaitable[bool]]) -> bool:
        """A host read that may hang or fail: past ``check_seconds``, or on a throw, it reads as "no"."""
        try:
            return bool(await asyncio.wait_for(read(), self._o.check_seconds))
        except Exception:
            return False

    async def _restart(self) -> None:
        """Start the advert again from a pause or a budget stop, after reading sign-in and discovery again.
        A stop, or a halt that landed meanwhile, wins."""
        if self._budget.stopped:
            if self._state == "paused":
                await self._halt("stopped", "budget")
            return
        epoch = self._epoch
        signed = await self._check(self._src.signed_in)
        if self._final or epoch != self._epoch:
            return
        if not signed:
            await self._halt("stopped", "signed-out")
            return
        served = await self._check(self._src.nearby_served)
        if self._final or epoch != self._epoch:
            return
        if not served:
            await self._halt("stopped", "discovery")
            return
        await self._advertise()

    # -- the advert ---------------------------------------------------------------------------------

    async def _advertise(self) -> None:
        """A new listener, port and instance; the old generation retires. Starts the renewal clock."""
        o = self._o
        epoch = self._epoch
        # One waiting session per source address (rule 2); the limiter below caps the waiting ones.
        limit = PendingLimiter(WAITING * 2, o.max_pending_per_address, PER_GROUP)
        gen = _Generation(limit, HandshakeLimiter(PER_MINUTE, WAITING, self._mono))

        def protocol() -> "asyncio.StreamReaderProtocol":
            reader = asyncio.StreamReader(loop=self._loop)
            return GatedProtocol(
                reader,
                lambda r, w: self._accept(gen, r, w),
                lambda t: self._gate(gen, t),
                self._loop,
            )

        sock = listen_socket(o.host, 0)
        try:
            gen.server = await self._loop.create_server(protocol, sock=sock)
        except BaseException:
            sock.close()
            raise
        try:
            port = int(sock.getsockname()[1])
            instance = approver_instance(self._random)
            tag = product_tag(self._src.slug, advert_epoch(self._src.now()))
            gen.adv = await self._mdns.advertise(MdnsAdvert(instance, port, ["v=1", "m=v", "h=" + tag]))
        except BaseException:
            gen.server.close()
            raise
        if epoch != self._epoch:
            # A stop landed while this was starting: what it made is torn down, not kept.
            await self._retire(gen)
            return
        old = self._gen
        self._gen = gen
        self._state = "advertising"
        self._reason = None
        if old is not None:
            await self._retire(old)
        if self._cancel_renew is not None:
            self._cancel_renew()
        self._cancel_renew = self._timer(self._renew_later, o.renew_seconds)

    def _renew_later(self) -> None:
        self._spawn(self._renew())

    async def _renew(self) -> None:
        async def go() -> None:
            if self._state != "advertising":
                return
            epoch = self._epoch
            signed = await self._check(self._src.signed_in)
            if epoch != self._epoch:
                return
            if not signed:
                await self._halt("stopped", "signed-out")
                return
            served = await self._check(self._src.nearby_served)
            if epoch != self._epoch:
                return
            if not served:
                await self._halt("stopped", "discovery")
                return
            try:
                await self._advertise()
            except Exception:
                # The advert cannot be renewed (the network interface went away, the port is gone): it must
                # not stand on, unrenewed and unchecked. It stops, and the host hears why.
                if epoch == self._epoch:
                    await self._halt("stopped", "discovery")

        await self._serial(go)

    async def _retire(self, g: _Generation) -> None:
        """The old listener accepts nothing more; a connection short of the transport is closed."""
        g.retired = True
        g.server.close()
        g.destroy_pending(keep_up=True)
        if g.adv is not None:
            try:
                await g.adv.stop()
            except Exception:
                pass

    def _halt(self, state: str, reason: str) -> "asyncio.Future[None]":
        """Take everything down. The state, the listener and the session closes happen before the first
        await, so a caller that does not wait still has them done."""
        self._epoch += 1
        if state == "stopped" and reason != "budget":
            self._final = True
        if self._cancel_renew is not None:
            self._cancel_renew()
            self._cancel_renew = None
        g, self._gen = self._gen, None
        self._state = state
        self._reason = reason
        work: List[Awaitable[Any]] = []
        if g is not None:
            g.retired = True
            g.server.close()
            # A connection short of the transport is dropped; the sessions past it hear ``peer_bye``.
            g.destroy_pending(keep_up=True)
            if g.adv is not None:
                work.append(asyncio.ensure_future(_quiet(g.adv.stop())))
        for live in list(self._live):
            self._end(live, ErrorCode.PEER_BYE)
        self._queue = []
        self._active = None

        async def after() -> None:
            if work:
                await asyncio.gather(*work)
            # The host's own stop and pause need no word back.
            if reason != "host":
                cb = self._o.on_stopped
                if cb is not None:
                    guarded(lambda: cb(reason))

        return asyncio.ensure_future(after())

    # -- sessions -----------------------------------------------------------------------------------

    def _gate(self, gen: _Generation, transport: Any) -> bool:
        admitted = admit_transport(
            transport,
            gen.limit,
            self._o.allow_loopback,
            refuse=gen.retired or self._state != "advertising" or len(self._live) >= self._o.max_sessions,
        )
        if admitted is None:
            return False
        gen.slots[transport] = admitted
        return True

    async def _accept(self, gen: _Generation, reader: Any, writer: Any) -> None:
        admitted = gen.slots.pop(writer.transport, None)
        if admitted is None:  # not admitted by the gate: cannot happen, and closes if it does
            return _abort(writer)
        slot = _Slot(gen, writer, admitted, self._o.handshake_seconds)
        try:
            live = self._make_live(gen, reader, writer, slot)
            if live is None:
                return _abort(writer)
            await live.link.run()
        except asyncio.CancelledError:
            _abort(writer)
            raise
        except Exception:
            _abort(writer)
        finally:
            slot.settle()

    def _make_live(self, gen: _Generation, reader: Any, writer: Any, slot: _Slot) -> Optional[_Live]:
        if gen.retired or self._state != "advertising":
            return None
        key = bytearray(self._random(32))
        ref: List[Optional[_Live]] = [None]
        opts: Dict[str, Any] = {
            "mode": "v",
            "role": "responder",
            "slug": self._src.slug,
            "static_key": bytes(key),
            "admission": gen.limiter,
            "hello": nearby_hello(self._src.slug, self._o.label),
            "mono": self._mono,
        }
        if self._o.ports is not None:
            opts["ports"] = self._o.ports

        def on_event(e: Any) -> None:
            if ref[0] is not None:
                self._event(ref[0], e)

        def on_closed(c: Closed) -> None:
            if ref[0] is not None:
                self._closed(ref[0], c)

        link = SocketLink(
            reader,
            writer,
            opts,
            LinkHandlers(on_closed=on_closed),
            handshake_seconds=self._o.handshake_seconds,
            on_event=on_event,
        )
        flow = link.channel.vouch
        if flow is None:
            _abort(writer)
            return None
        live = _Live(link, slot, key, flow)
        ref[0] = live
        self._live.add(live)
        return live

    def _event(self, live: _Live, e: Any) -> None:
        if isinstance(e, Established):
            live.slot.established()
            # The one-time static key has done its work.
            _wipe(live.key)
            live.hello = e.hello
        elif isinstance(e, Sas):
            live.sas = e.code
            self._queue.append(live)
            self._pump()
        elif isinstance(e, Record):
            self._record(live, e.record_type, e.body)

    def _record(self, live: _Live, type_: int, body: bytes) -> None:
        v = live.flow.receive(VouchRecord(type_, body))
        if not v.ok:
            self._end(live, str(v.close))
            return
        for r in v.deliver:
            if r.type == RECORD["VOUCH_REQ"]:
                self._verify(live, r.body)
            elif 0x8100 <= r.type <= 0xFFFD:
                self._end(live, ErrorCode.PEER_UNKNOWN_CRITICAL)

    def _verify(self, live: _Live, body: bytes) -> None:
        hello = live.hello
        ok: Optional[VouchRequest] = None
        if hello is not None and len(body) <= VOUCH_REQ_MAX:
            try:
                ok = verify_vouch_request(
                    slug=self._src.slug,
                    h=live.link.channel.handshake_hash(),
                    hello=VouchHello(platform=hello.platform, label=hello.label),
                    # ``HELLO`` was cleaned when the session read it; cleaning it again is not idempotent.
                    hello_cleaned=True,
                    body=body,
                )
            except Exception:
                ok = None
        if ok is None:
            _resolve(live.request, "invalid")
            self._end(live, ErrorCode.PEER_BAD_FRAME)
            return
        live.flow.verified()
        _resolve(live.request, ok)

    def _closed(self, live: _Live, c: Closed) -> None:
        if live.dead:
            return
        live.dead = True
        live.closed = c
        _wipe(live.key)
        live.slot.settle()
        for cancel in live.cancels:
            cancel()
        live.cancels = []
        self._live.discard(live)
        self._queue = [x for x in self._queue if x is not live]
        _resolve(live.request, "invalid")
        # A prompt that was shown and ended before the person answered, by anything but this module (the
        # 120 s deadline, the peer closing or the connection dropping), counts (rule 2).
        if live.shown and not live.picked and not live.local:
            self._failure()
        for closer in list(live.closers):
            _call_guarded(closer, c)
        if self._active is live:
            self._active = None
            self._pump()

    def _end(self, live: _Live, code: str) -> None:
        """Close a session with ``code``. The engine sends the CLOSE record and the link finishes at once."""
        if live.dead:
            return
        live.local = True
        try:
            live.link.close_nowait(code)
        except Exception:
            pass

    def _failure(self) -> None:
        """Count one prompted failure; the second in the window stops the advert."""
        if not self._budget.fail():
            return

        async def go() -> None:
            if self._state == "advertising":
                await self._halt("stopped", "budget")

        self._spawn(self._serial(go))

    # -- the prompt, one at a time ------------------------------------------------------------------

    def _pump(self) -> None:
        if self._state != "advertising":
            return
        if not self._prompt:
            for live in self._queue:
                if not live.noticed:
                    live.noticed = True
                    cb = self._o.on_notice
                    if cb is not None:
                        n = ApprovalNotice(
                            live.hello.label if live.hello is not None else None,
                            live.hello.platform if live.hello is not None else "",
                        )
                        _call_guarded(cb, n)
            return
        if self._active is not None:
            return
        nxt = next((x for x in self._queue if not x.shown and not x.dead), None)
        if nxt is None:
            return
        self._active = nxt
        nxt.shown = True
        nxt.flow.code_shown()
        assert nxt.sas is not None
        codes = decoy_codes(nxt.sas, self._random).codes
        approval = NearbyApproval(self, nxt, [sas_display(c) for c in codes])
        try:
            self._handler(approval)
        except Exception:
            self._end(nxt, ErrorCode.PEER_BYE)

    def _release(self, live: _Live) -> None:
        """The prompt is over (a pick, a decline): the next waiting session may show its codes."""
        self._queue = [x for x in self._queue if x is not live]
        if self._active is live:
            self._active = None
        self._pump()

    def _abandon(self, live: _Live, reason: str) -> None:
        """A session ended before the right pick: nothing is delivered and no route is called."""
        v = live.flow.abandon(reason)
        self._release(live)
        if live.dead:
            return
        # ``abandon`` always closes: peer_bye here (timeouts come from the engine).
        self._end(live, ErrorCode.PEER_BYE if v.ok else str(v.close))

    async def _pick(self, live: _Live, code: Any) -> Union[VouchRequest, str]:
        if live.dead:
            raise LanError("closed", "The session is closed.")
        if live.sas is None or live.picked:
            raise LanError("not_picked", "There is no code to pick.")
        if _code_value(code) != live.sas:
            self._failure()
            self._abandon(live, "wrong-pick")
            return "mismatch"
        v = live.flow.picked()
        if not v.ok:
            self._end(live, str(v.close))
            return "invalid"
        live.picked = True
        live.slot.settle()
        # The prompt slot stays with this session until it finishes or closes: the next waiting session
        # shows no code meanwhile. The session stays for records after ``approved``, and no longer than
        # 300 s past the pick.
        live.cancels.append(self._timer(lambda: self._end(live, ErrorCode.PEER_BYE), self._o.keep_open_seconds))
        # The person's pick is M's confirmation; the held ``VOUCH_REQ`` is delivered from here on.
        live.link.channel.confirm_sas()
        if live.dead:
            return "invalid"
        wait = self._timer(lambda: self._end(live, ErrorCode.PEER_TIMEOUT), self._o.request_wait_seconds)
        try:
            return await live.request  # type: ignore[no-any-return]
        finally:
            wait()

    async def _decline(self, live: _Live) -> None:
        if live.dead or live.picked:
            return
        self._failure()
        self._abandon(live, "none-match")

    async def _finish(self, live: _Live, a: ApproveAnswerInput) -> FinishOutcome:
        if live.dead:
            raise LanError("closed", "The session is closed.")
        # No silent approval: the right pick on this session and a verified request, or nothing.
        if not live.flow.may_finish:
            raise LanError("not_picked", "The person has not picked the code on this session.")
        act = finish_map(
            ApproveAnswer(
                http=a.http, body=a.body, discovery_nearby=a.discovery_nearby, keys_retried=live.keys_retried
            )
        )
        if act.send is not None:
            rec = VouchRecord(RECORD["VOUCH_RESULT"], build_vouch_result(act.send))
            v = live.flow.send(rec)
            if not v.ok:
                self._end(live, str(v.close))
                raise LanError("closed", "The session is closed.")
            try:
                live.link.channel.send_record(rec.type, rec.body)
            except Exception:
                raise LanError("closed", "The session is closed.") from None
            # Finished: the next waiting session may show its codes.
            self._release(live)
            if act.send != "approved":
                self._end(live, ErrorCode.PEER_BYE)
            return FinishOutcome(sent=act.send)
        if act.wait is not None:
            if act.wait == "keys":
                live.keys_retried = True
            return FinishOutcome(wait=act.wait)
        self._release(live)
        self._end(live, ErrorCode.PEER_BYE)
        if act.stop_advert:

            async def stop_it() -> None:
                await self._halt("stopped", "discovery")

            self._spawn(self._serial(stop_it))
        return FinishOutcome(closed=True)

    async def _send(self, live: _Live, type_: int, body: bytes) -> None:
        if live.dead:
            raise LanError("closed", "The session is closed.")
        if isinstance(type_, bool) or not isinstance(type_, int) or type_ < 0x0030 or type_ > 0x003F:
            raise LanError("bad_type", "Sync records are 0x0030 to 0x003F.")
        v = live.flow.send(VouchRecord(type_, body))
        if not v.ok:
            self._end(live, str(v.close))
            raise LanError("not_picked", "A record needs an approved vouch.")
        try:
            live.link.channel.send_record(type_, body)
        except ValueError as e:
            if str(e) == "message too large":
                raise LanError("too_large", "The message is larger than D accepts.") from None
            raise LanError("closed", "The session is closed.") from None
        except Exception:
            raise LanError("closed", "The session is closed.") from None


async def _quiet(aw: Awaitable[Any]) -> None:
    try:
        await aw
    except Exception:
        pass


