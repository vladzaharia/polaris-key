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

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, FrozenSet, Optional

from .jws import TrustSet, verify_jws
from .models import CLOCK_SKEW_SECONDS, ISSUER, TYP_TRUST

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .context import CoreContext

__all__ = [
    "SUPPORTED_TRUST_SCHEMA_VERSIONS",
    "TrustManifestResult",
    "merge_trust",
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


@dataclass(frozen=True)
class TrustManifestResult:
    """The outcome of verifying a manifest."""

    #: The verified manifest payload, or ``None`` when it was rejected outright.
    doc: Optional[Dict[str, Any]]
    #: The keys it publishes with ``status != "revoked"``. This REPLACES the previously
    #: discovered set rather than merging into it — pruning is mandatory (§1 rule 2), and
    #: absence in a newer manifest is revocation.
    discovered: TrustSet


_REJECTED = TrustManifestResult(doc=None, discovered={})


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def verify_trust_manifest(
    jws: str,
    *,
    pinned: TrustSet,
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
    verified = verify_jws(jws, pinned, typ=typ, require_typ=True)
    if verified is None:
        return _REJECTED
    doc = verified.payload
    if not isinstance(doc, dict):
        return _REJECTED

    wall = int(time.time()) if now is None else now
    if doc.get("schemaVersion") not in SUPPORTED_TRUST_SCHEMA_VERSIONS:
        return _REJECTED
    if doc.get("aud") != expected_aud:
        return _REJECTED
    if doc.get("iss") != expected_iss:
        return _REJECTED
    issued_at = _int_or_none(doc.get("issuedAt"))
    expires_at = _int_or_none(doc.get("expiresAt"))
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
    for key in keys:
        if not isinstance(key, dict):
            return _REJECTED
        # `status` is typed as the non-revoked subset on the wire type, but the server
        # emits revoked entries EXPLICITLY for at least 2x cacheSeconds (§1) so clients
        # get a positive signal to prune on.
        status = key.get("status")
        kid = key.get("kid")
        public_key = key.get("publicKey")
        if not isinstance(kid, str) or not isinstance(public_key, str):
            return _REJECTED
        # Substitution attempt — reject the manifest, keep the previous trust set.
        pinned_bytes = pinned.get(kid)
        if pinned_bytes is not None and pinned_bytes != public_key:
            return _REJECTED
        if status == "revoked":
            continue
        if (
            key.get("alg") != "EdDSA"
            or key.get("kty") != "OKP"
            or key.get("crv") != "Ed25519"
        ):
            continue
        discovered[kid] = public_key

    return TrustManifestResult(doc=doc, discovered=discovered)


class TrustManager:
    """Core's trust CUSTODIAN: it holds the two tiers, decides when to go to the network,
    and folds each accepted manifest into the clock floor.

    All the actual rules live in :func:`verify_trust_manifest` above; this class owns the
    state and the schedule.
    """

    def __init__(self, ctx: "CoreContext") -> None:
        self._ctx = ctx
        #: Tier 2 — REPLACED, never merged into, on every successful verification.
        self._discovered: TrustSet = {}
        self._manifest: Optional[Dict[str, Any]] = None

    @property
    def effective(self) -> TrustSet:
        """The effective set: manifest keys first, pins spread LAST so they are terminal."""
        return merge_trust(self._ctx.pinned_trust, self._discovered)

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
        """Forget everything learned. Called on deactivate, and at the top of every cache
        load so a reload can never inherit keys the file no longer justifies."""
        self._discovered = {}
        self._manifest = None

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
            expected_aud=self._ctx.product,
            now=now,
            check_freshness=False,
        )
        return self._install(result)

    def refresh(self) -> Optional[str]:
        """Fetch, verify and install a signed trust manifest from the network.

        Verified against the PINNED keys only — never against the current (possibly
        extended) set. v1 verified against the effective set, so a single planted key
        could sign a manifest minting further keys and the poisoning became
        self-sustaining (R2-01's amplifier). It also keeps the online and offline paths
        identical: anything installed here still verifies after a restart, when only the
        pins are available.

        Returns the compact JWS to persist, or ``None`` when nothing acceptable arrived.
        """
        res = self._ctx.request(
            "GET",
            self._ctx.url(TRUST_MANIFEST_PATH),
            headers={"accept": "application/jose"},
        )
        if res.status_code != 200:
            return None
        jws = res.text
        result = verify_trust_manifest(
            jws,
            pinned=self._ctx.pinned_trust,
            expected_aud=self._ctx.product,
            # Anti-rollback: derived from the manifest we last verified, never from a
            # disk counter (R4-03 — `lastTrustIssuedAt` used to be an attacker-writable
            # JSON field).
            last_trust_issued_at=self.last_issued_at,
        )
        return jws if self._install(result) else None

    def _install(self, result: TrustManifestResult) -> bool:
        if result.doc is None:
            return False
        self._manifest = result.doc
        self._discovered = result.discovered
        issued_at = _int_or_none(result.doc.get("issuedAt"))
        if issued_at is not None:
            self._ctx.raise_floor(issued_at)
        return True
