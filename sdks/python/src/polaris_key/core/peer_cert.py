"""The Cloud Connect device certificate (``pkey-peer+jws``) and roster (``pkey-ring+jws``):
WIRE-CONTRACT-V5 §15.2 and §15.3, ported from ``packages/client-core/src/peer/cert.ts``.

Pure functions over bytes and a clock; nothing here does I/O and nothing raises. Both documents are
signed by the product key and verified against the effective product set (§1) through
:func:`~polaris_key.core.jws.verify_jws`, which keeps the strict JWS, Ed25519 and JSON rules. A
failing check names the step that refused it, in the order §15.2 lists them.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from .b64url import b64url_decode, b64url_encode
from .device_proof import is_x25519_low_order
from .jws import TrustSet, _point_acceptable, verify_jws
from .models import CLOCK_SKEW_SECONDS, ISSUER, _wire_int
from .patterns import _full_match

__all__ = [
    "PEER_CERT_TYP",
    "RING_TYP",
    "PEER_CERT_SECONDS",
    "MAX_PEER_CERT_SECONDS",
    "PEER_CERT_RENEW_SECONDS",
    "RING_SECONDS",
    "MAX_RING_DEVICES",
    "PeerCert",
    "PeerDeviceKeys",
    "Ring",
    "PeerSession",
    "CertResult",
    "RingResult",
    "ReplaceResult",
    "Admission",
    "verify_peer_cert",
    "verify_ring",
    "ring_expired",
    "replace_ring",
    "admit_peer",
]

PEER_CERT_TYP = "pkey-peer+jws"
RING_TYP = "pkey-ring+jws"
PEER_CERT_SECONDS = 604_800
MAX_PEER_CERT_SECONDS = 604_800
PEER_CERT_RENEW_SECONDS = 302_400
RING_SECONDS = 604_800
MAX_RING_DEVICES = 128

_SUB = re.compile(r"ps_[A-Za-z0-9_-]{22}")
_DEVICE = re.compile(r"[A-Za-z0-9_-]{32}")
_KEY = re.compile(r"[A-Za-z0-9_-]{43}")


@dataclass(frozen=True)
class PeerDeviceKeys:
    device_id: str
    sign_key: str
    agree_key: str


@dataclass(frozen=True)
class PeerCert:
    """A verified certificate's claims."""

    sub: str
    device_id: str
    sign_key: str
    agree_key: str
    ring_epoch: int
    issued_at: int
    expires_at: int

    def to_json(self) -> Dict[str, Any]:
        return {
            "sub": self.sub,
            "deviceId": self.device_id,
            "signKey": self.sign_key,
            "agreeKey": self.agree_key,
            "ringEpoch": self.ring_epoch,
            "issuedAt": self.issued_at,
            "expiresAt": self.expires_at,
        }


@dataclass(frozen=True)
class Ring:
    """A verified roster's claims."""

    sub: str
    epoch: int
    issued_at: int
    expires_at: int
    devices: Tuple[PeerDeviceKeys, ...]


@dataclass(frozen=True)
class PeerSession:
    """§15.2 step 7: the Noise session a certificate is shown in. Mode ``a`` also names the verifier's
    own subject and device id; modes ``v`` and ``p`` check the key only."""

    mode: str
    remote_static: str
    own_sub: Optional[str] = None
    own_device_id: Optional[str] = None


@dataclass(frozen=True)
class CertResult:
    ok: bool
    cert: Optional[PeerCert] = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class RingResult:
    ok: bool
    ring: Optional[Ring] = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class ReplaceResult:
    replace: bool
    ring: Optional[Ring] = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class Admission:
    admit: bool
    cert: Optional[PeerCert] = None
    #: ``"none"`` or ``"request"`` (ask the peer for ``RING``) when admitted.
    ring_sync: Optional[str] = None
    #: ``"cert-invalid"`` or ``"peer_revoked"`` when refused.
    reason: Optional[str] = None


def _key_bytes(v: Any) -> Optional[bytes]:
    """A canonical base64url string of exactly 32 bytes, decoded; ``None`` otherwise."""
    if not isinstance(v, str) or _full_match(_KEY, v) is None:
        return None
    try:
        raw = b64url_decode(v)
    except ValueError:
        return None
    if len(raw) != 32 or b64url_encode(raw) != v:
        return None
    return raw


