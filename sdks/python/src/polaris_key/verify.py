"""The FROZEN Polaris Key wire crypto: compact JWS (EdDSA / Ed25519) verify + sign.

Native re-implementation of ``@plrs/jws`` (packages/shared-jws/src/index.ts) at
**wire contract v2** (docs/security/WIRE-CONTRACT-V2.md). The cross-language conformance
corpus pins this byte-for-byte, so the construction is exact::

    protected header = {"alg":"EdDSA","kid":<kid>}            (key order: alg then kid)
                     = {"alg":"EdDSA","typ":<typ>,"kid":<kid>} when a typ is emitted
    signingInput     = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
    signature        = Ed25519 over the ASCII bytes of signingInput
    compact JWS      = signingInput "." base64url(signature)

SECURITY — the v2 verification order (§2.1) is normative in all five implementations::

    1. split on "." -> exactly 3 segments
    2. len(encHeader)  > MAX_HEADER_B64  -> FAIL   (cap the ENCODED form, pre-decode)
    3. len(encPayload) > MAX_PAYLOAD_B64 -> FAIL
    4. STRICT base64url-decode the header           (R2-05)
    5. decoded header > MAX_HEADER_BYTES -> FAIL    (R2-04)
    6. parse header, REJECTING duplicate keys       (R2-06)
    7. header.alg == "EdDSA"
    8. header.typ matches the expected type         (R2-10)
    9. header.kid is a str
   10. key = trustSet[kid]; absent -> FAIL          (never from the document)
   11. STRICT base64url-decode the signature
   12. VERIFY over ASCII(encHeader "." encPayload)
   13. ONLY NOW decode + parse the payload, rejecting duplicate keys

Steps 12->13 are the important reordering: **no implementation may parse an unverified
payload.** The signature is checked over the bytes exactly as received — the payload is
never re-serialised, so cross-language verification is byte-stable.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from .b64url import b64url_decode, b64url_encode, b64url_encode_str
from .models import ISSUER, SECONDS_PER_DAY, ManagedConfigDoc

__all__ = [
    "TrustSet",
    "VerifiedJws",
    "verify_jws",
    "verify_jws_doc",
    "verify_doc",
    "sign_jws",
    "TYP_CONFIG",
    "TYP_TRUST",
    "CLOCK_SKEW_SECONDS",
    "MAX_GRACE_SECONDS",
    "MAX_HEADER_BYTES",
    "MAX_DOC_BYTES",
    "MAX_PAYLOAD_BYTES",
]

# A trust set: kid -> raw 32-byte Ed25519 public key, base64url-encoded.
TrustSet = Dict[str, str]

# ── Document-type domain separators (§2.4) ──────────────────────────────────────────
# One product signing key signs BOTH config documents and trust manifests, so without a
# `typ` a manifest can be replayed where a config doc is expected (R2-10 — today that
# replay fails only by accident, via a swallowed TypeError).
TYP_CONFIG = "pkey-config+jws"
TYP_TRUST = "pkey-trust+jws"

# ── Size limits (§2.1) ──────────────────────────────────────────────────────────────
# Hard cap on the decoded JWS payload before JSON parsing — a cheap denial-of-service
# guard against a hostile, oversized document.
MAX_DOC_BYTES = 65536
# Back-compatible alias; the v1 name for the same limit.
MAX_PAYLOAD_BYTES = MAX_DOC_BYTES
# Hard cap on the decoded PROTECTED HEADER. A legitimate header is ~60 bytes. Without
# this the payload cap is trivially bypassed by moving the blob into the header instead
# (R2-04: an 8 MiB header was decoded and parsed pre-verification).
MAX_HEADER_BYTES = 1024


def _b64_cap(byte_len: int) -> int:
    """The encoded length of ``byte_len`` bytes of base64url, plus slack."""
    return -(-byte_len * 4 // 3) + 4


# Encoded-form caps, checked BEFORE decoding so an oversized blob is never allocated.
MAX_HEADER_B64 = _b64_cap(MAX_HEADER_BYTES)
MAX_PAYLOAD_B64 = _b64_cap(MAX_DOC_BYTES)

# ── Claim-validation limits (§3) ────────────────────────────────────────────────────
# NORMATIVE and identical in all five implementations — see packages/sdk-node/src/claims.ts.
# v1 had no skew anywhere, so a device 61 minutes fast flipped a freshly-signed document
# straight to `grace`.
CLOCK_SKEW_SECONDS = 300
# Upper bound on the signed offline window: `graceUntil <= issuedAt + MAX_GRACE_SECONDS`.
# Bounds a hostile control plane and a tampered cache file alike — v1 accepted a
# `graceUntil` a century out. A year comfortably exceeds any real `maxOfflineDays`.
MAX_GRACE_SECONDS = 365 * SECONDS_PER_DAY


@dataclass(frozen=True)
class VerifiedJws:
    """The decoded ``kid`` + payload returned on a successful verify."""

    kid: str
    payload: Dict[str, Any]


def _reject_duplicate_keys(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    """``object_pairs_hook`` that refuses any object declaring the same key twice.

    Duplicate members MUST cause failure — not last-wins (TS/Python) and not first-wins
    (Swift's ``JSONSerialization``), because any silent resolution is a differential
    across five implementations. ``{"alg":"none","kid":"x","alg":"EdDSA"}`` read as
    ``EdDSA`` here and ``none`` in Swift: the algorithm-downgrade guard returning
    opposite answers per language (R2-06).
    """
    out: Dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate JSON object key")
        out[key] = value
    return out


def _parse_strict_json(raw: bytes) -> Any:
    """UTF-8 decode + JSON parse, rejecting duplicate object keys. Raises on failure."""
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)


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
    jws: str, trusted_keys: TrustSet, *, typ: Optional[str] = None
) -> Optional[VerifiedJws]:
    """Verify a compact JWS against a trust set, in the §2.1 order.

    Returns the decoded ``kid`` + payload, or ``None`` on ANY failure (malformed,
    oversized, duplicate JSON keys, out-of-alphabet base64url, unknown ``kid``, wrong
    ``alg``, wrong ``typ``, bad signature). Never raises.

    ``typ`` requires the given document-type domain separator. When omitted, a header
    carrying NO ``typ`` is accepted (v1 compatibility) but a header carrying a DIFFERENT
    one is still rejected — so the cross-protocol replay is closed immediately, before
    ``typ`` becomes mandatory (rollout §7.2).
    """
    if not isinstance(jws, str):
        return None
    parts = jws.split(".")
    if len(parts) != 3:
        return None
    enc_header, enc_payload, enc_sig = parts

    # 2-3. Bound the ENCODED segments before decoding anything (R2-04).
    if len(enc_header) > MAX_HEADER_B64:
        return None
    if len(enc_payload) > MAX_PAYLOAD_B64:
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

    # 8. Domain separation (§2.4). An absent `typ` is tolerated for v1 compatibility, but
    #    a header asserting a DIFFERENT type is rejected outright.
    if "typ" in header:
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
    try:
        key.verify(sig, signing_input)
    except (InvalidSignature, Exception):
        return None

    # 13. ONLY NOW decode + parse the payload. Everything above this line ran on
    #     unauthenticated bytes; everything below runs on authenticated ones.
    try:
        payload_bytes = b64url_decode(enc_payload)
    except Exception:
        return None
    if len(payload_bytes) > MAX_DOC_BYTES:
        return None
    try:
        payload = _parse_strict_json(payload_bytes)
    except Exception:
        return None

    return VerifiedJws(kid=kid, payload=payload)


def verify_jws_doc(
    jws: str, trusted_keys: TrustSet, *, typ: Optional[str] = TYP_CONFIG
) -> Optional[ManagedConfigDoc]:
    """Verify a JWS and decode its payload into a :class:`ManagedConfigDoc`.

    ``ManagedConfigDoc.from_dict`` type-checks every field, so a signed-but-malformed
    document (``"issuedAt": "5"``) becomes ``None`` here instead of a ``TypeError``
    escaping into the caller's ``refresh()`` (R4-13).
    """
    v = verify_jws(jws, trusted_keys, typ=typ)
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
    now: Optional[int] = None,
    expected_iss: str = ISSUER,
    check_freshness: bool = True,
    typ: Optional[str] = TYP_CONFIG,
) -> Optional[ManagedConfigDoc]:
    """Verify a JWS then enforce the §3 claim checks. Returns ``None`` on any failure.

    Checked in order, each failure returning "no document" and **never** a throw:

    ==================  ==========================================================
    ``typ``             ``pkey-config+jws`` (§2.4); absent is accepted during rollout
    ``schemaVersion``   shape only — a positive integer (see below)
    ``aud``             ``== expected_aud``
    ``iss``             ``== expected_iss`` (default ``key.plrs.im``)
    ``deviceId``        ``== device_id``
    ``issuedAt``        ``> last_accepted_issued_at``
    ``graceUntil``      ``>= expiresAt`` and ``<= issuedAt + MAX_GRACE_SECONDS``
    freshness           ``issuedAt <= now + skew`` and ``expiresAt > now - skew``
    ==================  ==========================================================

    ``schemaVersion`` is a SHAPE check, not an allow-list (§3.1 correction 1): on a
    managed-config document this field carries the per-product **catalog** version
    (``packages/worker/src/product.ts:114``), which increments on every catalog edit, so
    an allow-list would reject every product that ever republished its schema. What
    R2-08's ``schemaVersion: 999`` payload actually violated is the shape.

    ``check_freshness`` (§3.1 correction 2) is ``True`` on the **network** path: a
    document that arrives already expired, or stamped in the far future, is neither
    accepted nor cached. It MUST be ``False`` on the **cache-reload** path, where a
    cached document is *expected* to be past its short ``expiresAt`` — that is what
    offline operation is. Its signed outer bound there is ``graceUntil``, enforced by the
    gate against the monotonic clock floor (§4.3). Asserting freshness on reload would
    delete offline grace outright.
    """
    doc = verify_jws_doc(jws, trusted_keys, typ=typ)
    if doc is None:
        return None
    now = int(time.time()) if now is None else now

    if doc.schemaVersion < 1:
        return None
    if doc.aud != expected_aud:
        return None
    if doc.iss != expected_iss:
        return None
    if doc.deviceId != device_id:
        return None
    if last_accepted_issued_at is not None and doc.issuedAt <= last_accepted_issued_at:
        return None
    # A grace window shorter than the expiry, or longer than a year, is not a document
    # this client will honour — whoever authored it.
    if doc.graceUntil < doc.expiresAt:
        return None
    if doc.graceUntil > doc.issuedAt + MAX_GRACE_SECONDS:
        return None
    if check_freshness:
        if doc.issuedAt > now + CLOCK_SKEW_SECONDS:
            return None
        if doc.expiresAt <= now - CLOCK_SKEW_SECONDS:
            return None
    return doc


def sign_jws(
    payload: Any, signing_key_pem: str, kid: str, typ: Optional[str] = None
) -> str:
    """Sign a JSON-serialisable payload into a compact JWS (test/tooling helper).

    The header key order is fixed (``alg``, then ``typ`` when present, then ``kid``). The
    signature is computed over the ASCII bytes of the encoded ``signingInput`` — the SAME
    bytes the verifier checks. With ``typ`` omitted the emitted bytes are byte-identical
    to v1, so every existing corpus case still round-trips.

    ``ensure_ascii=False`` is load-bearing (§2.5 / R2-07): the default ``True`` escapes
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
