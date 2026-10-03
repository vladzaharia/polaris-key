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
from typing import AbstractSet, Any, Collection, Dict, Mapping, Optional, Tuple, Union

from ..constants_generated import (
    DELEGABLE_PACK_TYPE_VALUES,
    MAX_BUILD_EMBEDS,
    MAX_DELEGATION_TTL_SECONDS,
    MAX_DELEGATION_TYPES,
    MAX_PACK_VARIANTS,
    MAX_RECORD_JWS_BYTES,
    MAX_VARIANT_DELTAS,
    REVOCATION_REASON_MAX_BYTES,
)
from .b64url import b64url_decode
from .jws import TrustSet, verify_jws
from .models import TYP_RELEASE, ReleasePin, ReleaseRecordDoc, _wire_int
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
    "RevocationBody",
    "VerifiedRevocation",
    "VerifyRevocationResult",
    "revocation_of",
    "verify_revocation",
    "newer_revocation",
    "DELEGATED_KID_PATTERN",
    "RecordDelegation",
    "DelegationBody",
    "VerifiedDelegation",
    "VerifyDelegationResult",
    "delegation_hash_of",
    "delegated_kid",
    "delegation_of",
    "verify_delegation",
    "covers_pack",
    "record_revoked",
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
        # plans/P4-10.md §2.2: checks 81-83 and the object ref at ``chunks`` (``bytes`` and
        # ``size`` from 1); other members are ignored (reserved: an index delta).
        if "chunks" in v:
            c = v["chunks"]
            if not isinstance(c, dict):
                return False
            if _full_match(OBJECT_FORMAT_PATTERN, c.get("format")) is None:
                return False
            if not object_ref(c, 1, 1):
                return False
            if "params" in c and not isinstance(c["params"], dict):
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
    record's ``content`` and ``builds[].embeds`` the app ones (§2.4); the ``revocation`` kind
    (checked further by ``verify_revocation``), the ``delegation`` kind (read by ``delegation_of``) and unknown kinds
    keep the common claims only. The
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
class RecordDelegation:
    """The delegation a delegated record verified through (plans/P4-19.md §2.3): its record
    hash (the kid's hex), its scope root, its effective types (``types ∩
    DELEGABLE_PACK_TYPES``, in the delegation's order) and its signing window."""

    sha256: str
    deliverable: str
    types: Tuple[str, ...]
    issuedAt: int
    expiresAt: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sha256": self.sha256,
            "deliverable": self.deliverable,
            "types": list(self.types),
            "issuedAt": self.issuedAt,
            "expiresAt": self.expiresAt,
        }


@dataclass(frozen=True)
class VerifyReleaseRecordResult:
    """``verify_release_record``'s answer: ``ok`` with the decoded ``record``, or the refusal
    ``step`` (``releaseRecordCases`` ``expect.step``): ``hash``, ``jws``, ``claims``,
    ``cross-check``, and on the delegated path ``delegation`` or ``scope`` (plans/P4-19.md
    §2.3). ``delegation`` is the delegation a content key's record verified through, ``None``
    for a release key's."""

    ok: bool
    record: Optional[ReleaseRecordDoc] = None
    step: Optional[str] = None
    delegation: Optional[RecordDelegation] = None


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
        header = json.loads(b64url_decode(enc_header).decode("utf-8", "strict"))
    except Exception:
        return None
    if not isinstance(header, dict) or not isinstance(header.get("kid"), str):
        return None
    return header["kid"]


def _in_trust(raw: bytes, trust: TrustSet) -> bool:
    """True when any key of ``trust`` has the raw bytes ``raw``."""
    for k in trust.values():
        other = _raw_key(k)
        if other is not None and other == raw:
            return True
    return False


