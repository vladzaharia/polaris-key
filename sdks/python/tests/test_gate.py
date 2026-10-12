# @pkey-feature license.gate
"""Licence-gate transitions + semver/channel helpers.

Mirrors ``@polaris-key/client-core``'s ``gate.test.ts`` / ``semver.ts``. The corpus's gate matrix
pins the cross-SDK decisions; this suite pins the transitions and boundaries around them,
including the two guards v3 added.
"""

from __future__ import annotations

import pytest

from polaris_key.core.models import (
    BLOCK_REASONS,
    STRICTEST_BLOCK_REASON,
    AllowedRange,
    BlockedState,
    LicenseDoc,
    coerce_block_reason,
    is_block_reason,
)
from polaris_key.core.semver import (
    channel_for_version,
    compare_semver,
    is_dev_build,
    parse_semver,
)
from polaris_key.license.gate import is_usable, license_state


def _doc(*, issued: int, expires: int, grace: int) -> LicenseDoc:
    return LicenseDoc(
        iss="key.plrs.im",
        aud="djdl",
        deviceId="dev_1",
        issuedAt=issued,
        expiresAt=expires,
        graceUntil=grace,
        licenseId="lic_1",
    )


# ── the v3 guards ───────────────────────────────────────────────────────────────────
def test_license_service_disabled_is_not_applicable_and_usable() -> None:
    """§5 / D-08: a config-only or release-only product has no licence to be missing, so
    it must boot USABLE rather than sitting on ``needs-activation`` forever."""
    st = license_state(license_service_enabled=False, activation=None, doc=None, now=100)
    assert st.status == "not-applicable"
    assert is_usable(st) and is_usable(st.status)


def test_not_applicable_precedes_every_other_rule() -> None:
    doc = _doc(issued=0, expires=1000, grace=2000)
    st = license_state(
        license_service_enabled=False,
        activation="token",
        doc=doc,
        now=999_999,
        last_sync_unauthorized=True,
        blocked=BlockedState(reason="version-too-old"),
    )
    assert st.status == "not-applicable"


@pytest.mark.parametrize("activation", ["token", "bundle"])
def test_both_activation_sources_gate_identically(activation: str) -> None:
    """§7: a device is activated either by an online-minted ``pkeyt_`` token or by a
    verified offline bundle import. Both are activated; only ``None`` is not."""
    doc = _doc(issued=0, expires=1000, grace=2000)
    assert license_state(activation=activation, doc=doc, now=500).status == "ok"
    assert license_state(activation=activation, doc=doc, now=1500).status == "grace"
    assert license_state(activation=activation, doc=doc, now=2500).status == "expired"


def test_activation_precedes_the_unsigned_blocked_hint() -> None:
    """The ONE ordering v3 changed: an unactivated device with a stale build block reports
    ``needs-activation`` rather than a version error it cannot act on."""
    blocked = BlockedState(reason="version-too-old", allowedRange=AllowedRange(min="1.0.0"))
    assert (
        license_state(activation=None, doc=None, now=100, blocked=blocked).status
        == "needs-activation"
    )
    assert (
        license_state(activation="token", doc=None, now=100, blocked=blocked).status
        == "version-too-old"
    )


# ── the carried v2 state machine ────────────────────────────────────────────────────
def test_no_activation_needs_activation() -> None:
    st = license_state(activation=None, doc=None, now=100)
    assert st.status == "needs-activation"
    assert not is_usable(st)


def test_activated_but_no_doc_needs_activation() -> None:
    assert license_state(activation="token", doc=None, now=100).status == "needs-activation"


def test_unauthorized_is_revoked() -> None:
    st = license_state(
        activation="token", doc=None, now=100, last_sync_unauthorized=True
    )
    assert st.status == "revoked"


def test_blocked_takes_precedence_over_a_valid_doc() -> None:
    blocked = BlockedState(reason="version-too-old", allowedRange=AllowedRange(min="1.0.0"))
    doc = _doc(issued=0, expires=1000, grace=2000)
    st = license_state(activation="token", doc=doc, now=500, blocked=blocked)
    assert st.status == "version-too-old"
    assert st.allowedRange is not None and st.allowedRange.min == "1.0.0"


