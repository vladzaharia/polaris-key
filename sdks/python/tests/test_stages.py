# @pkey-feature ui.stages
"""Unit properties of :mod:`polaris_key.core.stages` that the stage matrix cannot express:
purity, identity on an ignored event, malformed events and the defaults. The rows and probes
run in ``test_stage_matrix.py``."""

from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any, List

import pytest

from polaris_key.core import stages as stages_module
from polaris_key.core.stages import (
    BootOptions,
    BootState,
    boot_guard_action,
    boot_transition,
    initial_boot_state,
)
from polaris_key.license.gate import is_usable

_TO_GATE: List[Any] = [
    {"type": "start"},
    {"type": "shell.done"},
    {"type": "guard.done", "result": "ok"},
    {"type": "sync.done", "result": "ok"},
]
_TO_FETCH: List[Any] = _TO_GATE + [
    {"type": "gate.status", "status": "ok"},
    {"type": "decide.done", "decision": "none"},
]


def _run(events: List[Any], **options: Any) -> BootState:
    state = initial_boot_state(**options)
    for event in events:
        state = boot_transition(state, event).state
    return state


def test_never_mutates_its_input_and_is_deterministic() -> None:
    state = _run(_TO_GATE, required_packs=["core"])
    event = {"type": "gate.status", "status": "needs-activation"}
    before_state, before_event = copy.deepcopy(state), copy.deepcopy(event)
    first = boot_transition(state, event)  # type: ignore[arg-type]
    second = boot_transition(state, event)  # type: ignore[arg-type]
    assert first == second
    assert state == before_state and event == before_event
    assert first.state is not state


def test_reads_no_clock_randomness_or_io() -> None:
    source = Path(stages_module.__file__).read_text(encoding="utf-8")
    imports = re.findall(r"^\s*(?:from|import)\s+(\S+)", source, re.MULTILINE)
    assert set(imports) <= {"__future__", "collections.abc", "dataclasses", "typing", ".models"}


def test_copies_required_packs() -> None:
    packs = ["core"]
    state = initial_boot_state(required_packs=packs)
    packs.append("extra")
    assert state.options.requiredPacks == ("core",)


def test_ignored_event_returns_the_input_object() -> None:
    gate = _run(_TO_GATE)
    late = boot_transition(gate, {"type": "sync.timeout"})
    assert late.state is gate and late.emits == ()
    assert boot_transition(gate, {"type": "retry"}).state is gate
    offline = _run(_TO_GATE[:3] + [{"type": "sync.timeout"}], allow_offline=False)
    assert offline.stage == "offline"
    assert boot_transition(offline, {"type": "play-offline"}).state is offline


@pytest.mark.parametrize(
    "prefix, event",
    [
        ([], {"type": "launch"}),
        ([], {}),
        ([], "start"),
        ([], None),
        ([], {"type": ["start"]}),
        (_TO_GATE[:2], {"type": "guard.done", "result": "maybe"}),
        (_TO_GATE[:2], {"type": "guard.done"}),
        (_TO_GATE[:3], {"type": "sync.done", "result": "timeout"}),
        (_TO_GATE[:3], {"type": "sync.done"}),
        (_TO_GATE, {"type": "gate.status", "status": "valid"}),
        (_TO_GATE, {"type": "gate.status", "status": 1}),
        (_TO_FETCH[:-1], {"type": "decide.done", "decision": "maybe"}),
        (_TO_FETCH[:-1], {"type": "decide.done"}),
        (_TO_FETCH, {"type": "fetch.done", "result": "partial", "installed": []}),
        (_TO_FETCH, {"type": "fetch.done", "result": "ok"}),
        (_TO_FETCH, {"type": "fetch.done", "result": "ok", "installed": "core"}),
        (_TO_FETCH, {"type": "fetch.done", "result": "ok", "installed": [1]}),
        (_TO_GATE, {"type": "fail"}),
        (_TO_GATE, {"type": "fail", "code": 500}),
    ],
)
def test_malformed_events_are_ignored(prefix: List[Any], event: Any) -> None:
    state = _run(prefix)
    result = boot_transition(state, event)
    assert result.state is state
    assert result.emits == ()


def test_an_extra_key_is_accepted() -> None:
    state = _run(_TO_GATE[:3])
    result = boot_transition(state, {"type": "sync.done", "result": "ok", "attempt": 2})  # type: ignore[typeddict-unknown-key]
    assert result.state.stage == "gate"
    assert result.emits == ({"type": "stage_changed", "stage": "gate", "previous": "sync"},)


def test_defaults() -> None:
    assert initial_boot_state() == BootState(
        stage="idle",
        outcome="running",
        options=BootOptions(allowOffline=True, allowGrace=True, requiredPacks=()),
        sync="pending",
        resume="shell",
    )
    assert _run(_TO_GATE[:2]).resume == "guard"
    assert _run(_TO_GATE[:3]).resume == "sync"
    blocked = _run(_TO_GATE + [{"type": "gate.status", "status": "version-too-old"}])
    retried = boot_transition(blocked, {"type": "retry"}).state
    assert (retried.stage, retried.sync) == ("sync", "pending")


def test_boot_guard_rolls_back_at_max_failed_boots() -> None:
    assert boot_guard_action(staged=True, failed_boots=1) == "apply-staged"
    assert boot_guard_action(staged=True, failed_boots=2) == "roll-back"


@pytest.mark.parametrize("sync", ["ok", "offline", "error"])
def test_gate_pass_set_is_is_usable(sync: str) -> None:
    at_gate = _run(_TO_GATE[:3] + [{"type": "sync.done", "result": sync}])
    for status in (
        "ok",
        "grace",
        "expired",
        "revoked",
        "needs-activation",
        "version-too-old",
        "version-too-new",
        "channel-not-entitled",
        "not-applicable",
    ):
        nxt = boot_transition(at_gate, {"type": "gate.status", "status": status})  # type: ignore[typeddict-item]
        assert (nxt.state.stage == "decide") is is_usable(status), status