def _keys_ok(sign_key: Any, agree_key: Any) -> bool:
    """§15.2 step 4 for one ``(signKey, agreeKey)`` pair. A verifier is lenient about non-canonical
    X25519 spellings (bit 255, ``u >= p``) but not about low-order points."""
    s = _key_bytes(sign_key)
    a = _key_bytes(agree_key)
    return s is not None and a is not None and _point_acceptable(s) and not is_x25519_low_order(a)


def _matches(rx: "re.Pattern[str]", v: Any) -> bool:
    return isinstance(v, str) and _full_match(rx, v) is not None


def _now() -> int:
    return int(time.time())


def verify_peer_cert(
    jws: str,
    *,
    trust: TrustSet,
    expected_aud: str,
    now: Optional[int] = None,
    session: Optional[PeerSession] = None,
) -> CertResult:
    """§15.2 steps 1 to 7, in order; the first failing step names the reason. ``session`` is omitted
    to check the certificate alone (steps 1 to 6)."""
    v = verify_jws(jws, trust, typ=PEER_CERT_TYP)
    if v is None or not isinstance(v.payload, dict):
        return CertResult(False, reason="jws-rejected")
    d = v.payload
    if d.get("iss") != ISSUER or d.get("aud") != expected_aud:
        return CertResult(False, reason="issuer-or-audience")
    epoch = _wire_int(d.get("ringEpoch"), 1)
    iat = _wire_int(d.get("issuedAt"), 0)
    exp = _wire_int(d.get("expiresAt"), 0)
    if epoch is None or iat is None or exp is None:
        return CertResult(False, reason="integer")
    if not _matches(_SUB, d.get("sub")) or not _matches(_DEVICE, d.get("deviceId")):
        return CertResult(False, reason="subject-or-device")
    if not _keys_ok(d.get("signKey"), d.get("agreeKey")):
        return CertResult(False, reason="keys")
    if exp - iat < 1 or exp - iat > MAX_PEER_CERT_SECONDS:
        return CertResult(False, reason="lifetime")
    at = _now() if now is None else now
    if iat > at + CLOCK_SKEW_SECONDS or at > exp + CLOCK_SKEW_SECONDS:
        return CertResult(False, reason="clock")
    if session is not None:
        if session.mode == "a":
            if d["sub"] != session.own_sub:
                return CertResult(False, reason="sub-mismatch")
            if d["deviceId"] == session.own_device_id:
                return CertResult(False, reason="own-device")
        if d["agreeKey"] != session.remote_static:
            return CertResult(False, reason="static-mismatch")
    cert = PeerCert(d["sub"], d["deviceId"], d["signKey"], d["agreeKey"], epoch, iat, exp)
    return CertResult(True, cert=cert)


def verify_ring(jws: str, *, trust: TrustSet, expected_aud: str) -> RingResult:
    """§15.3: the roster's own checks. The clock is a separate question (:func:`ring_expired`)."""
    v = verify_jws(jws, trust, typ=RING_TYP)
    if v is None or not isinstance(v.payload, dict):
        return RingResult(False, reason="jws-rejected")
    d = v.payload
    if d.get("iss") != ISSUER or d.get("aud") != expected_aud:
        return RingResult(False, reason="issuer-or-audience")
    epoch = _wire_int(d.get("epoch"), 1)
    iat = _wire_int(d.get("issuedAt"), 0)
    exp = _wire_int(d.get("expiresAt"), 0)
    if epoch is None or iat is None or exp is None:
        return RingResult(False, reason="integer")
    if not _matches(_SUB, d.get("sub")):
        return RingResult(False, reason="subject")
    if exp - iat < 1 or exp - iat > RING_SECONDS:
        return RingResult(False, reason="lifetime")
    devices = d.get("devices")
    if not isinstance(devices, list) or len(devices) < 1 or len(devices) > MAX_RING_DEVICES:
        return RingResult(False, reason="devices-size")
    for e in devices:
        if not isinstance(e, dict) or not _matches(_DEVICE, e.get("deviceId")):
            return RingResult(False, reason="device")
        if not _keys_ok(e.get("signKey"), e.get("agreeKey")):
            return RingResult(False, reason="keys")
    ids: List[str] = [e["deviceId"] for e in devices]
    for k in range(1, len(ids)):
        if ids[k] == ids[k - 1]:
            return RingResult(False, reason="duplicate-id")
        if not ids[k - 1] < ids[k]:  # ASCII, so code units are the byte order
            return RingResult(False, reason="unsorted")
    for f in ("signKey", "agreeKey"):
        if len({e[f] for e in devices}) != len(devices):
            return RingResult(False, reason="duplicate-key")
    ring = Ring(
        d["sub"],
        epoch,
        iat,
        exp,
        tuple(PeerDeviceKeys(e["deviceId"], e["signKey"], e["agreeKey"]) for e in devices),
    )
    return RingResult(True, ring=ring)


