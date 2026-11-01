"""Inter-account links, ``client.cloud_connect.links`` (CC-19.6; WIRE-CONTRACT-V5 §15.10): pair two devices of
two accounts once, in person, and open sessions to the contact later without a new pairing, on the LAN first
and then through the contact relay. Mirrors ``packages/sdk-node/src/connect/links.ts``.

- ``pair(...)``: open the pairing window: show each code, ``confirm()`` or ``decline()``, and a link is stored
  on both devices. LAN only (mode ``p``);
- ``list()``: the links this device holds;
- ``remove(id)``: delete a link: its secret goes, open sessions with it hear ``peer_revoked``, the other
  device finds the link "not reachable";
- ``set_reachable(id, on)``: advertise a link on the LAN and keep a relay room for it, or stop;
- ``open(id)``: a session to the contact: LAN first, the contact relay after a failed or timed-out LAN
  attempt (unless the host turned the relay off);
- ``on_link(fn)``: called with each session a contact opened to this device (on the Connect thread).

Rules this module keeps:

- links are the developer's opt-in in every transport (D-12): ``pair``, the adverts and the mode-``c`` answer
  need the cached discovery ``interAccount`` to be true. Without it ``pair`` and ``open`` raise the typed N/A
  (:class:`~polaris_key.core.caps.UnsupportedError`, code ``connect_links_disabled``), nothing is advertised
  and no mode ``c`` is answered; when a refresh says false the adverts and rooms are withdrawn and the open
  contact sessions end with ``peer_bye``;
- a link is a secret and a key on this device only. :class:`~polaris_key.connect.contacts.ContactInfo` carries
  neither; a deleted contact's secret is gone from the record before ``remove`` returns;
- the order is LAN, then the contact relay, as for the person's own devices (cloud_connect.py).
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Mapping, Optional

from ..constants_generated import ErrorCode, Feature, UnsupportedReason
from ..core.b64url import b64url_decode
from ..core.caps import Unsupported, UnsupportedError
from .client import ConnectClient
from .contacts import ContactInfo, contact_id, info_of
from .errors import LanError

if TYPE_CHECKING:  # the pairing window imports asyncio and sockets: only when it is opened
    from .cloud_connect import CloudConnect
    from .pairing import LinkPairHandle, LinkPairing
    from .session import ConnectSession

__all__ = ["CloudLinks"]

LAN_ATTEMPT_SECONDS = 4.0


class CloudLinks:
    """``client.cloud_connect.links``."""

    def __init__(self, cloud: "CloudConnect", connect: ConnectClient) -> None:
        self._cloud = cloud
        self._connect = connect
        self._lock = threading.Lock()
        self._on_link: List[Callable[["ConnectSession"], None]] = []
        self._sessions: set = set()  # type: ignore[type-arg]
        self._pairing: List["LinkPairing"] = []
        self._unsub: List[Callable[[], None]] = []
        self._follow: Optional[Callable[[], None]] = None
        self._lan: Any = None
        self._relay: Any = None
        self._lan_attempt = LAN_ATTEMPT_SECONDS
        self._relay_on = False

    def __repr__(self) -> str:
        return "<CloudLinks>"

    def __reduce__(self) -> Any:
        raise TypeError("links cannot be pickled")

    def inter_account(self) -> bool:
        """The cached discovery answer ``services.connect.interAccount``: true only while the product's
        setting, ``launch.connectLinks`` and the service are on (§15.9). False before discovery."""
        f = getattr(self._connect, "inter_account", None)
        return f() is True if f is not None else False

    def _require_on(self, what: str) -> None:
        if not self.inter_account():
            raise UnsupportedError(
                Unsupported(
                    Feature.CONNECT_LINKS,
                    UnsupportedReason.PRODUCT,
                    "links between accounts are off for this product (%s)" % what,
                ),
                ErrorCode.CONNECT_LINKS_DISABLED,
            )

    # -- the API --------------------------------------------------------------------------------------

    def list(self) -> List[ContactInfo]:
        """The links this device holds."""
        return info_of(self._connect.contact_rows())

    def remove(self, id: str) -> bool:  # noqa: A002 - mirrors Node
        """Delete a link (and a re-pair waiting on it). Its secret is dropped from the record, and an open
        session with that contact is closed with ``peer_revoked``. False when ``id`` names no link."""
        found = [False]
        gone: List[str] = []

        def fn(rows: List[Any], _now: int) -> Optional[List[Any]]:
            nxt = [r for r in rows if contact_id(r.agree_key) != id]
            found[0] = len(nxt) != len(rows)
            gone[:] = [r.agree_key for r in rows if contact_id(r.agree_key) == id]
            return nxt if found[0] else None

        self._connect.update_contacts(fn)
        for k in gone:
            # The link's kept partial transfers go with it (§15.11).
            try:
                self._cloud.transfer.forget_peer(b64url_decode(k))
            except Exception:
                pass
        return found[0]

    def set_reachable(self, id: str, reachable: bool) -> bool:  # noqa: A002
        """Advertise a link on the LAN and keep a relay room for it (at most 8 at once), or stop. False
        when ``id`` names no link."""
        import dataclasses

        found = [False]

        def fn(rows: List[Any], _now: int) -> Optional[List[Any]]:
            found[0] = any(contact_id(r.agree_key) == id for r in rows)
            if not found[0]:
                return None
            return [
                dataclasses.replace(r, reachable=bool(reachable)) if contact_id(r.agree_key) == id else r for r in rows
            ]

        self._connect.update_contacts(fn)
        return found[0]

    def on_link(self, fn: Callable[["ConnectSession"], None]) -> Callable[[], None]:
        """Called with each session a contact opened to this device, on either path (on the Connect
        thread). Returns the unsubscribe."""
        with self._lock:
            self._on_link.append(fn)

        def off() -> None:
            with self._lock:
                if fn in self._on_link:
                    self._on_link.remove(fn)

        return off

    def pair(self, options: Optional[Mapping[str, Any]] = None, **kw: Any) -> "LinkPairHandle":
        """Open the pairing window. Both people do it; each device advertises, finds the other and runs
        the code. Options (a mapping, or keyword arguments): ``categories`` (at most 8 distinct
        ``a-z 0-9 -`` strings), ``on_code`` (called with each :class:`~polaris_key.connect.pairing.LinkOffer`
        that reached the code: show it, then ``confirm()`` or ``decline()``), ``label``, ``on_linked``,
        ``on_failed`` and ``seconds`` (at most 300). Raises the typed N/A while links are off, and what
        ``identity()`` raises. The returned handle closes the window (``stop()``); it also closes by itself
        after ``seconds`` and once a link is made. Callbacks run on the Connect thread."""
        from .pairing import LinkPairHandle, LinkPairing

        o: Dict[str, Any] = {**(dict(options) if options else {}), **kw}
        self._require_on("pair")
        # Fails here, on the caller's thread, for options that break a rule.
        LinkPairing.check(o)
        self._connect.identity()
        pairing = self._cloud._run(self._start_pairing(o))
        with self._lock:
            self._pairing.append(pairing)
        return LinkPairHandle(pairing)

    async def _start_pairing(self, o: Dict[str, Any]) -> "LinkPairing":
        from .pairing import LinkPairing

        return await LinkPairing.start(self._connect.pair_source(), o)

    def open(
        self,
        id: str,
        *,
        relay: bool = True,
        lan_attempt_seconds: Optional[float] = None,  # noqa: A002
    ) -> "ConnectSession":
        """A session to a contact: LAN first when it was seen on the network, the contact relay after a
        failed or timed-out LAN attempt (unless ``relay=False``). A pending contact (a re-pair) is tried
        before the held one. Raises the typed N/A while links are off, :class:`LanError` ``not_started``
        before ``cloud_connect.start()``, and the last :class:`LanError` or :class:`RelayError` when no path
        works."""
        self._require_on("open")
        return self._cloud._run(self._open(id, relay, lan_attempt_seconds))  # type: ignore[no-any-return]

    async def _open(self, cid: str, relay_opt: bool, lan_attempt: Optional[float]) -> "ConnectSession":
        import asyncio

        loop = asyncio.get_running_loop()
        lan, rel = self._lan, self._relay
        if lan is None and rel is None:
            raise LanError("not_started", "Cloud Connect is not started.")
        rows = [
            r for r in await loop.run_in_executor(None, self._connect.contact_rows) if contact_id(r.agree_key) == cid
        ]
        if not rows:
            raise LanError("unknown_peer", "That is not a link on this device.")
        # The newest secret first: the pending one of a re-pair, then the held one.
        order = [True for r in rows if r.pending_since is not None] + [False for r in rows if r.pending_since is None]
        last: Optional[BaseException] = None
        for pending in order:
            if lan is not None and (cid, pending) in lan.contact_peers():
                task = asyncio.ensure_future(lan.connect_contact(cid, pending))
                done, _ = await asyncio.wait({task}, timeout=self._lan_attempt if lan_attempt is None else lan_attempt)
                if task in done:
                    try:
                        return await self._track_held(task.result())
                    except Exception as e:
                        last = e
                        if not (rel is not None and relay_opt and self._relay_on):
                            if len(order) == 1:
                                raise
                else:
                    task.add_done_callback(_close_late)
                    last = LanError("connect_failed", "The LAN attempt took too long; trying the relay.")
            if rel is not None and relay_opt and self._relay_on:
                try:
                    return await self._track_held(await rel.dial(cid, pending))
                except Exception as e:
                    last = e
        if last is not None:
            raise last
        raise LanError("unknown_peer", "That contact was not found on this network, and the relay is off.")

    # -- wiring (CloudConnect.start and stop; on the Connect loop) ----------------------------------------

    def attach(self, lan: Any, relay: Any, lan_attempt: float, relay_on: bool) -> None:
        self.detach_sync()
        self._lan, self._relay = lan, relay
        self._lan_attempt, self._relay_on = lan_attempt, relay_on
        if lan is not None:
            self._unsub.append(lan.on_contact_session(self._inbound))
        if relay is not None:
            self._unsub.append(relay.on_session(self._inbound))
        # The list or the gate moved: end the sessions that no longer have a footing.
        follow = getattr(self._connect, "on_contacts_changed", None)
        self._follow = follow(self._contacts_changed) if follow is not None else None

    def detach_sync(self) -> None:
        for u in self._unsub:
            try:
                u()
            except Exception:
                pass
        self._unsub.clear()
        if self._follow is not None:
            self._follow()
            self._follow = None
        self._lan = self._relay = None

    async def detach(self) -> None:
        """Stop the pairing windows and the contact sessions; the transports are CloudConnect's."""
        self.detach_sync()
        await self.close_pairings()
        for s in list(self._sessions):
            try:
                s.close()
            except Exception:
                pass
        self._sessions.clear()

    async def close_pairings(self) -> None:
        with self._lock:
            pairs, self._pairing = self._pairing, []
        for p in pairs:
            try:
                await p.stop()
            except Exception:
                pass

    def _inbound(self, s: "ConnectSession") -> None:
        import asyncio

        self._track(s)
        # The handshake may have begun before the contact was removed or the gate went off: the session
        # is delivered only while the contact (same secret) is held and links are on.
        asyncio.ensure_future(self._deliver(s))

    async def _deliver(self, s: "ConnectSession") -> None:
        if not await self._still_held(s):
            return
        with self._lock:
            subs = list(self._on_link)
        for f in subs:
            try:
                f(s)
            except Exception:
                pass  # a host callback never ends a session

    async def _still_held(self, s: "ConnectSession") -> bool:
        """Close ``s`` (``peer_revoked``, or ``peer_bye`` when the gate is off) unless its contact is held."""
        import asyncio

        ref = s.contact
        if ref is None:
            return True
        on = self.inter_account()
        held = False
        if on:
            loop = asyncio.get_running_loop()
            held = bool(await loop.run_in_executor(None, self._connect.holds_contact, ref.agree_key, ref.tag))
        if held:
            return True
        try:
            s.close("peer_revoked" if on else "peer_bye")
        except Exception:
            pass
        return False

    async def _track_held(self, s: "ConnectSession") -> "ConnectSession":
        self._track(s)
        if await self._still_held(s):
            return s
        raise LanError("unknown_peer", "That link was removed.")

    def _track(self, s: "ConnectSession") -> "ConnectSession":
        self._sessions.add(s)
        s.on_close(lambda _c: self._sessions.discard(s))
        return s

    def _contacts_changed(self) -> None:
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
        """A closed gate ends every contact session (``peer_bye``) and the pairing windows; a deleted
        contact's sessions end ``peer_revoked``."""
        import asyncio

        loop = asyncio.get_running_loop()
        if not self.inter_account():
            for s in list(self._sessions):
                try:
                    s.close("peer_bye")
                except Exception:
                    pass
            await self.close_pairings()
            return
        if not self._sessions:
            return
        rows = await loop.run_in_executor(None, self._connect.contact_rows)
        have = {contact_id(r.agree_key) for r in rows}
        for s in list(self._sessions):
            if s.contact is not None and s.contact.id not in have:
                try:
                    s.close("peer_revoked")
                except Exception:
                    pass


def _close_late(f: Any) -> None:
    if f.cancelled() or f.exception() is not None:
        return
    try:
        f.result().close()
    except Exception:
        pass
