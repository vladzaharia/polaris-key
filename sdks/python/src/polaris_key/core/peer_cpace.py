"""WIRE-CONTRACT-V5 §15.12, "The mode-q handshake": CPace for account-free local pairing. Suite
CPACE-X25519-SHA512 of draft-irtf-cfrg-cpace-21 in its initiator-responder setting, written from the draft's
text: the string functions (``prepend_len``, ``lv_cat``, ``generator_string``, ``transcript_ir``),
``decodeUCoordinate``, the Elligator 2 map, the share check, the ISK, the PSK that feeds Noise, and the two
frames (C1, C2) that run before it. Nothing here does I/O. Mirrors ``packages/client-core/src/peer/cpace.ts``.

Timing. Every scalar multiplication runs through the ``NoisePorts`` X25519 (``cryptography``, constant time).
The Elligator 2 map does not: it runs over Python integers, whose arithmetic is variable-time, and its input is
derived from the password. The shower makes its generators at every rotation, before its window takes the next
C1, and a joiner that scanned a QR makes its own before it dials. A joiner that typed a code cannot: the ``sid``
is the advert's instance, so its map runs between a chosen advert and its connection, at most twice per code
and 300 s (the dial budget, :mod:`.peer_local`). Callers MUST make a generator ahead of the connection that
needs it, never inside the reply to a peer's frame.

A share or a K that breaks a rule is a refusal, not an exception: the caller closes the connection silently and
counts no failure (§15.12 step 3).
"""

from __future__ import annotations

import hashlib
import os
from typing import Any, Callable, Dict, NamedTuple, Optional, Union

from .device_proof import is_x25519_low_order
from .peer_noise import NoisePorts, hkdf_sha256

__all__ = [
    "CPACE_C1_LENGTH",
    "CPACE_C2_LENGTH",
    "CPACE_FRAME_VERSION",
    "CPACE_KIND_BYTE",
    "CPACE_QR_SECRET_BYTES",
    "CPACE_SHARE_LENGTH",
    "Elligator2Result",
    "cpace_generator",
    "cpace_isk",
    "cpace_prs_code",
    "cpace_prs_qr",
    "cpace_psk",
    "cpace_scalar",
    "cpace_share",
    "check_share",
    "elligator2",
    "encode_c1",
    "encode_c2",
    "generator_string",
    "lv_cat",
    "parse_c1",
    "parse_c2",
    "prepend_len",
    "transcript_ir",
]

#: The first byte of both frames.
CPACE_FRAME_VERSION = 0x01
#: The kind byte of C1: ``0x01`` for a code, ``0x02`` for a QR.
CPACE_KIND_BYTE: Dict[str, int] = {"code": 0x01, "qr": 0x02}
CPACE_C1_LENGTH = 34
CPACE_C2_LENGTH = 33
CPACE_SHARE_LENGTH = 32
#: The QR secret, in bytes (``LOCAL_QR_SECRET_BYTES``).
CPACE_QR_SECRET_BYTES = 16

_DSI = b"CPace255"
_DSI_ISK = b"CPace255_ISK"
#: SHA-512's input block size, the draft's ``s_in_bytes``.
_S_IN_BYTES = 128
_DEFAULT_PORTS = NoisePorts()

# -- The draft's string functions (appendix A) ------------------------------------------------------


def prepend_len(data: bytes) -> bytes:
    """``prepend_len``: the LEB128 length, then the data."""
    n = len(data)
    out = bytearray()
    while n >= 128:
        out.append((n % 128) + 128)
        n //= 128
    out.append(n)
    return bytes(out) + bytes(data)


def lv_cat(*args: bytes) -> bytes:
    """``lv_cat``: every argument length-prefixed, then concatenated."""
    return b"".join(prepend_len(a) for a in args)


def generator_string(dsi: bytes, prs: bytes, ci: bytes, sid: bytes, s_in_bytes: int) -> bytes:
    """``generator_string(DSI, PRS, CI, sid, s_in_bytes)``."""
    zpad = max(0, s_in_bytes - 1 - len(prepend_len(prs)) - len(prepend_len(dsi)))
    return lv_cat(dsi, prs, bytes(zpad), ci, sid)


def transcript_ir(ya: bytes, ada: bytes, yb: bytes, adb: bytes) -> bytes:
    """``transcript_ir(Ya, ADa, Yb, ADb)``."""
    return lv_cat(ya, ada) + lv_cat(yb, adb)


