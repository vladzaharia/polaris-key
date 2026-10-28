"""The Cloud Connect API an app calls (CC-10.15; WIRE-CONTRACT-V5 §15): ``client.cloud_connect``. A facade
over the identity client, the LAN service, the relay and the sessions they open. Mirrors
``packages/sdk-node/src/connect/cloudConnect.ts``.

- ``start()``: get the identity (making and registering the device keys on first use), listen and browse on
  the LAN, then connect to the relay unless the host or the product turned it off;
- ``peers()``: the person's other devices that can be reached now, with the paths they have;
- ``devices()``: the person's devices as the Worker lists them (display data);
- ``open(device_id)``: a session to one device, LAN first, the relay after a bounded LAN attempt;
- ``on_channel(fn)``: sessions other devices opened to this one, on either path;
- ``stop()``: close the sessions, the relay and the LAN service.

The services run on the Connect loop (D-3), one private asyncio loop on a daemon thread; every method here
is a plain blocking call from the host's thread, and ``AsyncClient`` mirrors them as coroutines. Callbacks
(``on_channel``, ``on_notice``, a session's ``on_message``) run on the Connect thread: keep them short and
do not call a blocking method of this class from one.

Rules this module keeps:

- the order is LAN, then relay. The LAN attempt is bounded (``lan_attempt_seconds``, default 4); when it
  fails or runs out of time and the relay is on, the relay is tried. A device not seen on the LAN goes
  straight to the relay. ``session.path`` says which path was used;
- the relay stays off, with no socket and no ticket asked for, when the host turned it off (``relay=False``
  at start, or per call) and when discovery says so: ``services.connect.relay`` is false, or the ticket
  endpoint is null (G21). ``status().relay_reason`` says which;
- the relay carries mode ``a`` only; modes ``v`` and ``p`` are not reachable through this API;
- an inbound session with no ``on_channel`` listener is closed (G9);
- a failure on one path is never swallowed: when no path works the last typed error is raised
  (:class:`~polaris_key.connect.errors.LanError` or :class:`~polaris_key.connect.errors.RelayError`).
"""

from __future__ import annotations

import concurrent.futures
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Mapping, Optional

from .client import ConnectClient, ConnectDevice
from .errors import LanError, RelayError
from .loop import connect_loop

if TYPE_CHECKING:  # the transports import asyncio and sockets: only when Connect starts
    from .channel import ConnectNotice
    from .lan import LanService
    from .relay import RelayService
    from .session import ConnectSession

__all__ = ["CloudConnect", "CloudConnectStatus", "CloudPeer", "LAN_ATTEMPT_SECONDS"]

LAN_ATTEMPT_SECONDS = 4.0
#: How long ``stop()`` waits for the Connect loop to tear down.
STOP_SECONDS = 15.0


@dataclass(frozen=True)
class CloudPeer:
    device_id: str
    #: Seen on this network right now.
    lan: bool
    #: Online in the relay room right now.
    relay: bool


@dataclass(frozen=True)
class CloudConnectStatus:
    running: bool
    #: ``off``, ``on`` or ``failed`` (see ``lan_error``).
    lan: str
    lan_error: Optional[BaseException]
    #: ``off``, or the relay's state: ``connecting``, ``open``, ``backoff``, ``unavailable``, ``blocked``...
    relay: str
    relay_error: Optional[RelayError]
    #: Why the relay is ``off``: ``host`` (turned off), ``product`` (discovery says no relay),
    #: ``no_ticket`` (discovery names no ticket endpoint) or ``dependency`` (the ``connect`` extra is
    #: not installed); ``None`` while it is on.
    relay_reason: Optional[str] = None


def relay_wanted(discovery: Optional[Mapping[str, Any]]) -> Optional[str]:
    """``None`` when discovery allows the relay, else why not (G21). An unknown discovery (a build that
    pinned ``expected_services``) allows it: the ticket route answers for itself."""
    if not isinstance(discovery, Mapping):
        return None
    services = discovery.get("services")
    f = services.get("connect") if isinstance(services, Mapping) else None
    if not isinstance(f, Mapping):
        return None
    if f.get("relay") is False:
        return "product"
    ep = f.get("endpoints")
    if isinstance(ep, Mapping) and "ticket" in ep and ep["ticket"] is None:
        return "no_ticket"
    return None


