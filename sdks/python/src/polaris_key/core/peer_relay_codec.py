"""WIRE-CONTRACT-V5 §15.7: relay envelopes, one binary WebSocket message each. A device is its 24
decoded device-id bytes. A message that does not match its layout exactly is refused.

A message is a ``dict`` with an ``op`` key, as in the Node reference (``send`` and ``recv`` carry
``to`` or ``from``, ``session`` and ``noise``; ``members`` a ``devices`` list; ``ring`` an ``epoch``;
``ping`` and ``pong`` ``data``; ``gone`` a ``device``; ``limit`` a ``reason`` 1 to 4)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

__all__ = ["RELAY_MAX_MESSAGE", "decode_relay", "encode_relay"]

RELAY_MAX_MESSAGE = 65564
_MAX_SAFE_INTEGER = 2**53 - 1

_OPS = {
    "send": 0x01,
    "list": 0x02,
    "ping": 0x03,
    "recv": 0x81,
    "members": 0x82,
    "ring": 0x83,
    "pong": 0x84,
    "gone": 0x85,
    "limit": 0x86,
}


def _need(ok: bool) -> None:
    if not ok:
        raise ValueError("relay envelope")


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def encode_relay(m: Dict[str, Any]) -> bytes:
    """Encode one message; raises ``ValueError`` on a value its layout cannot hold."""
    name = m.get("op")
    _need(isinstance(name, str) and name in _OPS)
    op = bytes([_OPS[name]])
    if name in ("send", "recv"):
        dev = m["to"] if name == "send" else m["from"]
        session, noise = m["session"], m["noise"]
        _need(len(dev) == 24 and _is_int(session) and 0 <= session <= 0xFFFFFFFF)
        _need(1 <= len(noise) <= 65535)
        out = op + bytes(dev) + session.to_bytes(4, "big") + bytes(noise)
    elif name == "list":
        out = op
    elif name in ("ping", "pong"):
        _need(len(m["data"]) == 8)
        out = op + bytes(m["data"])
    elif name == "members":
        devs = m["devices"]
        _need(len(devs) <= 255 and all(len(d) == 24 for d in devs))
        out = op + bytes([len(devs)]) + b"".join(bytes(d) for d in devs)
    elif name == "ring":
        e = m["epoch"]
        _need(_is_int(e) and 0 <= e <= _MAX_SAFE_INTEGER)
        out = op + e.to_bytes(8, "big")
    elif name == "gone":
        _need(len(m["device"]) == 24)
        out = op + bytes(m["device"])
    else:  # limit
        r = m["reason"]
        _need(_is_int(r) and 1 <= r <= 4)
        out = op + bytes([r])
    _need(len(out) <= RELAY_MAX_MESSAGE)
    return out


def decode_relay(direction: str, b: bytes) -> Optional[Dict[str, Any]]:
    """Decode one message. ``direction`` is who sent it: ``toRoom`` or ``toClient``. None means
    refused (the caller closes the socket)."""
    if direction not in ("toRoom", "toClient"):
        raise ValueError("direction")
    if len(b) < 1 or len(b) > RELAY_MAX_MESSAGE:
        return None
    op = b[0]
    rest = bytes(b[1:])
    n = len(rest)
    if direction == "toRoom":
        if op == 0x01 and n >= 29:
            return {"op": "send", "to": rest[:24], "session": int.from_bytes(rest[24:28], "big"), "noise": rest[28:]}
        if op == 0x02 and n == 0:
            return {"op": "list"}
        if op == 0x03 and n == 8:
            return {"op": "ping", "data": rest}
        return None
    if op == 0x81 and n >= 29:
        return {"op": "recv", "from": rest[:24], "session": int.from_bytes(rest[24:28], "big"), "noise": rest[28:]}
    if op == 0x82 and n >= 1 and n == 1 + rest[0] * 24:
        devices: List[bytes] = [rest[1 + i * 24 : 25 + i * 24] for i in range(rest[0])]
        return {"op": "members", "devices": devices}
    if op == 0x83 and n == 8:
        epoch = int.from_bytes(rest, "big")
        if epoch > _MAX_SAFE_INTEGER:
            return None
        return {"op": "ring", "epoch": epoch}
    if op == 0x84 and n == 8:
        return {"op": "pong", "data": rest}
    if op == 0x85 and n == 24:
        return {"op": "gone", "device": rest}
    if op == 0x86 and n == 1 and 1 <= rest[0] <= 4:
        return {"op": "limit", "reason": rest[0]}
    return None
