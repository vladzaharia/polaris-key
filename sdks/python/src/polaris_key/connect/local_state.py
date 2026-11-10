"""The local-link store, ``pkey.connect.local.v1`` (CC-29.9; WIRE-CONTRACT-V5 §15.12, "What each side stores"):
the links this device holds for one product, each with its own link private key and the link secret. It sits in
its own file in the SDK's state directory, written through the device key store's file storage (``0600`` in a
``0700`` directory, replaced atomically, refused when foreign or loose), or in memory for a host whose keys are
memory-only. It is not account data: a sign-out, a licence deactivation and an account deletion leave it alone.
Mirrors ``packages/sdk-node/src/connect/localState.ts``.

Rules this module keeps:

- the record is parsed strictly; one that exists but is unusable is an error for the caller to surface, never
  silently replaced (replacing it would forget the held links);
- a private key and a secret are fields of the record and of nothing else here: :class:`LocalLinkInfo` carries
  neither, and no error, ``repr`` or pickle names one;
- a link is added under the store's lock, which also holds the cap (``MAX_LOCAL_LINKS``), and the read, the
  judgement and the write happen inside one storage update, so a second process on the directory cannot pass
  the cap or overwrite a link between them;
- a link in use (:class:`LiveLocal`) carries its decoded key and secret: the user of one wipes it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from ..constants_generated import ErrorCode
from ..core.b64url import b64url_decode, b64url_encode
from ..core.errors import PolarisError
from ..core.peer_contact import MAX_CONTACT_CATS
from ..core.peer_local import MAX_LIVE_LOCAL_ADVERTS, MAX_LOCAL_LINKS
from ..devices.keys import (
    DeviceKeyError,
    DeviceKeyStorage,
    DeviceKeyStoreError,
    FileDeviceKeyStorage,
    InMemoryDeviceKeyStorage,
)

__all__ = [
    "LOCAL_STATE_FILE",
    "LOCAL_STATE_SCHEMA",
    "LiveLocal",
    "LocalLinkInfo",
    "LocalLinkRow",
    "LocalLinkStore",
    "LocalRef",
    "info_of_local",
    "live_of_local",
    "local_link_id",
    "local_storage",
    "local_tag",
    "parse_local_state",
    "ref_of_local",
    "wipe_locals",
]

LOCAL_STATE_SCHEMA = "pkey.connect.local.v1"
LOCAL_STATE_FILE = "pkey.connect.local.v1.json"

_KEY = re.compile(r"[A-Za-z0-9_-]{43}\Z")
_CAT = re.compile(r"[a-z0-9-]{1,32}\Z")
_ID = re.compile(r"[A-Za-z0-9_-]{16}\Z")


def _key32(v: Any) -> bool:
    if not isinstance(v, str) or _KEY.match(v) is None:
        return False
    try:
        return len(b64url_decode(v)) == 32
    except ValueError:
        return False


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def local_link_id(peer_key: bytes) -> str:
    """The id of a link on this device: ``SHA-256("pkey-local/1" 0x00 peerKey)[0..12]`` in base64url, 16
    characters. Derived from the peer's link key, a public key, and meaningful here only."""
    return b64url_encode(hashlib.sha256(b"pkey-local/1\x00" + bytes(peer_key)).digest()[:12])


def local_tag(secret: Any) -> str:
    """A one-way tag that tells two secrets apart without holding either."""
    return b64url_encode(hashlib.sha256(b"pkey-local-tag/1\x00" + bytes(secret)).digest()[:12])


@dataclass(frozen=True)
class LocalLinkRow:
    """One link as it rests in the record. Keys and the secret are canonical base64url of 32 bytes. The private
    key and the secret are in no ``repr``."""

    id: str
    #: This device's private key for the link: the static key of every session under it.
    own_key: str = field(repr=False)
    own_public: str
    peer_key: str
    secret: str = field(repr=False)
    cats: Tuple[str, ...]
    created_at: int
    reachable: bool
    #: The peer's label, cleaned; a rename replaces it on this device only.
    label: Optional[str] = None
    last_seen: Optional[int] = None

    def __repr__(self) -> str:
        return "<LocalLinkRow %s>" % self.id

    def __reduce__(self) -> Any:
        raise TypeError("a local link row cannot be pickled")

    def to_json(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "id": self.id,
            "ownKey": self.own_key,
            "ownPublic": self.own_public,
            "peerKey": self.peer_key,
            "secret": self.secret,
        }
        if self.label is not None:
            d["label"] = self.label
        d["cats"] = list(self.cats)
        d["createdAt"] = self.created_at
        if self.last_seen is not None:
            d["lastSeen"] = self.last_seen
        d["reachable"] = self.reachable
        return d


