"""Trust-set construction — wire contract v2 §1.

A verifier holds exactly two tiers, in strictly decreasing authority:

  pinned    ``trust=`` compiled into the host application. Terminal.
  manifest  keys learned from a signed ``polaris-trust.jws``, re-verified on every load.

and nothing else. The on-disk cache is NO LONGER a key source: it persists the manifest's
compact JWS, never bare ``kid -> key`` JSON, so a file write can neither add a kid nor
swap the bytes behind one (R2-01 / R2-02 / R4-02).

Mirrors ``packages/sdk-node/src/trust.ts`` rule for rule, and is driven by the shared
``trustCases`` corpus section so the two cannot silently diverge.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, Optional

from .models import ISSUER
from .verify import CLOCK_SKEW_SECONDS, TYP_TRUST, TrustSet, verify_jws

__all__ = [
    "SUPPORTED_TRUST_SCHEMA_VERSIONS",
    "TrustManifestResult",
    "merge_trust",
    "verify_trust_manifest",
]

#: Trust-manifest schema versions this SDK understands. Unknown => fail closed.
#:
#: Unlike the config document's ``schemaVersion`` (a per-product *catalog* version, which
#: is therefore only shape-checked — §3.1 correction 1), ``TrustManifestDoc.schemaVersion``
#: is a genuine wire version: the protocol types it as the literal ``1`` and the Worker
#: hardcodes it. So this one IS an allow-list.
SUPPORTED_TRUST_SCHEMA_VERSIONS: FrozenSet[int] = frozenset({1})


def merge_trust(pinned: TrustSet, discovered: TrustSet) -> TrustSet:
    """Resolve the effective trust set. Pins are applied LAST, so terminal (§1.1 rule 2).

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
    #: discovered set rather than merging into it — pruning is mandatory (§1.2 rule 4),
    #: and absence in a newer manifest is revocation.
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
) -> TrustManifestResult:
    """Verify a signed trust manifest and derive the keys it publishes.

    Two normative rules the v1 code had neither of:

    1. A manifest presenting a PINNED kid with DIFFERENT key bytes is a substitution
       attempt, so the whole manifest is rejected and the previous trust set is kept
       (§1.1 rule 1).
    2. ``key.status`` is read. ``revoked`` keys are dropped, and because the result
       replaces the discovered set wholesale, a kid that simply disappears from a newer
       manifest is dropped too. That is what restores the server's ability to revoke
       (§1.2).

    The manifest is verified against the **pinned** keys only — never against the
    discovered set. Verifying against the current (manifest-extended) set is what made
    R2-01 self-sustaining, and it is also the only self-consistent choice, because §4.2
    re-verifies the cached manifest against the pins on every load.
    """
    verified = verify_jws(jws, pinned, typ=TYP_TRUST)
    if verified is None:
        return _REJECTED
    doc = verified.payload
    if not isinstance(doc, dict):
        return _REJECTED

    now = int(time.time()) if now is None else now
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
        if issued_at > now + CLOCK_SKEW_SECONDS:
            return _REJECTED
        if expires_at <= now - CLOCK_SKEW_SECONDS:
            return _REJECTED
    keys = doc.get("keys")
    if not isinstance(keys, list):
        return _REJECTED

    discovered: TrustSet = {}
    for key in keys:
        if not isinstance(key, dict):
            return _REJECTED
        # `status` is typed as the non-revoked subset on the wire type, but the server now
        # emits revoked entries EXPLICITLY for at least 2x cacheSeconds (§1.2) so clients
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
