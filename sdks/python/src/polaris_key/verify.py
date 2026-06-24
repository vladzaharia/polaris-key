"""The FROZEN Polaris Key wire crypto: compact JWS (EdDSA / Ed25519) verify + sign.

Native re-implementation of ``@polaris-key/jws`` (packages/shared-jws/src/index.ts).
The cross-language conformance corpus pins this byte-for-byte, so the construction is
exact::

    protected header = {"alg":"EdDSA","kid":<kid>}            (key order: alg then kid)
    signingInput     = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
    signature        = Ed25519 over the ASCII bytes of signingInput
    compact JWS      = signingInput "." base64url(signature)

SECURITY: the verifying key is selected by the header ``kid`` from a caller-supplied
trust set, NEVER from the document; ``alg`` is asserted ``EdDSA`` and ``kid`` asserted a
``str`` BEFORE any signature math so a ``none``/HMAC downgrade is rejected. The signature
is checked over the ASCII bytes of ``encHeader.encPayload`` exactly as received — the
payload is never re-serialised, so cross-language verification is byte-stable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from .b64url import b64url_decode, b64url_encode, b64url_encode_str
from .models import ManagedConfigDoc

__all__ = [
    "TrustSet",
    "VerifiedJws",
    "verify_jws",
    "verify_jws_doc",
    "verify_doc",
    "sign_jws",
]

# A trust set: kid -> raw 32-byte Ed25519 public key, base64url-encoded.
TrustSet = Dict[str, str]

# Hard cap on the decoded JWS payload size (bytes) before JSON parsing — a cheap
# denial-of-service guard against a hostile, oversized document.
MAX_PAYLOAD_BYTES = 65536


@dataclass(frozen=True)
class VerifiedJws:
    """The decoded ``kid`` + payload returned on a successful verify."""

    kid: str
    payload: Dict[str, Any]


def _import_verify_key(raw_base64url: str) -> Ed25519PublicKey:
    """Import a 32-byte RAW Ed25519 public key (base64url) for verification.

    Pass the raw 32 bytes straight to ``from_public_bytes`` — do NOT prepend an SPKI
    prefix (that's a Node/WebCrypto-only quirk). Reject non-32-byte keys.
    """
    raw = b64url_decode(raw_base64url)
    if len(raw) != 32:
        raise ValueError(f"Ed25519 public key must be 32 bytes, got {len(raw)}")
    return Ed25519PublicKey.from_public_bytes(raw)


def verify_jws(jws: str, trusted_keys: TrustSet) -> Optional[VerifiedJws]:
    """Verify a compact JWS against a trust set.

    Returns the decoded ``kid`` + payload, or ``None`` on ANY failure (malformed,
    unknown ``kid``, wrong ``alg``, bad signature).
    """
    parts = jws.split(".")
    if len(parts) != 3:
        return None
    enc_header, enc_payload, enc_sig = parts

    try:
        header_bytes = b64url_decode(enc_header)
        payload_bytes = b64url_decode(enc_payload)
    except Exception:
        return None

    # Reject an oversized payload BEFORE json.loads to bound the parse cost.
    if len(payload_bytes) > MAX_PAYLOAD_BYTES:
        return None

    try:
        header = json.loads(header_bytes.decode("utf-8"))
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception:
        return None

    # Reject none/HS downgrade BEFORE any signature math.
    if not isinstance(header, dict):
        return None
    if header.get("alg") != "EdDSA" or not isinstance(header.get("kid"), str):
        return None

    kid = header["kid"]
    # Select the pubkey by kid from the TRUST SET — never from the doc.
    raw_key = trusted_keys.get(kid)
    if not raw_key:
        return None

    try:
        key = _import_verify_key(raw_key)
    except Exception:
        return None

    try:
        sig = b64url_decode(enc_sig)
    except Exception:
        return None

    # Verify over the ASCII bytes of the ORIGINAL encoded segments — never re-serialise.
    signing_input = (enc_header + "." + enc_payload).encode("ascii")
    try:
        key.verify(sig, signing_input)
    except (InvalidSignature, Exception):
        return None

    return VerifiedJws(kid=kid, payload=payload)


def verify_jws_doc(jws: str, trusted_keys: TrustSet) -> Optional[ManagedConfigDoc]:
    """Verify a JWS and decode its payload into a :class:`ManagedConfigDoc`."""
    v = verify_jws(jws, trusted_keys)
    if v is None:
        return None
    try:
        return ManagedConfigDoc.from_dict(v.payload)
    except Exception:
        return None


def verify_doc(
    jws: str,
    trusted_keys: TrustSet,
    *,
    expected_aud: str,
    device_id: str,
    last_accepted_issued_at: Optional[int] = None,
) -> Optional[ManagedConfigDoc]:
    """Verify a JWS then enforce the anti-replay bindings (mirrors ``verify.ts``).

    Cryptographic verification is the frozen path; on top of it we assert the product
    audience, the device binding, and monotonic ``issuedAt`` so a doc can't be spliced
    across products/devices or replayed. Returns ``None`` on any failure.
    """
    doc = verify_jws_doc(jws, trusted_keys)
    if doc is None:
        return None
    if doc.aud != expected_aud:
        return None
    if doc.deviceId != device_id:
        return None
    if last_accepted_issued_at is not None and doc.issuedAt <= last_accepted_issued_at:
        return None
    return doc


def sign_jws(payload: Any, signing_key_pem: str, kid: str) -> str:
    """Sign a JSON-serialisable payload into a compact JWS (test/tooling helper).

    The header key order is fixed (``alg`` then ``kid``). The signature is computed over
    the ASCII bytes of the encoded ``signingInput`` — the SAME bytes the verifier checks.
    """
    header = {"alg": "EdDSA", "kid": kid}
    # separators=(",", ":") => compact, no whitespace, matching JSON.stringify.
    enc_header = b64url_encode_str(json.dumps(header, separators=(",", ":")))
    enc_payload = b64url_encode_str(json.dumps(payload, separators=(",", ":")))
    signing_input = enc_header + "." + enc_payload

    key = load_pem_private_key(signing_key_pem.encode("utf-8"), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("signing key must be Ed25519")
    sig = key.sign(signing_input.encode("ascii"))
    return signing_input + "." + b64url_encode(sig)
