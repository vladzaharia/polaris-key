"""Per-document claim validation — wire contract v3 §2–§3.

Mirrors ``@polaris-key/client-core``'s ``verify.ts``. Cryptographic verification is the frozen
:mod:`polaris_key.core.jws` path (encoded-length caps, strict base64url, duplicate-key
rejection, verify-before-parse, ``kid`` selected only from the caller's trust set). On top
of it this module asserts the full v3 claim set, so a document that is expired, foreign,
far-future, replayed, or wearing the wrong ``typ`` never becomes a document at all.

v3 splits the single v2 ``pkey-config+jws`` document into TWO — ``pkey-license+jws``
(grants) and ``pkey-config+jws`` (config + secrets). The envelope they share (§2) is
validated once, in :func:`validate_envelope`; only the per-document claims differ.

TWO VALIDATION PROFILES, selected by ``check_freshness`` (§3):

* **network path** (``True``, the default): reject if ``now > expiresAt + skew`` or
  ``issuedAt > now + skew``. A stale or future-dated document must never enter the cache.
* **reload path** (``False``): the document is EXPECTED to be past ``expiresAt`` — that
  is what offline operation is. Only ``graceUntil`` bounds it, enforced by the gate
  against the monotonic floor (§4.2). Used for cache reload AND bundle import (§7).
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

from .jws import TrustSet, verify_jws
from .models import (
    CLOCK_SKEW_SECONDS,
    ISSUER,
    MAX_GRACE_SECONDS,
    TYP_CONFIG,
    TYP_LICENSE,
    ConfigDoc,
    DocClaims,
    LicenseDoc,
)

__all__ = [
    "validate_envelope",
    "verify_doc",
    "verify_license_doc",
    "verify_config_doc",
]


def validate_envelope(
    claims: DocClaims,
    *,
    expected_aud: str,
    expected_iss: str,
    device_id: str,
    last_accepted_issued_at: Optional[int],
    now: int,
    check_freshness: bool,
) -> bool:
    """The shared envelope every per-service document carries (§2 / §3).

    Checked in one place so license and config can never drift apart on ``iss``, ``aud``,
    device binding, the grace ceiling, or the freshness split.
    """
    if claims.aud != expected_aud:
        return False
    # The issuer is the fixed `key.plrs.im` (§8), never derived from the base URL — an
    # attacker-controlled host must not be able to name its own issuer.
    if claims.iss != expected_iss:
        return False
    if claims.deviceId != device_id:
        return False
    # Per-TYPE anti-replay floor (§3): license and config carry INDEPENDENT floors, so a
    # settings refresh can never be blocked by a newer licence document (or vice versa).
    if last_accepted_issued_at is not None and claims.issuedAt <= last_accepted_issued_at:
        return False
    # A grace window shorter than the expiry, or longer than a year, is not a document
    # this client will honour — whoever authored it. The ceiling applies at VERIFY time,
    # not only in the gate (§3.3), so an over-generous bundle is refused before it can
    # reach the cache.
    if claims.graceUntil < claims.expiresAt:
        return False
    if claims.graceUntil > claims.issuedAt + MAX_GRACE_SECONDS:
        return False
    if check_freshness:
        if claims.issuedAt > now + CLOCK_SKEW_SECONDS:
            return False
        if claims.expiresAt <= now - CLOCK_SKEW_SECONDS:
            return False
    return True


def verify_doc(
    jws: str,
    trusted_keys: TrustSet,
    *,
    typ: str,
    decode: Callable[[Any], Any],
    expected_aud: str,
    device_id: str,
    last_accepted_issued_at: Optional[int],
    expected_iss: str = ISSUER,
    now: Optional[int] = None,
    check_freshness: bool = True,
) -> Any:
    """Verify one signed Polaris Key document of a known type.

    ``last_accepted_issued_at`` is REQUIRED: the per-type anti-replay floor, or an
    explicit ``None`` for "no floor". An omitted argument is a ``TypeError``, never a silent
    no-floor.

    Returns the decoded payload, or ``None`` on ANY failure — never a raise, so every
    call site fails closed identically.

    Size caps, strict base64url, duplicate-key rejection and verify-before-parse all live
    in :func:`polaris_key.core.jws.verify_jws`; it never JSON-parses an unauthenticated
    payload. ``typ`` closes cross-protocol replay — a trust manifest, an offline bundle,
    or the *other* document type presented here (§2) — and a header with no ``typ`` at
    all is refused outright in v3.
    """
    verified = verify_jws(jws, trusted_keys, typ=typ)
    if verified is None:
        return None
    doc = decode(verified.payload)
    if doc is None:
        return None
    wall = int(time.time()) if now is None else now
    if not validate_envelope(
        doc.claims(),
        expected_aud=expected_aud,
        expected_iss=expected_iss,
        device_id=device_id,
        last_accepted_issued_at=last_accepted_issued_at,
        now=wall,
        check_freshness=check_freshness,
    ):
        return None
    return doc


def verify_license_doc(
    jws: str,
    trusted_keys: TrustSet,
    *,
    expected_aud: str,
    device_id: str,
    last_accepted_issued_at: Optional[int],
    expected_iss: str = ISSUER,
    now: Optional[int] = None,
    check_freshness: bool = True,
) -> Optional[LicenseDoc]:
    """Verify a ``pkey-license+jws`` document (§2.1)."""
    return verify_doc(
        jws,
        trusted_keys,
        typ=TYP_LICENSE,
        decode=LicenseDoc.from_dict,
        expected_aud=expected_aud,
        device_id=device_id,
        expected_iss=expected_iss,
        last_accepted_issued_at=last_accepted_issued_at,
        now=now,
        check_freshness=check_freshness,
    )


def verify_config_doc(
    jws: str,
    trusted_keys: TrustSet,
    *,
    expected_aud: str,
    device_id: str,
    last_accepted_issued_at: Optional[int],
    expected_iss: str = ISSUER,
    now: Optional[int] = None,
    check_freshness: bool = True,
) -> Optional[ConfigDoc]:
    """Verify a ``pkey-config+jws`` document (§2.2)."""
    return verify_doc(
        jws,
        trusted_keys,
        typ=TYP_CONFIG,
        decode=ConfigDoc.from_dict,
        expected_aud=expected_aud,
        device_id=device_id,
        expected_iss=expected_iss,
        last_accepted_issued_at=last_accepted_issued_at,
        now=now,
        check_freshness=check_freshness,
    )
