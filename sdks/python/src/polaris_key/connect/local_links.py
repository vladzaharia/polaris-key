"""Pairing with a code, with no account, ``client.cloud_connect.local_links`` (CC-29.9; WIRE-CONTRACT-V5 §15.12):
two devices of one app on one LAN pair by an 8-digit code or a QR. One device shows (``pair``, the responder:
:class:`~polaris_key.connect.local_pairing.LocalShower`), the other types or scans (``join``, the initiator:
:class:`~polaris_key.connect.local_pairing.LocalJoiner`). CPace turns the code into a key, mode ``q`` runs Noise
over it, both people confirm, and each side stores a link in ``pkey.connect.local.v1`` (:mod:`.local_state`).
Mirrors ``packages/sdk-node/src/connect/localLinks.ts``.

Nothing here needs a signed-in device: no identity, no K_disc, no certificate. Pairing needs no ``start()``
either; the later sessions (mode ``l``) ride the LAN service ``cloud_connect.start()`` runs, which with no
account serves local links alone (§15.5, §15.12 "Mode l")::

    list()               the links this device holds
    rename(id, label)    change the label on this device only; it is never sent
    remove(id)           forget a link: its keys and secret go, open sessions hear ``peer_revoked``
    set_reachable(id, b) advertise the link's ``m=l`` name on the LAN (at most 8), or stop
    open(id)             a session to the peer, found by its advert on the LAN (no relay)
    on_link(fn)          called with each session a local link opened to this device
    on_change(fn)        called after the links or the gate changed: read ``list()`` and ``local_pairing()`` again
    dials_left(text)     the dials a join of the code typed so far may still make: 2, 1, 0 or ``None``

Rules this module keeps:

- ``pair``, ``join`` and every accept and dial need the cached discovery answer ``localPairing: true`` (§15.12
  "Gates"); without it they raise the typed N/A ``local-pairing-off``, and a read that clears it closes the
  window and every join;
- one window per device and product (the slot is taken before the first await), and a device that holds
  ``MAX_LOCAL_LINKS`` answers ``local-links-full`` before anything is advertised or dialled;
- ``open``, the ``m=l`` adverts and the mode-``l`` answer need the same cached answer; a read that clears it
  withdraws the adverts and ends the open sessions with ``peer_bye``, and the links stay on disk, inert. Managing
  links (``list``, ``rename``, ``remove``, ``set_reachable``, ``on_change``) is never gated, with the gate off and
  with no cached document;
- the joiner's dials are counted per typed nameplate across joins, in memory, for the whole process; so are the
  nameplates the shower's windows closed with in the last 300 s (a renewed window skips them) and the renewal
  floor (30 s after a window ended ``too-many-tries``, or after a second wrong-code window in 10 minutes);
- ``open`` makes one dial per link at a time, and a dial that reached the network and failed holds the next one
  off for 3 to 5 s, doubled for each failure in a row up to 60 s.
"""

from __future__ import annotations

import random
import threading
import time
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, List, Mapping, Optional, Set, Tuple

from ..core.b64url import b64url_decode
from ..core.peer_display import clean_label
from ..core.peer_local import (
    MAX_LIVE_LOCAL_ADVERTS,
    MAX_LOCAL_LINKS,
    DialBudget,
    NameplateMemory,
    RenewFloor,
    dials_left,
)
from .errors import LanError
from .local_common import LocalPaired, cancelled, check_options, cooldown, full, off, reachable_full
from .local_state import LocalLinkInfo, LocalLinkRow, info_of_local, local_tag

if TYPE_CHECKING:  # the pairing window imports asyncio and sockets: only when it is opened
    import asyncio

    from .client import ConnectClient
    from .cloud_connect import CloudConnect
    from .lan import LanService
    from .local_pairing import LocalJoiner, LocalPairHandle, LocalShower
    from .session import ConnectSession

__all__ = ["LocalLinks", "reset_local_budgets"]

#: A dial to one link is not repeated sooner than this (seconds): a base, with jitter, doubled after each failure
#: up to the cap.
DIAL_COOLDOWN_S = 3.0
DIAL_COOLDOWN_JITTER_S = 2.0
DIAL_BACKOFF_CAP_S = 60.0

