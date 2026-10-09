"""Trust-set construction and custody — wire contract v3 §1 and §4.2.

Semantics carried unchanged from v2; only the ``typ`` was rebranded to
``pkey-trust+jws``. A verifier holds exactly two tiers, in strictly decreasing authority:

  pinned    compiled into the host application. Terminal.
  manifest  keys learned from a signed ``polaris-trust.jws`` verified AGAINST THE PINS,
            re-verified on every load and REPLACED wholesale on every refresh, so absence
            is revocation.

and nothing else. The on-disk cache is NOT a key source: it persists the manifest's
compact JWS, never bare ``kid -> key`` JSON, so a file write can neither add a kid nor
swap the bytes behind one (R2-01 / R2-02 / R4-02).

WHY TRUST REFRESH IS CORE'S, NOT A SERVICE'S (§4.2)

v2's floor rode the ``/config`` fetch, which coupled the independent signed clock to one
service's document. v3 abolishes that: a product with ANY service enabled must still
advance the floor, so :meth:`TrustManager.refresh` is called by ``sync()`` on Core's own
cadence, before and independently of whichever documents the product happens to fetch. It
is also what makes the floor bite at all — a floor built from a document alone is provably
inert, because ``doc.issuedAt < doc.graceUntil`` always holds (R4-04).

The rules live here rather than in the client so this SDK and the Node one can be driven
by the same ``trustCases`` corpus section.
"""

from __future__ import annotations

import json
import time
from urllib.parse import quote
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, FrozenSet, Iterable, List, Optional, Tuple

from ..constants_generated import MAX_TRUST_SIGNER_ATTEMPTS
from .b64url import b64url_decode
from .jws import TrustSet, verify_jws
from .models import CLOCK_SKEW_SECONDS, ISSUER, TYP_TRUST, _wire_int

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .context import CoreContext

__all__ = [
    "SUPPORTED_TRUST_SCHEMA_VERSIONS",
    "TrustManifestResult",
    "merge_trust",
    "usable_pins",
    "compare_kid_bytes",
    "PinRevocations",
    "load_pin_revocations",
    "jws_header_kid",
    "trust_signer_order",
    "verify_trust_manifest",
    "TrustManager",
    "TRUST_MANIFEST_PATH",
]

#: ``GET /<product>/.well-known/polaris-trust.jws`` — Core's own route, unchanged in v3.
TRUST_MANIFEST_PATH = ".well-known/polaris-trust.jws"

#: Trust-manifest schema versions this SDK understands. Unknown => fail closed.
#:
#: Unlike the config document's ``schemaVersion`` (a per-product *catalog* version, which
#: is therefore only shape-checked), ``TrustManifestDoc.schemaVersion`` is a genuine wire
#: version: the protocol types it as the literal ``1`` and the Worker hardcodes it. So
#: this one IS an allow-list.
SUPPORTED_TRUST_SCHEMA_VERSIONS: FrozenSet[int] = frozenset({1})


def merge_trust(pinned: TrustSet, discovered: TrustSet) -> TrustSet:
    """Resolve the effective trust set. Pins are applied LAST, so terminal (§1 rule 1).

    ``{**discovered, **pinned}``. The v1 code merged these the other way round, which is
    the whole of R2-01 — one transposition, and a planted ``trustedKeys`` entry replaced
    the key bytes behind a kid the application had explicitly pinned in source.
    """
    return {**discovered, **pinned}


def kid_sort_key(kid: str) -> bytes:
    """Ascending UTF-8 byte order, the order every SDK can reproduce exactly."""
    return kid.encode("utf-8", "surrogatepass")


def compare_kid_bytes(a: str, b: str) -> int:
    x, y = kid_sort_key(a), kid_sort_key(b)
    return (x > y) - (x < y)


def usable_pins(pinned: TrustSet, tombstones: Iterable[str] = ()) -> TrustSet:
    """The pins minus the tombstoned kids (§1 tombstone rule 4)."""
    dead = set(tombstones)
    return {kid: key for kid, key in pinned.items() if kid not in dead}


#: The statuses that keep a published key (§3.2): an allow-list, exact and case-sensitive.
_LIVE_STATUSES: FrozenSet[str] = frozenset({"active", "staged", "retired"})


def _is_canonical_key(value: str) -> bool:
    try:
        b64url_decode(value)
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class TrustManifestResult:
    """The outcome of verifying a manifest."""

    #: The verified manifest payload, or ``None`` when it was rejected outright.
    doc: Optional[Dict[str, Any]]
    #: The keys it publishes with ``status != "revoked"``. This REPLACES the previously
    #: discovered set rather than merging into it — pruning is mandatory (§1 rule 2), and
    #: absence in a newer manifest is revocation.
    discovered: TrustSet
    #: The pinned kids this manifest NEWLY tombstones, ascending byte order (§1). Empty
    #: when rejected. The host records the manifest as the evidence for each.
    revokedPins: List[str] = field(default_factory=list)


