# @pkey-feature ui.boot
# @pkey-feature ui.stages packs.state
"""Cross-SDK boot stage machine conformance.

Drives the shared ``conformance/corpus/v2/stage-matrix.json`` through
:mod:`polaris_key.core.stages`. The Node runner (``conformance/runners/node/stageMatrix.test.ts``)
and the Swift runner (``StageMatrixTests.swift``) replay the SAME rows through their own
implementations, so the boot protocol cannot silently diverge between SDKs.

For every row it asserts each step's emits (as values), the stage sequence built from the
actual ``stage_changed`` emits, the final stage and the outcome. At the row's initial state and
after every step it also sends every probe and asserts that the state comes back unchanged with
no emits exactly when the probe's type is not in ``accepts`` for that state. Probe results are
discarded; the row continues from its own steps.
"""

from __future__ import annotations

import json
import platform
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.core.stages import (
    BOOT_CONFIRMATIONS,
    BOOT_OK_SECONDS,
    boot_confirmation,
    BOOT_EMIT_TYPES,
    BOOT_EVENT_TYPES,
    BOOT_GUARD_ACTIONS,
    BOOT_OUTCOMES,
    BOOT_STAGES,
    MAX_FAILED_BOOTS,
    BootState,
    boot_guard_action,
    boot_transition,
    initial_boot_state,
)

# tests/ -> python/ -> sdks/ -> repo root -> conformance/corpus/v2/stage-matrix.json
_MATRIX_PATH = (
    Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "stage-matrix.json"
)
_MATRIX: Dict[str, Any] = json.loads(_MATRIX_PATH.read_text(encoding="utf-8"))
_ROWS: List[Dict[str, Any]] = _MATRIX["rows"]
_GUARD_CASES: List[Dict[str, Any]] = _MATRIX["guardCases"]

#: The corpus's camelCase option keys → ``initial_boot_state``'s keyword arguments. Only the
#: keys a row's ``init`` carries are passed, so an omitted option takes its default.
_INIT_KWARGS = {
    "allowOffline": "allow_offline",
    "allowGrace": "allow_grace",
    "requiredPacks": "required_packs",
    "essentialPacks": "essential_packs",
}


def _accepts_key(state: BootState) -> str:
    """``gate:waiting`` while the gate waits, ``fetch:waiting`` while the fetch waits for
    consent, ``offline:playable`` at a playable offline stop (v3), otherwise the stage."""
    if state.stage == "gate" and state.outcome == "waiting":
        return "gate:waiting"
    if state.stage == "fetch" and state.outcome == "waiting":
        return "fetch:waiting"
    if state.stage == "offline" and state.canPlayOffline:
        return "offline:playable"
    return state.stage


def _probe(state: BootState, where: str) -> int:
    key = _accepts_key(state)
    accepted = _MATRIX["accepts"].get(key)
    assert accepted is not None, f"{where}: accepts has no {key}"
    for event in _MATRIX["probes"]:
        result = boot_transition(state, event)
        ignored = result.state == state and result.emits == ()
        assert ignored is (event["type"] not in accepted), (
            f"{where}: probe {event['type']} in {key}"
        )
    return len(_MATRIX["probes"])


def test_version_and_runtime() -> None:
    print(f"stage-matrix runner on Python {platform.python_version()}")
    assert _MATRIX["stageMatrixVersion"] == 3
    assert _MATRIX["maxFailedBoots"] == MAX_FAILED_BOOTS
    assert _MATRIX["bootOkSeconds"] == BOOT_OK_SECONDS


def test_vocabulary_matches_in_order() -> None:
    assert _MATRIX["vocabulary"] == {
        "stages": list(BOOT_STAGES),
        "outcomes": list(BOOT_OUTCOMES),
        "events": list(BOOT_EVENT_TYPES),
        "emits": list(BOOT_EMIT_TYPES),
        "guardActions": list(BOOT_GUARD_ACTIONS),
        "confirmations": list(BOOT_CONFIRMATIONS),
    }


def test_one_probe_per_event_type_in_order() -> None:
    assert [p["type"] for p in _MATRIX["probes"]] == _MATRIX["vocabulary"]["events"]


@pytest.mark.parametrize("row", _ROWS, ids=[r["name"] for r in _ROWS])
def test_stage_matrix_row(row: Dict[str, Any]) -> None:
    kwargs = {_INIT_KWARGS[k]: v for k, v in row["init"].items()}
    state = initial_boot_state(**kwargs)
    stages: List[str] = []
    probes = _probe(state, f"{row['name']}, initial state")
    for i, step in enumerate(row["steps"], start=1):
        where = f"{row['name']}, step {i} ({step['event']['type']})"
        result = boot_transition(state, step["event"])
        assert list(result.emits) == step["emits"], where
        stages.extend(e["stage"] for e in result.emits if e["type"] == "stage_changed")
        state = result.state
        # v3: canPlayOffline is true exactly at an offline stop whose emit said so.
        offline = [e for e in result.emits if e["type"] == "offline"]
        if offline:
            assert state.canPlayOffline is offline[0]["canPlayOffline"], where
        elif result.emits:
            assert state.canPlayOffline is False, where
        probes += _probe(state, f"{where}, after")
    assert stages == row["expect"]["stages"]
    assert state.stage == row["expect"]["stages"][-1]
    assert state.outcome == row["expect"]["outcome"]
    assert probes == (len(row["steps"]) + 1) * len(BOOT_EVENT_TYPES)


@pytest.mark.parametrize("case", _GUARD_CASES, ids=[c["name"] for c in _GUARD_CASES])
def test_boot_guard_case(case: Dict[str, Any]) -> None:
    inp = case["input"]
    action = boot_guard_action(staged=inp["staged"], failed_boots=inp["failedBoots"])
    assert action == case["expect"]["action"]


# Version 2 (plans/P3-01.md §2.10): boot confirmation, one case per outcome.
def test_one_confirm_case_per_outcome() -> None:
    assert sorted(c["outcome"] for c in _MATRIX["confirmCases"]) == sorted(BOOT_OUTCOMES)


@pytest.mark.parametrize(
    "case", _MATRIX["confirmCases"], ids=[c["outcome"] for c in _MATRIX["confirmCases"]]
)
def test_confirm_case(case: Dict[str, Any]) -> None:
    assert boot_confirmation(case["outcome"]) == case["expect"]