#: The joiner's dial budgets, one per product for the whole process: an app that makes a new client per screen or
#: per retry meets the same budget, so retries cannot multiply a fake advert's guesses. In memory only (a restart
#: resets it, as §15.12 allows).
_BUDGETS: Dict[str, DialBudget] = {}
_BUDGETS_LOCK = threading.Lock()


def _budget_of(slug: str) -> DialBudget:
    with _BUDGETS_LOCK:
        b = _BUDGETS.get(slug)
        if b is None:
            _BUDGETS[slug] = b = DialBudget()
        return b


#: The nameplates the shower's windows of a product closed with, one memory per product for the whole process, like
#: the dial budgets: a window that closes and the next one that opens, even through a new client, never share a
#: nameplate within 300 s.
_NAMEPLATES: Dict[str, NameplateMemory] = {}

#: The renewal floors, one per product for the whole process, like the dial budgets: a host that renews from
#: ``on_end`` meets the same floor through a new client.
_FLOORS: Dict[str, RenewFloor] = {}


def _memory_of(slug: str) -> NameplateMemory:
    with _BUDGETS_LOCK:
        m = _NAMEPLATES.get(slug)
        if m is None:
            _NAMEPLATES[slug] = m = NameplateMemory()
        return m


def _floor_of(slug: str) -> RenewFloor:
    with _BUDGETS_LOCK:
        f = _FLOORS.get(slug)
        if f is None:
            _FLOORS[slug] = f = RenewFloor()
        return f


def reset_local_budgets() -> None:
    """Forget every dial budget, remembered nameplate and renewal floor. For tests."""
    with _BUDGETS_LOCK:
        _BUDGETS.clear()
        _NAMEPLATES.clear()
        _FLOORS.clear()


#: How often a join looks at the host's ``cancel`` event (seconds): a cancel is heard within 250 ms.
CANCEL_POLL_S = 0.05


async def _watch(stop: "threading.Event", handle: "_JoinHandle") -> None:
    """Cancel the join once the host sets its event."""
    import asyncio

    while not stop.is_set():
        await asyncio.sleep(CANCEL_POLL_S)
    handle.cancel("cancelled")


class _JoinHandle:
    def __init__(self) -> None:
        #: ``cancelled`` (the host's ``cancel`` event) or ``closed`` (the gate went off); the first one wins.
        self.stopped: Optional[str] = None
        self.joiner: Optional[LocalJoiner] = None

    def cancel(self, why: str = "closed") -> None:
        if self.stopped is None:
            self.stopped = why
        if self.joiner is not None:
            self.joiner.cancel(why)


