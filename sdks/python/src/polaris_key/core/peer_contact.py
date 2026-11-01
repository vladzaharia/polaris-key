"""WIRE-CONTRACT-V5 §15.10: inter-account links. Pure functions, no I/O: the contact secret, the ``CONTACT``
body, a link's categories, the order of the pairing exchange, the contact advert (name, TXT, browse) and
the contact room (room id, alias, ticket body). The vectors are ``peer-matrix.json`` ``contact``; the
session (:mod:`.peer_session`) runs the exchange and mode ``c``. Mirrors
``packages/client-core/src/peer/contact.ts``.

The secret and the keys are key material: nothing here logs one or puts one in an error or a ``repr``.
"""

from __future__ import annotations

import hmac as _hmac
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

from .b64url import b64url_decode, b64url_encode
from .device_label import normalize_device_label
from .device_proof import is_x25519_low_order
from .peer_advert import advert_epoch, base32_lower, device_id_bytes, is_instance_name
from .peer_noise import hkdf_sha256, hmac_sha256, sha256
from .peer_payload import parse_strict_object

__all__ = [
    "CONTACT_BODY_MAX",
    "CONTACT_EXCHANGE_SECONDS",
    "CONTACT_LEASE_BYTES",
    "CONTACT_ROOM_IDLE_SECONDS",
    "CONTACT_TICKET_BODY_MAX",
    "ContactExchange",
    "MAX_CONTACTS",
    "MAX_CONTACT_CATS",
    "MAX_CONTACT_SECRETS",
    "MAX_LIVE_CONTACT_ADVERTS",
    "MAX_PENDING_CONTACTS",
    "PENDING_CONTACT_SECONDS",
    "StoredContact",
    "browse_contact_instance",
    "build_contact",
    "contact_alias",
    "contact_categories",
    "contact_instance",
    "contact_pin",
    "contact_rid",
    "contact_secret",
    "contact_ticket_body",
    "contact_trial_order",
    "drop_stale_pending",
    "parse_contact",
    "parse_contact_ticket_body",
    "parse_contact_txt",
    "promote_contact",
    "store_contact",
]

#: Contacts one device holds for one product.
MAX_CONTACTS = 64
MAX_CONTACT_CATS = 8
#: Pairings with a peer the host already holds wait here as pending contacts (§15.10). At most this
#: many at once; the oldest is dropped for a newer one.
MAX_PENDING_CONTACTS = 8
#: A pending contact that no handshake has promoted is dropped this long after it was stored.
PENDING_CONTACT_SECONDS = 86_400
#: The secrets a responder tries and a browser tests: the held contacts and the pending ones.
MAX_CONTACT_SECRETS = MAX_CONTACTS + MAX_PENDING_CONTACTS
#: Contact adverts a host keeps live at once.
MAX_LIVE_CONTACT_ADVERTS = 8
CONTACT_BODY_MAX = 4096
CONTACT_TICKET_BODY_MAX = 256
#: The relay leases bytes to a contact room in steps of this many (§15.7).
CONTACT_LEASE_BYTES = 1_048_576
#: A contact room with no socket for this long erases itself (§15.7).
CONTACT_ROOM_IDLE_SECONDS = 2_592_000
#: From this side's ``CONFIRM`` to the peer's ``CONTACT``.
CONTACT_EXCHANGE_SECONDS = 30

_CAT = re.compile(r"[a-z0-9-]{1,32}\Z")
_KEY = re.compile(r"[A-Za-z0-9_-]{43}\Z")
_RID = re.compile(r"[A-Za-z0-9_-]{22}\Z")


def _key32(v: Any) -> Optional[bytes]:
    """A canonical base64url of 32 bytes, decoded, or ``None``."""
    if not isinstance(v, str) or _KEY.match(v) is None:
        return None
    try:
        b = b64url_decode(v)
    except ValueError:
        return None
    return b if len(b) == 32 else None