@dataclass(frozen=True)
class LocalLinkInfo:
    """What the host sees of one link. No key, no secret."""

    #: Names the link on this device (16 characters). Not the peer's key and not shared.
    id: str
    label: Optional[str]
    #: The data categories both people approved, in byte order.
    categories: Tuple[str, ...]
    #: Unix seconds.
    created_at: int
    last_seen: Optional[int]
    #: Advertised on the LAN (at most 8 at once). A new link is reachable already while fewer than 8 are.
    reachable: bool


def _parse_rows(v: Any) -> Optional[List[LocalLinkRow]]:
    if not isinstance(v, list) or len(v) > MAX_LOCAL_LINKS:
        return None
    out: List[LocalLinkRow] = []
    for r in v:
        if not isinstance(r, dict):
            return None
        rid = r.get("id")
        if not isinstance(rid, str) or _ID.match(rid) is None:
            return None
        if not all(_key32(r.get(k)) for k in ("ownKey", "ownPublic", "peerKey", "secret")):
            return None
        cats = r.get("cats")
        if (
            not isinstance(cats, list)
            or len(cats) > MAX_CONTACT_CATS
            or len(set(cats)) != len(cats)
            or not all(isinstance(c, str) and _CAT.match(c) for c in cats)
        ):
            return None
        label = r.get("label")
        if label is not None and not isinstance(label, str):
            return None
        last = r.get("lastSeen")
        if not _is_int(r.get("createdAt")) or (last is not None and not _is_int(last)):
            return None
        if not isinstance(r.get("reachable"), bool):
            return None
        out.append(
            LocalLinkRow(
                id=rid,
                own_key=r["ownKey"],
                own_public=r["ownPublic"],
                peer_key=r["peerKey"],
                secret=r["secret"],
                cats=tuple(cats),
                created_at=r["createdAt"],
                reachable=r["reachable"],
                label=label,
                last_seen=last,
            )
        )
    return out


