"""Inter-account links as the Python SDK holds them (CC-19.6; WIRE-CONTRACT-V5 §15.10): the contact rows of
``pkey.connect.v1`` and the pure steps that change them. The rules (the cap of 64, the pending contacts, the
trial order, the 24 h lapse) are :mod:`polaris_key.core.peer_contact`'s; this module only carries the SDK's
own columns (``created_at``, ``reachable``) across those calls. Mirrors
``packages/sdk-node/src/connect/contacts.ts``.

Rules this module keeps:

- a contact secret is key material: it is decoded for a call and, where Python allows, wiped after
  (a ``bytearray`` is zeroed; an immutable ``bytes`` copy handed to a session cannot be); it is in no
  :class:`ContactInfo`, no error and no ``repr``, and ``ContactInfo`` carries no key of any kind;
- an ``id`` is derived from the peer's agreeKey (a public key) and names a link on this device only:
  SHA-256("pkey-contact/1" 0x00 agreeKey)[0..12] in base64url, 16 characters.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, replace
from typing import Any, List, Optional, Sequence, Tuple

from ..core.b64url import b64url_decode, b64url_encode
from ..core.peer_contact import (
    MAX_CONTACT_SECRETS,
    StoredContact,
    contact_trial_order,
    drop_stale_pending,
    store_contact,
)
from .state import ContactRow

__all__ = [
    "ContactInfo",
    "ContactRef",
    "LiveContact",
    "contact_id",
    "drop_stale_rows",
    "info_of",
    "live_of",
    "promote_row",
    "ref_of",
    "store_row",
    "trial_order_of",
    "wipe_live",
]


@dataclass(frozen=True)
class ContactInfo:
    """What the host sees of one link."""

    #: Names the link on this device (16 characters). Not the peer's key and not shared.
    id: str
    #: The label stored when the link was made, display data the other person chose.
    label: Optional[str]
    #: The data categories both people approved, in byte order.
    categories: Tuple[str, ...]
    #: Unix seconds.
    created_at: int
    #: Advertised on the LAN and kept in a relay room (at most 8 at once).
    reachable: bool
    #: A newer pairing with the same peer waits for its first handshake (§15.10).
    re_pair_pending: bool


@dataclass(frozen=True)
class ContactRef:
    """The link a session was made over."""

    id: str
    label: Optional[str]
    categories: Tuple[str, ...]
    #: The peer's agreeKey, 43 base64url characters (a public key).
    agree_key: str
    #: The session was opened under a pending contact: it is a first handshake of a re-pair.
    pending: bool

    def __repr__(self) -> str:
        return "<ContactRef %s>" % self.id


def contact_id(agree_key: str) -> str:
    h = hashlib.sha256(b"pkey-contact/1\x00" + b64url_decode(agree_key)).digest()
    return b64url_encode(h[:12])


@dataclass
class LiveContact:
    """A contact in use: the row with its secret decoded. :func:`wipe_live` zeroes the secret."""

    id: str
    agree_key: str
    agree_key_bytes: bytes
    secret: bytearray = field(repr=False)
    label: Optional[str]
    cats: Tuple[str, ...]
    reachable: bool
    pending: bool

    def __repr__(self) -> str:
        return "<LiveContact %s%s>" % (self.id, " pending" if self.pending else "")

    def __reduce__(self) -> Any:
        raise TypeError("a contact cannot be pickled")


def live_of(row: ContactRow) -> LiveContact:
    return LiveContact(
        id=contact_id(row.agree_key),
        agree_key=row.agree_key,
        agree_key_bytes=b64url_decode(row.agree_key),
        secret=bytearray(b64url_decode(row.secret)),
        label=row.label,
        cats=tuple(row.cats),
        reachable=row.reachable,
        pending=row.pending_since is not None,
    )


def ref_of(c: LiveContact) -> ContactRef:
    return ContactRef(id=c.id, label=c.label, categories=c.cats, agree_key=c.agree_key, pending=c.pending)


def wipe_live(cs: Sequence[LiveContact]) -> None:
    for c in cs:
        for i in range(len(c.secret)):
            c.secret[i] = 0


def _row_key(r: Any) -> Tuple[str, bool]:
    pend = getattr(r, "pending_since", None)
    return (r.agree_key, pend is not None)


def _stored_of(r: ContactRow) -> StoredContact:
    return StoredContact(r.agree_key, b64url_decode(r.secret), r.label, tuple(r.cats), r.pending_since)


def trial_order_of(rows: Sequence[ContactRow]) -> List[LiveContact]:
    """The contacts in ``contact_trial_order`` (held first, then pending), decoded. The caller wipes them."""
    by_key = {_row_key(r): r for r in rows}
    out: List[LiveContact] = []
    for s in contact_trial_order([_stored_of(r) for r in rows]):
        r = by_key.get(_row_key(s))
        if r is not None:
            out.append(live_of(r))
    return out[:MAX_CONTACT_SECRETS]


def info_of(rows: Sequence[ContactRow]) -> List[ContactInfo]:
    pending = {r.agree_key for r in rows if r.pending_since is not None}
    return [
        ContactInfo(
            id=contact_id(r.agree_key),
            label=r.label,
            categories=tuple(r.cats),
            created_at=r.created_at,
            reachable=r.reachable,
            re_pair_pending=r.agree_key in pending,
        )
        for r in rows
        if r.pending_since is None
    ]


def store_row(
    rows: Sequence[ContactRow],
    agree_key: str,
    secret: bytes,
    cats: Sequence[str],
    label: Optional[str],
    now_seconds: int,
) -> Tuple[bool, List[ContactRow], bool]:
    """Store a contact the pairing produced (``store_contact``); the new one is reachable.
    ``(ok, rows, pending)``; ``ok`` False means ``full``."""
    stored = [_stored_of(r) for r in rows]
    incoming = StoredContact(agree_key, bytes(secret), label, tuple(cats))
    ok, nxt, pending = store_contact(stored, incoming, now_seconds)
    if not ok:
        return False, list(rows), False
    keep = {_row_key(r): r for r in rows}
    out: List[ContactRow] = []
    for i, c in enumerate(nxt):
        was = keep.get(_row_key(c)) if (i < len(nxt) - 1 or c.secret is not incoming.secret) else None
        if was is not None:
            out.append(was)
            continue
        out.append(
            ContactRow(
                agree_key=c.agree_key,
                secret=b64url_encode(c.secret),
                cats=tuple(c.cats),
                created_at=now_seconds,
                reachable=True,
                label=c.label,
                pending_since=c.pending_since,
            )
        )
    return True, out, pending


def promote_row(rows: Sequence[ContactRow], agree_key: str) -> List[ContactRow]:
    """A handshake under the pending contact of ``agree_key`` passed the pin: it takes the held one's place."""
    pend = next((r for r in rows if r.pending_since is not None and r.agree_key == agree_key), None)
    held = next((r for r in rows if r.pending_since is None and r.agree_key == agree_key), None)
    if pend is None:
        return list(rows)
    out: List[ContactRow] = []
    for r in rows:
        if r is pend:
            continue
        if r.pending_since is None and r.agree_key == agree_key:
            # The new link: its secret, label and categories, made when the pairing was; the held
            # one's local choice of reachability stays.
            out.append(
                replace(
                    pend,
                    pending_since=None,
                    reachable=held.reachable if held is not None else pend.reachable,
                )
            )
        else:
            out.append(r)
    return out


def drop_stale_rows(rows: Sequence[ContactRow], now_seconds: int) -> List[ContactRow]:
    """Drop the pending contacts that lapsed."""
    keep = {_row_key(s) for s in drop_stale_pending([_stored_of(r) for r in rows], now_seconds)}
    return [r for r in rows if _row_key(r) in keep]
