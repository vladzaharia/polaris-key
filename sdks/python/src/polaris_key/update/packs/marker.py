"""The marker, ``pkey-marker/1`` (plans/P4-01.md §2.6, §2.8; WIRE-CONTRACT-V4 §3.7), a port of
client-core's ``packs/marker.ts``: the compact pack record beside an embedded single-file payload
(``X.pkey.json``) or inside an embedded tree (``D/.pkey/pack.json``). ``cases.json#markerCases``
pins :func:`verify_marker`; the byte match against the embedded payload and the stamp's pin is
the host's (:func:`match_embedded`).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Union

from ...constants_generated import MARKER_FORMAT, MAX_RECORD_JWS_BYTES, ErrorCode
from ...core.jws import TrustSet
from ...core.pack_claims import VERSION_PATTERN, is_pack_id
from ...core.patterns import _full_match
from ...core.release_record import verify_release_record
from .files import strict_parse

__all__ = ["VerifyMarkerResult", "verify_marker", "match_embedded"]


@dataclass(frozen=True)
class VerifyMarkerResult:
    """``ok`` with the pack id, version, verified record (its payload ``dict``) and record hash;
    or ``marker-rejected`` with the ``step``: ``format``, ``hash``, ``jws``, ``claims``,
    ``cross-check`` (and the host's ``payload`` and ``pin``)."""

    ok: bool
    pack_id: Optional[str] = None
    version: Optional[str] = None
    record: Optional[Dict[str, Any]] = None
    record_sha256: Optional[str] = None
    release: Optional[str] = None
    error: Optional[str] = None
    step: Optional[str] = None


def _refuse(step: str) -> VerifyMarkerResult:
    return VerifyMarkerResult(ok=False, error=ErrorCode.MARKER_REJECTED, step=step)


def verify_marker(
    marker: Union[str, bytes],
    *,
    release_keys: TrustSet,
    product_trust: TrustSet,
    expected_aud: str,
) -> VerifyMarkerResult:
    """``verifyMarker(marker, opts)`` (§2.6 "Markers", V4 §3.7), in order: strict JSON
    (``format``); ``format == "pkey-marker/1"``, ``packId`` a pack id, ``version`` matching
    ``VERSION_RE``, ``release`` a string (``format``); steps 12–14 with ``release`` as the body
    and its own SHA-256 as the pin hash (``hash``, ``jws``, ``claims``); ``kind == "pack"``,
    ``deliverable == packId``, ``version == version`` (``cross-check``). Never raises."""
    try:
        data = marker.encode("utf-8", "surrogatepass") if isinstance(marker, str) else bytes(marker)
        m = strict_parse(data)
        if not isinstance(m, dict):
            return _refuse("format")
        if m.get("format") != MARKER_FORMAT:
            return _refuse("format")
        if not is_pack_id(m.get("packId")):
            return _refuse("format")
        if _full_match(VERSION_PATTERN, m.get("version")) is None:
            return _refuse("format")
        release = m.get("release")
        if not isinstance(release, str):
            return _refuse("format")
        if not release.isascii() or len(release) > MAX_RECORD_JWS_BYTES:
            return _refuse("hash")
        record_sha256 = hashlib.sha256(release.encode("ascii")).hexdigest()
        v = verify_release_record(
            release,
            release_keys=release_keys,
            product_trust=product_trust,
            expected_aud=expected_aud,
            expected_hash=record_sha256,
        )
        if not v.ok or v.record is None:
            return _refuse(v.step or "jws")
        record = v.record.to_dict()
        if (
            record.get("kind") != "pack"
            or record.get("deliverable") != m["packId"]
            or record.get("version") != m["version"]
        ):
            return _refuse("cross-check")
        return VerifyMarkerResult(
            ok=True,
            pack_id=m["packId"],
            version=m["version"],
            record=record,
            record_sha256=record_sha256,
            release=release,
        )
    except Exception:
        return _refuse("format")


def match_embedded(
    verified: VerifyMarkerResult,
    payload: Mapping[str, Any],
    stamp: Optional[Mapping[str, Any]],
) -> Dict[str, Any]:
    """The host's match of an embedded payload against its verified marker (§2.6): the variant
    whose ``payload`` the bytes match (``{"kind": "file", "sha256", "size"}`` by SHA-256 and
    size, ``{"kind": "tree", "treeDigest"}`` by tree digest), and, when the stamp pins the pack,
    the record hash equal to the pin's. Returns ``{"ok": True, "variant": i}`` or
    ``{"ok": False, "error": "marker-rejected", "step": "payload" | "pin"}``."""
    record = verified.record or {}
    index = -1
    for i, v in enumerate(record.get("variants") or []):
        p = v.get("payload") or {}
        if payload.get("kind") == "file":
            hit = p.get("sha256") == payload.get("sha256") and p.get("size") == payload.get("size")
        else:
            hit = (v.get("files") or {}).get("layout") == "tree" and p.get("sha256") == payload.get(
                "treeDigest"
            )
        if hit:
            index = i
            break
    if index < 0:
        return {"ok": False, "error": ErrorCode.MARKER_REJECTED, "step": "payload"}
    pins = (stamp or {}).get("pins") or []
    pin = next((p for p in pins if p.get("pack") == verified.pack_id), None)
    if pin is not None and pin["release"]["sha256"] != verified.record_sha256:
        return {"ok": False, "error": ErrorCode.MARKER_REJECTED, "step": "pin"}
    return {"ok": True, "variant": index}