_REJECTED = TrustManifestResult(doc=None, discovered={})


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def verify_trust_manifest(
    jws: str,
    *,
    pinned: TrustSet,
    tombstones: Iterable[str] = (),
    expected_aud: str,
    expected_iss: str = ISSUER,
    last_trust_issued_at: Optional[int] = None,
    now: Optional[int] = None,
    check_freshness: bool = True,
    typ: str = TYP_TRUST,
) -> TrustManifestResult:
    """Verify a signed trust manifest and derive the keys it publishes.

    Two normative rules the v1 code had neither of:

    1. A manifest presenting a PINNED kid with DIFFERENT key bytes is a substitution
       attempt, so the whole manifest is rejected and the previous trust set is kept
       (§1 rule 1).
    2. ``key.status`` is read. ``revoked`` keys are dropped, and because the result
       replaces the discovered set wholesale, a kid that simply disappears from a newer
       manifest is dropped too. That is what restores the server's ability to revoke
       (§1 rule 2).

    The manifest is verified against the **pinned** keys only — never against the
    discovered set. Verifying against the current (manifest-extended) set is what made
    R2-01 self-sustaining, and it is also the only self-consistent choice, because §4.1
    re-verifies the cached manifest against the pins on every load.

    Entries that are not ``alg: EdDSA`` / ``kty: OKP`` / ``crv: Ed25519`` are SKIPPED,
    not fatal (carried v2 semantics): a future-alg key in the manifest must not brick
    current verifiers.
    """
    dead = set(tombstones)
    verified = verify_jws(jws, usable_pins(pinned, dead), typ=typ)
    if verified is None:
        return _REJECTED
    doc = verified.payload
    if not isinstance(doc, dict):
        return _REJECTED

    wall = int(time.time()) if now is None else now
    # V4 §3: an integer claim first (``True in frozenset({1})`` holds, and ``1.0 == 1``),
    # then the allow-list.
    schema_version = _wire_int(doc.get("schemaVersion"), 1)
    if schema_version is None or schema_version not in SUPPORTED_TRUST_SCHEMA_VERSIONS:
        return _REJECTED
    if doc.get("aud") != expected_aud:
        return _REJECTED
    if doc.get("iss") != expected_iss:
        return _REJECTED
    issued_at = _wire_int(doc.get("issuedAt"), 0)
    expires_at = _wire_int(doc.get("expiresAt"), 0)
    if issued_at is None or expires_at is None:
        return _REJECTED
    if last_trust_issued_at is not None and issued_at <= last_trust_issued_at:
        return _REJECTED
    if check_freshness:
        if issued_at > wall + CLOCK_SKEW_SECONDS:
            return _REJECTED
        if expires_at <= wall - CLOCK_SKEW_SECONDS:
            return _REJECTED
    keys = doc.get("keys")
    if not isinstance(keys, list):
        return _REJECTED

    discovered: TrustSet = {}
    revoked: set = set()
    for key in keys:
        if not isinstance(key, dict):
            return _REJECTED
        # Read the raw value: an unknown future status must degrade gracefully.
        status = key.get("status")
        kid = key.get("kid")
        public_key = key.get("publicKey")
        if not isinstance(kid, str) or not isinstance(public_key, str):
            return _REJECTED
        # Substitution attempt (a tombstoned pin keeps this protection): reject the
        # manifest, keep the previous trust set.
        pinned_bytes = pinned.get(kid)
        if pinned_bytes is not None and pinned_bytes != public_key:
            return _REJECTED
        if status == "revoked":
            if pinned_bytes is not None:
                # A manifest cannot revoke the key that signed it: refused in full (§1).
                if kid == verified.kid:
                    return _REJECTED
                if kid not in dead:
                    revoked.add(kid)
            continue
        if not isinstance(status, str) or status not in _LIVE_STATUSES:
            continue
        if (
            key.get("alg") != "EdDSA"
            or key.get("kty") != "OKP"
            or key.get("crv") != "Ed25519"
        ):
            continue
        if not _is_canonical_key(public_key):
            continue
        discovered[kid] = public_key

    # A tombstoned kid leaves every set; a later manifest cannot restore it (§1).
    for kid in dead | revoked:
        discovered.pop(kid, None)
    return TrustManifestResult(
        doc=doc, discovered=discovered, revokedPins=sorted(revoked, key=kid_sort_key)
    )


@dataclass(frozen=True)
class PinRevocations:
    """What :func:`load_pin_revocations` derives from the cached evidence."""

    #: The tombstoned pinned kids, ascending byte order.
    tombstones: List[str]
    #: The evidence that re-verified, keyed by the kid it revokes. Write this back.
    kept: Dict[str, str]


