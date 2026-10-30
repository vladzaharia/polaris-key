"""Nearby approval (CC-15; WIRE-CONTRACT-V5 §15.4, §15.6.1): the approver half (``NearbyApprover``) and the
requester half (``NearbyRequester``, below). Mirrors ``packages/sdk-node/src/connect/nearbyApprover.ts`` and
``nearbyRequester.ts`` as they stand after their red-team fix round.

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

The requester (D, the device with no sign-in) browses for approvers, dials a few, lists them by their
``HELLO`` and lets its person tap one. Only then does the code run on that session; the others close
``peer_bye`` before any code record, so no other approver ever prompts. D shows its code, sends
``VOUCH_REQ`` and reads ``VOUCH_RESULT``. It calls no route: the host holds the request from
``nearby/start`` and polls. Rules it keeps:

- D connects out and never listens; it browses ``_pkeypeer._tcp`` for ``m=v`` with the product tag of the
  current or the previous epoch, judged by the mode-a address rule;
- at most 4 approvers are dialled at once, picked at random and never in arrival order, each with a
  one-time X25519 key that is wiped when the handshake ends; a session that ends before the choice is
  replaced while the request lives (a bounded number of times per advert);
- every session stops after ``HELLO`` (``hold_sas``); the list has at most 8 entries, shows the reported
  label and platform only, and is never chosen from for the person;
- the code on D's screen is D's confirmation, then ``VOUCH_REQ`` goes out;
- ``0x0030`` to ``0x003F`` are held, 16 records and 16 KiB, until the person confirms the signed-in account
  (``confirm_account``, rule 12); a decline or a close drops them all;
- a session held and not chosen for 20 s is closed ``peer_bye`` and replaced, so one approver cannot sit
  on a dial slot;
- one answer per request: once ``VOUCH_RESULT`` said ``approved``, or ``confirm_account()`` ran, no other
  approver is dialled or chosen. ``confirm_account()`` is for the session that was chosen;
- the request and the label are checked when the request starts; ``expires_in`` is at most 300 s;
- the host's callbacks run inside a guard: a throw cannot skip the cleanup that follows;
- the browse and the wait for ``VOUCH_RESULT`` end at ``expires_in`` (300 s), then every session closes
  ``peer_bye``; the request handle, ``sig``, ``h`` and the nonces are in no message.
"""

from __future__ import annotations

import asyncio
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Set, Tuple, Union

from ..connect.dial import dial_race
from ..connect.errors import LanError
from ..connect.lan import Admitted, GatedProtocol, admit_transport, listen_socket
from ..connect.lan_judge import PendingLimiter, text_verdict
from ..constants_generated import ErrorCode
from .device_keys import DeviceKeyPort
from .peer_advert import advert_epoch, parse_txt, product_tag
from .peer_frame import RECORD
from .peer_link import LinkHandlers, SocketLink
from .peer_mdns import MdnsAdapter, MdnsAdvert, MdnsFound, MdnsHandle, MulticastDnsAdapter
from .peer_noise import NoisePorts
from .peer_sas import sas_display
from .peer_session import Closed, Established, HandshakeLimiter, PeerHello, Record, Sas
from .peer_vouch import (
    VOUCH_REQ_MAX,
    ApproveAnswer,
    BuildVouchRequestOptions,
    VouchFailureBudget,
    VouchFlow,
    VouchHello,
    VouchRecord,
    VouchRequest,
    approver_instance,
    build_vouch_request,
    build_vouch_result,
    decoy_codes,
    finish_map,
    parse_vouch_result,
    uniform_below,
    verify_vouch_request,
)

