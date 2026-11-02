"""Direct Transfer as the host sees it (CC-20.5; WIRE-CONTRACT-V5 §15.11): ``client.cloud_connect.transfer``.
Mirrors the contract of ``packages/sdk-node/src/connect/transfer.ts``.

- ``send(peer, source, name=, type=, cat=, chunk=)``: offer content to a peer and return a
  :class:`TransferHandle`. ``peer`` is an open :class:`~polaris_key.connect.session.ConnectSession`, a device
  id (a session is opened, LAN first), or a :class:`~polaris_key.connect.contacts.ContactInfo` from
  ``links.list()``. ``source`` is a path, ``bytes`` or a seekable binary file object. The whole content is
  read once to hash it before the ``OFFER`` goes out; ``name`` is display data only.
- ``on_offer(handler)``: every ``OFFER`` from a peer is put to the handler, one transfer at a time. Without a
  handler the offer is declined. The handler returns an :class:`Accept` (the destination, which the host
  always chooses), ``"decline"``, or ``None`` to answer later with :meth:`IncomingOffer.accept` or
  :meth:`IncomingOffer.decline` (the person is asked; unanswered, the offer ends after 120 s). It runs on
  the Connect thread: return quickly, and make no transfer call from inside it.
  Setting a handler also keeps the sessions peers open to this device (without it, an inbound session
  no ``on_channel`` listener wants is closed).
- ``on_result(fn)``: each transfer's end, in either direction, as a :class:`TransferResult`.

Rules this module keeps:

- the peer's ``name`` never reaches a path: a partial file is named by the derived partial path, and the
  delivered file is the host's ``dest``, written by a temp file and a rename, never over an existing file
  unless ``overwrite`` is set;
- a transfer is declined, not accepted, when there is no handler, no state directory for the partial files,
  or no usable destination; in mode ``c`` the category is checked before the person is asked;
- a partial is kept when a session ends, and offered again when the same peer sends the same transfer
  (the verified prefix is hashed again first); sign-out and removing a link delete partials.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, BinaryIO, Callable, Dict, List, NamedTuple, Optional, Set, Union

from ..constants_generated import ErrorCode
from ..core.b64url import b64url_encode
from ..core.errors import PolarisError
from ..core.peer_session import Established
from ..core.peer_xfer import (
    XFER,
    XFER_CAP,
    XFER_DEFAULT_CHUNK,
    XFER_MAX_CHUNK,
    XFER_MAX_SIZE,
    XferMachine,
    is_xfer_id,
    parse_xfer_offer,
    xfer_partial_path,
)
from ..core.peer_xfer_endpoint import XferEndpoint, XferEvents
from .errors import LanError
from .transfer_store import DEFAULT_QUOTA_BYTES, PartialStore

_log = logging.getLogger("polaris_key")

__all__ = [
    "Accept",
    "IncomingOffer",
    "LinkUnknownError",
    "PeerLacksTransfer",
    "Transfer",
    "TransferCancelled",
    "TransferHandle",
    "TransferResult",
]

_CAT = re.compile(r"[a-z0-9-]{1,32}\Z")
_TYPE = re.compile(r"[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*\Z")
_BLOCK = 1024 * 1024
_MAX_PENDING_META = 64

Source = Union[str, "os.PathLike[str]", bytes, bytearray, memoryview, BinaryIO]
Json = Dict[str, Any]


class TransferCancelled(PolarisError):
    """A transfer ended without delivering the content (code ``transfer-cancelled``). ``reason`` is the
    ``CANCEL`` reason sent or received: ``declined``, ``cancelled``, ``hash``, ``size``, ``category``,
    ``busy``, ``quota`` or ``timeout``; ``closed`` when the session ended first."""

    def __init__(self, reason: str, message: str = "The transfer did not finish.") -> None:
        super().__init__(ErrorCode.TRANSFER_CANCELLED, message)
        self.reason = reason

    def __reduce__(self) -> Any:
        return (TransferCancelled, (self.reason, self.message))


class LinkUnknownError(PolarisError):
    """The host named a link this device does not hold (code ``link-unknown``)."""

    def __init__(self, message: str = "That link is not held on this device.") -> None:
        super().__init__(ErrorCode.LINK_UNKNOWN, message)

    def __reduce__(self) -> Any:
        return (LinkUnknownError, (self.message,))


class PeerLacksTransfer(PolarisError):
    """The session's peer did not list ``xfer/1`` (code ``peer_not_allowed``): nothing was sent."""

    reason = "not_allowed"

    def __init__(self) -> None:
        super().__init__(ErrorCode.PEER_NOT_ALLOWED, "The peer did not offer Direct Transfer (xfer/1) on this session.")

    def __reduce__(self) -> Any:
        return (PeerLacksTransfer, ())