def parse_local_state(raw: bytes, product: str) -> Optional[List[LocalLinkRow]]:
    """The rows of a record, or ``None`` when it is unusable (not this schema, another product's, or any row
    breaks a rule)."""
    try:
        v = json.loads(bytes(raw).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(v, dict) or v.get("schema") != LOCAL_STATE_SCHEMA or v.get("product") != product:
        return None
    return _parse_rows(v.get("links"))


@dataclass(frozen=True)
class LocalRef:
    """The link a mode-``l`` session was made over. No key, no secret."""

    id: str
    #: The stored label, or the one the person gave it with ``rename``.
    label: Optional[str]
    categories: Tuple[str, ...]
    #: The peer's link public key, canonical base64url of 32 bytes.
    peer_key: str
    #: A one-way tag of the secret the session opened under (not the secret).
    tag: str = field(default="", repr=False)

    def __repr__(self) -> str:
        return "<LocalRef %s>" % self.id


@dataclass
class LiveLocal:
    """A link in use: the row with its key and secret decoded. :func:`wipe_locals` zeroes them."""

    id: str
    own_key: bytearray = field(repr=False)
    own_public: bytes
    peer_key: bytes
    secret: bytearray = field(repr=False)
    label: Optional[str]
    cats: Tuple[str, ...]
    reachable: bool
    tag: str = field(default="", repr=False)

    def __repr__(self) -> str:
        return "<LiveLocal %s>" % self.id

    def __reduce__(self) -> Any:
        raise TypeError("a local link cannot be pickled")


def live_of_local(r: LocalLinkRow) -> LiveLocal:
    secret = b64url_decode(r.secret)
    return LiveLocal(
        id=r.id,
        own_key=bytearray(b64url_decode(r.own_key)),
        own_public=b64url_decode(r.own_public),
        peer_key=b64url_decode(r.peer_key),
        secret=bytearray(secret),
        label=r.label,
        cats=tuple(r.cats),
        reachable=r.reachable,
        tag=local_tag(secret),
    )


def ref_of_local(l: LiveLocal) -> LocalRef:  # noqa: E741 - the Node name
    return LocalRef(id=l.id, label=l.label, categories=l.cats, peer_key=b64url_encode(l.peer_key), tag=l.tag)


def wipe_locals(ls: Sequence[LiveLocal]) -> None:
    for x in ls:
        for b in (x.secret, x.own_key):
            for i in range(len(b)):
                b[i] = 0


def info_of_local(rows: Sequence[LocalLinkRow]) -> List[LocalLinkInfo]:
    return [
        LocalLinkInfo(r.id, r.label, tuple(r.cats), r.created_at, r.last_seen, r.reachable) for r in rows
    ]


def local_storage(state_dir: str, persistence: str) -> DeviceKeyStorage:
    """The record's home: the file store in the state directory, or memory."""
    if persistence == "memory":
        return InMemoryDeviceKeyStorage()
    return FileDeviceKeyStorage(os.path.join(state_dir, LOCAL_STATE_FILE))


class LocalLinkStore:
    """The links this device holds for one product. Blocking and thread-safe; the facade runs it on a worker
    thread when it is called from the Connect loop."""

    def __init__(self, product: str, open_storage: Callable[[], DeviceKeyStorage]) -> None:
        self._product = product
        self._open = open_storage
        self._storage: Optional[DeviceKeyStorage] = None
        self._lock = threading.RLock()

    def __repr__(self) -> str:
        return "<LocalLinkStore>"

    def __reduce__(self) -> Any:
        raise TypeError("a local link store cannot be pickled")

    def _store(self) -> DeviceKeyStorage:
        if self._storage is None:
            self._storage = self._open()
        return self._storage

    @staticmethod
    def _error(e: BaseException) -> PolarisError:
        if isinstance(e, PolarisError):
            return e
        what = str(e) if isinstance(e, DeviceKeyStoreError) else "store fault"
        return PolarisError(ErrorCode.STORE_FAILED, "The local links could not be used: %s" % what)

    def rows(self) -> List[LocalLinkRow]:
        """The rows, with their keys and secrets: they stay inside the SDK."""
        with self._lock:
            try:
                raw = self._store().get()
            except DeviceKeyError as e:
                raise self._error(e) from e
            if raw is None:
                return []
            try:
                rows = parse_local_state(bytes(raw), self._product)
            finally:
                for i in range(len(raw)):
                    raw[i] = 0
            if rows is None:
                raise PolarisError(ErrorCode.STORE_FAILED, "The local links record is unreadable.")
            return rows

    def count(self) -> int:
        """How many links are held."""
        return len(self.rows())

    def update(self, fn: Callable[[List[LocalLinkRow]], Optional[List[LocalLinkRow]]]) -> List[LocalLinkRow]:
        """Change the rows under the store's lock: ``fn`` returns the new rows, or ``None`` for no change.
        Returns the rows as they are after. The read, the judgement and the write are one storage update."""
        with self._lock:
            result: List[List[LocalLinkRow]] = [[]]

            def transform(current: Optional[bytearray]) -> Optional[bytes]:
                base: List[LocalLinkRow] = []
                if current is not None:
                    rows = parse_local_state(bytes(current), self._product)
                    if rows is None:
                        raise PolarisError(ErrorCode.STORE_FAILED, "The local links record is unreadable.")
                    base = rows
                nxt = fn(base)
                result[0] = base if nxt is None else nxt
                if nxt is None:
                    return None
                doc = {"schema": LOCAL_STATE_SCHEMA, "product": self._product, "links": [r.to_json() for r in nxt]}
                return json.dumps(doc, separators=(",", ":")).encode("utf-8")

            try:
                self._store().update(transform)  # type: ignore[arg-type]
            except (DeviceKeyError, PolarisError) as e:
                raise self._error(e) from e
            return result[0]

    def add(
        self,
        *,
        own_key: bytes,
        own_public: bytes,
        peer_key: bytes,
        secret: bytes,
        cats: Sequence[str],
        now: int,
        label: Optional[str] = None,
    ) -> Tuple[bool, str]:
        """Add a link, unless the device already holds ``MAX_LOCAL_LINKS``. The cap is judged under the lock,
        so two pairings that finish together cannot both pass it. ``(stored, id)``."""
        lid = local_link_id(peer_key)
        full = [False]

        def fn(rows: List[LocalLinkRow]) -> Optional[List[LocalLinkRow]]:
            if len(rows) >= MAX_LOCAL_LINKS:
                full[0] = True
                return None
            others = [r for r in rows if r.id != lid]
            # Reachable by default; with the live-advert limit already reached the new link is stored off and
            # the list says so (§15.12, "Reachable by default").
            reachable = sum(1 for r in others if r.reachable) < MAX_LIVE_LOCAL_ADVERTS
            return others + [
                LocalLinkRow(
                    id=lid,
                    own_key=b64url_encode(own_key),
                    own_public=b64url_encode(own_public),
                    peer_key=b64url_encode(peer_key),
                    secret=b64url_encode(secret),
                    cats=tuple(cats),
                    created_at=now,
                    reachable=reachable,
                    label=label,
                )
            ]

        self.update(fn)
        return (not full[0]), lid