def verify_release_record(
    jws: str,
    *,
    release_keys: TrustSet,
    product_trust: TrustSet,
    expected_aud: str,
    expected_hash: str,
    pin: Optional[ReleaseRecordPin] = None,
    delegation: Optional[str] = None,
) -> VerifyReleaseRecordResult:
    """Client steps 12–16 (plans/P3-01.md §2.5, plans/P4-19.md §2.3), in the contract's order:

    12. a body over ``MAX_RECORD_JWS_BYTES`` (88 844) or with a byte outside ASCII is refused
        without hashing; otherwise its SHA-256 must equal ``expected_hash``, before any
        Ed25519 work;
    13. the key is selected by ``kid`` from ``release_keys`` (the PINNED release keys) only,
        refused if its raw bytes are also in ``product_trust`` (the effective product trust
        set), then ``verify_jws`` with that one key and ``typ`` ``pkey-release+jws``. Otherwise,
        with ``delegation`` (the delegation's compact JWS) supplied and a ``pkd1-`` kid: the
        delegation is verified against the pinned release keys (:func:`verify_delegation`, its
        hash the kid's hex), its key must equal no pinned release key and no product key (both
        step ``delegation``), then ``verify_jws`` with the delegated key (step ``jws``);
    14. the claims (:func:`release_record_claims`);
    15. with a ``pin``: ``kind`` equals the pin's ``kind`` (``app`` by default), and ``deliverable``, ``version`` and ``seq`` equal
        the pin's;
    16. a delegated record only (``scope``): ``kind: pack``, ``deliverable`` the scope root or
        under it by whole segments, ``type`` in the effective types, every variant's
        ``files.layout`` ``tree``, and ``delegation.issuedAt ≤ issuedAt ≤ delegation.expiresAt``.

    Without ``delegation`` the behaviour is the pre-P4-19 one. Never raises.
    """
    try:
        # 12. Hash before signature.
        if not isinstance(jws, str):
            return _fail("hash")
        if not jws.isascii() or len(jws) > MAX_RECORD_JWS_BYTES:
            return _fail("hash")
        if hashlib.sha256(jws.encode("ascii")).hexdigest() != expected_hash:
            return _fail("hash")

        # 13. The pinned release keys only, and never a product key; or one delegation from them.
        kid = _header_kid(jws)
        if kid is None:
            return _fail("jws")
        verified: Optional[VerifiedDelegation] = None
        if kid in release_keys:
            key = release_keys[kid]
            raw = _raw_key(key)
            if raw is None:
                return _fail("jws")
            if _in_trust(raw, product_trust):
                return _fail("jws")
        else:
            h = delegation_hash_of(jws)
            if not isinstance(delegation, str) or h is None:
                return _fail("jws")
            d = verify_delegation(
                delegation,
                release_keys=release_keys,
                product_trust=product_trust,
                expected_aud=expected_aud,
                expected_hash=h,
            )
            if not d.ok or d.delegation is None:
                return _fail("delegation")
            raw = _raw_key(d.delegation.publicKey)
            if raw is None:
                return _fail("delegation")
            if _in_trust(raw, release_keys) or _in_trust(raw, product_trust):
                return _fail("delegation")
            verified = d.delegation
            key = d.delegation.publicKey
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

        # 16. The delegation's scope.
        if verified is not None and not _in_scope(v.payload, verified):
            return _fail("scope")
        return VerifyReleaseRecordResult(
            ok=True,
            record=record,
            delegation=(
                None
                if verified is None
                else RecordDelegation(
                    sha256=verified.sha256,
                    deliverable=verified.deliverable,
                    types=verified.types,
                    issuedAt=verified.issuedAt,
                    expiresAt=verified.expiresAt,
                )
            ),
        )
    except Exception:
        return _fail("jws")


def _in_scope(record: Dict[str, Any], d: "VerifiedDelegation") -> bool:
    """Step 16 (plans/P4-19.md §2.3) over a record whose claims passed."""
    if record.get("kind") != "pack":
        return False
    if not covers_pack(d.deliverable, record["deliverable"]):
        return False
    t = record.get("type")
    if not isinstance(t, str) or t not in d.types:
        return False
    if not all(x["files"]["layout"] == "tree" for x in record["variants"]):
        return False
    return d.issuedAt <= record["issuedAt"] <= d.expiresAt


def covers_pack(root: str, pack: str) -> bool:
    """Whether pack id ``pack`` is the scope root ``root`` or under it by whole segments
    (plans/P4-19.md §2.3 step 16): ``djdl.events`` covers ``djdl.events.halloween``, never
    ``djdl.eventsx``."""
    return pack == root or pack.startswith(root + ".")


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