def load_pin_revocations(
    evidence: Optional[Dict[str, Any]],
    *,
    pinned: TrustSet,
    expected_aud: str,
    expected_iss: str = ISSUER,
) -> PinRevocations:
    """Re-derive the tombstones from the cache's ``pinRevocations`` slice (§4.1).

    Each entry is re-verified on the RELOAD profile in ascending manifest ``issuedAt``
    (ties: the revoked kid's byte order) against the pins minus the tombstones already
    applied. An entry that does not verify, whose signer is already tombstoned, or that
    does not revoke the kid it is filed under, is dropped.
    """
    candidates: List[Tuple[int, str, str]] = []
    if isinstance(evidence, dict):
        for kid, jws in evidence.items():
            if not isinstance(jws, str) or kid not in pinned:
                continue
            pre = verify_trust_manifest(
                jws,
                pinned=pinned,
                expected_aud=expected_aud,
                expected_iss=expected_iss,
                check_freshness=False,
            )
            if pre.doc is None:
                continue
            candidates.append((pre.doc["issuedAt"], kid, jws))
    candidates.sort(key=lambda c: (c[0], kid_sort_key(c[1])))
    tombstones: List[str] = []
    kept: Dict[str, str] = {}
    for _issued_at, kid, jws in candidates:
        result = verify_trust_manifest(
            jws,
            pinned=pinned,
            tombstones=tombstones,
            expected_aud=expected_aud,
            expected_iss=expected_iss,
            check_freshness=False,
        )
        if result.doc is None or kid not in result.revokedPins:
            continue
        tombstones.append(kid)
        kept[kid] = jws
    return PinRevocations(tombstones=sorted(tombstones, key=kid_sort_key), kept=kept)


def jws_header_kid(jws: str) -> Optional[str]:
    """The header ``kid`` of a compact JWS, unverified, or ``None``. For the signer retry only."""
    try:
        header = json.loads(b64url_decode(jws.split(".")[0]).decode("utf-8"))
    except Exception:
        return None
    kid = header.get("kid") if isinstance(header, dict) else None
    return kid if isinstance(kid, str) else None


def trust_signer_order(usable: TrustSet, header_kid: Optional[str]) -> List[str]:
    """The ``?signer=<kid>`` retry order (§2.3). Empty when the default manifest's header
    ``kid`` is a usable pin; otherwise each usable pin in ascending byte order, at most
    ``MAX_TRUST_SIGNER_ATTEMPTS``."""
    if header_kid is not None and header_kid in usable:
        return []
    kids = sorted((k for k in usable if k != header_kid), key=kid_sort_key)
    return kids[:MAX_TRUST_SIGNER_ATTEMPTS]


