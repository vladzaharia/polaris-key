"""base64url encode/decode helpers — the frozen wire alphabet.

The Polaris Key wire format uses unpadded base64url everywhere (JWS segments, raw
public keys). Decoding must re-pad before handing bytes to the stdlib, and encoding
must strip the padding so the bytes are byte-identical to what the Node/Swift SDKs
and the Worker produce.

SECURITY (wire contract v2 §2.3 / audit finding R2-05): decoding is **strict**. The
previous implementation called ``base64.urlsafe_b64decode(s + pad)``, which defaults to
``validate=False`` and therefore silently *discards* every out-of-alphabet character —
so ``sig + "***"`` and ``sig + "\\n \\t"`` were accepted by Python and rejected by Node
(``atob`` throws) and Swift (``Data(base64Encoded:)`` returns ``nil``). That handed one
SDK unbounded wire malleability: arbitrarily many distinct JWS strings decoding to the
same verified document, defeating any upstream de-duplication / allow-listing / logging
keyed on the token string.

The rule is now identical in every language: the ``-_`` alphabet only — no ``+``/``/``
(the standard alphabet), no ``=`` padding on the wire, no whitespace, no other byte.
**Reject, never sanitise.**
"""

from __future__ import annotations

import base64
import re

__all__ = ["b64url_decode", "b64url_encode", "b64url_encode_str", "B64URL_RE"]

# The unpadded base64url alphabet. Nothing else is a valid wire segment. Mirrors
# `B64URL_RE` in packages/shared-jws/src/index.ts.
# `\Z`, not `$`: `$` also matches before a final newline, so `re.match` would let `abc\n` through.
# `fullmatch` below is the enforcing call; the anchor keeps a `.match` caller safe.
B64URL_RE = re.compile(r"[A-Za-z0-9_-]*\Z")


def b64url_decode(s: str) -> bytes:
    """Strictly decode an unpadded base64url string.

    Tolerates only the missing ``=`` padding (which the wire format omits by
    construction). Raises :class:`ValueError` on anything outside ``[A-Za-z0-9_-]`` —
    including ``+``/``/``, explicit ``=``, whitespace and control bytes — rather than
    dropping it, so Python accepts exactly the strings Node and Swift accept.
    """
    if not isinstance(s, str):
        raise ValueError("base64url input must be a str")
    if B64URL_RE.fullmatch(s) is None:
        raise ValueError("base64url input contains out-of-alphabet characters")
    pad = "=" * ((4 - (len(s) % 4)) % 4)
    # `validate=True` is redundant after the alphabet check above but keeps the guarantee
    # local to this call: a future edit to the regex can't silently re-open R2-05.
    try:
        raw = base64.urlsafe_b64decode(s + pad)
    except Exception as exc:  # a length of 4n+1 is not base64 at all
        raise ValueError("base64url input has an impossible length") from exc
    # Canonical form (wire contract v4 §1): the last character's unused low bits must be
    # zero, so one byte string has exactly one spelling. Re-encoding is the whole test.
    if b64url_encode(raw) != s:
        raise ValueError("base64url input is not canonical")
    return raw


def b64url_encode(data: bytes) -> str:
    """Encode bytes as unpadded base64url (the ``-_`` alphabet, no ``=``)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_encode_str(s: str) -> str:
    """Encode a UTF-8 string as unpadded base64url (the JWS segment encoder)."""
    return b64url_encode(s.encode("utf-8"))