class Accept(NamedTuple):
    """The host's yes: where the content goes. ``dest`` is a file path in an existing, writable directory."""

    dest: str
    overwrite: bool = False


@dataclass(frozen=True)
class TransferResult:
    """How a transfer ended. ``direction`` is ``out`` or ``in``; ``outcome`` is ``delivered``, ``cancelled``
    (``reason`` says why) or ``closed`` (the session ended; an incoming partial is kept to resume). ``path``
    is the delivered file of an incoming transfer."""

    id: str
    direction: str
    outcome: str
    reason: Optional[str] = None
    path: Optional[str] = None

    @property
    def delivered(self) -> bool:
        return self.outcome == "delivered"

    def raise_for_status(self) -> "TransferResult":
        """Raises :class:`TransferCancelled` unless the content was delivered."""
        if self.outcome != "delivered":
            raise TransferCancelled(self.reason or self.outcome)
        return self


class TransferHandle:
    """An outgoing transfer."""

    def __init__(self, id_: str, cancel: Callable[[str], None]) -> None:
        self.id = id_
        self._cancel = cancel
        self._done = threading.Event()
        self._result: Optional[TransferResult] = None

    def __repr__(self) -> str:
        return "<TransferHandle %s%s>" % (self.id, " done" if self._done.is_set() else "")

    @property
    def done(self) -> bool:
        return self._done.is_set()

    @property
    def result(self) -> Optional[TransferResult]:
        return self._result

    def cancel(self) -> None:
        """Cancel (a no-op once the content is out and the peer has the last record)."""
        self._cancel(self.id)

    def wait(self, timeout: Optional[float] = None) -> TransferResult:
        """Block until the transfer ends. Raises ``TimeoutError`` after ``timeout`` seconds."""
        if not self._done.wait(timeout):
            raise TimeoutError("transfer still running")
        assert self._result is not None
        return self._result

    def _finish(self, r: TransferResult) -> None:
        if self._result is None:
            self._result = r
            self._done.set()


class IncomingOffer:
    """What a peer offers. ``name`` is already cleaned display data (never a path), ``type`` and ``cat`` are as
    sent. Answer later with :meth:`accept` or :meth:`decline`; an offer the peer withdrew has ``withdrawn``."""

    def __init__(
        self,
        id_: str,
        size: int,
        name: Optional[str],
        type_: Optional[str],
        cat: Optional[str],
        peer_device_id: str,
        contact_id: Optional[str],
        answer: Callable[["IncomingOffer", Optional[Accept]], None],
    ) -> None:
        self.id = id_
        self.size = size
        self.name = name
        self.type = type_
        self.cat = cat
        self.peer_device_id = peer_device_id
        self.contact_id = contact_id
        self.withdrawn = False
        self._answer = answer

    def __repr__(self) -> str:
        return "<IncomingOffer %s size=%d>" % (self.id, self.size)

    def accept(self, dest: str, overwrite: bool = False) -> None:
        """Accept into ``dest``, a file path in an existing writable directory (else the offer is declined)."""
        self._answer(self, Accept(os.fspath(dest), bool(overwrite)))

    def decline(self) -> None:
        self._answer(self, None)


OfferHandler = Callable[[IncomingOffer], Union[Accept, str, bool, None]]


