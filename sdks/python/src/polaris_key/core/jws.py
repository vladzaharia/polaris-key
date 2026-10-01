"""The FROZEN Polaris Key wire crypto: compact JWS (EdDSA / Ed25519) verify + sign.

Native re-implementation of ``@polaris-key/jws`` (``packages/shared-jws/src/index.ts``) at
**wire contract v4** (docs/security/WIRE-CONTRACT-V4.md §1). The construction is frozen
and unchanged from v2 — only the ``typ`` values were rebranded::

    protected header = {"alg":"EdDSA","kid":<kid>}            (key order: alg then kid)
                     = {"alg":"EdDSA","typ":<typ>,"kid":<kid>} when a typ is emitted
    signingInput     = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
    signature        = Ed25519 over the ASCII bytes of signingInput
    compact JWS      = signingInput "." base64url(signature)

SECURITY — the normative verification order (§1) in all five implementations::

    1. split on "." -> exactly 3 segments
    2. len(encHeader)  > MAX_HEADER_B64  -> FAIL   (cap the ENCODED form, pre-decode)
    3. len(encPayload) > cap(effective)  -> FAIL
    4. STRICT base64url-decode the header           (R2-05)
    5. decoded header > MAX_HEADER_BYTES -> FAIL    (R2-04)
    6. parse header, REJECTING duplicate keys       (R2-06)
    7. header.alg == "EdDSA"
    8. header.typ matches the expected type; MISSING typ fails when require_typ (§2)
    9. header.kid is a str
   10. key = trustSet[kid]; absent -> FAIL          (never from the document)
   11. STRICT base64url-decode the signature
   12. VERIFY over ASCII(encHeader "." encPayload)
   13. ONLY NOW decode + parse the payload, rejecting duplicate keys

Steps 12->13 are the important ordering: **no implementation may parse an unverified
payload.** The signature is checked over the bytes exactly as received — the payload is
never re-serialised, so cross-language verification is byte-stable.

WHAT v4 ADDED (WIRE-CONTRACT-V4 §1.1–§1.2), for every ``typ``

* Ed25519 pre-checks before the backend's verify: ``S < L``, canonical ``A`` and ``R``, and
  neither of the eight small-order encodings. OpenSSL accepts a non-canonical or small-order
  key, and every backend accepts a small-order ``R``.
* Strict JSON for the header and the payload: well-formed UTF-8 with no BOM, exactly one
  object, no ``NaN``/``Infinity`` (``parse_constant``), every number token inside binary64's
  range judged from its digits (``parse_int``/``parse_float``), no lone surrogate, no U+0000 in
  a member name, and at most ``MAX_JSON_DEPTH`` levels.

WHAT v3 ADDED

* ``require_typ``: a header carrying NO ``typ`` is REJECTED (§2). Every shipping call
  site in this SDK sets it; the option exists so the rule is stated once rather than
  duplicated at each verifier.
* ``max_payload_bytes``: a RAISE-ONLY cap for ``pkey-bundle+jws`` alone (262 144 bytes,
  §1). It can only ever raise — the effective cap is ``max(MAX_DOC_BYTES, requested)`` —
  so a value below the frozen 64 KiB is inert rather than quietly tightening one call
  site out of step with the contract. The HEADER cap is untouched: moving a blob into
  the header is R2-04, and no ``typ`` widens it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from .b64url import b64url_decode, b64url_encode, b64url_encode_str
from .patterns import _full_match
from .models import MAX_DOC_BYTES, MAX_HEADER_BYTES, MAX_JSON_DEPTH
from .strict_json import reject_duplicate_keys

__all__ = [
    "TrustSet",
    "VerifiedJws",
    "verify_jws",
    "sign_jws",
    "MAX_HEADER_B64",
    "MAX_PAYLOAD_B64",
    "b64_cap",
    "SMALL_ORDER_ENCODINGS",
    "ed25519_prechecks",
]

#: A trust set: kid -> raw 32-byte Ed25519 public key, base64url-encoded.
TrustSet = Dict[str, str]


def b64_cap(byte_len: int) -> int:
    """The encoded length of ``byte_len`` bytes of base64url, plus slack."""
    return -(-byte_len * 4 // 3) + 4


#: Encoded-form caps, checked BEFORE decoding so an oversized blob is never allocated.
MAX_HEADER_B64 = b64_cap(MAX_HEADER_BYTES)
MAX_PAYLOAD_B64 = b64_cap(MAX_DOC_BYTES)


@dataclass(frozen=True)
class VerifiedJws:
    """The decoded ``kid`` + payload returned on a successful verify."""

    kid: str
    payload: Any


def _payload_cap_for(requested: Optional[int]) -> int:
    """The decoded-payload cap in force for one call. RAISE-ONLY (§1)."""
    if requested is None or isinstance(requested, bool) or not isinstance(
        requested, (int, float)
    ):
        return MAX_DOC_BYTES
    if requested != requested or requested in (float("inf"), float("-inf")):
        return MAX_DOC_BYTES  # non-finite
    return max(MAX_DOC_BYTES, int(requested))


#: The duplicate-member hook (R2-06), shared with the config environment rule.
_reject_duplicate_keys = reject_duplicate_keys


class _StrictJsonRefused(ValueError):
    """A header or payload broke WIRE-CONTRACT-V4 §1.2."""


def _strict_pairs(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    """Rule 6 (no duplicate names, compared by code point) and rule 7 (no U+0000 in a name)."""
    for key, _ in pairs:
        if "\x00" in key:
            raise _StrictJsonRefused("U+0000 in a member name")
    return _reject_duplicate_keys(pairs)


_NUMBER_RE = re.compile(r"-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?")


def _number_in_range(token: str) -> bool:
    """Rule 8, judged exactly from the token's digits: zero, or a magnitude of at least
    10^-307 and below 10^308. An exponent of more than six significant digits is out."""
    m = _full_match(_NUMBER_RE, token)
    if m is None:
        return False
    int_part, frac = m.group(1), m.group(2) or ""
    digits = int_part + frac
    first = next((k for k, c in enumerate(digits) if c != "0"), -1)
    exp_digits = (m.group(4) or "0").lstrip("0")
    if len(exp_digits) > 6:
        return False
    if first == -1:
        return True
    exp = int(exp_digits or "0") * (-1 if m.group(3) == "-" else 1)
    power = len(int_part) - 1 - first + exp
    return -307 <= power <= 307


def _parse_int(token: str) -> int:
    if not _number_in_range(token):
        raise _StrictJsonRefused("number out of range")
    return int(token)


def _parse_float(token: str) -> float:
    if not _number_in_range(token):
        raise _StrictJsonRefused("number out of range")
    return float(token)


def _parse_constant(name: str) -> Any:
    raise _StrictJsonRefused(f"{name} is not JSON")


def _depth_exceeds(text: str, limit: int) -> bool:
    """Rule 9 on the raw text (strings skipped), before ``json.loads`` recurses into it."""
    depth = 0
    in_string = False
    escaped = False
    for c in text:
        if in_string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
        elif c in "[{":
            depth += 1
            if depth > limit:
                return True
        elif c in "]}":
            depth -= 1
    return False


def _has_surrogate(value: Any) -> bool:
    """Rule 5: a decoded string or member name holding a surrogate came from a lone (or
    reversed) surrogate escape; a valid escaped pair decodes to one astral character."""
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, str):
            if any("\ud800" <= ch <= "\udfff" for ch in v):
                return True
        elif isinstance(v, dict):
            stack.extend(v.keys())
            stack.extend(v.values())
        elif isinstance(v, list):
            stack.extend(v)
    return False


def _parse_strict_json(raw: bytes) -> Any:
    """Decode and parse one header or payload under WIRE-CONTRACT-V4 §1.2. Raises on failure.

    ``bytes.decode("utf-8")`` already refuses ill-formed UTF-8, encoded surrogates and
    overlongs (rule 1); a leading U+FEFF is refused explicitly (rule 2).
    """
    text = raw.decode("utf-8")
    if text.startswith("\ufeff"):
        raise _StrictJsonRefused("byte order mark")
    if _depth_exceeds(text, MAX_JSON_DEPTH):
        raise _StrictJsonRefused("too deep")
    value = json.loads(
        text,
        object_pairs_hook=_strict_pairs,
        parse_int=_parse_int,
        parse_float=_parse_float,
        parse_constant=_parse_constant,
    )
    if not isinstance(value, dict):
        raise _StrictJsonRefused("not one JSON object")
    if _has_surrogate(value):
        raise _StrictJsonRefused("lone surrogate")
    return value


# ── Ed25519 strictness (WIRE-CONTRACT-V4 §1.1) ─────────────────────────────────────
_ED25519_L = 2**252 + 27742317777372353535851937790883648493
_ED25519_P = 2**255 - 19
#: The eight small-order point encodings (order 1, 2, 4, 4 and the four of order 8).
SMALL_ORDER_ENCODINGS = frozenset(
    bytes.fromhex(h)
    for h in (
        "0100000000000000000000000000000000000000000000000000000000000000",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    )
)
_NEGATIVE_ZERO_ENCODINGS = frozenset(
    bytes.fromhex(h)
    for h in (
        "0100000000000000000000000000000000000000000000000000000000000080",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    )
)


def _point_acceptable(enc: bytes) -> bool:
    """Checks 2–3 for one 32-byte encoding: canonical, and not of small order."""
    if len(enc) != 32:
        return False
    if int.from_bytes(enc, "little") & ((1 << 255) - 1) >= _ED25519_P:
        return False
    return enc not in _NEGATIVE_ZERO_ENCODINGS and enc not in SMALL_ORDER_ENCODINGS


def ed25519_prechecks(key: bytes, sig: bytes) -> bool:
    """WIRE-CONTRACT-V4 §1.1 checks 1–3 on the trusted key ``A`` and ``R ‖ S``, by bytes."""
    if len(key) != 32 or len(sig) != 64:
        return False
    if int.from_bytes(sig[32:], "little") >= _ED25519_L:
        return False
    return _point_acceptable(key) and _point_acceptable(sig[:32])


def _import_verify_key(raw_base64url: str) -> Ed25519PublicKey:
    """Import a 32-byte RAW Ed25519 public key (base64url) for verification.

    Pass the raw 32 bytes straight to ``from_public_bytes`` — do NOT prepend an SPKI
    prefix (that's a Node/WebCrypto-only quirk). Reject non-32-byte keys.
    """
    raw = b64url_decode(raw_base64url)
    if len(raw) != 32:
        raise ValueError(f"Ed25519 public key must be 32 bytes, got {len(raw)}")
    return Ed25519PublicKey.from_public_bytes(raw)


def verify_jws(
    jws: str,
    trusted_keys: TrustSet,
    *,
    typ: Optional[str] = None,
    require_typ: bool = False,
    max_payload_bytes: Optional[int] = None,
) -> Optional[VerifiedJws]:
    """Verify a compact JWS against a trust set, in the §1 order.

    Returns the decoded ``kid`` + payload, or ``None`` on ANY failure (malformed,
    oversized, duplicate JSON keys, out-of-alphabet base64url, unknown ``kid``, wrong
    ``alg``, wrong or missing ``typ``, bad signature). Never raises.
    """
    if not isinstance(jws, str):
        return None
    parts = jws.split(".")
    if len(parts) != 3:
        return None
    enc_header, enc_payload, enc_sig = parts

    # 2-3. Bound the ENCODED segments before decoding anything (R2-04).
    max_payload = _payload_cap_for(max_payload_bytes)
    if len(enc_header) > MAX_HEADER_B64:
        return None
    if len(enc_payload) > b64_cap(max_payload):
        return None

    # 4-6. Header: strict decode, bound the decoded size, parse rejecting duplicates.
    try:
        header_bytes = b64url_decode(enc_header)
    except Exception:
        return None
    if len(header_bytes) > MAX_HEADER_BYTES:
        return None
    try:
        header = _parse_strict_json(header_bytes)
    except Exception:
        return None
    # A non-object header ("x", 1, null) must fail here, not on attribute access.
    if not isinstance(header, dict):
        return None

    # 7. Reject none/HS downgrade BEFORE any signature math.
    if header.get("alg") != "EdDSA":
        return None

    # 8. Domain separation (§2). v3 REQUIRES a typ at every call site that asks for one;
    #    a header asserting a DIFFERENT type is rejected in either mode.
    if "typ" not in header:
        if require_typ:
            return None
    else:
        header_typ = header["typ"]
        if not isinstance(header_typ, str):
            return None
        if typ is not None and header_typ != typ:
            return None

    # 9-10. Select the pubkey by kid from the TRUST SET — never from the doc.
    kid = header.get("kid")
    if not isinstance(kid, str):
        return None
    raw_key = trusted_keys.get(kid)
    if not raw_key:
        return None
    try:
        key = _import_verify_key(raw_key)
    except Exception:
        return None

    # 11-12. Verify over the ASCII bytes of the ORIGINAL encoded segments.
    try:
        sig = b64url_decode(enc_sig)
    except Exception:
        return None
    try:
        signing_input = (enc_header + "." + enc_payload).encode("ascii")
    except UnicodeEncodeError:
        return None
    # V4 §1.1: S < L, canonical A and R, no small-order A or R — before the backend.
    if not ed25519_prechecks(b64url_decode(raw_key), sig):
        return None
    try:
        key.verify(sig, signing_input)
    except Exception:
        return None

    # 13. ONLY NOW decode + parse the payload. Everything above this line ran on
    #     unauthenticated bytes; everything below runs on authenticated ones.
    try:
        payload_bytes = b64url_decode(enc_payload)
    except Exception:
        return None
    if len(payload_bytes) > max_payload:
        return None
    try:
        payload = _parse_strict_json(payload_bytes)
    except Exception:
        return None

    return VerifiedJws(kid=kid, payload=payload)


def sign_jws(
    payload: Any, signing_key_pem: str, kid: str, typ: Optional[str] = None
) -> str:
    """Sign a JSON-serialisable payload into a compact JWS (test/tooling helper).

    The header key order is fixed (``alg``, then ``typ`` when present, then ``kid``). The
    signature is computed over the ASCII bytes of the encoded ``signingInput`` — the SAME
    bytes the verifier checks.

    ``ensure_ascii=False`` is load-bearing (§1 / R2-07): the default ``True`` escapes
    every non-ASCII code point to ``\\uXXXX`` while ``JSON.stringify`` emits raw UTF-8, so
    the same payload produced a DIFFERENT signing input — and therefore a different
    signature — in Python than in Node.
    """
    header: Dict[str, Any] = (
        {"alg": "EdDSA", "typ": typ, "kid": kid} if typ else {"alg": "EdDSA", "kid": kid}
    )
    # separators=(",", ":") => compact, no whitespace; ensure_ascii=False => raw UTF-8.
    # Together these are exactly what JSON.stringify emits.
    enc_header = b64url_encode_str(
        json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    )
    enc_payload = b64url_encode_str(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    )
    signing_input = enc_header + "." + enc_payload

    key = load_pem_private_key(signing_key_pem.encode("utf-8"), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("signing key must be Ed25519")
    sig = key.sign(signing_input.encode("ascii"))
    return signing_input + "." + b64url_encode(sig)
