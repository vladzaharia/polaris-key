"""WIRE-CONTRACT-V5 §15.4: discovery adverts. Pure functions: the account instance name, the product
tag, TXT parsing and the browse match. Nothing here does I/O or reads a clock (``now`` is passed in).
Mirrors ``packages/client-core/src/peer/advert.ts``."""

from __future__ import annotations

import base64
import re
from typing import Any, Dict, List, NamedTuple, Optional, Sequence

from .peer_noise import hmac_sha256, sha256

__all__ = [
    "ADVERT_EPOCH_SECONDS",
    "BrowseHit",
    "account_instance",
    "advert_epoch",
    "base32_lower",
    "browse_account_instance",
    "device_id_bytes",
    "is_instance_name",
    "parse_txt",
    "product_tag",
]

ADVERT_EPOCH_SECONDS = 900
_MAX_BROWSE_ROSTER = 128
_DEVICE_ID = re.compile(r"[A-Za-z0-9_-]{32}\Z")
_INSTANCE = re.compile(r"p1-[a-z2-7]{16}\Z")
_TAG = re.compile(r"[0-9a-f]{16}\Z")


def advert_epoch(now_seconds: int) -> int:
    return int(now_seconds // ADVERT_EPOCH_SECONDS)


def base32_lower(b: bytes) -> str:
    """RFC 4648 base32, lower-case alphabet, no padding."""
    return base64.b32encode(bytes(b)).decode("ascii").rstrip("=").lower()


def device_id_bytes(device_id: str) -> bytes:
    """A device id is 32 base64url characters: the 24 bytes the advert and the relay use."""
    if not isinstance(device_id, str) or _DEVICE_ID.match(device_id) is None:
        raise ValueError("device id")
    return base64.urlsafe_b64decode(device_id)


def _u64(n: int) -> bytes:
    return n.to_bytes(8, "big")


def account_instance(k_disc: bytes, epoch: int, device_id: str) -> str:
    """The mode-a instance name of a device in one epoch under one discovery key."""
    mac = hmac_sha256(k_disc, b"pkey-peer/1 disc\x00" + _u64(epoch) + device_id_bytes(device_id))
    return "p1-" + base32_lower(mac)[:16]


def product_tag(slug: str, epoch: int) -> str:
    """The ``h`` TXT value of the approver and pair adverts."""
    salt = sha256(b"pkey-peer/1 salt\x00", slug.encode("utf-8"))
    return hmac_sha256(salt, b"pkey-peer/1 pair\x00" + _u64(epoch)).hex()[:16]


def is_instance_name(name: str) -> bool:
    return isinstance(name, str) and _INSTANCE.match(name) is not None


def parse_txt(entries: Sequence[str]) -> Dict[str, Any]:
    """``{"ok": True, "mode": ..., "h": ...}`` or ``{"ok": False, "reason": ...}`` (``duplicate``,
    ``version``, ``mode``, ``tag``). An entry splits at its first ``=``; one without ``=`` or with an
    empty key is ignored; a repeated key refuses."""
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
    m = kv.get("m")
    if m not in ("a", "v", "p"):
        return {"ok": False, "reason": "mode"}
    if m == "a":
        return {"ok": True, "mode": m}
    h = kv.get("h")
    if h is None or _TAG.match(h) is None:
        return {"ok": False, "reason": "tag"}
    return {"ok": True, "mode": m, "h": h}


class BrowseHit(NamedTuple):
    device_id: str
    #: 0 the current epoch, 1 the previous one.
    epoch_back: int
    #: 0 the newest discovery key, 1 the previous one.
    key_index: int


def browse_account_instance(
    instance: str, k_discs: Sequence[bytes], now_seconds: int, roster: Sequence[str]
) -> Optional[BrowseHit]:
    """Which roster device an account instance belongs to: the current and the previous epoch, the
    (at most two) delivered keys, newest first. At most 512 HMACs for a 128-device roster."""
    if not is_instance_name(instance):
        return None
    epoch = advert_epoch(now_seconds)
    hits: List[BrowseHit] = []
    for epoch_back in (0, 1):
        if epoch - epoch_back < 0:
            continue
        for i in range(min(len(k_discs), 2)):
            for device_id in roster[:_MAX_BROWSE_ROSTER]:
                if account_instance(k_discs[i], epoch - epoch_back, device_id) == instance:
                    hits.append(BrowseHit(device_id, epoch_back, i))
                    return hits[0]
    return None
