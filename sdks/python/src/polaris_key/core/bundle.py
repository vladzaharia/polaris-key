"""Offline activation bundles — wire contract v3 §7.

A bundle (``pkey-bundle+jws``) is the air-gapped activation path (D-12): an operator mints
one against a device's request code, carries it across on a USB stick, and the client
imports it with no network at all. It wraps up to three inner compact JWSs — a licence
document, an optional config document, and the trust manifest needed to verify them — so
its payload cap is 262 144 bytes rather than the 64 KiB every other document gets (§1).

THE ORDER IS THE CONTRACT

§7 numbers five steps, and the conformance corpus (``bundleCases``) pins WHICH ONE refuses
for each vector, not merely that something did. That is why refusals are named for the
step rather than the symptom: "the bundle was addressed to another device" (step 2) and
"the licence document inside it was addressed to another device" (step 4) are different
failures with different operator remedies, and a verifier that collapsed them would pass a
weaker test than the one the five SDKs have to agree on.

:func:`inspect_bundle` is the pure verifier — steps 1–4, no store, no I/O.
:func:`import_bundle` is step 5, the host's atomic cache write. Keeping the write out of
the verifier is what makes ALL-OR-NOTHING structural rather than disciplinary: there is no
partial result available to write, because a refusal hands back no documents at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Mapping, Optional, Union

from .errors import PolarisError
from .jws import TrustSet, verify_jws
from .models import (
    CLOCK_SKEW_SECONDS,
    MAX_BUNDLE_BYTES,
    TYP_BUNDLE,
    ConfigDoc,
    LicenseDoc,
    _wire_int,
)
from .store import CacheRecord
from .trust import merge_trust, usable_pins, verify_trust_manifest
from .verify import verify_config_doc, verify_license_doc

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .cache import CacheManager
    from .context import CoreContext
    from .trust import TrustManager

__all__ = [
    "MAX_BUNDLE_BYTES",
    "BUNDLE_JWS_REJECTED",
    "BUNDLE_CLAIMS_REJECTED",
    "BUNDLE_TRUST_REJECTED",
    "INNER_DOC_REJECTED",
    "BUNDLE_REFUSAL_REASONS",
    "VerifiedBundleDoc",
    "VerifiedBundle",
    "BundleAccepted",
    "BundleRefused",
    "BundleInspection",
    "inspect_bundle",
    "verify_bundle",
    "ImportBundleResult",
    "import_bundle",
]

# Which numbered step of §7 refused. Named for the step, not for the symptom, because the
# corpus asserts the attribution and the five SDKs must agree on it.
#: step 1 — signature, ``typ``, or the 262 144-byte cap.
BUNDLE_JWS_REJECTED = "bundle-jws-rejected"
#: step 2 — ``aud``/``deviceId``/import window/vacuous ``docs``.
BUNDLE_CLAIMS_REJECTED = "bundle-claims-rejected"
#: step 3 — the inner manifest failed against the PINS.
BUNDLE_TRUST_REJECTED = "bundle-trust-rejected"
#: step 4 — a carried document failed against the effective set.
INNER_DOC_REJECTED = "inner-doc-rejected"

BUNDLE_REFUSAL_REASONS = (
    BUNDLE_JWS_REJECTED,
    BUNDLE_CLAIMS_REJECTED,
    BUNDLE_TRUST_REJECTED,
    INNER_DOC_REJECTED,
)

#: Human-readable causes, so a CLI can tell an operator WHICH thing is wrong with the file
#: they were handed. The machine-readable form is the ``PolarisError.code``.
_MESSAGES: Dict[str, str] = {
    BUNDLE_JWS_REJECTED: "The bundle's signature, type or size was not acceptable.",
    BUNDLE_CLAIMS_REJECTED: (
        "The bundle is not addressed to this device, or its import window has closed."
    ),
    BUNDLE_TRUST_REJECTED: (
        "The trust manifest inside the bundle was rejected against the pinned keys."
    ),
    INNER_DOC_REJECTED: (
        "A document inside the bundle failed verification; nothing was imported."
    ),
}


@dataclass(frozen=True)
class VerifiedBundleDoc:
    """One inner document that survived every step, kept alongside the exact bytes it
    arrived as: the host persists the SIGNED artifact, never the decoded object (§4.1)."""

    jws: str
    doc: Any


@dataclass(frozen=True)
class VerifiedBundle:
    """A bundle that passed all four verification steps. Everything the host needs for §7
    step 5's atomic write, and nothing it would have to re-derive."""

    #: The mint's audit anchor.
    bundleId: str
    #: The inner trust manifest's compact JWS — cached as ``trustJws`` unless the install
    #: holds a verified manifest with a newer ``issuedAt`` (§7 step 5).
    trustJws: str
    #: The inner trust manifest's signed ``issuedAt``.
    trustIssuedAt: int
    #: ``usable pins ∪ live manifest keys``, with the pins terminal — the set step 4 used.
    effectiveTrust: TrustSet
    #: Whichever documents the bundle carried, in §7 order. ``license`` absent ⇒ NO
    #: activation effect: the gate stays ``needs-activation`` (or ``not-applicable``),
    #: never ``activation="bundle"``.
    docs: Dict[str, VerifiedBundleDoc] = field(default_factory=dict)
    #: Pinned kids the inner manifest newly tombstones (§1); the host files the manifest as
    #: their evidence in ``pinRevocations``, in the same write.
    revokedPins: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class BundleAccepted:
    bundle: VerifiedBundle
    ok: bool = True


