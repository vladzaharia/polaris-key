"""License-gate transitions + semver/channel helpers (mirrors gate.ts / semver.ts)."""

from __future__ import annotations

from polaris_key.license import (
    AllowedRange,
    BlockedState,
    channel_for_version,
    compare_semver,
    is_dev_build,
    is_usable,
    license_state,
    parse_semver,
)
from polaris_key.models import DocProfile, ManagedConfigDoc, ManagedPayload


def _doc(*, issued: int, expires: int, grace: int) -> ManagedConfigDoc:
    return ManagedConfigDoc(
        schemaVersion=1,
        aud="djdl",
        iss="key.plrs.im",
        licenseId="lic_1",
        deviceId="dev_1",
        issuedAt=issued,
        expiresAt=expires,
        graceUntil=grace,
        profile=DocProfile(name="A", firstName="A", email="a@b.c", enrolledAt=0),
        payload=ManagedPayload(config={}, secrets={}, entitlements={}),
    )


def test_no_token_needs_enroll() -> None:
    st = license_state(has_token=False, doc=None, now=100)
    assert st.status == "needs-enroll"
    assert not is_usable(st.status)


def test_token_but_no_doc_needs_enroll() -> None:
    st = license_state(has_token=True, doc=None, now=100)
    assert st.status == "needs-enroll"


def test_unauthorized_is_revoked() -> None:
    st = license_state(has_token=True, doc=None, now=100, last_sync_unauthorized=True)
    assert st.status == "revoked"


def test_blocked_takes_precedence() -> None:
    blocked = BlockedState(
        reason="version-too-old", allowedRange=AllowedRange(min="1.0.0")
    )
    st = license_state(has_token=True, doc=None, now=100, blocked=blocked)
    assert st.status == "version-too-old"
    assert st.allowedRange is not None
    assert st.allowedRange.min == "1.0.0"


def test_ok_within_expiry() -> None:
    doc = _doc(issued=0, expires=1000, grace=2000)
    st = license_state(has_token=True, doc=doc, now=500, last_verified_at=499)
    assert st.status == "ok"
    assert is_usable(st.status)
    assert st.graceUntil == 2000
    assert st.lastVerifiedAt == 499


def test_grace_between_expiry_and_grace() -> None:
    doc = _doc(issued=0, expires=1000, grace=2000)
    st = license_state(has_token=True, doc=doc, now=1500)
    assert st.status == "grace"
    assert is_usable(st.status)


def test_expired_past_grace() -> None:
    doc = _doc(issued=0, expires=1000, grace=2000)
    st = license_state(has_token=True, doc=doc, now=2500)
    assert st.status == "expired"
    assert not is_usable(st.status)


def test_boundary_equal_not_yet_grace() -> None:
    # now == expiresAt is NOT > expiresAt, so still ok.
    doc = _doc(issued=0, expires=1000, grace=2000)
    assert license_state(has_token=True, doc=doc, now=1000).status == "ok"
    # now == graceUntil is NOT > graceUntil, so still grace.
    assert license_state(has_token=True, doc=doc, now=2000).status == "grace"


# ── semver ──────────────────────────────────────────────────────────────────────
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
    assert channel_for_version("0.0.0-staging.1") == "staging"
    assert channel_for_version("0.0.0-pr42.1") == "pr"


def test_is_dev_build() -> None:
    assert is_dev_build("0.0.0-dev+abc")
    assert not is_dev_build("1.0.0")