def _u64(n: int) -> bytes:
    return n.to_bytes(8, "big")


# -- the contact secret -----------------------------------------------------------------------------


def contact_secret(h: bytes, n_d: bytes, n_m: bytes, agree_key_a: bytes, agree_key_b: bytes) -> bytes:
    """``HKDF-SHA256(salt = h, ikm = nD || nM, info = "pkey-peer/1 contact" || 0x00 || lo || hi)``, 32 bytes:
    ``h`` is the mode-``p`` handshake hash, ``nD`` and ``nM`` the two SAS nonces and ``lo``, ``hi`` the two
    devices' agreeKeys (32 raw bytes each) by unsigned byte order."""
    if len(agree_key_a) != 32 or len(agree_key_b) != 32:
        raise ValueError("agreeKey")
    a, b = bytes(agree_key_a), bytes(agree_key_b)
    lo, hi = (a, b) if a <= b else (b, a)
    return hkdf_sha256(bytes(h), bytes(n_d) + bytes(n_m), b"pkey-peer/1 contact\x00" + lo + hi, 32)


# -- the CONTACT body --------------------------------------------------------------------------------


def _valid_cats(cats: Sequence[Any]) -> bool:
    return (
        len(cats) <= MAX_CONTACT_CATS
        and all(isinstance(c, str) and _CAT.match(c) is not None for c in cats)
        and len(set(cats)) == len(cats)
    )


def _clean_label(raw: str) -> Optional[str]:
    """NFC, then the device-label cleaning (§12.7.1): ``None`` when nothing is left."""
    return normalize_device_label(unicodedata.normalize("NFC", raw))


def build_contact(agree_key: str, cats: Sequence[str], label: Optional[str] = None) -> bytes:
    """The bytes of a ``CONTACT`` body. Raises ``ValueError`` for a body the peer would refuse."""
    key = _key32(agree_key)
    if key is None or is_x25519_low_order(key):
        raise ValueError("agreeKey")
    if not _valid_cats(list(cats)):
        raise ValueError("cats")
    body: Dict[str, Any] = {"v": 1, "agreeKey": agree_key}
    if label is not None:
        cleaned = _clean_label(label)
        if cleaned is not None:
            body["label"] = cleaned
    body["cats"] = list(cats)
    out = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(out) > CONTACT_BODY_MAX:
        raise ValueError("size")
    return out


def parse_contact(body: bytes, own: Optional[str] = None) -> Dict[str, Any]:
    """Judge one ``CONTACT`` body: ``{"ok": True, "agreeKey", "label"?, "cats"}`` or ``{"ok": False}``.
    ``own`` is the reader's own agreeKey: a body that carries it is no contact. The label is cleaned as a
    ``HELLO`` label (§15.6) and dropped when nothing is left."""
    no: Dict[str, Any] = {"ok": False}
    if len(body) > CONTACT_BODY_MAX:
        return no
    o = parse_strict_object(bytes(body))
    if o is None:
        return no
    v = o.get("v")
    if isinstance(v, bool) or not isinstance(v, int) or v != 1:
        return no
    ak = o.get("agreeKey")
    key = _key32(ak)
    if key is None or is_x25519_low_order(key):
        return no
    if own is not None and ak == own:
        return no
    cats = o.get("cats")
    if not isinstance(cats, list) or not _valid_cats(cats):
        return no
    label: Optional[str] = None
    if "label" in o:
        raw = o["label"]
        if not isinstance(raw, str):
            return no
        label = _clean_label(raw)
    out: Dict[str, Any] = {"ok": True, "agreeKey": ak}
    if label is not None:
        out["label"] = label
    out["cats"] = list(cats)
    return out


def contact_categories(a: Sequence[str], b: Sequence[str]) -> List[str]:
    """A link's categories: the entries both sides list, once each, in byte order."""
    return sorted({c for c in a if c in b}, key=lambda s: s.encode("utf-8"))


# -- the pairing exchange ----------------------------------------------------------------------------


