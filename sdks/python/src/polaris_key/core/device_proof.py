"""The device proof ``pkey-proof/1`` (WIRE-CONTRACT-V5 §12.11.1, §15.8; plans/CC-01.md R-6): the
message a device signs and a verifier for it, both pure. The signing key and its store are
:mod:`polaris_key.devices.keys`; this module only builds the bytes to sign and checks a signature
against them. The vectors are ``conformance/corpus/v2/device-proof.json``.

Mirrors ``packages/client-core/src/deviceProof.ts``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Optional, Tuple

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .b64url import b64url_decode
from .jws import ed25519_prechecks

__all__ = [
    "DEVICE_PROOF_VERSION",
    "DEVICE_PROOF_KEYS_SKEW_SECONDS",
    "DEVICE_PROOF_PURPOSES",
    "DeviceProofFields",
    "DeviceProof",
    "Ed25519VerifyPort",
    "device_proof_keys_value",
    "device_proof_message",
    "is_x25519_low_order",
    "verify_device_proof",
]

DEVICE_PROOF_VERSION = "pkey-proof/1"

#: The ``keys`` proof's skew window, in seconds either side of now.
DEVICE_PROOF_KEYS_SKEW_SECONDS = 300

#: The nine purposes, in the order of V5 §12.11.1.
DEVICE_PROOF_PURPOSES: Tuple[str, ...] = (
    "keys",
    "nonce",
    "exchange",
    "link",
    "nearby-start",
    "nearby-poll",
    "nearby-approve",
    "vouch",
    "restore",
)

# `\Z`, not `$`: `$` also matches before a final newline. Printable ASCII without space only.
_LINE_FIELD = re.compile(r"[\x21-\x7e]+\Z")
_KEYS_VALUE = re.compile(r"([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,15})\Z")
_P25519 = 2**255 - 19
_MAX_SAFE_INTEGER = 2**53 - 1
#: The u-coordinates of the five low-order X25519 points (0, 1, the two of order 8, p - 1).
_X25519_LOW_ORDER_U = frozenset(
    (
        0,
        1,
        325606250916557431795983626356110631294008115727848805560023387167927233504,
        39382357235489614581723060781553021112529911719440698176882885853963445705823,
        _P25519 - 1,
    )
)

#: Verifies ``sig`` by the raw 32-byte ``key`` over ``message``, after the V5 §1.1 prechecks.
Ed25519VerifyPort = Callable[[bytes, bytes, bytes], bool]


@dataclass(frozen=True)
class DeviceProofFields:
    """The six message lines' fields (line 1 is the version)."""

    purpose: str
    #: The product slug.
    product: str
    #: The ``X-PKey-Device`` value.
    device_id: str
    #: The purpose's value (line 5).
    value: str
    #: Base64url SHA-256 of the presented provider token, or ``-`` when none (line 6).
    token_hash: str = "-"


@dataclass(frozen=True)
class DeviceProof(DeviceProofFields):
    """A signed proof: the fields, the signing key (raw 32 bytes, base64url) and the 64-byte
    signature (base64url)."""

    sign_key: str = ""
    sig: str = ""


def device_proof_keys_value(sign_key: str, agree_key: str, issued_at: int) -> str:
    """The ``keys`` purpose's value: ``<signKey>.<agreeKey>.<issuedAt>``."""
    return f"{sign_key}.{agree_key}.{issued_at}"


def device_proof_message(f: DeviceProofFields) -> Optional[bytes]:
    """The bytes a device signs, or ``None`` when a field would break the line format."""
    lines = (DEVICE_PROOF_VERSION, f.purpose, f.product, f.device_id, f.value, f.token_hash)
    for line in lines:
        if not isinstance(line, str) or _LINE_FIELD.match(line) is None:
            return None
    return "\n".join(lines).encode("ascii")


def _raw32(s: object) -> Optional[bytes]:
    """A canonical base64url of exactly 32 bytes, decoded, or ``None``."""
    if not isinstance(s, str) or len(s) != 43:
        return None
    try:
        b = b64url_decode(s)
    except ValueError:
        return None
    return b if len(b) == 32 else None


def is_x25519_low_order(enc32: bytes) -> bool:
    """WIRE-CONTRACT-V5 §15.2 step 4: true when a raw 32-byte X25519 public key is a low-order point.
    The high bit is masked and the value reduced mod p (RFC 7748 §5), so every spelling of the five
    low-order u-coordinates is caught, canonical or not."""
    if len(enc32) != 32:
        return False
    u = (int.from_bytes(enc32, "little") & ((1 << 255) - 1)) % _P25519
    return u in _X25519_LOW_ORDER_U


def _agree_key_ok(s: str) -> bool:
    """The one X25519 spelling an issuer accepts: bit 255 clear, u < p, and not a low-order point."""
    k = _raw32(s)
    if k is None or (k[31] & 0x80) != 0 or is_x25519_low_order(k):
        return False
    return int.from_bytes(k, "little") < _P25519


def _keys_value_ok(p: DeviceProof, now: Optional[int]) -> bool:
    if p.token_hash != "-" or now is None:
        return False
    m = _KEYS_VALUE.match(p.value)
    if m is None or m.group(1) != p.sign_key or not _agree_key_ok(m.group(2)):
        return False
    issued_at = int(m.group(3))
    return issued_at <= _MAX_SAFE_INTEGER and abs(issued_at - now) <= DEVICE_PROOF_KEYS_SKEW_SECONDS


def cryptography_ed25519_verify(key: bytes, sig: bytes, message: bytes) -> bool:
    """The default port: ``cryptography``'s Ed25519."""
    try:
        Ed25519PublicKey.from_public_bytes(key).verify(sig, message)
        return True
    except (InvalidSignature, ValueError):
        return False


def verify_device_proof(
    proof: DeviceProof,
    *,
    now: Optional[int] = None,
    verify: Optional[Ed25519VerifyPort] = None,
) -> bool:
    """True only for a strict Ed25519 proof by ``sign_key`` (V5 §12.11.1); it never says why not.
    ``now`` (epoch seconds) is needed for purpose ``keys``, whose ``issuedAt`` must lie within the
    skew window."""
    if proof.purpose not in DEVICE_PROOF_PURPOSES:
        return False
    key = _raw32(proof.sign_key)
    if key is None:
        return False
    message = device_proof_message(proof)
    if message is None:
        return False
    if proof.purpose == "keys" and not _keys_value_ok(proof, now):
        return False
    sig_text = proof.sig
    if not isinstance(sig_text, str) or len(sig_text) != 86:
        return False
    try:
        sig = b64url_decode(sig_text)
    except ValueError:
        return False
    if len(sig) != 64 or not ed25519_prechecks(key, sig):
        return False
    return (verify or cryptography_ed25519_verify)(key, sig, message)