class TrustManager:
    """Core's trust CUSTODIAN: it holds the two tiers and the pin evidence, decides when to
    go to the network, and folds each accepted manifest into the clock floor.

    All the actual rules live in :func:`verify_trust_manifest` above; this class owns the
    state and the schedule.
    """

    def __init__(self, ctx: "CoreContext") -> None:
        self._ctx = ctx
        #: Tier 2 — REPLACED, never merged into, on every successful verification.
        self._discovered: TrustSet = {}
        self._manifest: Optional[Dict[str, Any]] = None
        #: The tombstoned pins, re-derived from ``_evidence`` on every load (§1, §4.1).
        self._tombstones: List[str] = []
        #: The ``pinRevocations`` slice as it should be written: kid -> the revoking manifest.
        self._evidence: Dict[str, str] = {}

    @property
    def usable(self) -> TrustSet:
        """The pins minus the tombstones: the ONLY keys a manifest or bundle verifies against."""
        return usable_pins(self._ctx.pinned_trust, self._tombstones)

    @property
    def revoked_pins(self) -> List[str]:
        """The tombstoned pins (ascending byte order)."""
        return list(self._tombstones)

    @property
    def pin_revocations(self) -> Dict[str, str]:
        """The ``pinRevocations`` slice to persist; a copy. Empty when no pin was revoked."""
        return dict(self._evidence)

    @property
    def effective(self) -> TrustSet:
        """The effective set: manifest keys first, the USABLE pins spread LAST so they are terminal."""
        return merge_trust(self.usable, self._discovered)

    @property
    def discovered(self) -> TrustSet:
        return dict(self._discovered)

    @property
    def manifest(self) -> Optional[Dict[str, Any]]:
        return self._manifest

    @property
    def last_issued_at(self) -> Optional[int]:
        if self._manifest is None:
            return None
        return _int_or_none(self._manifest.get("issuedAt"))

    def reset(self) -> None:
        """Forget the learned keys. Called on deactivate, and at the top of every cache
        load so a reload can never inherit keys the file no longer justifies. The tombstones
        are NOT forgotten: they are security state, re-derived from the evidence by
        :meth:`load_evidence`."""
        self._discovered = {}
        self._manifest = None

    def load_evidence(self, slice_: Optional[Dict[str, Any]]) -> None:
        """Re-derive the tombstones from the cached ``pinRevocations`` slice (§4.1). Entries
        that do not re-verify are dropped from :attr:`pin_revocations`, so the next write
        removes them."""
        held = load_pin_revocations(
            slice_, pinned=self._ctx.pinned_trust, expected_aud=self._ctx.product
        )
        self._tombstones = held.tombstones
        self._evidence = held.kept

    def note_revocations(self, jws: str, revoked_pins: Iterable[str]) -> None:
        """Record a verified manifest's new tombstones, with the manifest as their evidence."""
        kids = list(revoked_pins)
        if not kids:
            return
        for kid in kids:
            self._evidence[kid] = jws
        self._tombstones = sorted(set(self._tombstones) | set(kids), key=kid_sort_key)

    def load_cached(self, jws: str, *, now: Optional[int] = None) -> bool:
        """Re-verify a CACHED manifest and install what it publishes.

        Freshness is not asserted: a manifest is only minutes-fresh by design, and
        refusing a stale one would strand every offline client that has rotated keys. Its
        signature, its ``aud``/``iss``/``typ`` binding and the pinned-substitution guard
        all still apply — and its ``issuedAt`` still raises the floor, because a stale
        manifest is still a SIGNED LOWER BOUND on real time, independent of whether it may
        still publish keys.

        Returns ``False`` when the cached artifact did not verify, which the caller treats
        as "that slice is absent" and drops from the record (§4.1, fail closed).
        """
        result = verify_trust_manifest(
            jws,
            pinned=self._ctx.pinned_trust,
            tombstones=self._tombstones,
            expected_aud=self._ctx.product,
            now=now,
            check_freshness=False,
        )
        if result.doc is None:
            return False
        self._install(jws, result)
        return True

    def refresh(self) -> Optional[str]:
        """Fetch, verify and install a signed trust manifest from the network.

        Verified against the USABLE pins only — never against the current (possibly
        extended) set. v1 verified against the effective set, so a single planted key
        could sign a manifest minting further keys and the poisoning became
        self-sustaining (R2-01's amplifier). It also keeps the online and offline paths
        identical: anything installed here still verifies after a restart, when only the
        pins are available.

        When the default manifest is refused and its signer is not a usable pin (a rotation,
        or a revoked active key), the same manifest is requested signed by each usable pin
        (§2.3). Returns the compact JWS to persist, or ``None`` when nothing acceptable
        arrived. A manifest that tombstoned a pin also changed :attr:`pin_revocations`,
        which the caller writes in the same patch.
        """
        first = self._fetch_manifest(None)
        if first is None:
            return None

        def verify(jws: str) -> TrustManifestResult:
            return verify_trust_manifest(
                jws,
                pinned=self._ctx.pinned_trust,
                tombstones=self._tombstones,
                expected_aud=self._ctx.product,
                # Anti-rollback: derived from the manifest we last verified, never from a
                # disk counter (R4-03 — `lastTrustIssuedAt` used to be an attacker-writable
                # JSON field).
                last_trust_issued_at=self.last_issued_at,
                # The effective clock, so a rolled-back system clock cannot make a
                # fresh manifest look stale (or a stale one fresh).
                now=self._ctx.now(),
            )

        jws = first
        result = verify(jws)
        if result.doc is None:
            for signer in trust_signer_order(self.usable, jws_header_kid(first)):
                retry = self._fetch_manifest(signer)
                if retry is None:
                    continue
                attempt = verify(retry)
                if attempt.doc is not None:
                    jws, result = retry, attempt
                    break
        if result.doc is None:
            return None
        self._install(jws, result)
        return jws

    def _fetch_manifest(self, signer: Optional[str]) -> Optional[str]:
        """One ``GET /<p>/.well-known/polaris-trust.jws[?signer=<kid>]``; the body on a 200."""
        path = TRUST_MANIFEST_PATH
        if signer is not None:
            path += "?signer=" + quote(signer, safe="!*'()")
        res = self._ctx.request(
            "GET", self._ctx.url(path), headers={"accept": "application/jose"}
        )
        return res.text if res.status_code == 200 else None

    def _install(self, jws: str, result: TrustManifestResult) -> None:
        assert result.doc is not None
        self.note_revocations(jws, result.revokedPins)
        self._manifest = result.doc
        self._discovered = result.discovered
        issued_at = _int_or_none(result.doc.get("issuedAt"))
        if issued_at is not None:
            self._ctx.raise_floor(issued_at)