Options = Optional[Mapping[str, Any]]


class CloudConnect:
    """``client.cloud_connect``. ``discovery`` returns the loaded discovery document (or ``None``);
    ``apply_trust`` verifies and applies a trust manifest a peer pushed; ``now`` is epoch seconds (the
    client's own clock, with its floor)."""

    def __init__(
        self,
        connect: ConnectClient,
        discovery: Callable[[], Optional[Mapping[str, Any]]] = lambda: None,
        *,
        apply_trust: Optional[Callable[[str], Any]] = None,
        now: Optional[Callable[[], int]] = None,
    ) -> None:
        self._now = now
        self._connect = connect
        self._discovery = discovery
        self._apply_trust = apply_trust
        self._loop = connect_loop()
        self._lock = threading.Lock()
        self._lan: Optional["LanService"] = None
        self._relay: Optional["RelayService"] = None
        self._lan_failed: Optional[BaseException] = None
        self._relay_reason: Optional[str] = None
        self._self = ""
        self._running = False
        self._touched = False
        self._lan_attempt = LAN_ATTEMPT_SECONDS
        self._on_channel: List[Callable[["ConnectSession"], None]] = []
        self._on_notice: List[Callable[["ConnectNotice"], None]] = []
        self._unsub: List[Callable[[], None]] = []
        self._sessions: set = set()  # type: ignore[type-arg]
        self._gate: Any = None

    def __repr__(self) -> str:
        return "<CloudConnect running=%s>" % self._running

    def __reduce__(self) -> Any:
        raise TypeError("Cloud Connect cannot be pickled")

    # -- plumbing -----------------------------------------------------------------------------------

    def _run(self, coro: Any, timeout: Optional[float] = None) -> Any:
        """Run a coroutine on the Connect loop and wait. Refused from the Connect thread itself, which
        would wait on its own loop."""
        if self._loop.in_loop():
            coro.close()
            raise RuntimeError("a Cloud Connect callback cannot call a blocking method; hand the work to a thread")
        return self._loop.submit(coro).result(timeout)

    def _read(self, fn: Callable[[], Any]) -> Any:
        """Run a plain function on the loop's thread (where the services' tables live)."""
        if self._loop.in_loop():
            return fn()

        async def go() -> Any:
            return fn()

        return self._loop.submit(go()).result(10)

    def _serial(self) -> Any:
        import asyncio

        if self._gate is None:
            self._gate = asyncio.Lock()
        return self._gate

    # -- the API ------------------------------------------------------------------------------------

    def status(self) -> CloudConnectStatus:
        relay = self._relay
        st = relay.status if relay is not None else None
        return CloudConnectStatus(
            running=self._running,
            lan="on" if self._lan is not None else "failed" if self._lan_failed is not None else "off",
            lan_error=self._lan_failed,
            relay="off" if st is None else st.state,
            relay_error=None if st is None else st.error,
            relay_reason=self._relay_reason if st is None else st.reason,
        )

    def start(self, options: Options = None) -> None:
        """Get the identity and bring the transports up. ``options``: ``lan`` (``False``, or a mapping of
        :class:`~polaris_key.connect.lan.LanOptions` fields such as ``interfaces``), ``relay`` (``False``,
        or :class:`~polaris_key.connect.relay.RelayOptions` fields) and ``lan_attempt_seconds``. Raises what
        ``client.connect.identity()`` raises (``no-token``, ``connect-unavailable``, ``invalid-options``...).
        A LAN service that cannot start is not fatal while the relay is on (``status().lan_error`` says
        why); with the relay off the LAN error is raised."""
        with self._lock:
            self._touched = True
        self._run(self._start(options or {}))

    async def _start(self, opts: Mapping[str, Any]) -> None:
        from .lan import LanOptions, LanService, lan_source
        from .relay import RelayOptions, RelayService

        async with self._serial():
            if self._running:
                return
            import asyncio

            loop = asyncio.get_running_loop()
            ident = await loop.run_in_executor(None, self._connect.identity)
            self._self = ident.device_id
            self._lan_attempt = float(opts.get("lan_attempt_seconds", LAN_ATTEMPT_SECONDS))
            self._lan_failed = None
            self._relay_reason = None
            relay_opt = opts.get("relay", True)
            reason = "host" if relay_opt is False else relay_wanted(self._discovery())
            relay_on = reason is None
            src = lan_source(self._connect, apply_trust=self._apply_trust, now=self._now)
            lan_opt = opts.get("lan", True)
            if lan_opt is not False:
                try:
                    lo = (
                        lan_opt
                        if isinstance(lan_opt, LanOptions)
                        else LanOptions(**(lan_opt if isinstance(lan_opt, Mapping) else {}))
                    )
                    lan = await LanService.start(src, lo)
                    self._lan = lan
                    self._unsub.append(lan.on_session(self._inbound))
                    self._unsub.append(lan.on_notice(self._notice))
                except Exception as e:
                    self._lan_failed = e
                    if not relay_on:
                        raise
            if relay_on:
                ro = (
                    relay_opt
                    if isinstance(relay_opt, RelayOptions)
                    else RelayOptions(**(relay_opt if isinstance(relay_opt, Mapping) else {}))
                )
                relay = RelayService(src, self._connect.relay_ticket, ro)
                self._relay = relay
                self._unsub.append(relay.on_session(self._inbound))
                self._unsub.append(relay.on_notice(self._notice))
                relay.start()
            else:
                self._relay_reason = reason
            self._running = True

    def stop(self) -> None:
        """Close the sessions, the relay socket and the LAN service. Safe to call more than once, and
        before ``start`` (it then does nothing, and starts no thread)."""
        with self._lock:
            if not self._touched:
                return
        if self._loop.in_loop():
            raise RuntimeError("a Cloud Connect callback cannot call a blocking method; hand the work to a thread")
        fut = self._loop.submit(self._stop())
        try:
            fut.result(STOP_SECONDS)
        except (concurrent.futures.TimeoutError, TimeoutError):
            # A host callback is holding the Connect loop. Sign-out does not wait on the host's code:
            # force-cancel the transports (no graceful close), drop the discovery state, and go on.
            fut.cancel()
            self._force_stop()

    def _force_stop(self) -> None:
        with self._lock:
            lan, relay = self._lan, self._relay
            self._lan = self._relay = None
            self._running = False
            unsub, self._unsub = self._unsub, []
        for u in unsub:
            try:
                u()
            except Exception:
                pass
        for svc in (lan, relay):
            if svc is not None:
                try:
                    svc.abort()
                except Exception:
                    pass
        self._sessions.clear()
        # Stops the loop once the blocked callback returns and cancels every task still on it.
        self._loop.close(0.0)

    async def _stop(self) -> None:
        async with self._serial():
            if not self._running and self._lan is None and self._relay is None:
                return
            self._running = False
            for u in self._unsub:
                u()
            self._unsub.clear()
            lan, relay = self._lan, self._relay
            self._lan = self._relay = None
            for s in list(self._sessions):
                try:
                    s.close()
                except Exception:
                    pass
            self._sessions.clear()
            for svc in (lan, relay):
                if svc is not None:
                    try:
                        await svc.stop()
                    except Exception:
                        pass

    def peers(self) -> List[CloudPeer]:
        """The person's other devices that can be reached now, with the paths each has."""
        return self._read(self._peers)  # type: ignore[no-any-return]

    def _peers(self) -> List[CloudPeer]:
        out: Dict[str, List[bool]] = {}
        if self._lan is not None:
            for p in self._lan.peers():
                out[p.device_id] = [True, False]
        if self._relay is not None:
            for d in self._relay.members():
                if d == self._self:
                    continue
                out.setdefault(d, [False, False])[1] = True
        return [CloudPeer(d, v[0], v[1]) for d, v in out.items()]

    def refresh_peers(self) -> List[CloudPeer]:
        """Ask the relay room who is online now, so ``peers()`` includes devices that joined since. A
        no-op without the relay."""
        relay = self._relay
        if relay is not None:
            self._run(relay.refresh_members())
        return self.peers()

    def devices(self) -> List[ConnectDevice]:
        """``GET /<p>/connect/devices``: the person's devices, display data only."""
        return self._connect.list_devices()

    def open(
        self, device_id: str, *, relay: bool = True, lan_attempt_seconds: Optional[float] = None
    ) -> "ConnectSession":
        """A session to one of the person's devices. LAN first when the device was seen on the network,
        the relay after a failed or timed-out LAN attempt (unless ``relay=False``). Raises
        :class:`LanError` or :class:`RelayError`; ``session.path`` tells which path an open session took."""
        return self._run(self._open(device_id, relay, lan_attempt_seconds))  # type: ignore[no-any-return]

    async def _open(self, device_id: str, relay_opt: bool, lan_attempt: Optional[float]) -> "ConnectSession":
        import asyncio

        if not self._running:
            raise LanError("not_started", "Cloud Connect is not started.")
        lan, relay = self._lan, self._relay
        relay_ok = relay is not None and relay_opt is not False
        lan_error: Optional[BaseException] = None
        peer = next((p for p in lan.peers() if p.device_id == device_id), None) if lan is not None else None
        if lan is not None and peer is not None:
            task = asyncio.ensure_future(lan.connect(peer))
            done, _ = await asyncio.wait({task}, timeout=self._lan_attempt if lan_attempt is None else lan_attempt)
            if task in done:
                try:
                    return self._track(task.result())
                except Exception as e:
                    if not relay_ok:
                        raise
                    lan_error = e
            else:
                # A late attempt that still succeeds is closed: the caller has moved on.
                task.add_done_callback(_close_late)
                lan_error = LanError("connect_failed", "The LAN attempt took too long; trying the relay.")
                if not relay_ok:
                    raise lan_error
        if not relay_ok:
            if lan_error is not None:
                raise lan_error
            if relay is None or relay_opt is False:
                raise LanError("unknown_peer", "That device was not found on this network, and the relay is off.")
            raise RelayError("not_connected", "The relay is not connected.")
        assert relay is not None
        return self._track(await relay.dial(device_id))

    def on_channel(self, fn: Callable[["ConnectSession"], None]) -> Callable[[], None]:
        """Called with each session another device opened to this one, on either path (on the Connect
        thread). Without a listener an inbound session is closed (G9). Returns the unsubscribe."""
        with self._lock:
            self._on_channel.append(fn)

        def off() -> None:
            with self._lock:
                if fn in self._on_channel:
                    self._on_channel.remove(fn)

        return off

    def on_notice(self, fn: Callable[["ConnectNotice"], None]) -> Callable[[], None]:
        """Called when a roster or trust manifest a peer pushed is stored, applied or refused."""
        with self._lock:
            self._on_notice.append(fn)

        def off() -> None:
            with self._lock:
                if fn in self._on_notice:
                    self._on_notice.remove(fn)

        return off

    # -- on the loop --------------------------------------------------------------------------------

    def _inbound(self, s: "ConnectSession") -> None:
        with self._lock:
            subs = list(self._on_channel)
        if not subs:
            try:
                s.close()  # nobody to hand it to (G9)
            except Exception:
                pass
            return
        self._track(s)
        for f in subs:
            try:
                f(s)
            except Exception:
                pass  # a host callback never ends a session

    def _notice(self, n: "ConnectNotice") -> None:
        with self._lock:
            subs = list(self._on_notice)
        for f in subs:
            try:
                f(n)
            except Exception:
                pass

    def _track(self, s: "ConnectSession") -> "ConnectSession":
        self._sessions.add(s)
        s.on_close(lambda _c: self._sessions.discard(s))
        return s


def _close_late(f: Any) -> None:
    if f.cancelled() or f.exception() is not None:
        return
    try:
        f.result().close()
    except Exception:
        pass