class _Reader:
    """The sender's source: a path, bytes or a seekable file, hashed once and read by offset."""

    def __init__(self, source: Source) -> None:
        self._lock = threading.Lock()
        self._owned: Optional[BinaryIO] = None
        self.name: Optional[str] = None
        if isinstance(source, (bytes, bytearray, memoryview)):
            self._f: BinaryIO = io.BytesIO(bytes(source))
        elif isinstance(source, (str, os.PathLike)):
            p = os.fspath(source)
            self.name = os.path.basename(p) or None
            self._owned = self._f = open(p, "rb")
        elif hasattr(source, "read") and hasattr(source, "seek"):
            self._f = source
        else:
            raise TypeError("source must be a path, bytes or a seekable binary file")
        self._f.seek(0, os.SEEK_END)
        self.size = self._f.tell()
        if self.size > XFER_MAX_SIZE:
            self.close()
            raise ValueError("the content is larger than 2^40 bytes")
        h = hashlib.sha256()
        self._f.seek(0)
        left = self.size
        while left > 0:
            b = self._f.read(min(_BLOCK, left))
            if not b:
                self.close()
                raise OSError("the source ended early")
            h.update(b)
            left -= len(b)
        self.sha256 = h.hexdigest()

    def read(self, offset: int, length: int) -> bytes:
        with self._lock:
            self._f.seek(offset)
            return self._f.read(length)

    def close(self) -> None:
        f, self._owned = self._owned, None
        if f is not None:
            try:
                f.close()
            except OSError:
                pass


class _Wire:
    """Direct Transfer on one session."""

    def __init__(self, hub: "Transfer", session: Any, e: Established, peer_key: bytes) -> None:
        self.hub = hub
        self.session = session
        self.peer_key = peer_key
        self.endpoint: Optional[XferEndpoint] = None
        self.out: Dict[str, TransferHandle] = {}
        self.sources: Dict[str, _Reader] = {}
        self.pending: Dict[str, IncomingOffer] = {}
        self.dests: Dict[str, Accept] = {}
        self.meta: Dict[str, Json] = {}
        self.ref_meta: Dict[str, Json] = {}
        self.ref_id: Dict[str, str] = {}
        self.delivered_to: Dict[str, str] = {}
        self.failed_ids: Set[str] = set()
        self.epoch = 0
        self.lock = threading.Lock()