def ring_expired(ring: Ring, now: Optional[int] = None) -> bool:
    """§15.3: a roster is expired once ``now > expiresAt + 300``, the certificate's clock rule."""
    return (_now() if now is None else now) > ring.expires_at + CLOCK_SKEW_SECONDS


def _live_ring(held_jws: Optional[str], trust: TrustSet, aud: str, now: Optional[int]) -> Optional[Ring]:
    """The held ring, or ``None`` when there is none, it does not verify, or it is expired."""
    if held_jws is None:
        return None
    held = verify_ring(held_jws, trust=trust, expected_aud=aud)
    return held.ring if held.ok and held.ring is not None and not ring_expired(held.ring, now) else None


def replace_ring(
    held_jws: Optional[str],
    new_jws: str,
    *,
    trust: TrustSet,
    expected_aud: str,
    now: Optional[int] = None,
) -> ReplaceResult:
    """§15.3 "Held ring and replacement": the held ring is replaced only by a roster that verifies,
    has the same ``aud`` and ``sub``, a higher epoch and is not expired. An expired held ring counts
    as no ring at all."""
    nxt = verify_ring(new_jws, trust=trust, expected_aud=expected_aud)
    if not nxt.ok or nxt.ring is None:
        return ReplaceResult(False, reason="new-rejected")
    held = _live_ring(held_jws, trust, expected_aud, now)
    if held is not None:
        if nxt.ring.sub != held.sub:
            return ReplaceResult(False, reason="other-product-or-subject")
        if nxt.ring.epoch <= held.epoch:
            return ReplaceResult(False, reason="epoch-not-higher")
    if ring_expired(nxt.ring, now):
        return ReplaceResult(False, reason="new-expired")
    return ReplaceResult(True, ring=nxt.ring)


def admit_peer(
    cert_jws: str,
    held_ring_jws: Optional[str],
    *,
    trust: TrustSet,
    expected_aud: str,
    now: Optional[int] = None,
    session: Optional[PeerSession] = None,
) -> Admission:
    """§15.3 "Peer admission". ``ring_sync == "request"`` means the certificate is on a newer epoch
    than the held roster: ask the peer for ``RING``."""
    c = verify_peer_cert(cert_jws, trust=trust, expected_aud=expected_aud, now=now, session=session)
    if not c.ok or c.cert is None:
        return Admission(False, reason="cert-invalid")
    cert = c.cert
    ring = _live_ring(held_ring_jws, trust, expected_aud, now)
    if ring is None:
        return Admission(True, cert=cert, ring_sync="none")
    # A certificate of another account is judged by the session's own checks, never by this ring's
    # epoch: its numbers belong to a different roster.
    if cert.sub != ring.sub:
        return Admission(False, reason="cert-invalid")
    if ring.epoch > cert.ring_epoch:
        listed = any(
            e.device_id == cert.device_id and e.sign_key == cert.sign_key and e.agree_key == cert.agree_key
            for e in ring.devices
        )
        return Admission(True, cert=cert, ring_sync="none") if listed else Admission(False, reason="peer_revoked")
    return Admission(True, cert=cert, ring_sync="request" if cert.ring_epoch > ring.epoch else "none")