# ── the unsigned hint's VOCABULARY ──────────────────────────────────────────────────
def test_the_block_reason_vocabulary_is_the_three_non_usable_403_reasons() -> None:
    assert BLOCK_REASONS == ("version-too-old", "version-too-new", "channel-not-entitled")
    assert STRICTEST_BLOCK_REASON == "version-too-old"
    assert STRICTEST_BLOCK_REASON in BLOCK_REASONS
    # Every member is a status the gate refuses to run on: the vocabulary can only tighten.
    assert not any(is_usable(reason) for reason in BLOCK_REASONS)


def test_the_vocabulary_is_exported_from_core() -> None:
    import polaris_key.core as core

    assert core.BLOCK_REASONS is BLOCK_REASONS
    assert core.STRICTEST_BLOCK_REASON == STRICTEST_BLOCK_REASON
    assert core.is_block_reason is is_block_reason
    assert core.coerce_block_reason is coerce_block_reason


@pytest.mark.parametrize("reason", BLOCK_REASONS)
def test_a_member_of_the_vocabulary_survives_coercion_unchanged(reason: str) -> None:
    assert is_block_reason(reason) is True
    assert coerce_block_reason(reason) == reason


@pytest.mark.parametrize(
    "value",
    [
        "ok",
        "grace",
        "not-applicable",
        "expired",
        "definitely-fine",
        "",
        "Version-Too-Old",
        " version-too-old",
        None,
        5,
        True,
        b"version-too-old",
        ["version-too-old"],
        {"reason": "version-too-old"},
    ],
)
def test_anything_outside_the_vocabulary_coerces_to_the_strictest_reason(value) -> None:
    assert is_block_reason(value) is False
    assert coerce_block_reason(value) == STRICTEST_BLOCK_REASON


@pytest.mark.parametrize(
    "reason", ["ok", "grace", "not-applicable", "definitely-fine", ""]
)
@pytest.mark.parametrize("with_doc", [True, False], ids=["valid-doc", "no-doc-at-all"])
def test_an_out_of_vocabulary_blocked_reason_never_makes_the_gate_usable(
    reason: str, with_doc: bool
) -> None:
    """§4.1 keeps ``blocked`` unsigned on the argument that it can only ever make the gate
    STRICTER. That is a claim about the VOCABULARY, and ``BlockReason`` is just ``str``: the
    gate returns the reason AS the status, and ``is_usable`` answers True for
    ``ok``/``grace``/``not-applicable``. So an unsigned ``{"reason": "ok"}`` would licence the
    client with no signature anywhere — and ``blocked`` is read BEFORE the ``doc is None``
    check, so it needs no document either. The gate coerces at the decision point."""
    st = license_state(
        activation="token",
        doc=_doc(issued=1000, expires=4600, grace=2593000) if with_doc else None,
        now=1500,
        blocked=BlockedState(reason=reason),
    )
    assert st.status == "version-too-old"
    assert not is_usable(st)
    assert not is_usable(st.status)


@pytest.mark.parametrize("reason", BLOCK_REASONS)
def test_an_in_vocabulary_blocked_reason_is_still_honoured_verbatim(reason: str) -> None:
    """The fix narrows the hint; it does not delete it. Without this an implementation that
    coerced EVERY reason would pass the case above while destroying the feature."""
    st = license_state(
        activation="token",
        doc=_doc(issued=1000, expires=4600, grace=2593000),
        now=1500,
        blocked=BlockedState(reason=reason, allowedRange=AllowedRange(min="1.0.0")),
    )
    assert st.status == reason
    assert st.allowedRange == AllowedRange(min="1.0.0")


