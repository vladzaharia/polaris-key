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
from typing import Any, List, Optional, Tuple

from ..devices.keys import DeviceKeyStorage, FileDeviceKeyStorage, InMemoryDeviceKeyStorage

__all__ = [
    "CONNECT_STATE_SCHEMA",
    "CONNECT_STATE_FILE",
    "ConnectStateRecord",
    "parse_connect_state",
    "connect_storage",
]

CONNECT_STATE_SCHEMA = "pkey.connect.v1"
CONNECT_STATE_FILE = "pkey.connect.v1.json"

_KEY = re.compile(r"[A-Za-z0-9_-]{43}\Z")


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


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

    def __reduce__(self) -> Any:
        raise TypeError("a Cloud Connect state record cannot be pickled")

    def to_bytes(self) -> bytes:
        reg = None if self.registered is None else {"signKey": self.registered[0], "agreeKey": self.registered[1]}
        return json.dumps(
            {
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
            },
            separators=(",", ":"),
        ).encode("utf-8")


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
    )


def connect_storage(state_dir: str, persistence: str) -> DeviceKeyStorage:
    """The record's home: the file store in the state directory, or memory."""
    if persistence == "memory":
        return InMemoryDeviceKeyStorage()
    return FileDeviceKeyStorage(os.path.join(state_dir, CONNECT_STATE_FILE))
