"""Cross-SDK gate-parity conformance.

Drives the shared ``conformance/corpus/v1/gate-matrix.json`` fixture through the Python
SDK's gate and asserts every row reaches the decision the fixture pins. The Node, React,
and Swift suites run the SAME fixture through their own ports, so the four gate matrices
can't silently diverge.

Each row carries two halves: the build-gate inputs (version / channel / compat window /
entitlements) — which the Worker enforces and the SDK mirrors via ``_check_build_gate``
below, rebuilt from the SDK's exported semver/channel primitives — and the license-state
inputs (token / doc window / now / sync outcome). We derive the 403-style ``blocked`` from
the build gate, feed it into ``license_state``, and compare the resulting status / ok /
reason / allowedRange to the fixture.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from polaris_key.license import (
    BlockedState,
    channel_for_version,
    compare_semver,
    is_dev_build,
    is_usable,
    license_state,
)
from polaris_key.models import (
    AllowedRange,
    DocProfile,
    ManagedConfigDoc,
    ManagedEntry,
    ManagedPayload,
)

# tests/ -> python/ -> sdks/ -> repo root -> conformance/corpus/v1/gate-matrix.json
_MATRIX_PATH = (
    Path(__file__).resolve().parents[3]
    / "conformance"
    / "corpus"
    / "v1"
    / "gate-matrix.json"
)
_MATRIX = json.loads(_MATRIX_PATH.read_text(encoding="utf-8"))
_ROWS: List[Dict[str, Any]] = _MATRIX["rows"]


# ── Build-gate port (mirrors packages/worker/src/gate.ts `checkBuildGate`) ───────────
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


def _normalize_channel(header: str) -> str:
    if header == "staging":
        return "staging"
    if header == "pr" or header.startswith("pr"):
        return "pr"
    if header == "dev":
        return "dev"
    return "stable"


def _check_build_gate(gate: Dict[str, Any]) -> Optional[BlockedState]:
    version: str = gate["version"]
    if is_dev_build(version):
        return None
    ents = {k: ManagedEntry.from_dict(v) for k, v in gate.get("entitlements", {}).items()}
    min_v = _tighter_min(gate["compatMin"], _str_ent(ents.get("app.minVersion")))
    max_v = _tighter_max(gate["compatMax"], _str_ent(ents.get("app.maxVersion")))
    allowed = AllowedRange(min=min_v, max=max_v)
    if min_v and compare_semver(version, min_v) < 0:
        return BlockedState(reason="version-too-old", allowedRange=allowed)
    if max_v and compare_semver(version, max_v) > 0:
        return BlockedState(reason="version-too-new", allowedRange=allowed)
    channel = _normalize_channel(gate.get("channel") or channel_for_version(version))
    if channel not in ("stable", "dev"):
        granted = _arr_ent(ents.get("channels")) or ["stable"]
        if channel not in granted:
            return BlockedState(reason="channel-not-entitled")
    return None


def _build_doc(lic: Dict[str, Any]) -> Optional[ManagedConfigDoc]:
    if "issuedAt" not in lic or "expiresAt" not in lic or "graceUntil" not in lic:
        return None
    return ManagedConfigDoc(
        schemaVersion=1,
        aud="djdl",
        iss="key.plrs.im",
        licenseId="lic_matrix",
        deviceId="dev_matrix",
        issuedAt=lic["issuedAt"],
        expiresAt=lic["expiresAt"],
        graceUntil=lic["graceUntil"],
        profile=DocProfile(name="M", firstName="M", email="m@x.y", activatedAt=0),
        payload=ManagedPayload(config={}, secrets={}, entitlements={}),
    )


def test_gate_matrix_has_rows() -> None:
    assert len(_ROWS) > 0


@pytest.mark.parametrize("row", _ROWS, ids=[r["name"] for r in _ROWS])
def test_gate_matrix_row(row: Dict[str, Any]) -> None:
    lic = row["license"]
    blocked = _check_build_gate(row["gate"])
    state = license_state(
        has_token=lic["hasToken"],
        doc=_build_doc(lic),
        now=lic["now"],
        last_sync_unauthorized=lic.get("lastSyncUnauthorized", False),
        last_verified_at=lic.get("lastVerifiedAt"),
        blocked=blocked,
    )
    expect = row["expect"]
    assert state.status == expect["status"], row["name"]
    assert is_usable(state.status) is expect["ok"], f"{row['name']} usable"

    if expect.get("reason") is not None:
        assert blocked is not None and blocked.reason == expect["reason"], row["name"]

    expected_range = expect.get("allowedRange")
    if expected_range is not None:
        assert state.allowedRange == AllowedRange(
            min=expected_range.get("min"), max=expected_range.get("max")
        ), f"{row['name']} allowedRange"
    else:
        assert state.allowedRange is None, f"{row['name']} no allowedRange"