class Transfer:
    """``client.cloud_connect.transfer``. ``state_dir`` returns the SDK's state directory (``None`` for an
    in-memory client: incoming offers are then declined). ``open_peer`` opens a session to a device id or a
    link. ``now`` is a clock in epoch seconds and ``timer(fn, seconds)`` returns the cancel; both are test
    seams."""

    def __init__(
        self,
        state_dir: Callable[[], Optional[str]] = lambda: None,
        open_peer: Optional[Callable[[Any], Any]] = None,
        *,
        now: Optional[Callable[[], float]] = None,
        timer: Optional[Callable[[Callable[[], None], float], Callable[[], None]]] = None,
        links: Optional[Callable[[], List[str]]] = None,
        quota_bytes: int = DEFAULT_QUOTA_BYTES,
    ) -> None:
        self._quota = quota_bytes
        self._state_dir = state_dir
        self._open_peer = open_peer
        base = time.time() - time.monotonic()
        self._now = now or (lambda: time.monotonic() + base)
        self._timer = timer
        self._links = links
        self._lock = threading.RLock()
        self._handler: Optional[OfferHandler] = None
        self._on_result: List[Callable[[TransferResult], None]] = []
        self._wires: Dict[int, _Wire] = {}
        self._store: Optional[PartialStore] = None
        self._store_dir: Optional[str] = None
        #: Peer keys whose kept partials could not be deleted; tried again at the next start.
        self._unforgotten: Set[bytes] = set()

    def __repr__(self) -> str:
        return "<Transfer sessions=%d>" % len(self._wires)

    def __reduce__(self) -> Any:
        raise TypeError("transfers cannot be pickled")

    # -- the host's API -----------------------------------------------------------------------------

    def on_offer(self, handler: Optional[OfferHandler]) -> Callable[[], None]:
        """Set (or, with ``None``, clear) the one handler for incoming offers. Returns the unset."""
        with self._lock:
            self._handler = handler

        def off() -> None:
            with self._lock:
                if self._handler is handler:
                    self._handler = None

        return off

    @property
    def listening(self) -> bool:
        """True while an offer handler is set: inbound sessions that list ``xfer/1`` are kept open."""
        return self._handler is not None

    def on_result(self, fn: Callable[[TransferResult], None]) -> Callable[[], None]:
        with self._lock:
            self._on_result.append(fn)

        def off() -> None:
            with self._lock:
                if fn in self._on_result:
                    self._on_result.remove(fn)

        return off

    def send(
        self,
        peer: Any,
        source: Source,
        *,
        name: Optional[str] = None,
        type: Optional[str] = None,  # noqa: A002 - mirrors the wire member
        cat: Optional[str] = None,
        chunk: Optional[int] = None,
        id: Optional[str] = None,  # noqa: A002 - the wire member
    ) -> TransferHandle:
        """Offer ``source`` to ``peer``. Returns at once with a handle; the content moves when the peer
        accepts. ``cat`` is a data category (required toward a link: the peer refuses an offer outside the
        categories both people approved). ``id`` names the transfer; to resume one that a closed session left
        half done, pass the earlier handle's id and the same content: the peer answers with the offset it
        has verified. Raises ``ValueError`` for a bad argument, :class:`LinkUnknownError`
        for a link this device does not hold, and :class:`PeerLacksTransfer` when the peer did not advertise
        Direct Transfer."""
        if type is not None and (not isinstance(type, str) or _TYPE.match(type) is None or len(type) > 127):
            raise ValueError("type")
        if cat is not None and (not isinstance(cat, str) or _CAT.match(cat) is None):
            raise ValueError("cat")
        if chunk is not None and (isinstance(chunk, bool) or not isinstance(chunk, int) or chunk < 1):
            raise ValueError("chunk")
        session = self._session_of(peer)
        wire = self._wire_of(session)
        reader = _Reader(source)
        try:
            shown = name if name is not None else reader.name
            if shown is not None and len(shown.encode("utf-8", "surrogatepass")) > 255:
                raise ValueError("name")
            size = min(
                chunk or XFER_DEFAULT_CHUNK,
                XFER_MAX_CHUNK,
                int(session.hello.max_message) - 24,
            )
            if size < 1:
                raise ValueError("chunk")
            id_ = b64url_encode(secrets.token_bytes(16)) if id is None else id
            if not is_xfer_id(id_) or id_ in wire.out:
                raise ValueError("id")
            h = TransferHandle(id_, lambda i: self._cancel(wire, i))
            with wire.lock:
                wire.out[id_] = h
                wire.sources[id_] = reader
            args: Json = {"id": id_, "size": reader.size, "chunk": size, "sha256": reader.sha256}
            if cat is not None:
                args["cat"] = cat
            if shown is not None:
                args["name"] = shown
            if type is not None:
                args["type"] = type
            assert wire.endpoint is not None
            wire.endpoint.offer(**args)
            return h
        except BaseException:
            reader.close()
            raise

    def cancel(self, id: str) -> None:  # noqa: A002
        """Cancel the transfer with this id, in either direction (a no-op for an id that is not live)."""
        with self._lock:
            wires = list(self._wires.values())
        for w in wires:
            if w.endpoint is not None:
                w.endpoint.cancel(id)

    def purge(self) -> None:
        """Delete every kept partial (sign-out). Raises when a file cannot be deleted."""
        with self._lock:
            for w in list(self._wires.values()):
                if w.endpoint is not None:
                    w.endpoint.closed()
            store = self._get_store(create=False)
            if store is not None:
                store.purge()

    def forget_peer(self, peer_key: bytes) -> None:
        """Delete the kept partials of one peer key (a removed link or a device that left the roster). A
        failure is logged (the error's type only) and the key is tried again at the next start."""
        key = bytes(peer_key)
        try:
            store = self._get_store(create=False)
            if store is not None:
                store.purge(key)
        except Exception as err:  # noqa: BLE001 - one peer's cleanup never ends the caller
            _log.warning(
                "polaris_key: the kept transfers of a removed contact could not be deleted (%s); "
                "retrying at the next start",
                type(err).__name__,
            )
            with self._lock:
                self._unforgotten.add(key)
            return
        with self._lock:
            self._unforgotten.discard(key)

    def retry_forgotten(self) -> None:
        """Try again for the peers whose kept transfers could not be deleted earlier. Called at start."""
        with self._lock:
            keys = list(self._unforgotten)
        for key in keys:
            self.forget_peer(key)

    # -- the sessions -------------------------------------------------------------------------------

    def attach(self, link: Any, session: Any, e: Established) -> None:
        """Called on the Connect thread as a session is established: when both sides listed ``xfer/1``, take
        the session's transfer port. Records that arrive before this returns cannot exist."""
        if XFER_CAP not in e.caps or not hasattr(link, "attach_xfer"):
            return
        wire = _Wire(self, session, e, bytes(e.remote_static))
        mode = "c" if session.contact is not None else "a"
        store = self._get_store()
        own_max = link.channel.own_max_message
        holder: List[Optional[XferEndpoint]] = [None]

        def on_record(type_: int, body: bytes) -> None:
            if type_ == XFER["OFFER"]:
                o = parse_xfer_offer(body, own_max)
                if o is not None:
                    with wire.lock:
                        wire.meta[o["id"]] = o
                        while len(wire.meta) > _MAX_PENDING_META:
                            wire.meta.pop(next(iter(wire.meta)))
            ep = holder[0]
            if ep is not None:
                ep.receive(type_, body)

        write = link.attach_xfer(on_record)
        peer_key = wire.peer_key

        def new_ref(id_: str, sha: str) -> str:
            ref = xfer_partial_path(peer_key, id_, sha)
            m = wire.meta.get(id_)
            if m is not None:
                wire.ref_meta[ref] = {"id": id_, "sha256": sha, "size": m["size"], "chunk": m["chunk"]}
            wire.ref_id[ref] = id_
            return ref

        partials: List[Json] = []
        if store is not None:
            try:
                partials = store.partials(peer_key)
                wire.epoch = store.epoch(peer_key)
            except OSError:
                partials = []
        for p in partials:
            wire.ref_id[p["ref"]] = p["id"]
        machine = XferMachine(
            mode=mode,
            caps=e.caps,
            max_message=own_max,
            peer_key=peer_key,
            handler=lambda ask: self._decide(wire, ask),
            categories=session.contact.categories if session.contact is not None else (),
            free=store.free if store is not None else None,
            partials=partials,
            rehash=(lambda ref, off: store.rehash(ref, off, wire)) if store is not None else None,
            new_ref=new_ref,
        )
        ep = XferEndpoint(
            machine,
            send=write,
            close=link.close,
            read=lambda id_, off, n: self._read(wire, id_, off, n),
            apply=lambda eff: self._apply(wire, store, eff),
            events=_Events(self, wire),
            now=self._now,
            timer=self._timer,
        )
        holder[0] = ep
        wire.endpoint = ep
        with self._lock:
            self._wires[id(session)] = wire
        session.on_close(lambda _c: self._detach(wire))

    def _detach(self, wire: _Wire) -> None:
        with self._lock:
            self._wires.pop(id(wire.session), None)
        if wire.endpoint is not None:
            wire.endpoint.closed()
        store = self._get_store(create=False)
        if store is not None:
            store.release_owner(wire)
        for r in list(wire.sources.values()):
            r.close()
        wire.sources.clear()

    def _session_of(self, peer: Any) -> Any:
        from .session import ConnectSession

        if isinstance(peer, ConnectSession):
            return peer
        if self._open_peer is None:
            raise LanError("not_started", "Cloud Connect is not started.")
        if isinstance(peer, str) or hasattr(peer, "categories"):
            if not isinstance(peer, str) and self._links is not None and getattr(peer, "id", None) not in self._links():
                raise LinkUnknownError()
            return self._open_peer(peer)
        raise TypeError("peer must be a session, a device id or a link")

    def _wire_of(self, session: Any) -> _Wire:
        with self._lock:
            w = self._wires.get(id(session))
        if w is None or w.endpoint is None:
            raise PeerLacksTransfer()
        return w

    def _cancel(self, wire: _Wire, id_: str) -> None:
        if wire.endpoint is not None:
            wire.endpoint.cancel(id_)

    def _read(self, wire: _Wire, id_: str, offset: int, length: int) -> bytes:
        r = wire.sources.get(id_)
        if r is None:
            raise OSError("no source")
        return r.read(offset, length)

    # -- the receiver -------------------------------------------------------------------------------

    def _get_store(self, create: bool = True) -> Optional[PartialStore]:
        d = self._state_dir()
        if d is None:
            return None
        root = os.path.join(d, "transfers")
        with self._lock:
            if self._store is None or self._store_dir != root:
                if not create and not os.path.isdir(root):
                    return None
                self._store = PartialStore(root, quota_bytes=self._quota)
                self._store_dir = root
            return self._store

    def _decide(self, wire: _Wire, ask: Json) -> str:
        """The machine asks (on the thread inside a record): the host's handler, or the default decline."""
        with self._lock:
            handler = self._handler
        if handler is None or self._get_store() is None:
            return "decline"
        offer = IncomingOffer(
            ask["id"],
            ask["size"],
            ask.get("name"),
            ask.get("type"),
            ask.get("cat"),
            wire.session.peer_device_id,
            wire.session.contact.id if wire.session.contact is not None else None,
            lambda o, a: self._answer(wire, o, a),
        )
        try:
            r = handler(offer)
        except Exception:
            return "decline"
        if r is None:
            with wire.lock:
                wire.pending[offer.id] = offer
            return "ask"
        if isinstance(r, Accept) and self._dest_ok(r):
            with wire.lock:
                wire.dests[offer.id] = r
            return "accept"
        return "decline"

    def _dest_ok(self, a: Accept) -> bool:
        store = self._get_store()
        if store is None or not isinstance(a.dest, str) or a.dest == "":
            return False
        if os.path.isdir(a.dest):
            return False
        if not a.overwrite and os.path.lexists(a.dest):
            return False
        return store.destination_ok(a.dest)

    def _answer(self, wire: _Wire, offer: IncomingOffer, a: Optional[Accept]) -> None:
        with wire.lock:
            if wire.pending.pop(offer.id, None) is None:
                return  # answered, withdrawn or ended already
        ok = a is not None and self._dest_ok(a)
        if ok:
            assert a is not None
            with wire.lock:
                wire.dests[offer.id] = a
        if wire.endpoint is not None:
            wire.endpoint.consent(offer.id, "accept" if ok else "decline")

    def _apply(self, wire: _Wire, store: Optional[PartialStore], eff: Json) -> None:
        if store is None:
            raise OSError("no state directory")
        if "finalize" in eff:
            ref = eff["finalize"]
            id_ = wire.ref_id[ref]
            a = wire.dests[id_]
            try:
                store.deliver(ref, a.dest, a.overwrite, owner=wire)
            except BaseException:
                wire.failed_ids.add(id_)
                raise
            wire.delivered_to[id_] = a.dest
            return
        store.apply(
            wire.peer_key,
            eff,
            wire.ref_meta.get(eff["create"]) if "create" in eff else None,
            owner=wire,
            epoch=wire.epoch,
        )

    # -- the machine's events -----------------------------------------------------------------------

    def _result(self, wire: _Wire, r: Json) -> None:
        id_ = r["id"]
        with wire.lock:
            handle = wire.out.pop(id_, None)
            src = wire.sources.pop(id_, None)
            wire.pending.pop(id_, None)
            wire.meta.pop(id_, None)
            dest = wire.delivered_to.pop(id_, None)
        if src is not None:
            src.close()
        if r["outcome"] == "delivered" and handle is None and dest is None:
            # A transfer of zero bytes keeps no partial: the empty file is placed here.
            a = wire.dests.get(id_)
            store = self._get_store()
            if a is not None and store is not None:
                try:
                    store.deliver(None, a.dest, a.overwrite)
                    dest = a.dest
                except OSError:
                    r = {"id": id_, "outcome": "closed"}
        with wire.lock:
            wire.dests.pop(id_, None)
        res = TransferResult(
            id_,
            "out" if handle is not None else "in",
            r["outcome"],
            r.get("reason"),
            dest if r["outcome"] == "delivered" else None,
        )
        if handle is not None:
            handle._finish(res)
        with self._lock:
            subs = list(self._on_result)
        for f in subs:
            try:
                f(res)
            except Exception:
                pass


class _Events(XferEvents):
    def __init__(self, hub: Transfer, wire: _Wire) -> None:
        self._hub = hub
        self._wire = wire

    def result(self, r: Json) -> None:
        self._hub._result(self._wire, r)

    def withdraw(self, id_: str) -> None:
        with self._wire.lock:
            o = self._wire.pending.pop(id_, None)
            self._wire.dests.pop(id_, None)
            self._wire.meta.pop(id_, None)
        if o is not None:
            o.withdrawn = True

    def refused(self, id_: str) -> None:
        # Too many live transfers on this session: the handle ends as busy, nothing was sent.
        self._hub._result(self._wire, {"id": id_, "outcome": "cancelled", "reason": "busy"})

    def error(self, err: BaseException) -> None:
        for id_ in list(self._wire.failed_ids):
            self._hub._result(self._wire, {"id": id_, "outcome": "closed"})
        self._wire.failed_ids.clear()
