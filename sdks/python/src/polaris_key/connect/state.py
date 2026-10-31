"""The Cloud Connect state record, ``pkey.connect.v1`` (CC-10.1; WIRE-CONTRACT-V5 §15.3, §15.4): the held
roster and certificate as the compact JWSs the Worker signed, and K_disc, the discovery key(s), which is a
secret of the same standing as the device keys. It sits in its own file in the SDK's state directory,
written through the device key store's file storage: ``0600`` in a ``0700`` directory, replaced
atomically, refused when the directory or file is foreign or loose. A host whose keys are memory-only
gets a memory record, which dies with the process. Mirrors ``packages/sdk-node/src/connect/state.ts``.

Rules this module keeps:

* the record is parsed strictly; one that exists but is unusable is an error for the caller to surface,
  never silently replaced (replacing it would forget the held roster);
* K_disc is a field of the record and of nothing else here: no ``repr`` or accessor shows it.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..core.b64url import b64url_decode
from ..core.peer_contact import MAX_CONTACT_CATS, MAX_CONTACTS, MAX_PENDING_CONTACTS
from ..devices.keys import DeviceKeyStorage, FileDeviceKeyStorage, InMemoryDeviceKeyStorage

__all__ = [
    "CONNECT_STATE_SCHEMA",
    "CONNECT_STATE_FILE",
    "ConnectStateRecord",
    "ContactRow",
    "parse_connect_state",
    "connect_storage",
    "keys_after_ring",
]

CONNECT_STATE_SCHEMA = "pkey.connect.v1"
CONNECT_STATE_FILE = "pkey.connect.v1.json"

_KEY = re.compile(r"[A-Za-z0-9_-]{43}\Z")
_CAT = re.compile(r"[a-z0-9-]{1,32}\Z")


def _key32(v: Any) -> bool:
    if not isinstance(v, str) or _KEY.match(v) is None:
        return False
    try:
        return len(b64url_decode(v)) == 32
    except ValueError:
        return False


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


@dataclass(frozen=True)
class ContactRow:
    """One contact as it rests in the record (WIRE-CONTRACT-V5 §15.10). ``secret`` and ``agree_key`` are
    canonical base64url of 32 bytes; the secret is key material and is in no ``repr``."""

    agree_key: str
    secret: str = field(repr=False)
    cats: Tuple[str, ...]
    created_at: int
    #: The host's local "advertise and keep a relay room for this contact" choice.
    reachable: bool
    label: Optional[str] = None
    #: Unix seconds when a re-pair stored this contact pending; ``None`` for a held one.
    pending_since: Optional[int] = None

    def __repr__(self) -> str:
        return "<ContactRow%s>" % (" pending" if self.pending_since is not None else "")

    def __reduce__(self) -> Any:
        raise TypeError("a contact row cannot be pickled")

    def to_json(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"agreeKey": self.agree_key, "secret": self.secret}
        if self.label is not None:
            d["label"] = self.label
        d["cats"] = list(self.cats)
        d["createdAt"] = self.created_at
        d["reachable"] = self.reachable
        if self.pending_since is not None:
            d["pendingSince"] = self.pending_since
        return d


def _parse_contacts(v: Any) -> Optional[Tuple[ContactRow, ...]]:
    if not isinstance(v, list) or len(v) > MAX_CONTACTS + MAX_PENDING_CONTACTS:
        return None
    out = []
    for r in v:
        if not isinstance(r, dict) or not _key32(r.get("agreeKey")) or not _key32(r.get("secret")):
            return None
        cats = r.get("cats")
        if (
            not isinstance(cats, list)
            or len(cats) > MAX_CONTACT_CATS
            or not all(isinstance(c, str) and _CAT.match(c) for c in cats)
            or len(set(cats)) != len(cats)
        ):
            return None
        label = r.get("label")
        if label is not None and not isinstance(label, str):
            return None
        if not _is_int(r.get("createdAt")) or not isinstance(r.get("reachable"), bool):
            return None
        ps = r.get("pendingSince")
        if ps is not None and not _is_int(ps):
            return None
        out.append(
            ContactRow(
                agree_key=r["agreeKey"],
                secret=r["secret"],
                cats=tuple(cats),
                created_at=r["createdAt"],
                reachable=r["reachable"],
                label=label,
                pending_since=ps,
            )
        )
    return tuple(out)


@dataclass(frozen=True)
class ConnectStateRecord:
    """What is held for one device and one product."""

    product: str
    device_id: str
    #: The ``pkey-ring+jws`` held (verified when it was stored, and again when it is used).
    ring: str
    #: This device's ``pkey-peer+jws``.
    certificate: str
    #: K_disc, newest first: the current key, then at most one previous key (canonical base64url).
    #: Never shown in the ``repr``.
    disc_keys: List[str] = field(repr=False)
    #: The latest instant (seconds) the previous key may be used, or ``None`` when there is none.
    prev_until: Optional[int]
    #: The epoch of the roster the keys belong to.
    epoch: int
    #: The keys this device registered with the Worker, as ``(signKey, agreeKey)``, so an unchanged
    #: pair is not re-sent.
    registered: Optional[Tuple[str, str]]
    stored_at: int
    #: A pushed roster removed a device, so K_disc was replaced at the Worker and this copy is stale
    #: until the next identity fetch (CC-10.4, ``keysStale`` in Node's record). Absent when false.
    keys_stale: bool = False
    #: The inter-account links this device holds for the product (§15.10), in the order they are held.
    #: Each carries a contact secret: key material of the same standing as K_disc. Never in a ``repr``.
    contacts: Tuple[ContactRow, ...] = field(repr=False, default=())

    def __reduce__(self) -> Any:
        raise TypeError("a Cloud Connect state record cannot be pickled")

    def to_bytes(self) -> bytes:
        reg = None if self.registered is None else {"signKey": self.registered[0], "agreeKey": self.registered[1]}
        doc: Dict[str, Any] = {
            "schema": CONNECT_STATE_SCHEMA,
            "product": self.product,
            "deviceId": self.device_id,
            "ring": self.ring,
            "certificate": self.certificate,
            "discKeys": list(self.disc_keys),
            "prevUntil": self.prev_until,
            "epoch": self.epoch,
            "registered": reg,
            "storedAt": self.stored_at,
        }
        if self.keys_stale:
            doc["keysStale"] = True
        if self.contacts:
            doc["contacts"] = [c.to_json() for c in self.contacts]
        return json.dumps(doc, separators=(",", ":")).encode("utf-8")


def parse_connect_state(raw: bytes) -> Optional[ConnectStateRecord]:
    """The record, or ``None`` when it does not parse or does not have the contract shape."""
    try:
        v = json.loads(bytes(raw).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(v, dict) or v.get("schema") != CONNECT_STATE_SCHEMA:
        return None
    keys = v.get("discKeys")
    reg = v.get("registered")
    prev = v.get("prevUntil")
    if (
        not isinstance(v.get("product"), str)
        or not isinstance(v.get("deviceId"), str)
        or not isinstance(v.get("ring"), str)
        or not isinstance(v.get("certificate"), str)
        or not isinstance(keys, list)
        or not 1 <= len(keys) <= 2
        or not all(isinstance(k, str) and _KEY.match(k) for k in keys)
        or not (prev is None or _is_int(prev))
        or not _is_int(v.get("epoch"))
        or not _is_int(v.get("storedAt"))
    ):
        return None
    contacts: Tuple[ContactRow, ...] = ()
    if "contacts" in v:
        parsed = _parse_contacts(v["contacts"])
        if parsed is None:
            return None
        contacts = parsed
    registered = None
    if reg is not None:
        if (
            not isinstance(reg, dict)
            or not isinstance(reg.get("signKey"), str)
            or not isinstance(reg.get("agreeKey"), str)
        ):
            return None
        registered = (reg["signKey"], reg["agreeKey"])
    return ConnectStateRecord(
        product=v["product"],
        device_id=v["deviceId"],
        ring=v["ring"],
        certificate=v["certificate"],
        disc_keys=list(keys),
        prev_until=prev,
        epoch=v["epoch"],
        registered=registered,
        stored_at=v["storedAt"],
        keys_stale=v.get("keysStale") is True,
        contacts=contacts,
    )


def keys_after_ring(keys: List[str], prior: Any, nxt: Any) -> List[str]:
    """The previous K_disc survives a roster change only while no device left or changed its keys
    (§15.4); otherwise only the newest key is kept. ``prior`` and ``nxt`` are rosters (``.devices``)."""
    if len(keys) != 2:
        return list(keys)
    intact = all(
        any(n.device_id == d.device_id and n.sign_key == d.sign_key and n.agree_key == d.agree_key for n in nxt.devices)
        for d in prior.devices
    )
    return list(keys) if intact else [keys[0]]


def connect_storage(state_dir: str, persistence: str) -> DeviceKeyStorage:
    """The record's home: the file store in the state directory, or memory."""
    if persistence == "memory":
        return InMemoryDeviceKeyStorage()
    return FileDeviceKeyStorage(os.path.join(state_dir, CONNECT_STATE_FILE))