# -- The field, decodeUCoordinate and the Elligator 2 map -------------------------------------------

#: The prime of Curve25519, 2^255 - 19.
_P = (1 << 255) - 19
#: The Montgomery coefficient A of Curve25519 (B = 1).
_A = 486662
#: The non-square the draft's ``find_z_ell2`` finds for Curve25519.
_Z = 2


def _decode_u(u: bytes) -> int:
    """``decodeUCoordinate(u, 255)``: bit 255 cleared, the rest read little-endian; not reduced."""
    masked = bytearray(u)
    masked[31] &= 0x7F
    return int.from_bytes(bytes(masked), "little")


def _encode_u(x: int) -> bytes:
    """32 little-endian bytes of a field element in ``[0, p)``."""
    return x.to_bytes(32, "little")


class Elligator2Result(NamedTuple):
    #: ``decodeUCoordinate(input) mod p``, 32 bytes.
    r: bytes
    #: Whether ``v = -A / (1 + 2 r^2)`` is on the curve; otherwise the result comes from the twist.
    on_curve: bool
    #: The u-coordinate of the result, 32 bytes little-endian.
    u: bytes


def elligator2(data: bytes) -> Elligator2Result:
    """The draft's ``map_to_curve_elligator2`` for Curve25519 (Z = 2) on 32 input bytes. It is variable time
    (see the file header): run it ahead of the connection, never on the network path."""
    if len(data) != 32:
        raise ValueError("elligator2: 32 bytes")
    r = _decode_u(bytes(data)) % _P
    # 1 + 2 r^2 is never 0: -1/2 is a non-square mod p, since p = 5 (mod 8).
    v = (-_A * pow(1 + _Z * r * r, _P - 2, _P)) % _P
    gv = (v * v * v + _A * v * v + v) % _P
    eps = pow(gv, (_P - 1) // 2, _P)
    # g(v) is never 0 (A^2 - 4 is a non-square), so eps is 1 or p - 1.
    if eps != 1 and eps != _P - 1:
        raise ValueError("elligator2: g(v) is zero")
    on_curve = eps == 1
    return Elligator2Result(_encode_u(r), on_curve, _encode_u(v if on_curve else (-v - _A) % _P))


# -- The password-related string and the generator --------------------------------------------------


def cpace_prs_code(digits: str) -> bytes:
    """``"pkey-peer/1 code" || 0x00 || <the 6 ASCII password digits>``."""
    if not (isinstance(digits, str) and len(digits) == 6 and digits.isascii() and digits.isdigit()):
        raise ValueError("cpace: password")
    return b"pkey-peer/1 code\x00" + digits.encode("ascii")


def cpace_prs_qr(secret: bytes) -> bytes:
    """``"pkey-peer/1 qr" || 0x00 || <the 16 secret bytes>``."""
    if len(secret) != CPACE_QR_SECRET_BYTES:
        raise ValueError("cpace: QR secret")
    return b"pkey-peer/1 qr\x00" + bytes(secret)


def cpace_generator(prs: bytes, ci: bytes, sid: bytes) -> bytes:
    """The generator: ``g = elligator2(SHA-512(generator_string(DSI, PRS, CI, sid, 128))[0..32])``, its
    u-coordinate as 32 bytes. ``ci`` is the mode-q prologue and ``sid`` the window's 10 bytes."""
    h = hashlib.sha512(generator_string(_DSI, bytes(prs), bytes(ci), bytes(sid), _S_IN_BYTES)).digest()[:32]
    return elligator2(h).u


# -- Shares and the refusals (§15.12 step 3) --------------------------------------------------------


def check_share(y: bytes) -> Dict[str, Any]:
    """A share is 32 bytes, canonical (bit 255 clear and u < 2^255 - 19) and not one of the low-order points.
    The canonical check comes first, so the low-order points at or above p refuse as non-canonical. This is
    stricter than the draft, which processes a non-canonical share. ``{"ok": True}`` or
    ``{"ok": False, "reason": "length" | "non-canonical" | "low-order"}``."""
    if len(y) != CPACE_SHARE_LENGTH:
        return {"ok": False, "reason": "length"}
    if (y[31] & 0x80) != 0 or _decode_u(bytes(y)) >= _P:
        return {"ok": False, "reason": "non-canonical"}
    if is_x25519_low_order(bytes(y)):
        return {"ok": False, "reason": "low-order"}
    return {"ok": True}


def cpace_scalar(random: Optional[Callable[[int], bytes]] = None) -> bytearray:
    """A fresh 32-byte scalar (a ``bytearray``, so it can be wiped). X25519 clamps it."""
    return bytearray((random or os.urandom)(32))


def cpace_share(y: bytes, g: bytes, ports: Optional[NoisePorts] = None) -> Optional[bytes]:
    """``Y = X25519(y, g)``. ``None`` when the backend refuses (a degenerate generator)."""
    out = (ports or _DEFAULT_PORTS).dh(bytes(y), bytes(g))
    return None if out is None or len(out) != 32 or int.from_bytes(out, "big") == 0 else out


def _wipe(b: Union[bytes, bytearray]) -> None:
    if isinstance(b, bytearray):
        for i in range(len(b)):
            b[i] = 0


def cpace_isk(
    sid: bytes,
    scalar: Union[bytes, bytearray],
    ya: bytes,
    yb: bytes,
    role: str,
    ports: Optional[NoisePorts] = None,
) -> Optional[bytes]:
    """``ISK = SHA-512(lv_cat("CPace255_ISK", sid, K) || transcript_ir(Ya, "", Yb, ""))``, 64 bytes, or
    ``None`` when K is 32 zero bytes (or the backend refuses the peer's share): the attempt aborts silently.
    The peer's share must already have passed :func:`check_share`. A ``bytearray`` scalar is overwritten."""
    peer = yb if role == "initiator" else ya
    k = (ports or _DEFAULT_PORTS).dh(bytes(scalar), bytes(peer))
    _wipe(scalar)
    if k is None or len(k) != 32 or int.from_bytes(k, "big") == 0:
        return None
    return hashlib.sha512(lv_cat(_DSI_ISK, bytes(sid), k) + transcript_ir(ya, b"", yb, b"")).digest()


def cpace_psk(isk: bytes, slug: str) -> bytes:
    """The Noise PSK of a pairing attempt: ``HKDF-SHA256(salt = empty, ikm = ISK, info = "pkey-peer/1 cpace" ||
    0x00 || slug)``."""
    return hkdf_sha256(b"", bytes(isk), b"pkey-peer/1 cpace\x00" + slug.encode("utf-8"), 32)


# -- The frames C1 and C2 (§15.12 step 2) -----------------------------------------------------------


def encode_c1(kind: str, ya: bytes) -> bytes:
    """C1, joiner to shower: ``0x01 || kind || Ya``, 34 bytes."""
    return bytes([CPACE_FRAME_VERSION, CPACE_KIND_BYTE[kind]]) + bytes(ya)


def encode_c2(yb: bytes) -> bytes:
    """C2, shower to joiner: ``0x01 || Yb``, 33 bytes."""
    return bytes([CPACE_FRAME_VERSION]) + bytes(yb)


def parse_c1(b: bytes) -> Dict[str, Any]:
    """The receiver's judgement of C1: length, version, kind, then the share. ``{"ok": True, "kind", "share"}``
    or ``{"ok": False, "reason": "length" | "version" | "kind" | "non-canonical" | "low-order"}``."""
    if len(b) != CPACE_C1_LENGTH:
        return {"ok": False, "reason": "length"}
    if b[0] != CPACE_FRAME_VERSION:
        return {"ok": False, "reason": "version"}
    kind = "code" if b[1] == CPACE_KIND_BYTE["code"] else "qr" if b[1] == CPACE_KIND_BYTE["qr"] else None
    if kind is None:
        return {"ok": False, "reason": "kind"}
    share = bytes(b[2:])
    v = check_share(share)
    return {"ok": True, "kind": kind, "share": share} if v["ok"] else {"ok": False, "reason": v["reason"]}


def parse_c2(b: bytes) -> Dict[str, Any]:
    """The receiver's judgement of C2: length, version, then the share."""
    if len(b) != CPACE_C2_LENGTH:
        return {"ok": False, "reason": "length"}
    if b[0] != CPACE_FRAME_VERSION:
        return {"ok": False, "reason": "version"}
    share = bytes(b[1:])
    v = check_share(share)
    return {"ok": True, "share": share} if v["ok"] else {"ok": False, "reason": v["reason"]}