class ContactExchange:
    """One side's order guard over the records of the exchange (§15.10, "Order of checks"). A ``CONTACT``
    goes out once this side has sent its ``CONFIRM`` and read the peer's; the peer's arrives only after
    both. After a close nothing happens.

    ``own`` is this device's agreeKey. ``held`` is the agreeKey of every active contact the host holds for
    the product: a peer in it is a re-pair, accepted at any count; a peer not in it is refused
    (``peer_not_allowed``, nothing stored) when the host already holds ``MAX_CONTACTS``.

    ``step(event)`` takes ``{"event": ...}`` (``own-confirm``, ``peer-confirm``, ``peer-contact`` with a
    ``body`` of bytes, ``timeout``) and answers ``{"sends": [...], "close"?, "stored"?}``."""

    def __init__(self, own: Optional[str] = None, held: Sequence[str] = ()) -> None:
        self._own = own
        self._held = list(held)
        self._own_confirmed = False
        self._peer_confirmed = False
        self._contact_sent = False
        self._peer_contact = False
        self._dead = False

    def __repr__(self) -> str:
        return "<ContactExchange>"

    @property
    def waiting(self) -> bool:
        """This side's ``CONFIRM`` is out and the peer's ``CONTACT`` is still wanted."""
        return not self._dead and self._own_confirmed and not self._peer_contact

    def step(self, e: Dict[str, Any]) -> Dict[str, Any]:
        r: Dict[str, Any] = {"sends": []}
        if self._dead:
            return r

        def bad() -> Dict[str, Any]:
            self._dead = True
            r["close"] = "peer_bad_frame"
            return r

        def maybe_contact() -> None:
            if self._own_confirmed and self._peer_confirmed and not self._contact_sent:
                self._contact_sent = True
                r["sends"].append("CONTACT")

        ev = e.get("event")
        if ev == "own-confirm":
            self._own_confirmed = True
            r["sends"].append("CONFIRM")
            maybe_contact()
            return r
        if ev == "peer-confirm":
            if self._peer_confirmed:
                return bad()
            self._peer_confirmed = True
            maybe_contact()
            return r
        if ev == "peer-contact":
            if not self._own_confirmed or not self._peer_confirmed or self._peer_contact:
                return bad()
            v = parse_contact(e["body"], self._own)
            if not v["ok"]:
                return bad()
            pending = v["agreeKey"] in self._held
            if not pending and len(self._held) >= MAX_CONTACTS:
                self._dead = True
                r["close"] = "peer_not_allowed"
                return r
            self._peer_contact = True
            stored: Dict[str, Any] = {"agreeKey": v["agreeKey"]}
            if "label" in v:
                stored["label"] = v["label"]
            stored["cats"] = v["cats"]
            stored["pending"] = pending
            r["stored"] = stored
            return r
        if ev == "timeout":
            if self._own_confirmed and not self._peer_contact:
                self._dead = True
                r["close"] = "peer_timeout"
            return r
        raise ValueError("event")


# -- the contact list --------------------------------------------------------------------------------


@dataclass
class StoredContact:
    """A contact the host holds. ``pending_since`` (unix seconds) marks a pending one. The secret is key
    material: it is in no ``repr``."""

    agree_key: str
    secret: bytes = field(repr=False)
    label: Optional[str] = None
    cats: Tuple[str, ...] = ()
    pending_since: Optional[int] = None

    def __repr__(self) -> str:
        return "<StoredContact%s>" % (" pending" if self.pending_since is not None else "")

    def __reduce__(self) -> Any:
        raise TypeError("a contact cannot be pickled")


def _active(lst: Sequence[StoredContact]) -> List[StoredContact]:
    return [c for c in lst if c.pending_since is None]


