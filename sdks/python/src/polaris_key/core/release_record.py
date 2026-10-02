"""The release record — WIRE-CONTRACT-V4 §2.4 and client steps 12–16 (plans/P3-01.md §2.4, §2.5).

A port of ``@polaris-key/client-core``'s ``record.ts``: ``release_record_claims`` (step 14),
``record_hash``, ``verify_release_record`` (hash before signature, key selection from the
PINNED release keys only, signature, claims, cross-check) and the reload path. Nothing here
does I/O or raises for a bad artifact.

A record is signed in CI with a release key the Worker never holds, and verified only against
the keys the app pins (``pinned_release_keys``): never merged with, and never added to from,
the product trust set. A selected release key whose raw bytes are also a product key is
refused, so the two-signer property cannot be lost without a trace.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Collection, Dict, Mapping, Optional, Tuple

from ..constants_generated import (
    MAX_BUILD_EMBEDS,
    MAX_PACK_VARIANTS,
    MAX_RECORD_JWS_BYTES,
    MAX_VARIANT_DELTAS,
)
from .b64url import b64url_decode
from .jws import TrustSet, verify_jws
from .models import TYP_RELEASE, ReleaseRecordDoc, _wire_int
from .pack_claims import (
    ENGINE_PATTERN,
    ENTITLEMENT_PATTERN,
    HANDLER_PREFIX_PATTERN,
    OBJECT_FORMAT_PATTERN,
    PACK_TYPE_PATTERN,
    VARIANT_AXIS_PATTERN,
    VARIANT_VALUE_PATTERN,
    VOCAB_TOKEN_PATTERN,
    content_claims,
    is_pack_id,
    object_ref,
    utf8_length,
    variant_key,
)
from .patterns import _full_match

__all__ = [
    "BUILD_ID_PATTERN",
    "MAX_RECORD_JWS_BYTES",
    "ReleaseRecordPin",
    "VerifyReleaseRecordResult",
    "CommittedRecord",
    "release_record_claims",
    "record_hash",
    "verify_release_record",
    "reload_release_records",
]

#: P2-04's ``BUILD_ID_RE``: ASCII, so the uniqueness check and the decision's tie-break by
#: build id compare bytes in every SDK.
BUILD_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
#: ``@polaris-key/manifest``'s ``DELIVERABLE_ID_PATTERN``, restated; at most 64 bytes.
_DELIVERABLE_RE = re.compile(r"[a-z][a-z0-9-]*(\.[a-z0-9-]+)*")
#: P2-04's ``VERSION_RE``. The record names no scheme: the pin's version parses under the feed's.
_VERSION_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+-]{0,63}")
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_MAX_BUILDS = 64
_MAX_ARTIFACTS = 32


def _non_empty(v: Any) -> bool:
    return isinstance(v, str) and v != ""


def _opt_string(o: Dict[str, Any], key: str) -> bool:
    """An optional string member: absent, or a string (a present ``null`` is refused)."""
    return key not in o or isinstance(o[key], str)


def _claims_ok(doc: Dict[str, Any], expected_aud: str) -> bool:
    schema_version = _wire_int(doc.get("schemaVersion"), 1)
    if schema_version is None or schema_version != 1:
        return False
    if not isinstance(doc.get("aud"), str) or doc["aud"] != expected_aud:
        return False
    deliverable = doc.get("deliverable")
    if (
        not isinstance(deliverable, str)
        or len(deliverable) > 64
        or _full_match(_DELIVERABLE_RE, deliverable) is None
    ):
        return False
    if not _non_empty(doc.get("kind")):
        return False
    if _full_match(_VERSION_RE, doc.get("version")) is None:
        return False
    if _wire_int(doc.get("seq"), 1) is None:
        return False
    if _wire_int(doc.get("issuedAt"), 0) is None:
        return False
    if "minSupportedSeq" in doc and _wire_int(doc["minSupportedSeq"], 1) is None:
        return False
    for key in ("tag", "channel", "title", "notes"):
        if not _opt_string(doc, key):
            return False
    if "provenance" in doc:
        p = doc["provenance"]
        if not isinstance(p, dict) or not _opt_string(p, "commit") or not _opt_string(
            p, "workflowRun"
        ):
            return False

    # plans/P4-01.md §2.2: §2.3 applies to `kind: pack` and §2.4 to `kind: app`; a record of
    # any other kind keeps the common claims only.
    if doc["kind"] == "pack":
        return _pack_claims_ok(doc)
    if doc["kind"] == "app" and "content" in doc and not content_claims(doc["content"]):
        return False

    if "builds" not in doc:
        return doc["kind"] != "app"
    builds = doc["builds"]
    if not isinstance(builds, list) or len(builds) < 1 or len(builds) > _MAX_BUILDS:
        return False
    ids = set()
    for build in builds:
        if not isinstance(build, dict):
            return False
        build_id = build.get("id")
        if _full_match(BUILD_ID_PATTERN, build_id) is None:
            return False
        if build_id in ids:
            return False
        ids.add(build_id)
        if not (
            _non_empty(build.get("platform"))
            and _non_empty(build.get("arch"))
            and _non_empty(build.get("format"))
        ):
            return False
        if not _opt_string(build, "buildNumber") or not _opt_string(build, "minOS"):
            return False
        if "requires" in build and not isinstance(build["requires"], dict):
            return False
        artifacts = build.get("artifacts")
        if not isinstance(artifacts, list) or len(artifacts) > _MAX_ARTIFACTS:
            return False
        payloads = 0
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                return False
            if not _non_empty(artifact.get("name")) or not _non_empty(artifact.get("role")):
                return False
            if artifact["role"] == "payload":
                payloads += 1
            if _full_match(_SHA256_RE, artifact.get("sha256")) is None:
                return False
            if _wire_int(artifact.get("size"), 0) is None:
                return False
            if not _opt_string(artifact, "contentType"):
                return False
        if payloads > 1:
            return False
        if doc["kind"] == "app" and "embeds" in build and not _embeds_ok(build["embeds"]):
            return False
    return True


def _embeds_ok(embeds: Any) -> bool:
    """``builds[].embeds`` (plans/P4-01.md §2.4): 0–64 unique pack ids."""
    if not isinstance(embeds, list) or len(embeds) > MAX_BUILD_EMBEDS:
        return False
    seen = set()
    for pack_id in embeds:
        if not is_pack_id(pack_id) or pack_id in seen:
            return False
        seen.add(pack_id)
    return True


def _opt_pattern(o: Dict[str, Any], key: str, pattern: "re.Pattern[str]") -> bool:
    """An optional member that must match ``pattern`` when present (``null`` is refused)."""
    return key not in o or _full_match(pattern, o[key]) is not None


def _hash_bytes_ok(v: Any) -> bool:
    """A ``{sha256, bytes}`` member (a delta's ``artifact`` or ``data``): bytes ≥ 1."""
    return (
        isinstance(v, dict)
        and _full_match(_SHA256_RE, v.get("sha256")) is not None
        and _wire_int(v.get("bytes"), 1) is not None
    )


def _pack_claims_ok(doc: Dict[str, Any]) -> bool:
    """The pack record's claims (plans/P4-01.md §2.3), after the common ones. A value outside a
    v1 vocabulary is never refused here; it only makes the governed thing unusable (§2.2)."""
    if doc["deliverable"] == "app":
        return False
    if "builds" in doc:
        return False
    if _full_match(PACK_TYPE_PATTERN, doc.get("type")) is None:
        return False
    if _wire_int(doc.get("formatVersion"), 1) is None:
        return False
    if "handler" in doc:
        h = doc["handler"]
        if not isinstance(h, dict):
            return False
        if "mountOrder" in h and _wire_int(h["mountOrder"], 0) is None:
            return False
        if "prefixes" in h:
            p = h["prefixes"]
            if not isinstance(p, list) or len(p) < 1 or len(p) > 32:
                return False
            seen = set()
            for prefix in p:
                if _full_match(HANDLER_PREFIX_PATTERN, prefix) is None:
                    return False
                if utf8_length(prefix) > 256 or prefix in seen:
                    return False
                seen.add(prefix)
        if not _opt_pattern(h, "activation", VOCAB_TOKEN_PATTERN):
            return False
    if not _opt_pattern(doc, "entitlement", ENTITLEMENT_PATTERN):
        return False

    variants = doc.get("variants")
    if not isinstance(variants, list) or len(variants) < 1 or len(variants) > MAX_PACK_VARIANTS:
        return False
    keys = set()
    axes: Optional[Tuple[str, ...]] = None
    for v in variants:
        if not isinstance(v, dict):
            return False
        sel = v.get("variant")
        if not isinstance(sel, dict):
            return False
        names = list(sel.keys())
        if len(names) > 4:
            return False
        for name in names:
            if _full_match(VARIANT_AXIS_PATTERN, name) is None:
                return False
            if _full_match(VARIANT_VALUE_PATTERN, sel[name]) is None:
                return False
        p = v.get("payload")
        if not isinstance(p, dict):
            return False
        if _wire_int(p.get("size"), 0) is None:
            return False
        if _full_match(_SHA256_RE, p.get("sha256")) is None:
            return False
        if not object_ref(v.get("full"), 0, 0):
            return False
        f = v.get("files")
        if not isinstance(f, dict):
            return False
        if _full_match(OBJECT_FORMAT_PATTERN, f.get("format")) is None:
            return False
        if _full_match(VOCAB_TOKEN_PATTERN, f.get("layout")) is None:
            return False
        if not object_ref(f, 1, 1):
            return False
        if "gaps" in f:
            if not isinstance(f["gaps"], dict):
                return False
            if f["layout"] == "tree":
                return False
            if not object_ref(f["gaps"], 0, 0):
                return False
        elif f["layout"] == "container":
            return False
        if "deltas" in v:
            deltas = v["deltas"]
            if not isinstance(deltas, list) or len(deltas) > MAX_VARIANT_DELTAS:
                return False
            ids = set()
            for d in deltas:
                if not isinstance(d, dict):
                    return False
                if _full_match(VOCAB_TOKEN_PATTERN, d.get("method")) is None:
                    return False
                if _full_match(VOCAB_TOKEN_PATTERN, d.get("scope")) is None:
                    return False
                if d["scope"] == "payload" and f["layout"] == "tree":
                    return False
                if _full_match(_SHA256_RE, d.get("from")) is None:
                    return False
                if _wire_int(d.get("memBytes"), 1) is None:
                    return False
                delta_id: Optional[str] = None
                if d["scope"] == "payload":
                    if not _hash_bytes_ok(d.get("artifact")):
                        return False
                    delta_id = d["artifact"]["sha256"]
                elif d["scope"] == "files":
                    if not object_ref(d.get("patch"), 1, 1):
                        return False
                    if not _hash_bytes_ok(d.get("data")):
                        return False
                    delta_id = d["patch"]["sha256"]
                if delta_id is not None:
                    if delta_id in ids:
                        return False
                    ids.add(delta_id)
        if "requires" in v:
            r = v["requires"]
            if not isinstance(r, dict) or not _opt_pattern(r, "engine", ENGINE_PATTERN):
                return False
        key = variant_key(sel)
        if key in keys:
            return False
        keys.add(key)
        axis_set = tuple(sorted(names))
        if axes is None:
            axes = axis_set
        elif axes != axis_set:
            return False
    return True


def release_record_claims(payload: Any, *, expected_aud: str) -> bool:
    """Client step 14 over a verified record payload: true when every claim of §2.4 holds.

    A ``kind: pack`` record must pass the pack claims (plans/P4-01.md §2.3) and a ``kind: app``
    record's ``content`` and ``builds[].embeds`` the app ones (§2.4); reserved kinds
    (``revocation``, ``delegation``) and unknown kinds keep the common claims only. The
    cross-check refuses them where an app record is expected. Never raises.
    """
    if not isinstance(payload, dict):
        return False
    try:
        return _claims_ok(payload, expected_aud)
    except Exception:
        return False


# ── Hash, key selection, signature, cross-check (client steps 12–16) ────────────────────────


def _utf8(s: str) -> bytes:
    """UTF-8 as JavaScript's ``TextEncoder`` writes it: a lone surrogate becomes U+FFFD."""
    try:
        return s.encode("utf-8")
    except UnicodeEncodeError:
        return s.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def record_hash(jws: str) -> str:
    """The record hash (WIRE-CONTRACT-V4 §8): the lowercase hex SHA-256 of the compact JWS's
    bytes, exactly as received. A record is ASCII; ``verify_release_record`` refuses any other
    body before hashing it, so the UTF-8 encoding here only matters to a caller hashing
    something else."""
    return hashlib.sha256(_utf8(jws)).hexdigest()


@dataclass(frozen=True)
class ReleaseRecordPin:
    """What a target pins, for the cross-check (step 15). ``kind`` is the record kind the pin
    names: ``app`` for a feed target (the default), ``pack`` for a content pin
    (plans/P4-01.md §2.6)."""

    deliverable: str
    version: str
    seq: int
    kind: str = "app"


@dataclass(frozen=True)
class VerifyReleaseRecordResult:
    """``verify_release_record``'s answer: ``ok`` with the decoded ``record``, or the refusal
    ``step`` (``releaseRecordCases`` ``expect.step``): ``hash``, ``jws``, ``claims`` or
    ``cross-check``."""

    ok: bool
    record: Optional[ReleaseRecordDoc] = None
    step: Optional[str] = None


def _fail(step: str) -> VerifyReleaseRecordResult:
    return VerifyReleaseRecordResult(ok=False, step=step)


def _raw_key(b64url: Any) -> Optional[bytes]:
    if not isinstance(b64url, str):
        return None
    try:
        return b64url_decode(b64url)
    except Exception:
        return None


def _header_kid(jws: str) -> Optional[str]:
    """The protected header's ``kid``, read without trusting anything else in it
    (``verify_jws`` re-reads the header strictly). ``None`` when there is none to read."""
    enc_header = jws.split(".")[0]
    if not enc_header:
        return None
    try:
        header = json.loads(b64url_decode(enc_header).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(header, dict) or not isinstance(header.get("kid"), str):
        return None
    return header["kid"]


def verify_release_record(
    jws: str,
    *,
    release_keys: TrustSet,
    product_trust: TrustSet,
    expected_aud: str,
    expected_hash: str,
    pin: Optional[ReleaseRecordPin] = None,
) -> VerifyReleaseRecordResult:
    """Client steps 12–15 (plans/P3-01.md §2.5), in the contract's order:

    12. a body over ``MAX_RECORD_JWS_BYTES`` (88 844) or with a byte outside ASCII is refused
        without hashing; otherwise its SHA-256 must equal ``expected_hash``, before any
        Ed25519 work;
    13. the key is selected by ``kid`` from ``release_keys`` (the PINNED release keys) only,
        refused if its raw bytes are also in ``product_trust`` (the effective product trust
        set), then ``verify_jws`` with that one key and ``typ`` ``pkey-release+jws``;
    14. the claims (:func:`release_record_claims`);
    15. with a ``pin``: ``kind`` equals the pin's ``kind`` (``app`` by default), and ``deliverable``, ``version`` and ``seq`` equal
        the pin's.

    Never raises.
    """
    try:
        # 12. Hash before signature.
        if not isinstance(jws, str):
            return _fail("hash")
        if not jws.isascii() or len(jws) > MAX_RECORD_JWS_BYTES:
            return _fail("hash")
        if hashlib.sha256(jws.encode("ascii")).hexdigest() != expected_hash:
            return _fail("hash")

        # 13. The pinned release keys only, and never a product key.
        kid = _header_kid(jws)
        if kid is None or kid not in release_keys:
            return _fail("jws")
        key = release_keys[kid]
        raw = _raw_key(key)
        if raw is None:
            return _fail("jws")
        for product_key in product_trust.values():
            if _raw_key(product_key) == raw:
                return _fail("jws")
        v = verify_jws(jws, {kid: key}, typ=TYP_RELEASE, require_typ=True)
        if v is None:
            return _fail("jws")

        # 14. The claims.
        if not release_record_claims(v.payload, expected_aud=expected_aud):
            return _fail("claims")
        record = ReleaseRecordDoc.from_dict(v.payload)

        # 15. The cross-check against the pin.
        if pin is not None:
            if record.kind != pin.kind or record.deliverable != pin.deliverable:
                return _fail("cross-check")
            if record.version != pin.version or record.seq != pin.seq:
                return _fail("cross-check")
        return VerifyReleaseRecordResult(ok=True, record=record)
    except Exception:
        return _fail("jws")


@dataclass(frozen=True)
class CommittedRecord:
    jws: str
    record: ReleaseRecordDoc


def reload_release_records(
    cached: Optional[Mapping[str, Any]],
    *,
    release_keys: TrustSet,
    product_trust: TrustSet,
    expected_aud: str,
    pinned: Collection[str],
) -> Dict[str, CommittedRecord]:
    """The reload path for the ``releaseRecords`` slice (plans/P3-01.md §2.5): each
    ``records[h]`` goes through steps 12–14 with ``h`` as the pin, and is kept only when
    ``pinned`` (the hashes a surviving committed feed's target for this platform pins) holds
    ``h``. Anything else is absent. Never raises."""
    out: Dict[str, CommittedRecord] = {}
    if not isinstance(cached, Mapping):
        return out
    for h, jws in cached.items():
        if not isinstance(h, str) or not isinstance(jws, str) or h not in pinned:
            continue
        r = verify_release_record(
            jws,
            release_keys=release_keys,
            product_trust=product_trust,
            expected_aud=expected_aud,
            expected_hash=h,
        )
        if r.ok and r.record is not None:
            out[h] = CommittedRecord(jws=jws, record=r.record)
    return out