class LocalLinks:
    """``client.cloud_connect.local_links``."""

    def __init__(
        self,
        cloud: "CloudConnect",
        connect: "ConnectClient",
        *,
        mono: Optional[Callable[[], float]] = None,
        rand: Optional[Callable[[], float]] = None,
    ) -> None:
        self._cloud = cloud
        self._connect = connect
        # A client without local links (a test's stand-in) holds none.
        self._real = hasattr(connect, "local_source")
        self._source: Any = None
        self._lock = threading.RLock()
        self._mono = mono or time.monotonic
        self._rand = rand or random.random
        self._lan: Optional["LanService"] = None
        self._unsub: List[Callable[[], None]] = []
        self._sessions: "Set[ConnectSession]" = set()
        self._on_link: "List[Callable[[ConnectSession], None]]" = []
        self._shower: Optional[LocalShower] = None
        #: The window that is being opened: the slot is taken before the first await.
        self._starting: "Optional[asyncio.Future[None]]" = None
        #: Bumped by ``close_all``: a window that began opening before it must not outlive it.
        self._epoch = 0
        self._joins: Set[_JoinHandle] = set()
        #: One dial per link at a time: a second ``open`` for the same link joins it.
        self._dials: "Dict[str, asyncio.Future[ConnectSession]]" = {}
        #: Per link: no dial before ``until`` (monotonic seconds), and the failures in a row.
        self._cool: Dict[str, Tuple[float, int]] = {}
        # The gate moved or a link was forgotten: sessions that no longer have a footing end.
        if self._real:
            connect.on_locals_changed(self._changed)

    def __repr__(self) -> str:
        return "<LocalLinks>"

    def __reduce__(self) -> Any:
        raise TypeError("local links cannot be pickled")

    @property
    def _src(self) -> Any:
        if self._source is None:
            self._source = self._connect.local_source()
        return self._source

    @property
    def _budget(self) -> DialBudget:
        return _budget_of(self._src.slug)

    @property
    def _memory(self) -> NameplateMemory:
        return _memory_of(self._src.slug)

    @property
    def _floor(self) -> RenewFloor:
        return _floor_of(self._src.slug)

    def local_pairing(self) -> bool:
        """The cached discovery answer ``services.connect.localPairing`` (§15.9, §15.12). False before
        discovery."""
        return self._src.allowed()

    def _require_on(self, what: str) -> None:
        if not self._src.allowed():
            raise off("Pairing with a code is off for this product (%s)." % what)

    # -- the API --------------------------------------------------------------------------------------

    def on_change(self, fn: Callable[[], None]) -> Callable[[], None]:
        """Called after the links or the gate changed: a pairing was stored, a link was renamed, forgotten,
        re-marked or seen, or the ``local_pairing`` answer flipped. It carries no data: read :meth:`list` and
        :meth:`local_pairing` again. Runs on the thread that made the change. Returns the unsubscribe. Never
        gated."""
        return self._src.on_view(fn)  # type: ignore[no-any-return]

    def dials_left(self, text: str) -> Optional[int]:
        """How many dials a join of the code typed so far may still make: 2, 1 or 0, from the first two digits
        alone; ``None`` until the text (spaces and hyphens ignored) starts with two digits. It reads those two
        digits, keeps nothing and spends nothing."""
        if not isinstance(text, str):
            return None
        return dials_left(self._budget, text, self._mono())

    def list(self) -> List[LocalLinkInfo]:
        """The local links this device holds. Listing is not gated."""
        return info_of_local(self._src.store.rows()) if self._real else []

    def pair(self, options: Optional[Mapping[str, Any]] = None, **kw: Any) -> "LocalPairHandle":
        """Show a code and a QR and wait for the other device (the responder). Options (a mapping, or keyword
        arguments): ``categories`` (at most 8 distinct ``a-z 0-9 -`` strings, the ones this app asks both
        people to approve), ``on_code`` (called with each :class:`~polaris_key.connect.local_common.LocalCode`:
        the window's code, and the new one after every failed guess), ``on_confirm`` (called with the
        :class:`~polaris_key.connect.local_pairing.LocalOffer` once a device reaches the consent: show it, then
        ``confirm()`` or ``decline()``), ``label``, ``on_linked``, ``on_failed``, ``seconds`` (at most 300),
        ``on_interrupted`` (called with how many connections were closed without counting a guess since the code
        last changed, at most once a second) and ``on_end`` (called once with a
        :class:`~polaris_key.connect.local_common.LocalPairEnd` when the window ends, after its advert and
        listener are gone: ``expired``, ``too-many-tries``, ``stored``, ``person`` or ``off``; a window
        ``renew()`` replaces ends with no call). Raises the typed N/A ``local-pairing-off`` while the gate is off,
        :class:`~polaris_key.connect.local_common.LocalPairingError` ``local-links-full`` (``cap`` ``stored``) at
        the cap and ``peer-closed`` (reason ``cooldown``) inside the renewal floor, and :class:`LanError`
        ``bad_input`` for options that break a rule or when this product already has a window open. The handle
        closes the window (``stop()``) and makes the next one (``renew()``); the window also closes by itself
        after ``seconds``, after the fifth failed guess, once a link is made and when the gate goes off.
        Callbacks run on the Connect thread."""
        o: Dict[str, Any] = {**(dict(options) if options else {}), **kw}
        self._require_on("pair")
        check_options(o)
        if not callable(o.get("on_code")):
            raise LanError("bad_input", "on_code is required.")
        sec = o.get("seconds")
        if sec is not None and (isinstance(sec, bool) or not isinstance(sec, (int, float)) or not sec > 0):
            raise LanError("bad_input", "seconds must be above 0.")
        return self._cloud._run(self._pair(o))  # type: ignore[no-any-return]

    async def _pair(self, o: Dict[str, Any]) -> "LocalPairHandle":
        from .local_pairing import LocalPairHandle

        first = await self._window(o, None)
        first.reveal()

        def again(cur: "LocalShower") -> "Awaitable[LocalShower]":
            return self._window(o, cur)

        return LocalPairHandle(first, again, self._cloud._run)

    async def _window(self, o: Dict[str, Any], replacing: "Optional[LocalShower]") -> "LocalShower":
        """Open a window; ``replacing`` is the one a renewal closes first (it makes no ``on_end``). The slot is
        taken before the first await and kept across the replacement."""
        import asyncio

        from .local_pairing import LocalShower

        loop = asyncio.get_running_loop()
        self._require_on("pair")
        if (self._shower is not None and self._shower.open and self._shower is not replacing) or (
            self._starting is not None
        ):
            raise LanError("bad_input", "A pairing window is already open.")
        start: "asyncio.Future[None]" = loop.create_future()
        self._starting = start
        epoch = self._epoch
        try:
            if await loop.run_in_executor(None, self._src.store.count) >= MAX_LOCAL_LINKS:
                raise full()
            if replacing is not None:
                try:
                    await replacing.close(None)
                except Exception:
                    pass
            # The SDK's floor under new windows (after a hard end, 30 s), checked once the window a renewal
            # replaces has ended and been counted.
            floor = self._floor.check((o.get("mono") or time.monotonic)())
            if not floor["allowed"]:
                raise cooldown(floor["retryIn"])
            box: List[Optional[LocalShower]] = [None]

            def closed(end: Optional[str], t: float) -> None:
                if box[0] is not None and self._shower is box[0]:
                    self._shower = None
                if end is not None:
                    self._floor.ended(end, t)

            mine = await LocalShower.start(self._src, o, self._memory, closed)
            box[0] = mine
            self._shower = mine
            # The gate was cleared while the window was opening: it closes before anyone sees a code.
            if epoch != self._epoch or not self._src.allowed():
                await mine.close("off")
                raise off("Pairing with a code was turned off (pair).")
            return mine
        finally:
            if self._starting is start:
                self._starting = None
            if not start.done():
                start.set_result(None)

    def join(self, options: Optional[Mapping[str, Any]] = None, **kw: Any) -> LocalPaired:
        """Type or scan the other device's code (the initiator). Options: ``code`` (the 8 digits typed, spaces
        and hyphens ignored) or ``qr`` (the text of the QR; exactly one of the two), ``categories``,
        ``on_confirm`` (as for ``pair``), ``label``, ``browse_seconds`` (at most 15) and ``cancel`` (a
        :class:`threading.Event`: set it to cancel the join, which reacts within 250 ms; no dial is refunded).
        Blocks until both people confirmed and both devices stored the link, and returns it. Raises a
        :class:`~polaris_key.connect.local_common.LocalPairingError`: ``pairing-code-failed`` (``reason``
        ``invalid``: the code did not parse; ``other-app``: the QR was not this app's; ``spent``: the dial budget
        for this code is spent; ``wrong``: an attempt failed after the other device answered),
        ``pairing-not-found`` (no matching advert in 15 s, or every attempt ended before an answer) and
        ``peer-closed`` (``reason`` ``declined``, ``timeout``, ``closed`` or ``cancelled``); the typed N/A
        ``local-pairing-off`` and ``local-links-full`` (``cap`` ``stored``) are raised before anything is
        browsed."""
        o: Dict[str, Any] = {**(dict(options) if options else {}), **kw}
        self._require_on("join")
        check_options(o)
        if (o.get("code") is None) == (o.get("qr") is None):
            raise LanError("bad_input", "Give exactly one of code and qr.")
        bs = o.get("browse_seconds")
        if bs is not None and (isinstance(bs, bool) or not isinstance(bs, (int, float)) or not bs > 0):
            raise LanError("bad_input", "browse_seconds must be above 0.")
        stop = o.get("cancel")
        if stop is not None and not isinstance(stop, threading.Event):
            raise LanError("bad_input", "cancel must be a threading.Event.")
        if stop is not None and stop.is_set():
            raise cancelled()
        return self._cloud._run(self._join(o))  # type: ignore[no-any-return]

    async def _join(self, o: Dict[str, Any]) -> LocalPaired:
        import asyncio

        from .local_pairing import LocalJoiner

        loop = asyncio.get_running_loop()
        # Registered before the first await, so a gate-clearing read or a cancel can stop it.
        handle = _JoinHandle()
        self._joins.add(handle)
        stop: Optional[threading.Event] = o.get("cancel")
        watch = loop.create_task(_watch(stop, handle)) if stop is not None else None
        try:
            if await loop.run_in_executor(None, self._src.store.count) >= MAX_LOCAL_LINKS:
                raise full()
            if handle.stopped == "cancelled":
                raise cancelled()
            if handle.stopped is not None or not self._src.allowed():
                raise off("Pairing with a code was turned off (join).")
            j = LocalJoiner(self._src, self._budget, o)
            handle.joiner = j
            return await j.run()
        finally:
            if watch is not None:
                watch.cancel()
            self._joins.discard(handle)

    def rename(self, id: str, label: str) -> bool:  # noqa: A002 - mirrors Node
        """Change a link's label on this device only; it is never sent. False when ``id`` names no link. Raises
        :class:`LanError` ``bad_input`` for a label that is empty once cleaned or longer than 64."""
        clean = clean_label(label) if isinstance(label, str) and len(label) <= 64 else None
        if clean is None:
            raise LanError("bad_input", "The label is not valid.")
        import dataclasses

        return self._change(id, lambda r, _rows: dataclasses.replace(r, label=clean))

    def set_reachable(self, id: str, reachable: bool) -> bool:  # noqa: A002
        """Advertise a link's ``m=l`` name on the LAN (at most 8 at once), or stop. False when ``id`` names no
        link. A new link is reachable already; turning a ninth on raises ``local-links-full``. The adverts run
        while ``cloud_connect.start()`` does and the gate is on."""
        if not isinstance(reachable, bool):
            raise LanError("bad_input", "reachable must be a boolean.")
        import dataclasses

        refused = [False]

        def f(r: LocalLinkRow, rows: List[LocalLinkRow]) -> LocalLinkRow:
            # At most ``MAX_LIVE_LOCAL_ADVERTS`` links are advertised: a ninth is refused, not left silently
            # unadvertised (§15.12, "Reachable by default").
            if reachable and not r.reachable and sum(1 for x in rows if x.reachable) >= MAX_LIVE_LOCAL_ADVERTS:
                refused[0] = True
                return r
            return dataclasses.replace(r, reachable=reachable)

        found = self._change(id, f)
        if refused[0]:
            raise reachable_full()
        return found

    def _change(self, id: str, f: Callable[[LocalLinkRow, List[LocalLinkRow]], LocalLinkRow]) -> bool:  # noqa: A002
        found = [False]

        def fn(rows: List[LocalLinkRow]) -> Optional[List[LocalLinkRow]]:
            found[0] = any(r.id == id for r in rows)
            return [f(r, rows) if r.id == id else r for r in rows] if found[0] else None

        self._src.store.update(fn)
        if found[0]:
            self._src.notify()
        return found[0]

    def remove(self, id: str) -> bool:  # noqa: A002
        """Forget a link: its keys and secret leave the record before this returns, an open session under it is
        closed ``peer_revoked``, a handshake in progress under it is closed before the host sees it, and the
        partial files kept for its peer are deleted. False when ``id`` names no link."""
        gone: List[bytes] = []

        def fn(rows: List[LocalLinkRow]) -> Optional[List[LocalLinkRow]]:
            hit = next((r for r in rows if r.id == id), None)
            if hit is None:
                return None
            gone.append(b64url_decode(hit.peer_key))
            return [r for r in rows if r.id != id]

        self._src.store.update(fn)
        if not gone:
            return False
        from .loop import connect_loop

        # The listener drops the link before this returns: a dial or a handshake that starts after ``remove``
        # cannot use it.
        if connect_loop().running:
            if connect_loop().in_loop():
                import asyncio

                # On the loop thread the held list is cut inline, so the link is gone before this returns;
                # the reload and the sessions' close follow on the loop.
                lan = self._lan
                if lan is not None:
                    lan.drop_local(id)
                asyncio.ensure_future(self._forget(id))
            else:
                try:
                    self._cloud._run(self._forget(id), 15)
                except Exception:
                    pass
        self._src.notify()
        for key in gone:
            try:
                self._cloud.transfer.forget_peer(key)
            except Exception:
                pass  # a failure is logged and retried at start
        return True

    async def _forget(self, id: str) -> None:  # noqa: A002
        lan = self._lan
        if lan is not None:
            try:
                await lan.forget_local(id)
            except Exception:
                pass
        await self._reconcile()

    def on_link(self, fn: "Callable[[ConnectSession], None]") -> Callable[[], None]:
        """Called with each session a local link opened to this device (on the Connect thread). Returns the
        unsubscribe."""
        with self._lock:
            self._on_link.append(fn)

        def off_() -> None:
            with self._lock:
                if fn in self._on_link:
                    self._on_link.remove(fn)

        return off_

    def open(self, id: str) -> "ConnectSession":  # noqa: A002
        """A session to the peer of a link, found by its ``m=l`` advert on the LAN (mode ``l``; the relay is never
        used). Raises the typed N/A ``local-pairing-off`` while the gate is off, :class:`LanError`
        ``not_started`` before ``cloud_connect.start()``, ``unknown_peer`` for an id that is no link or a peer
        not seen on this network, ``busy`` for a dial held off after one that failed, and ``handshake_failed``
        when the peer does not answer under the link (it forgot it: "Not reachable")."""
        return self._cloud._run(self._open(id))  # type: ignore[no-any-return]

    async def _open(self, id: str) -> "ConnectSession":  # noqa: A002
        import asyncio

        # One dial per link at a time; a caller that comes while one runs gets the same session.
        live = self._dials.get(id)
        if live is None:
            live = asyncio.ensure_future(self._dial(id))
            self._dials[id] = live

            def done(f: "asyncio.Future[ConnectSession]") -> None:
                if self._dials.get(id) is f:
                    del self._dials[id]
                if not f.cancelled():
                    f.exception()  # retrieved: a caller that left does not leave a warning

            live.add_done_callback(done)
        return await asyncio.shield(live)

    async def _dial(self, id: str) -> "ConnectSession":  # noqa: A002
        import asyncio

        loop = asyncio.get_running_loop()
        self._require_on("open")
        lan = self._lan
        if lan is None:
            raise LanError("not_started", "Cloud Connect is not started.")
        rows = await loop.run_in_executor(None, self._src.store.rows)
        if not any(r.id == id for r in rows):
            raise LanError("unknown_peer", "That is not a local link on this device.")
        # A dial that failed is not repeated at once, and the wait grows with each failure in a row: a peer that
        # closes on a message 1 (it is busy, or it forgot the link) is not hammered.
        cool = self._cool.get(id)
        if cool is not None and self._mono() < cool[0]:
            raise LanError("busy", "That device did not answer a moment ago; try again shortly.")
        try:
            s = await lan.connect_local(id)
        except Exception as e:
            # The gate was cleared while the dial ran.
            if not self._src.allowed():
                raise off("Pairing with a code was turned off (open).") from None
            # Only a dial that reached the network is held off: "not seen yet" is no attempt.
            reached = not isinstance(e, LanError) or e.reason not in ("unknown_peer", "not_started")
            if not reached:
                raise
            fails = (cool[1] if cool is not None else 0) + 1
            base = DIAL_COOLDOWN_S + DIAL_COOLDOWN_JITTER_S * self._rand()
            self._cool[id] = (self._mono() + min(DIAL_BACKOFF_CAP_S, base * 2 ** (fails - 1)), fails)
            raise
        self._cool.pop(id, None)
        # Tracked only once the link is known to be held.
        if not await self._still_held(s):
            if not self._src.allowed():
                raise off("Pairing with a code was turned off (open).")
            raise LanError("unknown_peer", "That link was removed.")
        self._track(s)
        return s

    def has(self, id: str) -> bool:  # noqa: A002
        """Whether ``id`` names a local link this device holds."""
        return self._real and any(r.id == id for r in self._src.store.rows())

    # -- wiring (CloudConnect.start and stop; on the Connect loop) ---------------------------------------

    def attach(self, lan: "LanService") -> None:
        """The LAN service the sessions come from. The previous one's sessions are ended first."""
        self.detach_sync()
        self._lan = lan
        self._unsub.append(lan.on_local_session(self._inbound))

    def detach_sync(self) -> None:
        for u in self._unsub:
            try:
                u()
            except Exception:
                pass
        self._unsub.clear()
        self._lan = None

    async def detach(self) -> None:
        """Ends the sessions; the transport is CloudConnect's."""
        self.detach_sync()
        mine = list(self._sessions)
        for s in mine:
            try:
                s.close("peer_bye")
            except Exception:
                pass
        # Only what this call ended: a session of a newer attach is left alone.
        for s in mine:
            self._sessions.discard(s)

    def _inbound(self, s: "ConnectSession") -> None:
        import asyncio

        # The handshake may have begun before the link was forgotten or the gate went off: the session is
        # delivered only while the link (same secret) is held and the gate is on.
        asyncio.ensure_future(self._deliver(s))

    async def _deliver(self, s: "ConnectSession") -> None:
        if not await self._still_held(s):
            return
        with self._lock:
            subs = list(self._on_link)
        # A session nobody will take is closed: no ``on_link`` subscriber and no Direct Transfer handler.
        if not subs and not self._cloud._transfer.listening:
            try:
                s.close("peer_bye")
            except Exception:
                pass
            return
        self._track(s)
        for f in subs:
            try:
                f(s)
            except Exception:
                pass  # a host callback never ends a session

    def _track(self, s: "ConnectSession") -> None:
        self._sessions.add(s)
        s.on_close(lambda _c: self._sessions.discard(s))

    async def _still_held(self, s: "ConnectSession") -> bool:
        """Close ``s`` (``peer_revoked``, or ``peer_bye`` when the gate is off) unless its link is still held."""
        import asyncio

        ref = s.local
        if ref is None:
            return True
        on = self._src.allowed()
        held = False
        if on:
            loop = asyncio.get_running_loop()
            try:
                rows = await loop.run_in_executor(None, self._src.store.rows)
            except Exception:
                rows = []
            held = any(r.id == ref.id and local_tag(b64url_decode(r.secret)) == ref.tag for r in rows)
        if held:
            return True
        try:
            s.close("peer_revoked" if on else "peer_bye")
        except Exception:
            pass
        return False

    def _changed(self) -> None:
        """From any thread: the gate or the list moved."""
        from .loop import connect_loop

        loop = connect_loop()
        if not loop.running:
            return
        try:
            loop.submit(self._reconcile())
        except RuntimeError:
            pass

    async def _reconcile(self) -> None:
        """A closed gate ends every session (``peer_bye``), a forgotten link's ends ``peer_revoked``."""
        import asyncio

        if not self._sessions:
            return
        if not self._src.allowed():
            for s in list(self._sessions):
                try:
                    s.close("peer_bye")
                except Exception:
                    pass
            return
        loop = asyncio.get_running_loop()
        try:
            rows = await loop.run_in_executor(None, self._src.store.rows)
        except Exception:
            rows = []
        held = {"%s|%s" % (r.id, local_tag(b64url_decode(r.secret))) for r in rows}
        for s in list(self._sessions):
            if s.local is not None and "%s|%s" % (s.local.id, s.local.tag) not in held:
                try:
                    s.close("peer_revoked")
                except Exception:
                    pass

    def close_all(self) -> None:
        """The gate was cleared by a discovery read: close the window and every join, and end every open session
        with ``peer_bye`` (§15.12 "Gates"). The adverts are withdrawn by the LAN service, which the client tells
        at the same time. Safe from any thread; does nothing before Connect's loop has started."""
        from .loop import connect_loop

        loop = connect_loop()
        if not loop.running:
            return
        try:
            loop.submit(self._close_all())
        except RuntimeError:
            pass

    async def _close_all(self) -> None:
        import asyncio

        self._epoch += 1
        for j in list(self._joins):
            j.cancel()
        shower = self._shower
        if shower is not None:
            try:
                await shower.close("off")
            except Exception:
                pass
        # A window still opening is stopped by its own start, which sees the new epoch.
        starting = self._starting
        if starting is not None:
            try:
                await asyncio.shield(starting)
            except Exception:
                pass
        for s in list(self._sessions):
            try:
                s.close("peer_bye")
            except Exception:
                pass