# ── P4-13: the revocation record (plans/P4-13.md §2.3, WIRE-CONTRACT-V4 §2.5.3) ──────────────


@dataclass(frozen=True)
class RevocationBody:
    """A usable revocation body, as :func:`revocation_of` reads it. ``pack`` is the record's
    ``deliverable``, ``target`` its ``revokes``."""

    pack: str
    target: str
    replacement: Optional[ReleasePin]
    reason: str
    issuedAt: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pack": self.pack,
            "target": self.target,
            "replacement": None if self.replacement is None else self.replacement.to_dict(),
            "reason": self.reason,
            "issuedAt": self.issuedAt,
        }


@dataclass(frozen=True)
class VerifiedRevocation:
    """A verified revocation: its body, its record hash and the pin it was verified with
    (``version`` and ``seq`` are the target's, the record's own)."""

    pack: str
    target: str
    replacement: Optional[ReleasePin]
    reason: str
    issuedAt: int
    record: str
    version: str
    seq: int

    def to_dict(self) -> Dict[str, Any]:
        out = RevocationBody(
            pack=self.pack,
            target=self.target,
            replacement=self.replacement,
            reason=self.reason,
            issuedAt=self.issuedAt,
        ).to_dict()
        out.update({"record": self.record, "version": self.version, "seq": self.seq})
        return out


@dataclass(frozen=True)
class VerifyRevocationResult:
    """``verify_revocation``'s answer: ``ok`` with the ``revocation``, or the refusal ``step``
    (``revocationCases`` ``expect.step``): ``hash``, ``jws``, ``claims``, ``cross-check`` or
    ``revocation``."""

    ok: bool
    revocation: Optional[VerifiedRevocation] = None
    step: Optional[str] = None


def revocation_of(doc: Any) -> Optional[RevocationBody]:
    """The revocation body (plans/P4-13.md §2.3), read beside the claims: usable when ``kind``
    is ``revocation``, ``deliverable`` is a pack id, ``revokes`` is 64 lowercase hex,
    ``replacement`` is absent or ``{sha256: 64 hex and not revokes, seq: an integer ≥ 1,
    version}``, and ``reason`` is a string of 1–``REVOCATION_REASON_MAX_BYTES`` bytes.
    ``builds`` and ``content`` are ignored. ``None`` when unusable. Never raises."""
    try:
        if not isinstance(doc, dict) or doc.get("kind") != "revocation":
            return None
        if not is_pack_id(doc.get("deliverable")):
            return None
        revokes = doc.get("revokes")
        if _full_match(_SHA256_RE, revokes) is None:
            return None
        replacement: Optional[ReleasePin] = None
        if "replacement" in doc:
            r = doc["replacement"]
            if not isinstance(r, dict):
                return None
            if _full_match(_SHA256_RE, r.get("sha256")) is None or r["sha256"] == revokes:
                return None
            if _wire_int(r.get("seq"), 1) is None:
                return None
            if _full_match(_VERSION_RE, r.get("version")) is None:
                return None
            replacement = ReleasePin(sha256=r["sha256"], seq=r["seq"], version=r["version"])
        reason = doc.get("reason")
        if not isinstance(reason, str):
            return None
        n = utf8_length(reason)
        if n < 1 or n > REVOCATION_REASON_MAX_BYTES:
            return None
        issued = doc.get("issuedAt")
        if isinstance(issued, bool) or not isinstance(issued, (int, float)):
            return None
        return RevocationBody(
            pack=doc["deliverable"],
            target=revokes,
            replacement=replacement,
            reason=reason,
            issuedAt=issued,  # type: ignore[arg-type]
        )
    except Exception:
        return None


