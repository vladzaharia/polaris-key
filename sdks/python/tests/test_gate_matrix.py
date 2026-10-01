# @pkey-feature license.gate
"""Cross-SDK gate-parity conformance.

Drives the shared ``conformance/corpus/v2/gate-matrix.json`` fixture through the Python
SDK's gate and asserts every row reaches the decision the fixture pins. The Node, React,
and Swift suites run the SAME fixture through their own ports, so the four gate matrices
can't silently diverge.

Each row carries two halves: the build-gate inputs (version / channel / compat window /
entitlements) — which the Worker enforces and the SDK mirrors via ``_check_build_gate``
below, rebuilt from the SDK's exported semver/channel primitives — and the license-state
inputs (``licenseServiceEnabled`` / ``activation`` / doc window / now / sync outcome). We
derive the 403-style ``blocked`` from the build gate, feed it into ``license_state``, and
compare the resulting status / usable / reason / allowedRange to the fixture.

gate-matrix v2 adds what v1 could not express: ``not-applicable`` for a product that does
not enable the licence service (D-08), ``activation: "bundle"`` for an air-gapped install
(§7), and the ONE ordering v3 changed — the activation guard runs BEFORE the unsigned
``blocked`` hint, so ``expect.reason`` on that row is deliberately NOT the status. P0-04 added
the channel rows of WIRE-CONTRACT-V3 §5.1 and retired the carried pre-R3-01 dev-bypass row.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from polaris_key.core.models import AllowedRange, BlockedState, LicenseDoc, ManagedEntry
from polaris_key.core.semver import channel_for_version, compare_semver, is_dev_build
from polaris_key.license.gate import is_usable, license_state

# tests/ -> python/ -> sdks/ -> repo root -> conformance/corpus/v2/gate-matrix.json
_MATRIX_PATH = (
    Path(__file__).resolve().parents[3]
    / "conformance"
    / "corpus"
    / "v2"
    / "gate-matrix.json"
)
_MATRIX = json.loads(_MATRIX_PATH.read_text(encoding="utf-8"))
_ROWS: List[Dict[str, Any]] = _MATRIX["rows"]


# ── Build-gate port (mirrors packages/worker/src/core/gate.ts `checkBuildGate`) ──────
# WIRE-CONTRACT-V3 §5.1 rules 2–5, rebuilt from the SDK's own semver/channel primitives. The
# Worker replays the same rows through the real gate (packages/worker/test/gateMatrixCorpus.test.ts).
_CHANNEL_ALIASES = {"staging": "beta", "latest": "stable"}
_CHANNEL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_PR_CHANNEL_RE = re.compile(r"^pr-?([0-9]+)$")
_PR_BUILD_RE = re.compile(r"^0\.0\.0-pr-?([0-9]+)")
_PR_N_RE = re.compile(r"^pr-[0-9]+$")
_PR_NUMBER_MAX_DIGITS = 7


def _str_ent(e: Optional[ManagedEntry]) -> Optional[str]:
    return e.value if e is not None and isinstance(e.value, str) else None


def _arr_ent(e: Optional[ManagedEntry]) -> Optional[List[str]]:
    if e is not None and isinstance(e.value, list):
        return [v for v in e.value if isinstance(v, str)]
    return None


def _tighter_min(a: Optional[str], b: Optional[str]) -> Optional[str]:
    if not a:
        return b
    if not b:
        return a
    return a if compare_semver(a, b) >= 0 else b


def _tighter_max(a: Optional[str], b: Optional[str]) -> Optional[str]:
    if not a:
        return b
    if not b:
        return a
    return a if compare_semver(a, b) <= 0 else b


def _pr_channel(digits: str) -> str:
    return "pr" if len(digits) > _PR_NUMBER_MAX_DIGITS else f"pr-{digits}"


def _implied_channel(version: str) -> str:
    """§5.1 rule 2: the family, with a PR build narrowed to its own ``pr-<n>``."""
    family = channel_for_version(version)
    if family != "pr":
        return family
    m = _PR_BUILD_RE.match(version)
    return _pr_channel(m.group(1)) if m else "pr"


def _normalize_channel_header(header: str, version: str) -> Optional[str]:
    """§5.1 rule 3: ``None`` is a malformed header, which the gate refuses."""
    if header in _CHANNEL_ALIASES:
        return _CHANNEL_ALIASES[header]
    if header == "pr":
        implied = _implied_channel(version)
        return implied if _PR_N_RE.match(implied) else "pr"
    m = _PR_CHANNEL_RE.match(header)
    if m:
        return _pr_channel(m.group(1))
    return header if _CHANNEL_NAME_RE.match(header) else None


def _channel_entitled(granted: List[str], channel: str) -> bool:
    """§5.1 rule 4: stable always; exact name; staging covers beta; pr covers pr-<n>."""
    if channel == "stable" or channel in granted:
        return True
    if channel == "beta" and "staging" in granted:
        return True
    return bool(_PR_N_RE.match(channel)) and "pr" in granted


def _check_build_gate(gate: Dict[str, Any]) -> Optional[BlockedState]:
    """§5.1 rule 5, in order: dev bypass by grant, version window, malformed header, channels."""
    version: str = gate["version"]
    ents = {k: ManagedEntry.from_any(v) for k, v in gate.get("entitlements", {}).items()}
    granted = _arr_ent(ents.get("channels"))
    if granted is None:
        granted = ["stable"]
    if is_dev_build(version) and "dev" in granted:
        return None
    min_v = _tighter_min(gate["compatMin"], _str_ent(ents.get("app.minVersion")))
    max_v = _tighter_max(gate["compatMax"], _str_ent(ents.get("app.maxVersion")))
    allowed = AllowedRange(min=min_v, max=max_v)
    if min_v and compare_semver(version, min_v) < 0:
        return BlockedState(reason="version-too-old", allowedRange=allowed)
    if max_v and compare_semver(version, max_v) > 0:
        return BlockedState(reason="version-too-new", allowedRange=allowed)
    header = gate.get("channel")
    declared = None if header is None else _normalize_channel_header(header, version)
    if header is not None and declared is None:
        return BlockedState(reason="channel-not-entitled")
    for channel in {_implied_channel(version), declared}:
        if channel is not None and not _channel_entitled(granted, channel):
            return BlockedState(reason="channel-not-entitled")
    return None


def _build_doc(lic: Dict[str, Any]) -> Optional[LicenseDoc]:
    """The gate reads only the three timestamps; the rest is fixture furniture."""
    if not {"issuedAt", "expiresAt", "graceUntil"} <= set(lic):
        return None
    return LicenseDoc(
        iss="key.plrs.im",
        aud="djdl",
        deviceId="dev_matrix",
        issuedAt=lic["issuedAt"],
        expiresAt=lic["expiresAt"],
        graceUntil=lic["graceUntil"],
        licenseId="lic_matrix",
        entitlements={},
    )


def test_gate_matrix_is_v2_and_has_rows() -> None:
    assert _MATRIX["gateMatrixVersion"] == 2
    assert len(_ROWS) > 0


# The rows P0-04 appended to gate-matrix v2 (WIRE-CONTRACT-V3 §5.1).
_P0_04_CHANNEL_ROWS = [
    "ok — beta header, channels [stable, beta]",
    "ok — beta header, channels [stable, staging] (alias)",
    "ok — staging header, channels [stable, beta] (alias)",
    "channel-not-entitled — beta header, channels [stable]",
    "ok — manual channel header, entitled by name",
    "channel-not-entitled — manual channel header, not entitled",
    "channel-not-entitled — malformed channel header",
    "ok — 0.0.0-beta build with beta entitlement",
    "channel-not-entitled — 0.0.0-beta build without a beta entitlement",
    "ok — 0.0.0-staging build is the beta channel, channels [stable, beta]",
    "ok — latest header is the stable channel",
    "ok — pr-42 header, channels grant the pr family",
    "ok — pr header on a 0.0.0-pr-42 build, channels [stable, pr-42]",
    "channel-not-entitled — pr-7 header, channels grant only pr-42",
    "channel-not-entitled — stable header cannot loosen a 0.0.0-pr-42 build",
    "channel-not-entitled — dev header without the dev entitlement",
    "version-too-old — dev build without the dev entitlement gets no bypass (R3-01)",
    "ok — dev build with the dev entitlement bypasses the window (R3-01)",
]


# @pkey-feature license.gate
def test_gate_matrix_covers_the_p0_04_channel_rows() -> None:
    names = {r["name"] for r in _ROWS}
    assert len(_ROWS) == 38
    for name in _P0_04_CHANNEL_ROWS:
        assert name in names, name
    assert (
        "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel"
        not in names
    )


@pytest.mark.parametrize("row", _ROWS, ids=[r["name"] for r in _ROWS])
def test_gate_matrix_row(row: Dict[str, Any]) -> None:
    lic = row["license"]
    blocked = _check_build_gate(row["gate"])
    state = license_state(
        license_service_enabled=lic["licenseServiceEnabled"],
        activation=lic["activation"],
        doc=_build_doc(lic),
        now=lic["now"],
        last_sync_unauthorized=lic.get("lastSyncUnauthorized", False),
        last_verified_at=lic.get("lastVerifiedAt"),
        blocked=blocked,
    )
    expect = row["expect"]
    assert state.status == expect["status"], row["name"]
    assert is_usable(state) is expect["ok"], f"{row['name']} usable"
    # `is_usable` must accept both call shapes across the SDK migration.
    assert is_usable(state.status) is expect["ok"], f"{row['name']} usable(str)"

    # `reason` describes the DERIVED build-gate hint, which on the unactivated+blocked row
    # is deliberately not the status — that row is the whole point of v3's ordering.
    if expect.get("reason") is not None:
        assert blocked is not None and blocked.reason == expect["reason"], row["name"]

    expected_range = expect.get("allowedRange")
    if expected_range is not None:
        assert state.allowedRange == AllowedRange(
            min=expected_range.get("min"), max=expected_range.get("max")
        ), f"{row['name']} allowedRange"
    else:
        assert state.allowedRange is None, f"{row['name']} no allowedRange"


def test_matrix_covers_the_v3_additions() -> None:
    """The three families v1's matrix could not express are all present — a fixture that
    silently lost them would make this suite green while proving nothing about v3."""
    names = [r["name"] for r in _ROWS]
    assert any(r["expect"]["status"] == "not-applicable" for r in _ROWS)
    assert any(r["license"]["activation"] == "bundle" for r in _ROWS)
    assert any(
        r["license"]["activation"] is None and r["expect"].get("reason") is not None
        for r in _ROWS
    ), f"the activation-precedes-blocked row is missing from {names}"