@dataclass(frozen=True)
class BundleRefused:
    reason: str
    ok: bool = False


BundleInspection = Union[BundleAccepted, BundleRefused]

_MISSING = object()


def inspect_bundle(
    jws: str,
    *,
    pinned: TrustSet,
    tombstones: Iterable[str] = (),
    product: str,
    device_id: str,
    now: int,
    floors: Mapping[str, Optional[int]],
    profile: str = "import",
) -> BundleInspection:
    """Walk §7's numbered order over one bundle, reporting which step refused.

    Nothing is returned until every step has passed, which is the mechanical form of
    all-or-nothing: a caller physically cannot write half a bundle, because a failure at
    step 4 hands back no documents at all — not even the ones that verified before it.

    ``tombstones`` are the pinned kids tombstoned on this install: not usable for the
    bundle, its manifest or the effective set. ``floors`` are §7 step 4's per-type
    anti-replay floors (``{"license": n | None, "config": n | None}``), the ``issuedAt`` of
    the verified cached document of each type; each inner document must be strictly newer.
    ``profile`` is ``"import"`` (the operator's act) or ``"reload"`` (the cached bundle at
    every start: no import window, no floors); anything else is treated as ``"import"``.
    """
    dead = list(tombstones)
    pins = usable_pins(pinned, dead)
    # ── 1. The bundle JWS against PINNED keys only ──────────────────────────────────
    # the required `typ` closes the replay this artifact would otherwise open: the raised cap
    # travels with the `typ`, so an untyped 256 KiB blob accepted here could be
    # re-presented at an ordinary document call site. The cap is taken from the protocol
    # constant rather than from the caller — no host gets to choose how big a bundle is.
    verified = verify_jws(
        jws,
        pins,
        typ=TYP_BUNDLE,
        max_payload_bytes=MAX_BUNDLE_BYTES,
    )
    if verified is None:
        return BundleRefused(BUNDLE_JWS_REJECTED)
    bundle = verified.payload
    if not isinstance(bundle, dict):
        return BundleRefused(BUNDLE_JWS_REJECTED)

    # ── 2. The bundle's OWN claims, on NETWORK-path freshness ───────────────────────
    # §7.2: a stale bundle is refused even though the documents it carries are validated
    # with the reload profile. The two windows mean different things — `expiresAt` here is
    # the operator's import deadline, while the inner documents' long bound is
    # `graceUntil`.
    bundle_id = bundle.get("bundleId")
    trust_jws = bundle.get("trust")
    # V4 §3: integer claims, minimum 0.
    issued_at = _wire_int(bundle.get("issuedAt"), 0)
    expires_at = _wire_int(bundle.get("expiresAt"), 0)
    if not isinstance(bundle_id, str) or bundle_id == "":
        return BundleRefused(BUNDLE_CLAIMS_REJECTED)
    if not isinstance(trust_jws, str):
        return BundleRefused(BUNDLE_CLAIMS_REJECTED)
    if bundle.get("aud") != product:
        return BundleRefused(BUNDLE_CLAIMS_REJECTED)
    if bundle.get("deviceId") != device_id:
        return BundleRefused(BUNDLE_CLAIMS_REJECTED)
    if issued_at is None or expires_at is None:
        return BundleRefused(BUNDLE_CLAIMS_REJECTED)
    if profile != "reload":
        if issued_at > now + CLOCK_SKEW_SECONDS:
            return BundleRefused(BUNDLE_CLAIMS_REJECTED)
        if now > expires_at + CLOCK_SKEW_SECONDS:
            return BundleRefused(BUNDLE_CLAIMS_REJECTED)

    docs_raw = bundle.get("docs")
    if not isinstance(docs_raw, dict):
        return BundleRefused(BUNDLE_CLAIMS_REJECTED)
    # V4 §3 presence: each of ``license`` and ``config`` is absent or a string; a present
    # ``null`` is refused (Node and Godot always did), never read as absent.
    if "license" in docs_raw and not isinstance(docs_raw["license"], str):
        return BundleRefused(BUNDLE_CLAIMS_REJECTED)
    if "config" in docs_raw and not isinstance(docs_raw["config"], str):
        return BundleRefused(BUNDLE_CLAIMS_REJECTED)
    license_jws = docs_raw.get("license")
    config_jws = docs_raw.get("config")
    # A bundle carrying NEITHER document is vacuous (§7): it can grant nothing and
    # configure nothing, so importing it would write a `bundle` slice with no
    # content behind it — an install that looks provisioned and is not. Refused here, at
    # the claims step, for the same reason the other addressing failures are.
    if license_jws is None and config_jws is None:
        return BundleRefused(BUNDLE_CLAIMS_REJECTED)

    # ── 3. The inner trust manifest, against the PINS, on the RELOAD profile ────────
    # Reload, not network: a bundle minted weeks ago carries a manifest whose minutes-long
    # `expiresAt` passed long before it reached the air-gapped machine. Everything else
    # about the manifest still applies — the signature, the `aud`/`iss`/`typ` binding, and
    # above all the pinned-substitution rule, which is what stops a bundle from shipping
    # its own roots.
    manifest = verify_trust_manifest(
        trust_jws,
        pinned=pinned,
        tombstones=dead,
        expected_aud=product,
        now=now,
        check_freshness=False,
    )
    if manifest.doc is None:
        return BundleRefused(BUNDLE_TRUST_REJECTED)
    effective_trust = merge_trust(
        usable_pins(pins, manifest.revokedPins), manifest.discovered
    )

    # ── 4. Each inner document against the EFFECTIVE set, reload profile ────────────
    # Bound to the LOCAL device id — step 2 has only proved the BUNDLE claims this device,
    # and a document inside it may claim another. There is no anti-replay floor here: a
    # bundle import is the act of establishing state on a device that has none, so there
    # is no previously-accepted document to be newer than. (The host applies its own floor
    # after the write, on the next network sync.)
    docs: Dict[str, VerifiedBundleDoc] = {}
    # A floor that is neither an integer nor ``None`` (or is missing) refuses the document.
    floor_values = {name: floors.get(name, _MISSING) for name in ("license", "config")}
    for name, value in floor_values.items():
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int)
        ):
            if (name == "license" and license_jws is not None) or (
                name == "config" and config_jws is not None
            ):
                return BundleRefused(INNER_DOC_REJECTED)
    if license_jws is not None:
        doc: Optional[LicenseDoc] = verify_license_doc(
            license_jws,
            effective_trust,
            expected_aud=product,
            device_id=device_id,
            last_accepted_issued_at=floor_values["license"],
            now=now,
            check_freshness=False,
        )
        if doc is None:
            return BundleRefused(INNER_DOC_REJECTED)
        docs["license"] = VerifiedBundleDoc(jws=license_jws, doc=doc)
    if config_jws is not None:
        cdoc: Optional[ConfigDoc] = verify_config_doc(
            config_jws,
            effective_trust,
            expected_aud=product,
            device_id=device_id,
            last_accepted_issued_at=floor_values["config"],
            now=now,
            check_freshness=False,
        )
        if cdoc is None:
            return BundleRefused(INNER_DOC_REJECTED)
        docs["config"] = VerifiedBundleDoc(jws=config_jws, doc=cdoc)

    # ── 5. The caller's turn ────────────────────────────────────────────────────────
    # Everything above passed, so and only so may the host write the cache atomically:
    # `bundle` (this JWS, verbatim), `trustJws` (unless the held one is newer), `docs`, and
    # the evidence for `revokedPins`. No token is created — a bundle-activated install has no credential and never talks to the
    # server.
    return BundleAccepted(
        VerifiedBundle(
            bundleId=bundle_id,
            trustJws=trust_jws,
            trustIssuedAt=manifest.doc["issuedAt"],
            effectiveTrust=effective_trust,
            docs=docs,
            revokedPins=manifest.revokedPins,
        )
    )