def verify_revocation(
    jws: str,
    *,
    release_keys: TrustSet,
    product_trust: TrustSet,
    expected_aud: str,
    entry: Mapping[str, Any],
) -> VerifyRevocationResult:
    """Verify a revocation record against a feed entry (plans/P4-13.md §2.3): V4 §3.5 steps
    12–14 with ``entry["record"]`` as the pin hash, step 15 with the pin ``{kind:
    "revocation", deliverable: entry["pack"], version: entry["version"], seq: entry["seq"]}``,
    and step 16 (``revocation``): the body is usable (:func:`revocation_of`) and ``revokes``
    equals ``entry["target"]``. ``entry`` is the feed's ``revocations`` entry (or a stored
    entry's equivalent). Never raises."""
    try:
        r = verify_release_record(
            jws,
            release_keys=release_keys,
            product_trust=product_trust,
            expected_aud=expected_aud,
            expected_hash=entry["record"],
            pin=ReleaseRecordPin(
                kind="revocation",
                deliverable=entry["pack"],
                version=entry["version"],
                seq=entry["seq"],
            ),
        )
    except Exception:
        return VerifyRevocationResult(ok=False, step="jws")
    if not r.ok or r.record is None:
        return VerifyRevocationResult(ok=False, step=r.step)
    body = revocation_of(r.record.to_dict())
    if body is None or body.target != entry.get("target"):
        return VerifyRevocationResult(ok=False, step="revocation")
    return VerifyRevocationResult(
        ok=True,
        revocation=VerifiedRevocation(
            pack=body.pack,
            target=body.target,
            replacement=body.replacement,
            reason=body.reason,
            issuedAt=body.issuedAt,
            record=entry["record"],
            version=r.record.version,
            seq=r.record.seq,
        ),
    )


def newer_revocation(a: Any, b: Any) -> Any:
    """The winner of two verified revocations of one target (plans/P4-13.md §2.3, decision
    18): the higher ``issuedAt``, else the higher record hash by bytes. The Worker ranks
    superseding revocations with this same rule. Revocations are permanent: superseding
    changes the replacement or reason, never the revoked status."""
    if a.issuedAt != b.issuedAt:
        return a if a.issuedAt > b.issuedAt else b
    return a if a.record >= b.record else b


# ── P4-19: content-key delegation (plans/P4-19.md §2.2–§2.6, WIRE-CONTRACT-V4 §2.5.4) ──────

#: ``DELEGATED_KID_PATTERN`` (``@polaris-key/protocol/release``), restated: ``pkd1-`` and the
#: delegation's record hash. 69 bytes, so it never collides with a declared release kid.
DELEGATED_KID_PATTERN = re.compile(r"pkd1-[0-9a-f]{64}")
#: 32 raw bytes in strict base64url (V4 §1): 43 characters, no padding, zero trailing bits.
_KEY_B64URL_RE = re.compile(r"[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]")


def delegation_hash_of(jws: Any) -> Optional[str]:
    """The delegation hash a delegated record's header names (plans/P4-19.md §2.2): the hex of
    a ``pkd1-<sha256>`` kid, read from the protected header only. ``None`` for any other kid.
    Never raises."""
    if not isinstance(jws, str):
        return None
    kid = _header_kid(jws)
    if kid is None or _full_match(DELEGATED_KID_PATTERN, kid) is None:
        return None
    return kid[5:]


def delegated_kid(delegation_sha256: str) -> str:
    """The delegated kid of a delegation record hash: ``pkd1-<sha256>``."""
    return "pkd1-" + delegation_sha256


@dataclass(frozen=True)
class DelegationBody:
    """A usable delegation body, as :func:`delegation_of` reads it. ``types`` are the effective
    types (``types ∩ DELEGABLE_PACK_TYPES``, in the record's order, never empty);
    ``listedTypes`` the record's ``types`` as listed."""

    deliverable: str
    seq: int
    publicKey: str
    types: Tuple[str, ...]
    listedTypes: Tuple[str, ...]
    issuedAt: int
    expiresAt: int


@dataclass(frozen=True)
class VerifiedDelegation(DelegationBody):
    """A verified delegation: its body and its record hash."""

    sha256: str = ""


@dataclass(frozen=True)
class VerifyDelegationResult:
    """``verify_delegation``'s answer: ``ok`` with the ``delegation``, or the refusal ``step``
    (a ``verify_release_record`` step, or ``delegation``)."""

    ok: bool
    delegation: Optional[VerifiedDelegation] = None
    step: Optional[str] = None


