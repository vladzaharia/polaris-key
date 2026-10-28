"""The device key port and the ``pkey-proof/1`` signer (CC-26.3; plans/CC-01.md R-5, R-6).

Pure: the host supplies a :class:`DeviceKeyPort` (:mod:`polaris_key.devices.keys` has the store)
and this module builds the bytes to sign, signs them through the port and checks the result against
the strict verifier before returning it. The private halves of both keys stay inside the port:
nothing here asks for them, and nothing here can.

Mirrors ``packages/client-core/src/deviceKeys.ts``.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

try:  # Protocol is 3.8+; kept explicit for the 3.9 floor.
    from typing import Protocol
except ImportError:  # pragma: no cover
    from typing_extensions import Protocol  # type: ignore[assignment]

from .b64url import b64url_encode
from .device_proof import (
    DeviceProof,
    DeviceProofFields,
    Ed25519VerifyPort,
    device_proof_keys_value,
    device_proof_message,
    verify_device_proof,
)

__all__ = [
    "DevicePublicKeys",
    "DeviceKeyPort",
    "DeviceKeyError",
    "DeviceKeyUnsupportedError",
    "DeviceKeysUnreadableError",
    "DeviceKeyStoreError",
    "DeviceProofError",
    "DeviceKeysRequest",
    "sign_device_proof",
    "sign_keys_proof",
    "build_device_keys_request",
]


class DeviceKeyError(Exception):
    """Base of the key store's own errors. The text never names a key, a seed or a signature."""


class DeviceKeyUnsupportedError(DeviceKeyError):
    """The store cannot hold or use the keys here (no Ed25519 or X25519, no storage it may use, a
    memory-only store asked to register). Never reported for a record that merely failed to parse."""


class DeviceKeysUnreadableError(DeviceKeyError):
    """The stored key record exists but cannot be used (it does not parse, its public halves do
    not match its private halves). It is never replaced automatically: replacing it would silently
    change the device's identity. Only ``wipe()`` clears it; ``ensure()`` then makes a new pair."""

    def __init__(self, message: str = "device keys: the record is unreadable") -> None:
        super().__init__(message)


class DeviceKeyStoreError(DeviceKeyError):
    """The store could not be used right now: an I/O fault, a path it refuses (foreign owner, loose
    mode, symlink), or a lock it could not take. Nothing was changed, and nothing reads as "no keys"."""


class DeviceProofError(DeviceKeyError):
    """A proof could not be built or did not verify. The text never names a key or a signature."""


@dataclass(frozen=True)
class DevicePublicKeys:
    """A device's two public keys: raw 32 bytes, canonical base64url (43 characters)."""

    #: The Ed25519 signing key.
    sign_key: str
    #: The X25519 agreement key.
    agree_key: str
    #: The local generation: 1 for the first key pair, plus one on every ``rotate()``. The store's
    #: own count, not the server's ``keySeq`` (the answer to ``PUT /devices/keys``).
    generation: int


class DeviceKeyPort(Protocol):
    """Custody of one device's signing (Ed25519) and agreement (X25519) keys. Keys are made on
    first need and never leave the port: callers get public halves, signatures and shared secrets."""

    def ensure(self) -> DevicePublicKeys:
        """The public keys, making the key pair first if the store holds none."""
        ...

    def public_keys(self) -> Optional[DevicePublicKeys]:
        """The public keys, or ``None`` when the store holds none. Never makes keys."""
        ...

    def sign(self, message: bytes) -> bytes:
        """The 64-byte Ed25519 signature by the signing key over ``message``."""
        ...

    def dh(self, peer_public: bytes) -> Optional[bytes]:
        """X25519 with the agreement key and a peer's raw public key; ``None`` when the peer key
        is refused (wrong length, low order, an all-zero result) or there are no keys."""
        ...

    def rotate(self) -> DevicePublicKeys:
        """Replaces both keys with a new pair and returns it (``generation`` + 1)."""
        ...

    def persistence(self) -> str:
        """``"durable"`` survives a restart, ``"memory"`` dies with the process. A memory port
        must not register keys."""
        ...

    def wipe(self) -> None:
        """Deletes both keys. The next ``ensure()`` makes a new pair, ``generation`` starting again."""
        ...


_PRODUCT_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")


def _refuse_memory_only(port: DeviceKeyPort, allow_ephemeral: bool) -> None:
    if allow_ephemeral:
        return
    persistence = getattr(port, "persistence", None)
    if callable(persistence) and persistence() == "memory":
        raise DeviceKeyUnsupportedError("memory-only")