__all__ = [
    "ApprovalNotice",
    "NearbyApproverInfo",
    "NearbyChoice",
    "NearbyRecord",
    "NearbyRequestOptions",
    "NearbyRequester",
    "RequesterSource",
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
            "static_key": key,
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




# -- the requester (D) --------------------------------------------------------------------------------

MAX_DIALS = 4
MAX_LIST = 8
EXPIRES_SECONDS = 300.0
TRIES_PER_ADVERT = 3
REDIAL_SECONDS = 0.25
#: A held session nobody chose is replaced after this long.
IDLE_SECONDS = 20.0
#: ``nearby/start``'s handle (the same pattern the vouch codec checks in a ``VOUCH_REQ``).
_REQUEST_RE = re.compile(r"nr_[A-Za-z0-9_-]{22}\Z")


@dataclass
class RequesterSource:
    """What the requester reads of the client. ``signer`` is a coroutine function: D's device keys (made
    when none exist) and its ``X-PKey-Device`` value; ``now`` is epoch seconds."""

    slug: str
    now: Callable[[], int]
    signer: Callable[[], Awaitable[Tuple[DeviceKeyPort, str]]]


@dataclass
class NearbyRequestOptions:
    """``request`` is the handle from ``nearby/start`` (``nr_...``). ``label`` is this device's label in
    ``HELLO`` and ``VOUCH_REQ`` (display data; optional; a string of at most 256 characters): it is shown on
    the approving device, so name the device, and never use an account identifier (an email address, a user
    id) as the label. ``expires_in`` is the seconds the request lives (default and most 300, from
    ``nearby/start``'s ``expiresIn``). ``close()`` ends the request."""

    request: str = field(repr=False)
    label: Optional[str] = None
    expires_in: Optional[float] = None
    mdns: Optional[MdnsAdapter] = None
    allow_loopback: bool = False
    handshake_seconds: float = HANDSHAKE_SECONDS
    timer: Optional[_Timer] = None
    random: Optional[_Random] = None
    #: Monotonic seconds for the sessions' deadlines.
    mono: Optional[Callable[[], float]] = None
    #: The session engine's randomness (SAS nonces, ephemeral keys); a test's seam.
    ports: Optional[NoisePorts] = None


@dataclass(frozen=True)
class NearbyApproverInfo:
    """One approver in the list. Unauthenticated display data: any device on the LAN can be listed."""

    id: str
    label: Optional[str]
    platform: str


@dataclass(frozen=True)
class NearbyRecord:
    #: A Sync record type, ``0x0030`` to ``0x003F``.
    type: int
    body: bytes = field(repr=False)


class NearbyChoice(NamedTuple):
    """What ``choose`` answers: D's code to show, like ``123 456``."""

    code: str


@dataclass
class _Candidate:
    instance: str
    hosts: List[str]
    port: int
    tries: int


class _Entry:
    def __init__(self, id_: str, instance: str, link: SocketLink, key: bytearray) -> None:
        self.id = id_
        self.instance = instance
        self.link = link
        self.key = key
        self.hello: Optional[PeerHello] = None
        self.code: Optional[int] = None
        self.code_wait: Optional["asyncio.Future[int]"] = None
        self.closed = False
        #: Cancels the idle clock.
        self.idle: Optional[Callable[[], None]] = None


class NearbyRequester:
    """The browse, the dials and the one chosen session of one nearby request. Its methods are
    coroutines (or plain calls) for the Connect loop; ``client.cloud_connect.nearby`` hands the host
    blocking forms of them."""

    def __init__(self, src: RequesterSource, o: NearbyRequestOptions) -> None:
        self._src = src
        self._o = o
        self._loop = asyncio.get_running_loop()
        self._random: _Random = o.random or os.urandom
        self._timer: _Timer = o.timer or _default_timer
        self._mdns: MdnsAdapter = o.mdns or MulticastDnsAdapter(allow_loopback=o.allow_loopback)
        self._candidates: Dict[str, _Candidate] = {}
        self._entries: Dict[str, _Entry] = {}
        #: Instances with a dial or a session in flight.
        self._active: Set[str] = set()
        self._browse: Optional[MdnsHandle] = None
        self._chosen: Optional[_Entry] = None
        self._flow: Optional[VouchFlow[Any]] = None
        self._result: Optional[str] = None
        self._ended = False
        #: ``approved`` came, or the account was confirmed: this request has its answer.
        self._answered = False
        self._cancels: List[Callable[[], None]] = []
        self._signer: Optional[Tuple[DeviceKeyPort, str]] = None
        self._tasks: Set["asyncio.Future[Any]"] = set()
        self._on_approvers: List[Callable[[List[NearbyApproverInfo]], None]] = []
        self._on_result: List[Callable[[str], None]] = []
        self._on_record: List[Callable[[NearbyRecord], None]] = []
        self._on_close: List[Callable[[str], None]] = []

    def __repr__(self) -> str:
        return "<NearbyRequest>"

    def __reduce__(self) -> Any:
        raise TypeError("a nearby request cannot be pickled")

    @classmethod
    async def start(cls, src: RequesterSource, o: NearbyRequestOptions) -> "NearbyRequester":
        """Start browsing and dialling. The caller holds the request from ``nearby/start``."""
        expires_in = cls._checked(o)
        r = cls(src, o)
        r._signer = await src.signer()
        r._cancels.append(r._timer(r._expire, expires_in))
        try:
            r._browse = await r._mdns.browse(r._found_safe, r._gone, lambda _instance: True)
        except BaseException:
            await r.close()
            raise
        return r

    @staticmethod
    def _checked(o: NearbyRequestOptions) -> float:
        """The request and the label are the host's input: refuse a bad one now, not at the tap."""
        if not isinstance(o.request, str) or _REQUEST_RE.match(o.request) is None:
            raise LanError("bad_input", "The request handle is not valid.")
        if o.label is not None and (not isinstance(o.label, str) or len(o.label) > LABEL_MAX):
            raise LanError("bad_input", "The label is not valid.")
        n = EXPIRES_SECONDS if o.expires_in is None else o.expires_in
        if isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) or n <= 0:
            raise LanError("bad_input", "expires_in must be above 0.")
        return float(min(n, EXPIRES_SECONDS))

    @staticmethod
    def _each(fns: List[Callable[[Any], Any]], value: Any) -> None:
        """Call every listener inside a guard."""
        for f in list(fns):
            _call_guarded(f, value)

    @property
    def approvers(self) -> List[NearbyApproverInfo]:
        """The approvers that said ``HELLO``, at most 8; empty once the person chose."""
        if self._chosen is not None:
            return []
        out = [
            NearbyApproverInfo(
                e.id,
                e.hello.label if e.hello is not None else None,
                e.hello.platform if e.hello is not None else "",
            )
            for e in self._entries.values()
            if e.hello is not None and not e.closed
        ]
        return out[:MAX_LIST]

    @property
    def result(self) -> Optional[str]:
        """What ``VOUCH_RESULT`` said. For display only: the host's poll is the authority."""
        return self._result

    @property
    def closed(self) -> bool:
        return self._ended

    def _sub(self, fns: List[Any], fn: Any) -> Callable[[], None]:
        fns.append(fn)

        def off() -> None:
            if fn in fns:
                fns.remove(fn)

        return off

    def on_approvers(self, fn: Callable[[List[NearbyApproverInfo]], None]) -> Callable[[], None]:
        return self._sub(self._on_approvers, fn)

    def on_result(self, fn: Callable[[str], None]) -> Callable[[], None]:
        return self._sub(self._on_result, fn)

    def on_record(self, fn: Callable[[NearbyRecord], None]) -> Callable[[], None]:
        """Sync records, once the person confirmed the account."""
        return self._sub(self._on_record, fn)

    def on_close(self, fn: Callable[[str], None]) -> Callable[[], None]:
        """The chosen session ended (or the request expired); with why."""
        return self._sub(self._on_close, fn)

    # -- browse and dial ----------------------------------------------------------------------------

    def _found_safe(self, f: MdnsFound) -> None:
        try:
            self._found(f)
        except Exception:
            pass

    def _found(self, f: MdnsFound) -> None:
        if self._ended or self._answered or self._chosen is not None:
            return
        txt = parse_txt(f.txt)
        if not txt["ok"] or txt["mode"] != "v":
            return
        # The product tag of this epoch or the last: an advert of another product is not ours.
        epoch = advert_epoch(self._src.now())
        tags = [product_tag(self._src.slug, e) for e in (epoch, epoch - 1)]
        if txt.get("h") not in tags:
            return
        hosts = [h for h in (f.hosts or (f.host,)) if text_verdict(h, self._o.allow_loopback)]
        if not hosts:
            return
        had = self._candidates.get(f.instance)
        self._candidates[f.instance] = _Candidate(f.instance, hosts, f.port, had.tries if had is not None else 0)
        self._pump()

    def _gone(self, instance: str) -> None:
        self._candidates.pop(instance, None)

    def _spawn(self, coro: Awaitable[Any]) -> "asyncio.Future[Any]":
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        t.add_done_callback(lambda f: f.cancelled() or f.exception())
        return t

    def _pump(self) -> None:
        """Dial candidates at random until 4 are in flight."""
        while (
            not self._ended
            and not self._answered
            and self._chosen is None
            and len(self._active) < MAX_DIALS
        ):
            free = [
                c for c in self._candidates.values() if c.instance not in self._active and c.tries < TRIES_PER_ADVERT
            ]
            if not free:
                return
            c = free[uniform_below(len(free), self._random)]
            c.tries += 1
            self._active.add(c.instance)
            self._spawn(self._dial(c))

    async def _dial(self, c: _Candidate) -> None:
        try:
            sock, _host = await dial_race(c.hosts, c.port, self._o.allow_loopback)
            reader, writer = await asyncio.open_connection(sock=sock)
        except (OSError, asyncio.TimeoutError):
            self._active.discard(c.instance)
            self._later()
            return
        if self._ended or self._answered or self._chosen is not None:
            _abort(writer)
            self._active.discard(c.instance)
            return
        key = bytearray(self._random(32))
        entry_id = "ap_" + self._random(6).hex()
        ref: List[Optional[_Entry]] = [None]
        opts: Dict[str, Any] = {
            "mode": "v",
            "role": "initiator",
            "slug": self._src.slug,
            "static_key": key,
            "hold_sas": True,
            "hello": nearby_hello(self._src.slug, self._o.label),
        }
        if self._o.mono is not None:
            opts["mono"] = self._o.mono
        if self._o.ports is not None:
            opts["ports"] = self._o.ports

        def on_event(e: Any) -> None:
            if ref[0] is not None:
                self._event(ref[0], e)

        def on_closed(cl: Closed) -> None:
            if ref[0] is not None:
                self._ended_(ref[0], cl)

        link = SocketLink(
            reader,
            writer,
            opts,
            LinkHandlers(on_closed=on_closed),
            handshake_seconds=self._o.handshake_seconds,
            on_event=on_event,
        )
        e = _Entry(entry_id, c.instance, link, key)
        ref[0] = e
        self._entries[entry_id] = e
        self._spawn(link.run())
        link.start()

    def _later(self) -> None:
        """A short pause before a replacement dial, so a refusing approver is not hammered."""
        self._cancels.append(self._timer(self._pump, REDIAL_SECONDS))

    def _list(self) -> None:
        self._each(self._on_approvers, self.approvers)  # type: ignore[arg-type]

    # -- a session's events -------------------------------------------------------------------------

    def _event(self, e: _Entry, ev: Any) -> None:
        if isinstance(ev, Established):
            # The one-time static key has done its work.
            _wipe(e.key)
            e.hello = ev.hello
            # Held and not chosen for 20 s: replaced, so one approver cannot sit on a dial slot.
            e.idle = self._timer(lambda: self._replace(e), IDLE_SECONDS)
            self._list()
        elif isinstance(ev, Sas):
            e.code = ev.code
            w, e.code_wait = e.code_wait, None
            if w is not None and not w.done():
                w.set_result(ev.code)
        elif isinstance(ev, Record):
            if e is self._chosen:
                self._record(ev.record_type, ev.body)

    def _replace(self, e: _Entry) -> None:
        e.idle = None
        if e is self._chosen or e.closed or self._ended:
            return
        # The advert gets its try back: this is not a failure of the approver.
        c = self._candidates.get(e.instance)
        if c is not None and c.tries > 0:
            c.tries -= 1
        e.link.close_nowait(ErrorCode.PEER_BYE)

    def _record(self, type_: int, body: bytes) -> None:
        flow = self._flow
        if flow is None:
            return
        v = flow.receive(VouchRecord(type_, body))
        if not v.ok:
            if self._chosen is not None:
                self._chosen.link.close_nowait(str(v.close))
            return
        for r in v.deliver:
            self._deliver(r)

    def _deliver(self, r: Any) -> None:
        if r.type == RECORD["VOUCH_RESULT"]:
            # Display only: an unknown status reads as ``denied`` (rule 6).
            got = parse_vouch_result(r.body)
            if got.refuse is not None or got.status is None:
                return
            self._result = got.status
            if got.status == "approved":
                self._answered = True
            self._each(self._on_result, got.status)
        elif 0x0030 <= r.type <= 0x003F:
            self._each(self._on_record, NearbyRecord(r.type, r.body))

    def _ended_(self, e: _Entry, c: Closed) -> None:
        if e.closed:
            return
        e.closed = True
        if e.idle is not None:
            e.idle()
            e.idle = None
        _wipe(e.key)
        self._entries.pop(e.id, None)
        self._active.discard(e.instance)
        w, e.code_wait = e.code_wait, None
        if w is not None and not w.done():
            w.set_exception(LanError("closed", "The session is closed."))
        if e is self._chosen:
            # The chosen session is over. Without an answer the request goes on: the person may choose
            # again from a fresh list.
            self._chosen = None
            self._flow = None
            if not self._ended:
                self._each(self._on_close, c.code)
                if self._result is None and not self._answered:
                    self._later()
        else:
            self._list()
            if not self._ended and not self._answered:
                self._later()

    # -- the person's choices -----------------------------------------------------------------------

    async def choose(self, id_: str) -> NearbyChoice:
        """The person tapped this approver. Starts the code on that session only and closes the others
        ``peer_bye``; answers D's code to show, and sends ``VOUCH_REQ`` once it is shown."""
        if self._ended:
            raise LanError("closed", "The request is closed.")
        if self._answered:
            raise LanError("closed", "The request has its answer.")
        if self._chosen is not None:
            raise LanError("not_started", "An approver is already chosen.")
        e = self._entries.get(id_)
        if e is None or e.hello is None or e.closed:
            raise LanError("unknown_peer", "That approver is no longer on the list.")
        signer = self._signer
        if signer is None:
            raise LanError("not_started", "Not started.")
        flow = e.link.channel.vouch
        if flow is None:
            raise LanError("closed", "The session is closed.")
        self._chosen = e
        if e.idle is not None:
            e.idle()
            e.idle = None
        self._flow = flow
        # The others close before any code record is sent on them: no other approver ever prompts.
        for o in list(self._entries.values()):
            if o is not e:
                o.link.close_nowait(ErrorCode.PEER_BYE)
        self._list()
        if e.code is not None:
            wait: "asyncio.Future[int]" = self._loop.create_future()
            wait.set_result(e.code)
        else:
            wait = self._loop.create_future()
            e.code_wait = wait
        e.link.channel.start_sas()
        code = await wait
        # Showing the code is D's confirmation; then the request goes to the chosen approver.
        flow.code_shown()
        e.link.channel.confirm_sas()
        port, device_id = signer
        body = build_vouch_request(
            BuildVouchRequestOptions(
                port=port,
                slug=self._src.slug,
                h=e.link.channel.handshake_hash(),
                request=self._o.request,
                device_id=device_id,
                hello=VouchHello(label=self._o.label, platform=sys.platform),
            )
        )
        v = flow.send(VouchRecord(RECORD["VOUCH_REQ"], body))
        if not v.ok:
            e.link.close_nowait(str(v.close))
            raise LanError("closed", "The session is closed.")
        try:
            e.link.channel.send_record(RECORD["VOUCH_REQ"], body)
        except Exception:
            raise LanError("closed", "The session is closed.") from None
        return NearbyChoice(sas_display(code))

    async def confirm_account(self) -> None:
        """The person confirmed that the signed-in account is theirs: held records go to ``on_record``. It
        counts for the session that was chosen and answered ``approved``; it is not a standing consent, and
        after it (or after ``approved``) no other approver can be chosen."""
        flow = self._flow
        if flow is None:
            raise LanError("not_started", "Nobody is chosen.")
        self._answered = True
        v = flow.confirm_account()
        if not v.ok:
            if self._chosen is not None:
                self._chosen.link.close_nowait(str(v.close))
            return
        for r in v.deliver:
            self._deliver(r)

    async def decline_account(self) -> None:
        """The person declined, or the screen timed out: every held record is dropped and the session
        closes."""
        flow = self._flow
        if flow is None:
            return
        v = flow.decline_account()
        if self._chosen is not None:
            self._chosen.link.close_nowait(ErrorCode.PEER_BYE if v.ok else str(v.close))

    # -- the end ------------------------------------------------------------------------------------

    def _expire(self) -> None:
        self._stop("expired")

    def close(self) -> "asyncio.Future[None]":
        """End the request: the browse stops and every session closes ``peer_bye``. The sessions are down
        when this returns; the result completes when the browse is withdrawn."""
        return self._stop(None)

    def destroy(self) -> None:
        """Drop every socket now, with no goodbye (the sign-out bound's force path)."""
        fut = self._stop(None)
        fut.add_done_callback(lambda f: f.cancelled() or f.exception())
        for e in list(self._entries.values()):
            e.link.destroy()
        for t in list(self._tasks):
            t.cancel()

    def _stop(self, why: Optional[str]) -> "asyncio.Future[None]":
        if self._ended:
            done: "asyncio.Future[None]" = self._loop.create_future()
            done.set_result(None)
            return done
        chosen = self._chosen is not None
        self._ended = True
        for c in self._cancels:
            c()
        self._cancels = []
        if why is not None or chosen:
            self._each(self._on_close, why or ErrorCode.PEER_BYE)
        browse, self._browse = self._browse, None
        # The sessions close before the browse is awaited: a browse that hangs cannot hold them up.
        for e in list(self._entries.values()):
            e.link.close_nowait(ErrorCode.PEER_BYE)
        return asyncio.ensure_future(_quiet(browse.stop())) if browse is not None else _resolved(self._loop)


def _resolved(loop: "asyncio.AbstractEventLoop") -> "asyncio.Future[None]":
    f: "asyncio.Future[None]" = loop.create_future()
    f.set_result(None)
    return f