def store_contact(
    lst: Sequence[StoredContact], incoming: StoredContact, now_seconds: int
) -> Tuple[bool, List[StoredContact], bool]:
    """Store a contact the exchange produced (§15.10). Returns ``(ok, list, pending)``. A peer whose
    agreeKey the host does not hold is added as an active contact, or refused (``ok`` False: ``full``) at
    ``MAX_CONTACTS``. A peer it does hold is stored pending: the held contact stays as it is, one pending
    contact per key (a newer one replaces an older), at most ``MAX_PENDING_CONTACTS`` (the oldest goes
    first). Pure: the list in, the list out."""
    held = any(c.agree_key == incoming.agree_key for c in _active(lst))
    fresh = StoredContact(incoming.agree_key, incoming.secret, incoming.label, tuple(incoming.cats))
    if not held:
        if len(_active(lst)) >= MAX_CONTACTS:
            return False, list(lst), False
        return True, list(lst) + [fresh], False
    nxt = [c for c in lst if not (c.pending_since is not None and c.agree_key == incoming.agree_key)]
    fresh.pending_since = now_seconds
    nxt.append(fresh)
    while True:
        pend = [c for c in nxt if c.pending_since is not None]
        if len(pend) <= MAX_PENDING_CONTACTS:
            break
        # Oldest first; of equal age, the one stored earlier (lower in the list).
        oldest = pend[0]
        for c in pend:
            if c.pending_since < oldest.pending_since:  # type: ignore[operator]
                oldest = c
        nxt.remove(oldest)
    return True, nxt, True


def promote_contact(lst: Sequence[StoredContact], agree_key: str) -> List[StoredContact]:
    """A handshake under a pending contact's secret passed the pin: it replaces the held contact of that
    key, in the held one's place. A key with no pending contact leaves the list as it is."""
    p = next((c for c in lst if c.pending_since is not None and c.agree_key == agree_key), None)
    if p is None:
        return list(lst)
    fresh = StoredContact(p.agree_key, p.secret, p.label, tuple(p.cats))
    out: List[StoredContact] = []
    for c in lst:
        if c is p:
            continue
        out.append(fresh if c.pending_since is None and c.agree_key == agree_key else c)
    return out


def drop_stale_pending(lst: Sequence[StoredContact], now_seconds: int) -> List[StoredContact]:
    """Drop the pending contacts stored ``PENDING_CONTACT_SECONDS`` ago or earlier."""
    return [
        c
        for c in lst
        if c.pending_since is None or now_seconds - c.pending_since < PENDING_CONTACT_SECONDS
    ]


def contact_trial_order(lst: Sequence[StoredContact]) -> List[StoredContact]:
    """The order a responder tries secrets and a browser tests contacts in: the active contacts in held
    order, then the pending ones in the order they were stored, at most ``MAX_CONTACT_SECRETS``."""
    return (
        [c for c in lst if c.pending_since is None] + [c for c in lst if c.pending_since is not None]
    )[:MAX_CONTACT_SECRETS]


# -- the pin -----------------------------------------------------------------------------------------


def contact_pin(held: str, remote_static: bytes) -> bool:
    """Mode c (§15.10): the remote static key must be the agreeKey of the contact whose secret opened the
    session. The initiator asks after message 2, the responder after message 3; a ``False`` ends the
    session as ``peer_revoked`` with nothing sent."""
    return _hmac.compare_digest(b64url_encode(bytes(remote_static)).encode("ascii"), held.encode("utf-8"))


# -- the LAN advert ----------------------------------------------------------------------------------


def contact_instance(secret: bytes, advertiser_agree_key: bytes, epoch: int) -> str:
    """The contact instance name for an advertiser in one epoch: ``p1-`` and the first 16 characters of the
    lower-case base32 of ``HMAC-SHA256(secret, "pkey-peer/1 cdisc" || 0x00 || u64be(epoch) || agreeKey)``,
    with the advertiser's own agreeKey so the two devices of a link differ."""
    mac = hmac_sha256(bytes(secret), b"pkey-peer/1 cdisc\x00" + _u64(epoch) + bytes(advertiser_agree_key))
    return "p1-" + base32_lower(mac)[:16]


