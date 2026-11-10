"""The Cloud Connect API an app calls (CC-10.15; WIRE-CONTRACT-V5 §15): ``client.cloud_connect``. A facade
over the identity client, the LAN service, the relay and the sessions they open. Mirrors
``packages/sdk-node/src/connect/cloudConnect.ts``.

- ``start()``: get the identity (making and registering the device keys on first use), listen and browse on
  the LAN, then connect to the relay unless the host or the product turned it off;
- ``peers()``: the person's other devices that can be reached now, with the paths they have;
- ``devices()``: the person's devices as the Worker lists them (display data);
- ``open(device_id)``: a session to one device, LAN first, the relay after a bounded LAN attempt;
- ``on_channel(fn)``: sessions other devices opened to this one, on either path;
- ``stop()``: close the sessions, the relay and the LAN service;
- ``links``: inter-account links (CC-19): ``pair()``, ``list()``, ``remove()``, ``open()``, ``on_link()``;
  off unless discovery says ``interAccount``.
- ``local_links``: local links (CC-29): ``pair()`` and ``join()`` with a code, ``list()``, ``rename()``,
  ``remove()``, ``set_reachable()``, ``open()``, ``on_link()``; off unless discovery says ``localPairing``, and
  needing no account.
- ``transfer``: Direct Transfer between peers (CC-20): ``send()``, ``on_offer()``, ``on_result()``. ``start()``
  lists ``xfer/1`` in the capabilities unless the options say ``transfer=False``.
- ``nearby``: approval of a device with no sign-in by a signed-in device nearby (mode ``v``, CC-15):
  ``nearby.request()`` on the new device, ``nearby.on_request()`` on the approver.

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
- with no account, ``start()`` brings up the LAN service for the local links alone when discovery says
  ``localPairing`` (§15.5, "A host that holds only local links runs the listener with no account at all"); it
  binds nothing until a link is held. A sign-out takes the account half away and, when links are reachable,
  brings that service back up (§15.12, "Forget and accounts");
- the account relay carries mode ``a`` only; modes ``v`` and ``p`` are not reachable through this API, and
  mode ``c`` runs over contact rooms (contact_relay.py) that only ``links`` opens;
- an inbound session with no ``on_channel`` listener is closed (G9);
- a failure on one path is never swallowed: when no path works the last typed error is raised
  (:class:`~polaris_key.connect.errors.LanError` or :class:`~polaris_key.connect.errors.RelayError`).
"""

from __future__ import annotations

import concurrent.futures
import dataclasses
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Mapping, Optional

from ..constants_generated import ErrorCode
from ..core.b64url import b64url_encode
from ..core.errors import PolarisError
from ..core.peer_xfer import XFER_CAP
from .client import ConnectClient, ConnectDevice
from .errors import LanError, RelayError
from .links import CloudLinks
from .local_links import LocalLinks
from .loop import connect_loop
from .nearby import CloudNearby, NearbyDeps
from .transfer import Transfer

if TYPE_CHECKING:  # the transports import asyncio and sockets: only when Connect starts
    from .channel import ConnectNotice
    from .contact_relay import ContactRelay
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