def _sign_any(
    port: DeviceKeyPort,
    fields: DeviceProofFields,
    now: Optional[int],
    verify: Optional[Ed25519VerifyPort],
) -> DeviceProof:
    before = port.ensure()
    message = device_proof_message(fields)
    if message is None:
        raise DeviceProofError("device proof: bad field")
    sig = b64url_encode(port.sign(message))
    after = port.public_keys()
    if after is None or after.sign_key != before.sign_key or after.generation != before.generation:
        raise DeviceProofError("device proof: keys changed while signing")
    proof = DeviceProof(
        purpose=fields.purpose,
        product=fields.product,
        device_id=fields.device_id,
        value=fields.value,
        token_hash=fields.token_hash,
        sign_key=before.sign_key,
        sig=sig,
    )
    if not verify_device_proof(proof, now=int(time.time()) if now is None else now, verify=verify):
        raise DeviceProofError("device proof: did not verify")
    return proof


def sign_device_proof(
    port: DeviceKeyPort,
    *,
    purpose: str,
    product: str,
    device_id: str,
    value: str,
    token_hash: str = "-",
    now: Optional[int] = None,
    verify: Optional[Ed25519VerifyPort] = None,
) -> DeviceProof:
    """Builds the ``pkey-proof/1`` message for ``purpose``, signs it through the port and returns the
    proof, re-verified. Raises :class:`DeviceProofError` when a field breaks the line format, when the
    keys changed while signing, or when the result would not verify. ``keys`` goes through
    :func:`sign_keys_proof`. ``verify`` is a test seam."""
    if purpose == "keys":
        raise DeviceProofError("device proof: use sign_keys_proof for keys")
    fields = DeviceProofFields(purpose, product, device_id, value, token_hash)
    return _sign_any(port, fields, now, verify)


def sign_keys_proof(
    port: DeviceKeyPort,
    *,
    product: str,
    device_id: str,
    issued_at: Optional[int] = None,
    allow_ephemeral: bool = False,
    verify: Optional[Ed25519VerifyPort] = None,
) -> Tuple[DeviceProof, DevicePublicKeys, int]:
    """The ``keys`` proof: the value names the port's own sign and agree keys and ``issued_at``.
    Returns ``(proof, keys, issued_at)``. Refuses a memory-only port unless ``allow_ephemeral``."""
    if not isinstance(product, str) or _PRODUCT_SLUG.match(product) is None:
        raise DeviceProofError("device proof: bad product")
    _refuse_memory_only(port, allow_ephemeral)
    at = int(time.time()) if issued_at is None else issued_at
    if not isinstance(at, int) or isinstance(at, bool) or at < 0:
        raise DeviceProofError("device proof: bad issued_at")
    keys = port.ensure()
    fields = DeviceProofFields(
        "keys", product, device_id, device_proof_keys_value(keys.sign_key, keys.agree_key, at), "-"
    )
    proof = _sign_any(port, fields, at, verify)
    if proof.sign_key != keys.sign_key:
        raise DeviceProofError("device proof: keys changed while signing")
    return proof, keys, at


@dataclass(frozen=True)
class DeviceKeysRequest:
    """The body of ``PUT /<p>/devices/keys`` (CC-03.2): ``sig`` is the ``keys`` proof."""

    sign_key: str
    agree_key: str
    issued_at: int
    sig: str

    def to_json(self) -> Dict[str, Any]:
        """The wire body (camelCase)."""
        return {
            "signKey": self.sign_key,
            "agreeKey": self.agree_key,
            "issuedAt": self.issued_at,
            "sig": self.sig,
        }


def build_device_keys_request(
    port: DeviceKeyPort,
    *,
    product: str,
    device_id: str,
    issued_at: Optional[int] = None,
    allow_ephemeral: bool = False,
    verify: Optional[Ed25519VerifyPort] = None,
) -> Tuple[str, DeviceKeysRequest]:
    """The request for ``PUT <base>/<product>/devices/keys`` for the port's keys: ``(path, body)``.
    The caller sends it with the device bearer and ``X-PKey-Device``; resending it is safe."""
    proof, keys, at = sign_keys_proof(
        port,
        product=product,
        device_id=device_id,
        issued_at=issued_at,
        allow_ephemeral=allow_ephemeral,
        verify=verify,
    )
    return f"/{product}/devices/keys", DeviceKeysRequest(keys.sign_key, keys.agree_key, at, proof.sig)
