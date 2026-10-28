"""WIRE-CONTRACT-V5 §15.5: the short authentication code of modes v and p, with its commit and
reveal. Nonces and commitments travel as 43 canonical base64url characters. Pure; mirrors
``packages/client-core/src/peer/sas.ts``."""

from __future__ import annotations

import hmac
import json
import re
from typing import Optional

from .b64url import b64url_decode, b64url_encode
from .peer_noise import hkdf_sha256, sha256

__all__ = [
    "decode_sas_value",
    "encode_sas_value",
    "parse_sas_body",
    "sas_body",
    "sas_commit",
    "sas_display",
    "sas_reveal_ok",
    "sas_value",
]

_VALUE = re.compile(r"[A-Za-z0-9_-]{43}\Z")
_MEMBERS = ("c", "nM", "nD")


def sas_commit(n_d: bytes) -> bytes:
    return sha256(n_d)


def encode_sas_value(b: bytes) -> str:
    """32 bytes as 43 base64url characters."""
    if len(b) != 32:
        raise ValueError("sas value")
    return b64url_encode(bytes(b))


def decode_sas_value(text: str) -> Optional[bytes]:
    """43 canonical base64url characters to 32 bytes; anything else is None."""
    if not isinstance(text, str) or _VALUE.match(text) is None:
        return None
    try:
        b = b64url_decode(text)
    except ValueError:
        return None
    return b if len(b) == 32 and b64url_encode(b) == text else None


def sas_body(member: str, value: bytes) -> bytes:
    """The body of SAS_COMMIT (``c``), SAS_NONCE (``nM``) or SAS_REVEAL (``nD``): compact JSON, one member."""
    if member not in _MEMBERS:
        raise ValueError("sas member")
    return json.dumps({member: encode_sas_value(value)}, separators=(",", ":")).encode("utf-8")


def parse_sas_body(member: str, body: bytes) -> Optional[bytes]:
    """Read a body; None when it is anything but the canonical one-member object."""
    if member not in _MEMBERS:
        raise ValueError("sas member")
    try:
        text = bytes(body).decode("utf-8")
    except UnicodeDecodeError:
        return None
    m = re.match(r'\{"' + member + r'":"([A-Za-z0-9_-]+)"\}\Z', text)
    return None if m is None else decode_sas_value(m.group(1))


def sas_value(h: bytes, n_d: bytes, n_m: bytes, mode: str) -> int:
    """The code, 0..999999, from the handshake hash and both nonces."""
    okm = hkdf_sha256(bytes(h), bytes(n_d) + bytes(n_m), b"pkey-peer/1 sas\x00" + mode.encode("utf-8"), 32)
    return int.from_bytes(okm[:4], "big") % 1_000_000


def sas_display(n: int) -> str:
    """Six digits with leading zeros, a space between the triples."""
    s = str(n).rjust(6, "0")
    return s[:3] + " " + s[3:]


def sas_reveal_ok(c: str, n_d: str) -> bool:
    """Does the revealed nonce match the commitment? Both are the base64url spelling."""
    commit = decode_sas_value(c)
    nonce = decode_sas_value(n_d)
    if commit is None or nonce is None:
        return False
    return hmac.compare_digest(sha256(nonce), commit)