def verify_bundle(
    jws: str,
    *,
    pinned: TrustSet,
    tombstones: Iterable[str] = (),
    product: str,
    device_id: str,
    now: int,
    floors: Mapping[str, Optional[int]],
    profile: str = "import",
) -> Optional[VerifiedBundle]:
    """Verify an offline activation bundle (§7). Returns the verified contents, or
    ``None`` on ANY refusal — the shape hosts want when they just need to know whether to
    write.

    Use :func:`inspect_bundle` when the refusal REASON matters (a CLI telling an operator
    that the bundle was minted for a different machine is a materially better error than
    "invalid").
    """
    result = inspect_bundle(
        jws,
        pinned=pinned,
        tombstones=tombstones,
        product=product,
        device_id=device_id,
        now=now,
        floors=floors,
        profile=profile,
    )
    return result.bundle if result.ok else None


@dataclass(frozen=True)
class ImportBundleResult:
    bundleId: str
    #: Which documents landed, in §7 order. ``license`` present ⇒ the gate is now
    #: activated by bundle; a config-only bundle imports settings and grants nothing
    #: (D-08).
    imported: List[str]


def import_bundle(
    ctx: "CoreContext",
    cache: "CacheManager",
    trust: "TrustManager",
    jws: str,
    now: Optional[int] = None,
) -> ImportBundleResult:
    """Verify and install an offline activation bundle — §7 step 5.

    Raises :class:`PolarisError` carrying the §7 step that refused: the step is the
    operator's remedy ("get a bundle minted for THIS machine" is a different action from
    "the mint bound the wrong device"), and collapsing them would make the air-gapped path
    the least diagnosable one.

    A byte-identical re-import of the bundle this install runs on (its cached ``bundle``
    re-verified) succeeds with NO write. The record is REPLACED, never merged: ``bundle``,
    ``docs`` and ``trustJws`` (the bundle's manifest, unless the held verified manifest is
    newer), plus the carried ``feeds``, ``releaseRecords`` and ``pinRevocations``.
    """
    from .context import now_sec

    when = now_sec() if now is None else now
    held = cache.state.bundle
    if held is not None and cache.bundle_jws() == jws:
        return ImportBundleResult(bundleId=held.bundleId, imported=list(held.docs))

    state = cache.state
    result = inspect_bundle(
        jws,
        pinned=ctx.pinned_trust,
        tombstones=trust.revoked_pins,
        product=ctx.product,
        device_id=ctx.device_id,
        now=when,
        # §7 step 4: each inner document strictly newer than the verified cached one of its type.
        floors={
            "license": state.license.doc.issuedAt if state.license else None,
            "config": state.config.doc.issuedAt if state.config else None,
        },
        profile="import",
    )
    if not result.ok:
        raise PolarisError(result.reason, _MESSAGES[result.reason])
    bundle = result.bundle
    # The inner manifest's tombstones (if any) join the evidence the record is written with.
    trust.note_revocations(bundle.trustJws, bundle.revokedPins)

    # §7 step 5: keep the held manifest when it is newer than the bundle's.
    held_trust = trust.manifest
    held_jws = cache.trust_jws()
    keep_held = (
        held_trust is not None
        and isinstance(held_trust.get("issuedAt"), int)
        and held_trust["issuedAt"] > bundle.trustIssuedAt
        and held_jws is not None
    )
    record = CacheRecord(
        docs={name: entry.jws for name, entry in bundle.docs.items()},
        # No ETags: these documents did not come from a conditional GET, and inventing
        # validators for them would make the next online sync send an `If-None-Match` the
        # server never issued.
        etags={},
        trustJws=held_jws if keep_held else bundle.trustJws,
        bundle=jws,
    )
    cache.replace(record)
    # Re-run the normal load path over what we just wrote rather than trusting the
    # in-memory objects: the imported install must reach exactly the state a RESTART would
    # reach, and the only way to be sure of that is to take the same route.
    cache.load(now=when)

    imported = [name for name in ("license", "config") if name in bundle.docs]
    return ImportBundleResult(bundleId=bundle.bundleId, imported=imported)
