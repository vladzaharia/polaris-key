"""Client license gate + semver/channel helpers.

Mirrors ``gate.ts`` and ``semver.ts`` from the Node SDK. ``license_state`` computes the
renderable status from the cached signed doc + current time + the last sync outcome; the
server enforces version/channel (a 403 -> ``blocked``), the client reflects that plus
offline grace. The semver/channel logic is pinned by the conformance corpus so all SDKs
agree.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional

from .models import AllowedRange, BlockReason, LicenseStatus, ManagedConfigDoc

__all__ = [
    "ParsedSemver",
    "parse_semver",
    "compare_semver",
    "channel_for_version",
    "is_dev_build",
    "LicenseState",
    "BlockedState",
    "license_state",
    "is_usable",
]

_SEMVER_RE = re.compile(
    r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z\-.]+))?(?:\+[0-9A-Za-z\-.]+)?$"
)
_PR_RE = re.compile(r"^0\.0\.0-pr\d+")
_NUMERIC_RE = re.compile(r"^\d+$")


@dataclass(frozen=True)
class ParsedSemver:
    major: int
    minor: int
    patch: int
    prerelease: List[str]


def parse_semver(v: str) -> Optional[ParsedSemver]:
    m = _SEMVER_RE.match(v)
    if not m:
        return None
    return ParsedSemver(
        major=int(m.group(1)),
        minor=int(m.group(2)),
        patch=int(m.group(3)),
        prerelease=m.group(4).split(".") if m.group(4) else [],
    )


def compare_semver(a: str, b: str) -> int:
    """Return -1, 0, or 1. Unparseable inputs compare equal (0), mirroring Node."""
    pa = parse_semver(a)
    pb = parse_semver(b)
    if pa is None or pb is None:
        return 0
    for ka, kb in ((pa.major, pb.major), (pa.minor, pb.minor), (pa.patch, pb.patch)):
        if ka != kb:
            return -1 if ka < kb else 1
    # A version with a prerelease is LOWER than the same without one.
    if not pa.prerelease and pb.prerelease:
        return 1
    if pa.prerelease and not pb.prerelease:
        return -1
    n = max(len(pa.prerelease), len(pb.prerelease))
    for i in range(n):
        x = pa.prerelease[i] if i < len(pa.prerelease) else None
        y = pb.prerelease[i] if i < len(pb.prerelease) else None
        if x is None:
            return -1
        if y is None:
            return 1
        xn = bool(_NUMERIC_RE.match(x))
        yn = bool(_NUMERIC_RE.match(y))
        if xn and yn:
            d = int(x) - int(y)
            if d != 0:
                return -1 if d < 0 else 1
        elif x != y:
            return -1 if x < y else 1
    return 0


def channel_for_version(version: str) -> str:
    """Map a version string to its release channel (stable/staging/pr/dev)."""
    if version.startswith("0.0.0-dev"):
        return "dev"
    if version.startswith("0.0.0-staging"):
        return "staging"
    if _PR_RE.match(version):
        return "pr"
    return "stable"


def is_dev_build(version: str) -> bool:
    return version.startswith("0.0.0-dev")


@dataclass(frozen=True)
class BlockedState:
    """A server 403 block: its reason + the allowed version window."""

    reason: BlockReason
    allowedRange: Optional[AllowedRange] = None


@dataclass(frozen=True)
class LicenseState:
    """The renderable gate state."""

    status: LicenseStatus
    graceUntil: Optional[int] = None
    lastVerifiedAt: Optional[int] = None
    allowedRange: Optional[AllowedRange] = None


def license_state(
    *,
    has_token: bool,
    doc: Optional[ManagedConfigDoc],
    now: int,
    last_sync_unauthorized: bool = False,
    blocked: Optional[BlockedState] = None,
    last_verified_at: Optional[int] = None,
) -> LicenseState:
    """Compute the gate status. Order matches ``gate.ts`` exactly.

    blocked(403) -> that reason; no token -> needs-enroll; lastSyncUnauthorized ->
    revoked; no doc -> needs-enroll; now > graceUntil -> expired; now > expiresAt ->
    grace; else ok.
    """
    if blocked is not None:
        return LicenseState(status=blocked.reason, allowedRange=blocked.allowedRange)
    if not has_token:
        return LicenseState(status="needs-enroll")
    if last_sync_unauthorized:
        return LicenseState(status="revoked")
    if doc is None:
        return LicenseState(status="needs-enroll")
    if now > doc.graceUntil:
        return LicenseState(status="expired", graceUntil=doc.graceUntil)
    if now > doc.expiresAt:
        return LicenseState(
            status="grace", graceUntil=doc.graceUntil, lastVerifiedAt=last_verified_at
        )
    return LicenseState(
        status="ok", graceUntil=doc.graceUntil, lastVerifiedAt=last_verified_at
    )


def is_usable(status: LicenseStatus) -> bool:
    """True when the gate permits running (ok or grace)."""
    return status == "ok" or status == "grace"
