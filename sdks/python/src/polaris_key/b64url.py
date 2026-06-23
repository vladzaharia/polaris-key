"""base64url encode/decode helpers — the frozen wire alphabet.

The Polaris Key wire format uses unpadded base64url everywhere (JWS segments, raw
public keys). Decoding must re-pad before handing bytes to the stdlib, and encoding
must strip the padding so the bytes are byte-identical to what the Node/Swift SDKs
and the Worker produce.
"""

from __future__ import annotations

import base64

__all__ = ["b64url_decode", "b64url_encode", "b64url_encode_str"]


def b64url_decode(s: str) -> bytes:
    """Decode a base64url string, tolerating missing padding and the ``-_`` alphabet.

    Mirrors the Node ``base64UrlDecode``: re-add ``=`` padding to a multiple of 4 then
    decode with the urlsafe alphabet.
    """
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode(s + pad)


def b64url_encode(data: bytes) -> str:
    """Encode bytes as unpadded base64url (the ``-_`` alphabet, no ``=``)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_encode_str(s: str) -> str:
    """Encode a UTF-8 string as unpadded base64url (the JWS segment encoder)."""
    return b64url_encode(s.encode("utf-8"))
