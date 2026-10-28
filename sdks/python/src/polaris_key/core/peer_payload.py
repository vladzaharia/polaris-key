"""WIRE-CONTRACT-V5 §15.5: handshake payloads. Strict JSON (§1.2), an object, at most 8 KiB. Pure;
mirrors ``packages/client-core/src/peer/payload.ts``."""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, NamedTuple, Optional, Sequence

from .jws import _parse_strict_json

__all__ = [
    "MAX_CAPS",
    "MAX_HANDSHAKE_PAYLOAD",
    "PayloadVerdict",
    "caps_intersection",
    "parse_handshake_payload",
    "parse_strict_object",
    "payload1",
    "payload23",
]

MAX_HANDSHAKE_PAYLOAD = 8192
MAX_CAPS = 32
_CAP = re.compile(r"[a-z0-9]+/[0-9]+\Z")
_MAX_SAFE_INTEGER = 2**53 - 1


class PayloadVerdict(NamedTuple):
    ok: bool
    caps: Optional[List[str]] = None
    ring: Optional[int] = None
    cert: Optional[str] = None


_NO = PayloadVerdict(False)


def parse_strict_object(b: bytes) -> Optional[Dict[str, Any]]:
    """Parse a payload as strict JSON; None on any failure."""
    try:
        value = _parse_strict_json(bytes(b))
    except (ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def parse_handshake_payload(mode: str, message: int, b: bytes) -> PayloadVerdict:
    """Judge one handshake payload: message 1, or message 2 or 3 in a mode."""
    if len(b) > MAX_HANDSHAKE_PAYLOAD:
        return _NO
    o = parse_strict_object(b)
    v = None if o is None else o.get("v")
    if o is None or isinstance(v, bool) or not isinstance(v, int) or v != 1:
        return _NO
    if message == 1:
        return _NO if "cert" in o else PayloadVerdict(True, [])
    caps = o.get("caps")
    if not isinstance(caps, list) or len(caps) > MAX_CAPS:
        return _NO
    if not all(isinstance(c, str) and _CAP.match(c) is not None for c in caps):
        return _NO
    if mode != "a":
        return _NO if "cert" in o else PayloadVerdict(True, list(caps))
    cert, ring = o.get("cert"), o.get("ring")
    if not isinstance(cert, str) or cert == "":
        return _NO
    if isinstance(ring, bool) or not isinstance(ring, int) or ring < 1 or ring > _MAX_SAFE_INTEGER:
        return _NO
    return PayloadVerdict(True, list(caps), ring, cert)


def caps_intersection(a: Sequence[str], b: Sequence[str]) -> List[str]:
    """The capabilities both sides list, once each, in byte order."""
    return sorted({c for c in a if c in b}, key=lambda s: s.encode("utf-8"))


def payload1() -> bytes:
    """The bytes of message 1's payload."""
    return b'{"v":1}'


def payload23(mode: str, caps: Sequence[str], account: Optional[Dict[str, Any]] = None) -> bytes:
    """The bytes of message 2 or 3: ``cert`` and ``ring`` in mode a only."""
    o: Dict[str, Any] = {"v": 1}
    if mode == "a":
        if account is None:
            raise ValueError("account payload")
        o["cert"] = account["cert"]
        o["ring"] = account["ring"]
    o["caps"] = list(caps)
    out = json.dumps(o, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(out) > MAX_HANDSHAKE_PAYLOAD:
        raise ValueError("payload size")
    return out