def delegation_of(doc: Any) -> Optional[DelegationBody]:
    """The delegation body (plans/P4-19.md §2.2), read beside the claims: usable when ``kind``
    is ``delegation``, ``deliverable`` is a pack id, ``delegate.publicKey`` is strict base64url
    of 32 bytes, ``types`` is 1–``MAX_DELEGATION_TYPES`` unique ``PACK_TYPE_PATTERN`` strings
    whose intersection with ``DELEGABLE_PACK_TYPES`` is non-empty, and ``expiresAt`` is an
    integer by token (minimum 1) with ``issuedAt < expiresAt ≤ issuedAt +
    MAX_DELEGATION_TTL_SECONDS``. ``builds``, ``content`` and unknown members are ignored.
    ``json.loads`` gives a ``float`` for every non-plain token, so the token rule needs no
    pointer set here. ``None`` when unusable. Never raises."""
    try:
        if not isinstance(doc, dict) or doc.get("kind") != "delegation":
            return None
        if not is_pack_id(doc.get("deliverable")):
            return None
        delegate = doc.get("delegate")
        if not isinstance(delegate, dict):
            return None
        public_key = delegate.get("publicKey")
        if not isinstance(public_key, str) or _full_match(_KEY_B64URL_RE, public_key) is None:
            return None
        types = doc.get("types")
        if not isinstance(types, list) or len(types) < 1 or len(types) > MAX_DELEGATION_TYPES:
            return None
        seen = set()
        for t in types:
            if not isinstance(t, str) or _full_match(PACK_TYPE_PATTERN, t) is None or t in seen:
                return None
            seen.add(t)
        effective = tuple(t for t in types if t in DELEGABLE_PACK_TYPE_VALUES)
        if not effective:
            return None
        expires_at = _wire_int(doc.get("expiresAt"), 1)
        issued_at = _wire_int(doc.get("issuedAt"), 0)
        seq = _wire_int(doc.get("seq"), 1)
        if expires_at is None or issued_at is None or seq is None:
            return None
        if not issued_at < expires_at:
            return None
        if expires_at > issued_at + MAX_DELEGATION_TTL_SECONDS:
            return None
        return DelegationBody(
            deliverable=doc["deliverable"],
            seq=seq,
            publicKey=public_key,
            types=effective,
            listedTypes=tuple(types),
            issuedAt=issued_at,
            expiresAt=expires_at,
        )
    except Exception:
        return None


def verify_delegation(
    jws: str,
    *,
    release_keys: TrustSet,
    product_trust: TrustSet,
    expected_aud: str,
    expected_hash: str,
) -> VerifyDelegationResult:
    """Verify a delegation record (plans/P4-19.md §2.3 step 13.1): steps 12–14 against the
    PINNED release keys only (the ASCII bound, the hash, the product-key refusal, the
    signature, the claims), then ``kind == "delegation"`` and :func:`delegation_of`. A
    delegation is never verified through another delegation, so a content key cannot
    re-delegate. Never raises."""
    r = verify_release_record(
        jws,
        release_keys=release_keys,
        product_trust=product_trust,
        expected_aud=expected_aud,
        expected_hash=expected_hash,
    )
    if not r.ok or r.record is None:
        return VerifyDelegationResult(ok=False, step=r.step)
    if r.record.kind != "delegation":
        return VerifyDelegationResult(ok=False, step="delegation")
    body = delegation_of(r.record.to_dict())
    if body is None:
        return VerifyDelegationResult(ok=False, step="delegation")
    return VerifyDelegationResult(
        ok=True,
        delegation=VerifiedDelegation(
            deliverable=body.deliverable,
            seq=body.seq,
            publicKey=body.publicKey,
            types=body.types,
            listedTypes=body.listedTypes,
            issuedAt=body.issuedAt,
            expiresAt=body.expiresAt,
            sha256=expected_hash,
        ),
    )


def record_revoked(
    record_sha256: str,
    delegation_sha256: Optional[str],
    revoked: Union[AbstractSet[str], Mapping[str, Any], Collection[str]],
) -> Optional[str]:
    """The one rule for applying revocations to a release (plans/P4-19.md §2.3): ``record``
    when the release's own hash is revoked, else ``delegation`` when the delegation it was
    signed under is, else ``None``. ``revoked`` holds the revoked target hashes (a set, or a
    mapping by target). Pure."""
    if record_sha256 in revoked:
        return "record"
    if delegation_sha256 is not None and delegation_sha256 in revoked:
        return "delegation"
    return None