def xfer_caps(caps: Any, on: bool) -> Any:
    """``caps`` with ``xfer/1`` listed once when Direct Transfer is on."""
    from ..core.peer_xfer import XFER_CAP

    c = list(caps)
    if on and XFER_CAP not in c:
        c.append(XFER_CAP)
    return tuple(c)


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
        nearby: Optional[NearbyDeps] = None,
        state_dir: Callable[[], Optional[str]] = lambda: None,
    ) -> None:
        self._nearby = CloudNearby(nearby)
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
        # A roster this device stores re-admits every open session (§15.6).
        connect.on_roster(self._readmit)
        self._contact_relay: Optional["ContactRelay"] = None
        self._links = CloudLinks(self, connect)
        self._local_links = LocalLinks(self, connect)
        #: The running LAN service has no account half (it serves local links alone).
        self._local_only = False
        #: What a sign-out starts the local-only service with; ``None`` when the host did not start Connect.
        self._resume_with: Optional[Mapping[str, Any]] = None
        #: The local-only service's watch on the link list (set while it runs).
        self._un_local: Optional[Callable[[], None]] = None
        self._transfer = Transfer(state_dir, self._open_for_transfer, links=self._link_ids)
        leave = getattr(connect, "on_roster_leave", None)
        if leave is not None:
            leave(self._forget_left)

    @property
    def transfer(self) -> Transfer:
        """Direct Transfer (CC-20): ``send``, ``on_offer``, ``on_result``."""
        return self._transfer

    def _forget_left(self, keys: List[bytes]) -> None:
        for k in keys:
            self._transfer.forget_peer(k)

    def _link_ids(self) -> List[str]:
        return [c.id for c in self._links.list()] + [x.id for x in self._local_links.list()]

    def _open_for_transfer(self, peer: Any) -> "ConnectSession":
        if isinstance(peer, str):
            return self.open(peer)
        if self._local_links.has(peer.id):
            return self._local_links.open(peer.id)
        return self._links.open(peer.id)

    @property
    def local_links(self) -> LocalLinks:
        """Local links (CC-29): pair with a code with no account (``pair``, ``join``), then ``list``,
        ``rename``, ``remove``, ``set_reachable``, ``open`` and ``on_link``; off unless discovery says
        ``localPairing``. It needs no sign-in; the later sessions (``open``, ``on_link``, the adverts) run while
        ``start()`` does."""
        return self._local_links

    @property
    def links(self) -> CloudLinks:
        """Inter-account links (CC-19): ``pair``, ``list``, ``remove``, ``set_reachable``, ``open``,
        ``on_link``."""
        return self._links

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

    @property
    def nearby(self) -> CloudNearby:
        """Nearby approval (CC-15): ``request()`` on the new device, ``on_request()`` on the approver. Gated
        by the Identity service's discovery, never by Connect: it works with Connect off."""
        return self._nearby

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

    def _xfer_hook(self, on: bool) -> Any:
        return self._transfer.attach if on else None

    async def _start(self, opts: Mapping[str, Any]) -> None:
        from .lan import LanOptions, LanService, lan_source
        from .relay import RelayOptions, RelayService

        async with self._serial():
            if self._running and not self._local_only:
                return
            # A local-only service gives way to the full one.
            if self._running:
                await self._stop_now()
            import asyncio

            loop = asyncio.get_running_loop()
            try:
                ident = await loop.run_in_executor(None, self._connect.identity)
            except Exception as e:
                if not self._no_account(e, opts):
                    raise
                return await self._start_local_only(opts)
            self._self = ident.device_id
            self._resume_with = opts
            await loop.run_in_executor(None, self._transfer.retry_forgotten)
            self._lan_attempt = float(opts.get("lan_attempt_seconds", LAN_ATTEMPT_SECONDS))
            self._lan_failed = None
            self._relay_reason = None
            relay_opt = opts.get("relay", True)
            reason = "host" if relay_opt is False else relay_wanted(self._discovery())
            relay_on = reason is None
            xfer_on = opts.get("transfer", True) is not False
            src = lan_source(self._connect, apply_trust=self._apply_trust, now=self._now)
            lan_opt = opts.get("lan", True)
            if lan_opt is not False:
                try:
                    lo = (
                        lan_opt
                        if isinstance(lan_opt, LanOptions)
                        else LanOptions(**(lan_opt if isinstance(lan_opt, Mapping) else {}))
                    )
                    lo = dataclasses.replace(lo, caps=xfer_caps(lo.caps, xfer_on), xfer=self._xfer_hook(xfer_on))
                    lan = await LanService.start(src, lo)
                    self._lan = lan
                    self._unsub.append(lan.on_session(self._inbound))
                    self._unsub.append(lan.on_notice(self._notice))
                except Exception as e:
                    self._lan_failed = e
                    if not relay_on:
                        raise
            contact_relay: Optional["ContactRelay"] = None
            if relay_on:
                from .contact_relay import ContactRelay, ContactRelaySource

                ro = (
                    relay_opt
                    if isinstance(relay_opt, RelayOptions)
                    else RelayOptions(**(relay_opt if isinstance(relay_opt, Mapping) else {}))
                )
                ro = ro._replace(caps=xfer_caps(ro.caps, xfer_on), xfer=self._xfer_hook(xfer_on))
                relay = RelayService(src, self._connect.relay_ticket, ro)
                self._relay = relay
                self._unsub.append(relay.on_session(self._inbound))
                self._unsub.append(relay.on_notice(self._notice))
                relay.start()
                # The contact rooms (§15.7) ride the same options. A device with no links keeps no room;
                # the list is read again whenever it changes.
                contact_relay = ContactRelay(
                    ContactRelaySource(src, lambda rid: self._connect.relay_ticket(("c", rid))), ro
                )
                self._contact_relay = contact_relay
                try:
                    await contact_relay.start()
                except Exception:
                    pass
            else:
                self._relay_reason = reason
            self._links.attach(self._lan, contact_relay, self._lan_attempt, relay_on)
            if self._lan is not None:
                self._local_links.attach(self._lan)
            self._local_only = False
            self._running = True

    def _no_account(self, e: BaseException, opts: Mapping[str, Any]) -> bool:
        """A start that found no account (no token, or no sign-in): with ``localPairing`` cached on and the LAN
        not turned off it serves local links alone; any other failure is the caller's."""
        return (
            isinstance(e, PolarisError)
            and e.code in (ErrorCode.NO_TOKEN, ErrorCode.ACCOUNT_REQUIRED)
            and opts.get("lan", True) is not False
            and getattr(self._connect, "local_pairing", lambda: False)()
        )

    async def _start_local_only(self, opts: Mapping[str, Any]) -> None:
        """The local-only service (§15.5, §15.12): no account half, the local links alone. A device that holds no
        link binds no listener (nothing to find, nothing to scan): it waits, and the first link (``pair``,
        ``join``) brings the listener up and the last one forgotten takes it down."""
        self._self = ""
        self._resume_with = opts
        self._lan_failed = None
        self._local_only = True
        self._running = True
        if self._un_local is None:
            self._un_local = self._connect.on_locals_changed(self._local_changed)
        try:
            await self._sync_local_now()
        except BaseException:
            self._local_only = False
            self._running = False
            if self._un_local is not None:
                self._un_local()
                self._un_local = None
            raise

    def _count_links(self) -> int:
        try:
            return self._connect.local_store().count()
        except Exception:
            return 0

    async def _sync_local_now(self) -> None:
        """Bring the local-only listener to match whether a link is held."""
        import asyncio

        from .lan import LanOptions, LanService, lan_source

        if not self._local_only:
            return
        loop = asyncio.get_running_loop()
        held = await loop.run_in_executor(None, self._count_links)
        if held == 0:
            lan = self._lan
            if lan is None:
                return
            # The last link is gone: the listener closes (the sessions of that link already ended).
            self._lan = None
            await self._local_links.detach()
            try:
                await lan.stop()
            except Exception:
                pass
            return
        if self._lan is not None:
            return
        opts = self._resume_with or {}
        lan_opt = opts.get("lan", True)
        xfer_on = opts.get("transfer", True) is not False
        src = lan_source(self._connect, apply_trust=self._apply_trust, now=self._now)
        try:
            lo = (
                lan_opt
                if isinstance(lan_opt, LanOptions)
                else LanOptions(**(lan_opt if isinstance(lan_opt, Mapping) else {}))
            )
            lo = dataclasses.replace(lo, caps=xfer_caps(lo.caps, xfer_on), xfer=self._xfer_hook(xfer_on))
            lan = await LanService.start_local(src, lo)
        except Exception as e:
            self._lan_failed = e
            raise
        if not self._local_only or self._lan is not None:
            lan.abort()
            return
        self._lan = lan
        self._local_links.attach(lan)

    def _local_changed(self) -> None:
        """From any thread: a link was added or forgotten (or the gate moved) while only local links are
        served."""
        if not self._loop.running:
            return
        try:
            self._loop.submit(self._sync_local())
        except RuntimeError:
            pass

    async def _sync_local(self) -> None:
        async with self._serial():
            try:
                await self._sync_local_now()
            except Exception:
                pass

    def stop(self) -> None:
        """Close the sessions, the relay socket and the LAN service. Safe to call more than once, and
        before ``start`` (it then does nothing, and starts no thread)."""
        self._resume_with = None
        self._stop_blocking()

    def _stop_blocking(self) -> None:
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

    def _resume_local(self) -> None:
        """After a sign-out: local links are not account data, so when the host had started Connect, the gate is
        on and a link is reachable, the LAN service comes back up without the account half (§15.12, "Forget and
        accounts")."""
        if self._resume_with is None or not getattr(self._connect, "local_pairing", lambda: False)():
            return
        if self._loop.in_loop():
            return
        try:
            self._loop.submit(self._resume()).result(STOP_SECONDS)
        except Exception:
            pass

    async def _resume(self) -> None:
        import asyncio

        async with self._serial():
            opts = self._resume_with
            if self._running or opts is None or not getattr(self._connect, "local_pairing", lambda: False)():
                return
            loop = asyncio.get_running_loop()

            def reachable() -> bool:
                try:
                    return any(r.reachable for r in self._connect.local_store().rows())
                except Exception:
                    return False

            if not await loop.run_in_executor(None, reachable):
                return
            try:
                await self._start_local_only(opts)
            except Exception:
                pass

    def _force_stop(self) -> None:
        with self._lock:
            lan, relay, croom = self._lan, self._relay, self._contact_relay
            self._lan = self._relay = self._contact_relay = None
            self._running = False
            self._local_only = False
            unsub, self._unsub = self._unsub, []
            if self._un_local is not None:
                unsub.append(self._un_local)
                self._un_local = None
        self._links.detach_sync()
        self._local_links.detach_sync()
        for u in unsub:
            try:
                u()
            except Exception:
                pass
        for svc in (lan, relay, croom):
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
            await self._stop_now()

    async def _stop_now(self) -> None:
        if not self._running and self._lan is None and self._relay is None:
            return
        self._running = False
        self._local_only = False
        if self._un_local is not None:
            self._un_local()
            self._un_local = None
        for u in self._unsub:
            u()
        self._unsub.clear()
        lan, relay, croom = self._lan, self._relay, self._contact_relay
        self._lan = self._relay = self._contact_relay = None
        await self._links.detach()
        await self._local_links.detach()
        for s in list(self._sessions):
            try:
                s.close()
            except Exception:
                pass
        self._sessions.clear()
        for svc in (lan, relay, croom):
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
            if self._transfer.listening and XFER_CAP in s.caps:
                self._track(s)  # a host that takes offers keeps the sessions its peers open for them
                return
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

    def _readmit(self, ring: Any) -> None:
        """Admit each open session again against a roster this device has just stored: a peer the roster no
        longer lists with the key the session was admitted under is closed ``peer_revoked``. A roster that
        only adds devices keeps every session. Never blocks: the closes run on the Connect loop."""
        sessions = list(self._sessions)
        gone = []
        for s in sessions:
            key = b64url_encode(s.peer_static) if s.peer_static is not None else None
            if not any(d.device_id == s.peer_device_id and (key is None or d.agree_key == key) for d in ring.devices):
                gone.append(s)
        if gone:
            self._loop.call_soon(_revoke, gone)

    def _track(self, s: "ConnectSession") -> "ConnectSession":
        self._sessions.add(s)
        s.on_close(lambda _c: self._sessions.discard(s))
        return s


def _revoke(sessions: List["ConnectSession"]) -> None:
    for s in sessions:
        try:
            s.revoke()
        except Exception:
            pass


def _close_late(f: Any) -> None:
    if f.cancelled() or f.exception() is not None:
        return
    try:
        f.result().close()
    except Exception:
        pass