def test_a_poisoned_blocked_reason_still_loses_to_the_activation_and_applicability_guards() -> None:
    """The guards that precede ``blocked`` still precede it: a poisoned hint is not a way to
    gate an unactivated install or a product without the licence service."""
    poisoned = BlockedState(reason="ok")
    assert (
        license_state(activation=None, doc=None, now=1500, blocked=poisoned).status
        == "needs-activation"
    )
    assert (
        license_state(
            license_service_enabled=False, activation=None, doc=None, now=1500, blocked=poisoned
        ).status
        == "not-applicable"
    )


def test_ok_within_expiry() -> None:
    doc = _doc(issued=0, expires=1000, grace=2000)
    st = license_state(activation="token", doc=doc, now=500, last_verified_at=499)
    assert st.status == "ok" and is_usable(st)
    assert st.graceUntil == 2000 and st.lastVerifiedAt == 499


def test_grace_between_expiry_and_grace() -> None:
    doc = _doc(issued=0, expires=1000, grace=2000)
    st = license_state(activation="token", doc=doc, now=1500)
    assert st.status == "grace" and is_usable(st)


def test_expired_past_grace() -> None:
    doc = _doc(issued=0, expires=1000, grace=2000)
    st = license_state(activation="token", doc=doc, now=2500)
    assert st.status == "expired" and not is_usable(st)


def test_boundary_equal_not_yet_grace() -> None:
    doc = _doc(issued=0, expires=1000, grace=2000)
    # now == expiresAt is NOT > expiresAt, so still ok.
    assert license_state(activation="token", doc=doc, now=1000).status == "ok"
    # now == graceUntil is NOT > graceUntil, so still grace.
    assert license_state(activation="token", doc=doc, now=2000).status == "grace"


def test_the_floor_is_a_minimum_never_a_substitute() -> None:
    doc = _doc(issued=0, expires=1000, grace=2000)
    # An honest clock ahead of every artifact costs nothing.
    assert license_state(activation="token", doc=doc, now=2500, high_water_mark=0).status == "expired"
    # A wound-back clock is clamped up to the floor.
    assert license_state(activation="token", doc=doc, now=0, high_water_mark=2500).status == "expired"


# ── semver ──────────────────────────────────────────────────────────────────────────
def test_parse_semver() -> None:
    p = parse_semver("1.2.3-rc.1+build5")
    assert p is not None
    assert (p.major, p.minor, p.patch) == (1, 2, 3)
    assert p.prerelease == ["rc", "1"]
    assert parse_semver("nope") is None


def test_compare_semver_core() -> None:
    assert compare_semver("1.0.0", "1.0.1") == -1
    assert compare_semver("2.0.0", "1.9.9") == 1
    assert compare_semver("1.2.3", "1.2.3") == 0


def test_compare_semver_prerelease() -> None:
    # A prerelease is lower than its release.
    assert compare_semver("1.0.0-rc.1", "1.0.0") == -1
    assert compare_semver("1.0.0", "1.0.0-rc.1") == 1
    # Numeric identifiers compare numerically.
    assert compare_semver("1.0.0-rc.2", "1.0.0-rc.10") == -1
    # Fewer prerelease identifiers => lower precedence.
    assert compare_semver("1.0.0-rc", "1.0.0-rc.1") == -1


def test_compare_unparseable_is_zero() -> None:
    assert compare_semver("x", "1.0.0") == 0


def test_channel_for_version() -> None:
    assert channel_for_version("1.2.3") == "stable"
    assert channel_for_version("0.0.0-dev+abc") == "dev"
    # P0-04: `staging` is the legacy spelling of `beta` (WIRE-CONTRACT-V3 §5.1 rule 2).
    assert channel_for_version("0.0.0-staging.1") == "beta"
    assert channel_for_version("0.0.0-beta.3") == "beta"
    assert channel_for_version("2.0.0-beta.1") == "stable"
    assert channel_for_version("0.0.0-pr42.1") == "pr"
    assert channel_for_version("0.0.0-pr-42.1") == "pr"


def test_is_dev_build() -> None:
    assert is_dev_build("0.0.0-dev+abc")
    assert not is_dev_build("1.0.0")