def parse_contact_txt(entries: Sequence[str]) -> Dict[str, Any]:
    """``v=1`` and ``m=c``. An entry splits at its first ``=``; one without ``=`` or with an empty key is
    ignored; a repeated key refuses; ``h`` is not read. ``{"ok": True}`` or ``{"ok": False, "reason"}``."""
    kv: Dict[str, str] = {}
    for e in entries:
        at = e.find("=")
        if at < 1:
            continue
        k = e[:at]
        if k in kv:
            return {"ok": False, "reason": "duplicate"}
        kv[k] = e[at + 1 :]
    if kv.get("v") != "1":
        return {"ok": False, "reason": "version"}
    if kv.get("m") != "c":
        return {"ok": False, "reason": "mode"}
    return {"ok": True}


class ContactKey(NamedTuple):
    """A contact the device holds: its secret and the peer's agreeKey (32 raw bytes)."""

    secret: bytes
    agree_key: bytes

    def __repr__(self) -> str:
        return "ContactKey(<redacted>)"

    __str__ = __repr__


def browse_contact_instance(
    instance: str, contacts: Sequence[ContactKey], now_seconds: int
) -> Optional[Dict[str, int]]:
    """Which contact an instance belongs to: the first of the first ``MAX_CONTACT_SECRETS``, in the order of
    ``contact_trial_order``, that matches in the current or the previous epoch. At most 144 HMACs.
    ``{"contact": index, "epochBack": 0|1}`` or ``None``."""
    if not is_instance_name(instance):
        return None
    epoch = advert_epoch(now_seconds)
    for i, c in enumerate(contacts[:MAX_CONTACT_SECRETS]):
        for back in (0, 1):
            if epoch - back < 0:
                continue
            if contact_instance(c.secret, c.agree_key, epoch - back) == instance:
                return {"contact": i, "epochBack": back}
    return None


# -- the contact room --------------------------------------------------------------------------------


def contact_rid(secret: bytes) -> str:
    """The room id: base64url of ``HKDF-SHA256(salt = empty, ikm = secret, info = "pkey-peer/1 room")[0..16]``,
    22 characters."""
    return b64url_encode(hkdf_sha256(b"", bytes(secret), b"pkey-peer/1 room", 32)[:16])


def _rid_bytes(rid: str) -> bytes:
    if not isinstance(rid, str) or _RID.match(rid) is None:
        raise ValueError("rid")
    try:
        return b64url_decode(rid)
    except ValueError:
        raise ValueError("rid") from None


def contact_alias(rid: str, device_id: str) -> bytes:
    """The alias a room uses for a device: ``SHA-256(rid || deviceId)[0..24]`` over the 16 decoded rid bytes
    and the 24 decoded device-id bytes."""
    return sha256(_rid_bytes(rid), device_id_bytes(device_id))[:24]


def contact_ticket_body(rid: str) -> str:
    """The ticket-request body for a contact room."""
    _rid_bytes(rid)
    return json.dumps({"room": "c", "rid": rid}, separators=(",", ":"))


def parse_contact_ticket_body(b: bytes) -> Dict[str, Any]:
    """Read a ticket-request body: strict JSON of at most 256 bytes with exactly ``room`` = "c" and a
    canonical ``rid``. ``{"ok": True, "rid"}`` or ``{"ok": False}``."""
    no: Dict[str, Any] = {"ok": False}
    if len(b) > CONTACT_TICKET_BODY_MAX:
        return no
    o = parse_strict_object(bytes(b))
    if o is None or len(o) != 2 or "room" not in o or "rid" not in o:
        return no
    if o["room"] != "c":
        return no
    rid = o["rid"]
    if not isinstance(rid, str) or _RID.match(rid) is None:
        return no
    try:
        if len(b64url_decode(rid)) != 16:
            return no
    except ValueError:
        return no
    return {"ok": True, "rid": rid}
